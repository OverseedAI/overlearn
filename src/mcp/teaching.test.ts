import { describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  createMcpHttpClient,
  createMcpStdioClient,
  type McpClient,
  type McpToolCallResult,
} from "./protocol";
import {
  createTeachingMcpHttpHandler,
  teachingMcpServerName,
  type TeachingSessionScope,
  type TeachingToolName,
  type TeachingWriteEvent,
} from "./teaching";
import {
  appendTranscriptEntry,
  createCourse,
  getCourse,
  listDemos,
  listFeynmanChecks,
  listGlossary,
  listLatestMasteryScores,
  openStore,
  readTopicTree,
  type Course,
  type Store,
} from "../store";

const proxyPath = fileURLToPath(new URL("./proxy.ts", import.meta.url));

const expectedToolNames: readonly TeachingToolName[] = [
  "get_course_state",
  "upsert_topic",
  "emit_demo",
  "upsert_lesson",
  "record_mastery",
  "feynman_check",
  "upsert_glossary_entry",
  "propose_course_plan",
];

type Transport = "http" | "stdio-proxy";

type Fixture = Readonly<{
  store: Store;
  draftCourse: Course;
  activeCourse: Course;
  scopes: ReadonlyMap<string, TeachingSessionScope>;
  writes: TeachingWriteEvent[];
}>;

type RunningFetchServer = Readonly<{
  url: string;
  stop: () => void;
}>;

const randomLoopbackPort = (): number =>
  20_000 + Math.floor(Math.random() * 20_000);

const withTimeout = async <T>(
  promise: Promise<T>,
  milliseconds: number,
  label: string,
): Promise<T> => {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  const timeoutPromise = new Promise<never>((_, reject) => {
    timeout = setTimeout(
      () => reject(new Error(`${label} timed out after ${milliseconds}ms`)),
      milliseconds,
    );
  });

  try {
    return await Promise.race([promise, timeoutPromise]);
  } finally {
    if (timeout !== undefined) {
      clearTimeout(timeout);
    }
  }
};

const startFetchServer = (
  fetch: (request: Request) => Response | Promise<Response>,
): RunningFetchServer => {
  let server: ReturnType<typeof Bun.serve> | undefined;
  let lastError: unknown;

  for (let attempt = 0; attempt < 20; attempt += 1) {
    try {
      server = Bun.serve({
        hostname: "127.0.0.1",
        port: randomLoopbackPort(),
        fetch,
      });
      break;
    } catch (error) {
      lastError = error;
    }
  }

  if (server === undefined) {
    throw lastError instanceof Error
      ? lastError
      : new Error("Unable to start test fetch server.");
  }

  return {
    url: server.url.toString(),
    stop: () => {
      server.stop(true);
    },
  };
};

const mcpUrl = (serverUrl: string, token: string): string =>
  new URL(`/mcp/${encodeURIComponent(token)}`, serverUrl).toString();

const parseResult = (result: McpToolCallResult): Record<string, unknown> => {
  const text = result.content.at(0)?.text;
  expect(text).toBeString();

  return JSON.parse(text ?? "{}") as Record<string, unknown>;
};

const asRecord = (
  value: unknown,
  label: string,
): Record<string, unknown> => {
  expect(value, label).toBeObject();
  return value as Record<string, unknown>;
};

const asArray = (value: unknown, label: string): unknown[] => {
  expect(Array.isArray(value), label).toBe(true);
  return value as unknown[];
};

const withFixture = async (
  run: (fixture: Fixture) => void | Promise<void>,
): Promise<void> => {
  const dir = await mkdtemp(join(tmpdir(), "overlearn-teaching-mcp-"));
  const store = openStore({ databasePath: join(dir, "overlearn.sqlite") });

  try {
    const draftCourse = createCourse(store, {
      title: "Draft Finance",
      description: "Draft description",
      status: "active",
      harnessId: "codex",
      attachedDir: "/tmp/finance",
    });
    const activeCourse = createCourse(store, {
      title: "Active Algebra",
      description: "Active description",
      status: "active",
      harnessId: "codex",
    });

    for (let turn = 1; turn <= 25; turn += 1) {
      appendTranscriptEntry(store, draftCourse.id, {
        turn,
        role: turn % 2 === 0 ? "agent" : "learner",
        content: `transcript turn ${turn}`,
        ts: `2026-01-01T00:${String(turn).padStart(2, "0")}:00.000Z`,
      });
    }

    const scopes = new Map<string, TeachingSessionScope>([
      ["token-a", { courseId: draftCourse.id }],
      ["token-b", { courseId: activeCourse.id }],
    ]);
    const writes: TeachingWriteEvent[] = [];

    await run({
      store,
      draftCourse,
      activeCourse,
      scopes,
      writes,
    });
  } finally {
    store.close();
    await rm(dir, { force: true, recursive: true });
  }
};

const createClient = (
  transport: Transport,
  serverUrl: string,
  token: string,
): McpClient => {
  const url = mcpUrl(serverUrl, token);

  if (transport === "http") {
    return createMcpHttpClient({
      name: teachingMcpServerName,
      url,
    });
  }

  return createMcpStdioClient(
    {
      name: teachingMcpServerName,
      command: process.execPath,
      args: [proxyPath, url],
      env: {},
    },
    {
      requestTimeoutMs: 3_000,
    },
  );
};

