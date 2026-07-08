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
  createTeachingMcpServer,
  createTeachingMcpHttpHandler,
  teachingMcpServerName,
  type ActiveTeachingTurn,
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
  listJournalEntries,
  listLatestMasteryScores,
  openStore,
  readTopicTree,
  upsertTopic,
  type Course,
  type Store,
} from "../store";

const proxyPath = fileURLToPath(new URL("./proxy.ts", import.meta.url));

const expectedToolNames: readonly TeachingToolName[] = [
  "get_course_state",
  "upsert_topic",
  "emit_demo",
  "append_lesson_note",
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
  setActiveTurn: (token: string, turn: ActiveTeachingTurn | null) => void;
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

    const activeTurns = new Map<string, ActiveTeachingTurn | null>();
    const scopes = new Map<string, TeachingSessionScope>([
      [
        "token-a",
        {
          courseId: draftCourse.id,
          getActiveTurn: () => activeTurns.get("token-a") ?? undefined,
        },
      ],
      [
        "token-b",
        {
          courseId: activeCourse.id,
          getActiveTurn: () => activeTurns.get("token-b") ?? undefined,
        },
      ],
    ]);
    const setActiveTurn = (token: string, turn: ActiveTeachingTurn | null) => {
      activeTurns.set(token, turn);
    };
    const writes: TeachingWriteEvent[] = [];

    await run({
      store,
      draftCourse,
      activeCourse,
      scopes,
      setActiveTurn,
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
  expect(currentTopicId).toBeNumber();
  fixture.setActiveTurn("token-a", {
    turn: 26,
    topicId: currentTopicId as number,
    topicPath: "finance/rule-of-72",
  });

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

  const noteResult = parseResult(
    await withTimeout(
      client.callTool("append_lesson_note", {
        markdown: "The Rule of 72 estimates doubling time as 72 / rate.",
      }),
      3_000,
      "append_lesson_note default",
    ),
  );
  expect(noteResult).toMatchObject({
    ok: true,
    entry: {
      topicId: currentTopicId,
      kind: "note",
      bodyMarkdown: "The Rule of 72 estimates doubling time as 72 / rate.",
      turn: 26,
    },
  });

  const tangentTopic = upsertTopic(fixture.store, fixture.draftCourse.id, {
    path: "finance/tangent",
    title: "Finance tangent",
    isCurrent: false,
  });
  const tangentNoteResult = parseResult(
    await withTimeout(
      client.callTool("append_lesson_note", {
        markdown: "This tangent belongs off the main Rule of 72 path.",
        topicPath: tangentTopic.path,
      }),
      3_000,
      "append_lesson_note tangent",
    ),
  );
  expect(tangentNoteResult).toMatchObject({
    ok: true,
    entry: {
      topicId: tangentTopic.id,
      kind: "note",
      turn: 26,
    },
  });

  const demoResult = parseResult(
    await withTimeout(
      client.callTool("emit_demo", {
        title: "Growth table",
        body: "<table><tr><td>6%</td><td>12 years</td></tr></table>",
        format: "html",
        fileName: "growth.html",
      }),
      3_000,
      "emit_demo",
    ),
  );
  expect(demoResult).toMatchObject({
    ok: true,
    demo: {
      title: "Growth table",
      topicId: currentTopicId,
      fileName: "growth.html",
      file: "growth.html",
      format: "html",
    },
  });

  const updatedDemoResult = parseResult(
    await withTimeout(
      client.callTool("emit_demo", {
        title: "Growth table updated",
        body: "<table><tr><td>8%</td><td>9 years</td></tr></table>",
        format: "html",
        fileName: "growth.html",
      }),
      3_000,
      "emit_demo update",
    ),
  );
  expect(updatedDemoResult).toMatchObject({
    ok: true,
    demo: {
      title: "Growth table updated",
      topicId: currentTopicId,
      fileName: "growth.html",
      file: "growth.html",
      format: "html",
    },
  });

  fixture.setActiveTurn("token-a", { turn: 27, topicId: null, topicPath: null });
  const chatOnlyDemoResult = parseResult(
    await withTimeout(
      client.callTool("emit_demo", {
        title: "Chat only",
        body: "no topic",
        format: "text",
        fileName: "chat-only.txt",
      }),
      3_000,
      "emit_demo chat only",
    ),
  );
  expect(chatOnlyDemoResult).toMatchObject({
    ok: true,
    demo: {
      title: "Chat only",
      topicId: null,
    },
  });
  fixture.setActiveTurn("token-a", {
    turn: 26,
    topicId: currentTopicId as number,
    topicPath: "finance/rule-of-72",
  });

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
  const rootTopic = asRecord(rootTopics[0], "root topic");
  expect(rootTopic).toMatchObject({
    path: "finance",
  });
  const childTopics = asArray(rootTopic["children"], "finance children");
  const ruleTopic = asRecord(
    childTopics.find(
      (topic) =>
        asRecord(topic, "candidate child")["path"] === "finance/rule-of-72",
    ),
    "rule topic",
  );
  expect(ruleTopic["path"]).toBe("finance/rule-of-72");
  expect(ruleTopic["state"]).toBe("current");
  expect(asRecord(ruleTopic["mastery"], "rule mastery")["score"]).toBe(82);
  const ruleJournal = asRecord(ruleTopic["journal"], "rule journal");
  expect(ruleJournal["totalCount"]).toBe(2);
  const ruleJournalEntries = asArray(ruleJournal["entries"], "rule journal entries");
  expect(ruleJournalEntries).toHaveLength(2);
  expect(ruleJournalEntries.map((entry) => asRecord(entry, "journal entry")["kind"])).toEqual([
    "note",
    "demo",
  ]);
  expect(asRecord(ruleJournalEntries[0], "note entry")).toMatchObject({
    kind: "note",
    bodyMarkdown: "The Rule of 72 estimates doubling time as 72 / rate.",
    turn: 26,
  });
  expect(asRecord(ruleJournalEntries[1], "demo pin")).toMatchObject({
    kind: "demo",
    turn: 26,
    demo: {
      title: "Growth table updated",
      file: "growth.html",
    },
  });

  const tangentStateTopic = asRecord(
    childTopics.find(
      (topic) => asRecord(topic, "candidate child")["path"] === tangentTopic.path,
    ),
    "tangent topic",
  );
  expect(asRecord(tangentStateTopic["journal"], "tangent journal")).toMatchObject({
    totalCount: 1,
    entries: [
      {
        kind: "note",
        bodyMarkdown: "This tangent belongs off the main Rule of 72 path.",
        turn: 26,
      },
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
    "append_lesson_note",
    "append_lesson_note",
    "emit_demo",
    "emit_demo",
    "emit_demo",
  ]);
  expect(
    fixture.writes.every((event) => event.courseId === fixture.draftCourse.id),
  ).toBe(true);
  const demoId = asRecord(demoResult["demo"], "demo")["id"];
  const noteEntryId = asRecord(noteResult["entry"], "note entry result")["id"];
  expect(demoId).toBeNumber();
  expect(noteEntryId).toBeNumber();
  expect(asRecord(updatedDemoResult["demo"], "updated demo")["id"]).toBe(demoId);
  expect(
    fixture.writes.find((event) => event.tool === "emit_demo")?.attachment,
  ).toEqual({
    kind: "demo",
    file: "growth.html",
    title: "Growth table",
  });
  expect(
    fixture.writes.find((event) => event.tool === "append_lesson_note")
      ?.attachment,
  ).toEqual({
    kind: "journal-note",
    entryId: noteEntryId as number,
    topicId: currentTopicId as number,
    markdown: "The Rule of 72 estimates doubling time as 72 / rate.",
  });

  expect(getCourse(fixture.store, fixture.draftCourse.id)).toMatchObject({
    title: "Draft Finance",
    description: "Draft description",
  });
  const persistedTopics = readTopicTree(fixture.store, fixture.draftCourse.id);
  expect(persistedTopics.map((topic) => topic.path)).toEqual(["finance"]);
  expect(persistedTopics[0]?.children.map((topic) => topic.path)).toEqual([
    "finance/rule-of-72",
    "finance/tangent",
  ]);
  expect(persistedTopics[0]?.children[0]).toMatchObject({
    path: "finance/rule-of-72",
    isCurrent: true,
  });
  expect(persistedTopics[0]?.children[1]).toMatchObject({
    path: "finance/tangent",
    isCurrent: false,
    enteredAt: null,
  });
  expect(listGlossary(fixture.store, fixture.draftCourse.id)).toHaveLength(1);
  expect(listLatestMasteryScores(fixture.store, fixture.draftCourse.id)).toHaveLength(
    1,
  );
  expect(listFeynmanChecks(fixture.store, fixture.draftCourse.id)).toHaveLength(
    1,
  );
  expect(listDemos(fixture.store, fixture.draftCourse.id)).toHaveLength(2);
  const currentJournal = listJournalEntries(
    fixture.store,
    fixture.draftCourse.id,
    currentTopicId as number,
  );
  expect(currentJournal.map((entry) => entry.kind)).toEqual(["note", "demo"]);
  expect(currentJournal[1]?.demoId).toBe(demoId as number);
  expect(currentJournal[1]?.turn).toBe(26);
  expect(
    listJournalEntries(fixture.store, fixture.draftCourse.id, tangentTopic.id).map(
      (entry) => entry.kind,
    ),
  ).toEqual(["note"]);
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

  const rejectedNote = await withTimeout(
    client.callTool("append_lesson_note", {
      markdown: "This has nowhere to go.",
    }),
    3_000,
    "active append_lesson_note without topic",
  );
  expect(rejectedNote.isError).toBe(true);
  expect(parseResult(rejectedNote)["error"]).toContain(
    "needs a topicPath because there is no current topic",
  );

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

  test("defaults writes to the active turn snapshot topic", async () => {
    await withFixture(async (fixture) => {
      const snapshotTopic = upsertTopic(fixture.store, fixture.draftCourse.id, {
        path: "snapshot-topic",
        title: "Snapshot topic",
      });
      const activeTurn = {
        turn: 9,
        topicId: snapshotTopic.id,
        topicPath: snapshotTopic.path,
      };

      upsertTopic(fixture.store, fixture.draftCourse.id, {
        path: "clicked-mid-turn",
        title: "Clicked mid-turn",
      });

      const definition = createTeachingMcpServer({
        store: fixture.store,
        scope: {
          courseId: fixture.draftCourse.id,
          getActiveTurn: () => activeTurn,
        },
        onWrite: (event) => {
          fixture.writes.push(event);
        },
      });
      const tool = definition.tools.find(
        (candidate) => candidate.name === "upsert_glossary_entry",
      );
      if (tool === undefined) {
        throw new Error("Missing upsert_glossary_entry tool.");
      }

      const result = parseResult(
        await tool.call({
          term: "Snapshot default",
          definition: "Resolved at turn start.",
        }),
      );

      expect(result).toMatchObject({
        ok: true,
        glossaryEntry: {
          term: "Snapshot default",
          topicId: snapshotTopic.id,
        },
      });
      expect(fixture.writes).toHaveLength(1);
      expect(fixture.writes.at(0)).toMatchObject({
        tool: "upsert_glossary_entry",
        courseId: fixture.draftCourse.id,
        activeTurn,
      });
    });
  });
});