const exerciseDraftTools = async (
  client: McpClient,
  fixture: Fixture,
): Promise<void> => {
  const initialized = await withTimeout(
    client.initialize(),
    3_000,
    "initialize",
  );
  expect(initialized.serverInfo).toEqual({
    name: teachingMcpServerName,
    version: "0.0.0",
  });

  const tools = await withTimeout(client.listTools(), 3_000, "tools/list");
  expect(tools.map((tool) => tool.name)).toEqual([...expectedToolNames]);
  expect(
    tools.map((tool) => [tool.name, tool.inputSchema["type"]]),
  ).toEqual([...expectedToolNames].map((name) => [name, "object"]));

  const invalid = await withTimeout(
    client.callTool("record_mastery", {
      concept: "rule-of-72",
      score: 101,
    }),
    3_000,
    "validation failure",
  );
  expect(invalid.isError).toBe(true);
  expect(parseResult(invalid)["error"]).toContain("score must be at most 100");
  expect(fixture.writes).toEqual([]);

  const topicResult = parseResult(
    await withTimeout(
      client.callTool("upsert_topic", {
        path: "rule-of-72",
        parentPath: "finance",
        title: "Rule of 72",
        body: "Estimate doubling time from a growth rate.",
        position: 2,
        setCurrent: true,
      }),
      3_000,
      "upsert_topic",
    ),
  );
  expect(topicResult).toMatchObject({ ok: true });
  expect(asRecord(topicResult["topic"], "topic")).toMatchObject({
    path: "finance/rule-of-72",
    title: "Rule of 72",
    current: true,
    state: "current",
    position: 2,
  });
  const currentTopicId = asRecord(topicResult["topic"], "topic")["id"];

  const glossaryResult = parseResult(
    await withTimeout(
      client.callTool("upsert_glossary_entry", {
        term: "Doubling time",
        definition: "The time required for a quantity to double.",
      }),
      3_000,
      "upsert_glossary_entry",
    ),
  );
  expect(glossaryResult).toMatchObject({
    ok: true,
    glossaryEntry: {
      term: "Doubling time",
      definition: "The time required for a quantity to double.",
      topicId: currentTopicId,
    },
  });

  const masteryResult = parseResult(
    await withTimeout(
      client.callTool("record_mastery", {
        concept: "rule-of-72",
        score: 82,
        gaps: ["rate as percent"],
        topicPath: "finance/rule-of-72",
      }),
      3_000,
      "record_mastery",
    ),
  );
  expect(masteryResult).toMatchObject({
    ok: true,
    mastery: {
      concept: "rule-of-72",
      score: 82,
      gaps: "rate as percent",
    },
  });

  const feynmanResult = parseResult(
    await withTimeout(
      client.callTool("feynman_check", {
        concept: "rule-of-72",
        prompt: "Explain why dividing 72 by the rate estimates doubling time.",
        keyPoints: ["growth rate", "doubling", "estimate"],
        topicPath: "finance/rule-of-72",
      }),
      3_000,
      "feynman_check",
    ),
  );
  expect(feynmanResult).toMatchObject({
    ok: true,
    feynmanCheck: {
      concept: "rule-of-72",
      keyPoints: ["growth rate", "doubling", "estimate"],
    },
  });

  const demoResult = parseResult(
    await withTimeout(
      client.callTool("emit_demo", {
        title: "Growth table",
        body: "| rate | years |\n| --- | --- |\n| 6% | 12 |",
        format: "markdown",
        topicPath: "finance/rule-of-72",
      }),
      3_000,
      "emit_demo",
    ),
  );
  expect(demoResult).toMatchObject({
    ok: true,
    demo: {
      title: "Growth table",
      format: "markdown",
    },
  });

  const lessonResult = await withTimeout(
    client.callTool("upsert_lesson", {
      lessonId: "rule-of-72",
      body: '# Rule of 72\n\nDivide 72 by the growth rate.\n\n:::demo growth.html "Growth table"',
    }),
    3_000,
    "upsert_lesson",
  );
  expect(lessonResult.isError).toBe(true);
  expect(parseResult(lessonResult)["error"]).toContain(
    "topic journal entries replace lessons",
  );

  const state = parseResult(
    await withTimeout(
      client.callTool("get_course_state", { transcriptLimit: 3 }),
      3_000,
      "get_course_state",
    ),
  );
  expect(state).toMatchObject({
    server: teachingMcpServerName,
    course: {
      id: fixture.draftCourse.id,
      title: "Draft Finance",
      status: "active",
      attachedDir: "/tmp/finance",
      harness: "codex",
    },
    currentTopicPath: "finance/rule-of-72",
    activeFeynmanCheck: {
      concept: "rule-of-72",
      keyPoints: ["growth rate", "doubling", "estimate"],
    },
  });
  expect(asArray(state["transcriptTail"], "transcriptTail")).toHaveLength(3);
  expect(asArray(state["glossary"], "glossary")).toEqual([
    expect.objectContaining({ term: "Doubling time" }),
  ]);
  expect(state["lessons"]).toBeUndefined();

  const rootTopics = asArray(state["topics"], "topics");
  expect(rootTopics).toHaveLength(1);
  expect(asRecord(rootTopics[0], "root topic")).toMatchObject({
    path: "finance",
    children: [
      expect.objectContaining({
        path: "finance/rule-of-72",
        state: "current",
        mastery: expect.objectContaining({ score: 82 }),
      }),
    ],
  });

  const planResult = await withTimeout(
    client.callTool("propose_course_plan", {
      title: "Planned Finance",
      description: "A sharper plan.",
      topics: [
        {
          path: "basics",
          title: "Basics",
          summary: "Core mental math.",
        },
      ],
    }),
    3_000,
    "propose_course_plan",
  );
  expect(planResult.isError).toBe(true);
  expect(parseResult(planResult)["error"]).toContain("only valid for draft courses");

  expect(fixture.writes.map((event) => event.tool)).toEqual([
    "upsert_topic",
    "upsert_glossary_entry",
    "record_mastery",
    "feynman_check",
    "emit_demo",
  ]);
  expect(
    fixture.writes.every((event) => event.courseId === fixture.draftCourse.id),
  ).toBe(true);
  const demoId = asRecord(demoResult["demo"], "demo")["id"];
  expect(
    fixture.writes.find((event) => event.tool === "emit_demo")?.attachment,
  ).toEqual({
    kind: "demo",
    // Markdown demos fall back to the synthesized servable .html key.
    file: `demo-${demoId}.html`,
    title: "Growth table",
  });
  expect(fixture.writes.find((event) => event.tool === "upsert_lesson")).toBeUndefined();

  expect(getCourse(fixture.store, fixture.draftCourse.id)).toMatchObject({
    title: "Draft Finance",
    description: "Draft description",
  });
  expect(readTopicTree(fixture.store, fixture.draftCourse.id)).toMatchObject([
    {
      path: "finance",
      children: [{ path: "finance/rule-of-72" }],
    },
  ]);
  expect(listGlossary(fixture.store, fixture.draftCourse.id)).toHaveLength(1);
  expect(listLatestMasteryScores(fixture.store, fixture.draftCourse.id)).toHaveLength(
    1,
  );
  expect(listFeynmanChecks(fixture.store, fixture.draftCourse.id)).toHaveLength(
    1,
  );
  expect(listDemos(fixture.store, fixture.draftCourse.id)).toHaveLength(1);
};

const exerciseActiveScope = async (
  client: McpClient,
  fixture: Fixture,
): Promise<void> => {
  await withTimeout(client.initialize(), 3_000, "active initialize");

  const activeState = parseResult(
    await withTimeout(
      client.callTool("get_course_state", {}),
      3_000,
      "active get_course_state",
    ),
  );
  expect(activeState).toMatchObject({
    course: {
      id: fixture.activeCourse.id,
      title: "Active Algebra",
      status: "active",
    },
    topics: [],
    glossary: [],
  });

  const writesBeforeReject = fixture.writes.length;
  const rejectedPlan = await withTimeout(
    client.callTool("propose_course_plan", {
      title: "Should not write",
      description: "Rejected.",
      topics: [
        {
          path: "blocked",
          title: "Blocked",
          summary: "This should not persist.",
        },
      ],
    }),
    3_000,
    "active propose_course_plan",
  );
  expect(rejectedPlan.isError).toBe(true);
  expect(parseResult(rejectedPlan)["error"]).toContain(
    "only valid for draft courses",
  );
  expect(fixture.writes).toHaveLength(writesBeforeReject);

  expect(getCourse(fixture.store, fixture.activeCourse.id)).toMatchObject({
    title: "Active Algebra",
    status: "active",
  });
  expect(readTopicTree(fixture.store, fixture.activeCourse.id)).toEqual([]);
  expect(listGlossary(fixture.store, fixture.activeCourse.id)).toEqual([]);
};

const runTransportScenario = async (transport: Transport): Promise<void> => {
  await withFixture(async (fixture) => {
    const handler = createTeachingMcpHttpHandler({
      store: fixture.store,
      resolveScope: (token) => fixture.scopes.get(token),
      onWrite: (event) => {
        fixture.writes.push(event);
      },
    });
    const server = startFetchServer(handler);
    const draftClient = createClient(transport, server.url, "token-a");
    const activeClient = createClient(transport, server.url, "token-b");

    try {
      await exerciseDraftTools(draftClient, fixture);
      await exerciseActiveScope(activeClient, fixture);
    } finally {
      await withTimeout(draftClient.close(), 3_000, "draft client close");
      await withTimeout(activeClient.close(), 3_000, "active client close");
      server.stop();
    }
  });
};

describe("teaching MCP server", () => {
  test("serves all teaching tools over streamable HTTP", async () => {
    await runTransportScenario("http");
  });

  test("serves all teaching tools through the stdio HTTP proxy", async () => {
    await runTransportScenario("stdio-proxy");
  });
});
