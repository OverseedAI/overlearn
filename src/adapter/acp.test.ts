import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  startMcpHttpServer,
  textMcpResult,
  type McpJsonObject,
  type McpServerDefinition,
} from "../mcp/protocol";
import {
  buildAcpPromptBlocks,
  createAcpHarnessAdapter,
  type AcpAdapterDefinition,
} from "./acp";
import { evaluatePermissionRequest } from "./permissions";
import type {
  AgentEvent,
  HarnessAdapter,
  HarnessSessionConfig,
  SessionRef,
} from "./types";

type FakeScenario =
  | "normal"
  | "permission"
  | "mcp-permission"
  | "claude-mcp-permission"
  | "never"
  | "slow-initialize"
  | "crash-always"
  | "malformed";
type FakeEnv = Readonly<Record<string, string | undefined>>;
type LiveSession = Readonly<{
  adapter: HarnessAdapter;
  session: SessionRef;
}>;

const fixturePath = fileURLToPath(
  new URL("../../test/fixtures/fake-acp-agent.ts", import.meta.url),
);
const mcpFixturePath = fileURLToPath(
  new URL("../../test/fixtures/fake-mcp-server.ts", import.meta.url),
);
const liveSessions: LiveSession[] = [];
const tempDirs: string[] = [];

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

const fakeDefinition = (scenario: FakeScenario): AcpAdapterDefinition => ({
  id: `fake-${scenario}`,
  name: `Fake ACP ${scenario}`,
  command: process.execPath,
  args: [fixturePath, scenario],
});

const createTempDir = (): Promise<string> =>
  withTimeout(
    mkdtemp(join(tmpdir(), "overlearn-acp-")),
    1_000,
    "create temp dir",
  );

const createFakeSession = async (
  scenario: FakeScenario,
  config: HarnessSessionConfig = {},
  env: FakeEnv = {},
): Promise<LiveSession> => {
  const cwd = await createTempDir();
  tempDirs.push(cwd);

  const adapter = createAcpHarnessAdapter(fakeDefinition(scenario), {
    requestTimeoutMs: 1_000,
    env,
  });
  const session = await withTimeout(
    adapter.newSession(cwd, config),
    1_500,
    `${scenario} session`,
  );

  const liveSession = { adapter, session };
  liveSessions.push(liveSession);
  return liveSession;
};

const collectEvents = async (
  events: AsyncIterable<AgentEvent>,
  label: string,
): Promise<readonly AgentEvent[]> =>
  withTimeout(
    (async () => {
      const collected: AgentEvent[] = [];

      for await (const event of events) {
        collected.push(event);

        if (event.type === "done" || event.type === "error") {
          break;
        }
      }

      return collected;
    })(),
    2_500,
    label,
  );

const readJsonLog = async (
  path: string,
): Promise<readonly Record<string, unknown>[]> => {
  const content = await readFile(path, "utf8");

  return content
    .split("\n")
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line) as Record<string, unknown>);
};

const isPidAlive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

afterEach(async () => {
  const sessions = liveSessions.splice(0);
  await Promise.all(
    sessions.map(({ adapter, session }) =>
      withTimeout(adapter.end(session), 1_500, `end ${session.id}`),
    ),
  );

  const dirs = tempDirs.splice(0);
  await Promise.all(
    dirs.map((dir) =>
      withTimeout(
        rm(dir, { force: true, recursive: true }),
        1_500,
        `remove ${dir}`,
      ),
    ),
  );
});

describe("ACP harness adapter detection", () => {
  test("reports a missing binary without attempting auth", () => {
    const adapter = createAcpHarnessAdapter(
      {
        id: "missing",
        name: "Missing",
        command: "overlearn-definitely-missing-acp-binary",
        args: [],
        auth: {
          env: ["OVERLEARN_FAKE_AUTH"],
        },
      },
      {
        env: {
          PATH: "/tmp/overlearn-empty-path",
          OVERLEARN_FAKE_AUTH: "present",
        },
      },
    );

    expect(adapter.detect()).toEqual({
      installed: false,
      authenticated: false,
    });
  });
});

describe("ACP harness adapter sessions", () => {
  test("builds ACP blocks for images, text files, and binary files", () => {
    const imageData = Buffer.from("image bytes").toString("base64");
    const textData = Buffer.from("plain text contents").toString("base64");
    const binaryData = Buffer.from([0, 1, 2, 255]).toString("base64");

    expect(
      buildAcpPromptBlocks("Explain these attachments.", [
        {
          kind: "image",
          name: "chart.png",
          mimeType: "image/png",
          data: imageData,
        },
        {
          kind: "file",
          name: "notes.txt",
          mimeType: "text/plain",
          data: textData,
        },
        {
          kind: "file",
          name: "report.pdf",
          mimeType: "application/pdf",
          data: binaryData,
        },
      ]),
    ).toEqual([
      { type: "text", text: "Explain these attachments." },
      { type: "image", mimeType: "image/png", data: imageData },
      {
        type: "resource",
        resource: {
          uri: "attachment:///notes.txt",
          name: "notes.txt",
          mimeType: "text/plain",
          text: "plain text contents",
        },
      },
      {
        type: "resource",
        resource: {
          uri: "attachment:///report.pdf",
          name: "report.pdf",
          mimeType: "application/pdf",
          blob: binaryData,
        },
      },
    ]);
  });

  test("passes configured MCP servers through session/new", async () => {
    const logDir = await createTempDir();
    tempDirs.push(logDir);
    const logPath = join(logDir, "fake-acp.jsonl");
    const mcpServers = [
      {
        name: "teaching-http",
        url: "http://127.0.0.1:9999/mcp",
        headers: {
          Authorization: "Bearer test",
        },
      },
      {
        name: "teaching-stdio",
        command: process.execPath,
        args: [mcpFixturePath],
        env: {
          OVERLEARN_TEST_MCP: "1",
        },
      },
    ] satisfies NonNullable<HarnessSessionConfig["mcpServers"]>;
    const expectedWireMcpServers = [
      {
        type: "http",
        name: "teaching-http",
        url: "http://127.0.0.1:9999/mcp",
        headers: [
          {
            name: "Authorization",
            value: "Bearer test",
          },
        ],
      },
      {
        name: "teaching-stdio",
        command: process.execPath,
        args: [mcpFixturePath],
        env: [
          {
            name: "OVERLEARN_TEST_MCP",
            value: "1",
          },
        ],
      },
    ];

    await createFakeSession(
      "normal",
      {
        mcpServers,
      },
      {
        FAKE_ACP_LOG: logPath,
      },
    );

    const entries = await readJsonLog(logPath);
    const sessionNew = entries.find((entry) => entry["event"] === "session/new");
    const params = sessionNew?.["params"];

    expect(sessionNew?.["mcpServers"]).toEqual(expectedWireMcpServers);
    expect(
      typeof params === "object" && params !== null && "mcpServers" in params
        ? params.mcpServers
        : undefined,
    ).toEqual(expectedWireMcpServers);
  });

  test("streams a full turn with stable event ordering and mappings", async () => {
    const { adapter, session } = await createFakeSession("normal");
    const events = await collectEvents(
      adapter.prompt(session, "teach the rule of 72"),
      "normal events",
    );

    expect(events.map((event) => event.type)).toEqual([
      "thinking",
      "text",
      "tool-call",
      "tool-call",
      "tool-call",
      "done",
    ]);
    expect(events[0]).toEqual({
      type: "thinking",
      text: "considering the lesson",
    });
    expect(events[1]).toEqual({
      type: "text",
      text: "Here is the first explanation.",
    });
    expect(events[2]).toEqual({
      type: "tool-call",
      id: "tool-1",
      name: "write_file",
      status: "started",
      input: { path: "demo.ts" },
    });
    expect(events[3]).toEqual({
      type: "tool-call",
      id: "tool-1",
      status: "delta",
      text: "writing demo.ts",
    });
    expect(events[4]).toEqual({
      type: "tool-call",
      id: "tool-1",
      status: "completed",
      result: { ok: true },
    });
    expect(events[5]).toEqual({
      type: "done",
      reason: "complete",
    });
  });

  test("allows slow real-world ACP startup with the default request timeout", async () => {
    const cwd = await createTempDir();
    tempDirs.push(cwd);

    const adapter = createAcpHarnessAdapter(fakeDefinition("slow-initialize"));
    const session = await withTimeout(
      adapter.newSession(cwd),
      5_000,
      "slow initialize session",
    );

    liveSessions.push({ adapter, session });
    expect(session.id).toBe("fake-session");
  });

  test("fake agent calls a configured HTTP MCP tool", async () => {
    const calls: McpJsonObject[] = [];
    const definition: McpServerDefinition = {
      name: "teaching",
      version: "0.0.0",
      tools: [
        {
          name: "upsert_topic",
          description: "Records a topic.",
          inputSchema: {
            type: "object",
            additionalProperties: true,
          },
          call: (args) => {
            calls.push(args);
            return textMcpResult(`http:${args["slug"] ?? "unknown"}`);
          },
        },
      ],
    };
    const mcpServer = startMcpHttpServer(definition);

    try {
      const { adapter, session } = await createFakeSession(
        "normal",
        {
          mcpServers: [
            {
              name: "teaching",
              url: mcpServer.url,
            },
          ],
        },
        {
          FAKE_ACP_MCP_CALL: JSON.stringify({
            server: "teaching",
            tool: "upsert_topic",
            args: {
              slug: "http-topic",
            },
          }),
        },
      );
      const events = await collectEvents(
        adapter.prompt(session, "call the teaching tool"),
        "http mcp events",
      );

      expect(events).toEqual([
        {
          type: "tool-call",
          id: "mcp-upsert_topic",
          name: "upsert_topic",
          status: "started",
          input: {
            slug: "http-topic",
          },
        },
        {
          type: "tool-call",
          id: "mcp-upsert_topic",
          status: "completed",
          result: {
            content: [
              {
                type: "text",
                text: "http:http-topic",
              },
            ],
          },
        },
        {
          type: "done",
          reason: "complete",
        },
      ]);
      expect(calls).toEqual([{ slug: "http-topic" }]);
    } finally {
      mcpServer.stop();
    }
  });

  test("fake agent calls a configured stdio MCP tool", async () => {
    const { adapter, session } = await createFakeSession(
      "normal",
      {
        mcpServers: [
          {
            name: "teaching",
            command: process.execPath,
            args: [mcpFixturePath],
            env: {},
          },
        ],
      },
      {
        FAKE_ACP_MCP_CALL: JSON.stringify({
          server: "teaching",
          tool: "upsert_topic",
          args: {
            slug: "stdio-topic",
          },
        }),
      },
    );
    const events = await collectEvents(
      adapter.prompt(session, "call the stdio teaching tool"),
      "stdio mcp events",
    );

    expect(events).toEqual([
      {
        type: "tool-call",
        id: "mcp-upsert_topic",
        name: "upsert_topic",
        status: "started",
        input: {
          slug: "stdio-topic",
        },
      },
      {
        type: "tool-call",
        id: "mcp-upsert_topic",
        status: "completed",
        result: {
          content: [
            {
              type: "text",
              text: 'upsert_topic:{"slug":"stdio-topic"}',
            },
          ],
        },
      },
      {
        type: "done",
        reason: "complete",
      },
    ]);
  });

  test("answers permission requests from the session policy and surfaces them", async () => {
    const { adapter, session } = await createFakeSession("permission", {
      permissionPolicy: {
        allow: [
          {
            action: "edit",
            resource: "lesson.md",
            reason: "Lesson markdown writes are pre-approved.",
          },
        ],
      },
    });
    const events = await collectEvents(
      adapter.prompt(session, "write the lesson"),
      "permission events",
    );

    expect(events.map((event) => event.type)).toEqual([
      "tool-call",
      "permission-request",
      "text",
      "done",
    ]);
    expect(events[0]).toEqual({
      type: "tool-call",
      id: "tool-1",
      name: "Write the generated lesson.",
      status: "started",
    });
    expect(events[1]).toEqual({
      type: "permission-request",
      request: expect.objectContaining({
        id: "1",
        action: "edit",
        resource: "lesson.md",
        description: "Write the generated lesson.",
      }),
      decision: {
        allowed: true,
        reason: "Lesson markdown writes are pre-approved.",
      },
    });
    expect(events[2]).toEqual({
      type: "text",
      text: "permission granted by fake",
    });
  });

  test("answers correlated MCP tool approvals from the session policy", async () => {
    const { adapter, session } = await createFakeSession("mcp-permission", {
      permissionPolicy: {
        allow: [
          {
            action: "mcp",
            resource: "overlearn-teaching.get_course_state",
            reason: "Overlearn teaching MCP reads are pre-approved.",
          },
        ],
      },
    });
    const events = await collectEvents(
      adapter.prompt(session, "read course state"),
      "mcp permission events",
    );

    expect(events).toEqual([
      {
        type: "tool-call",
        id: "mcp-call-1",
        name: "mcp.overlearn-teaching.get_course_state",
        status: "started",
        input: {
          server: "overlearn-teaching",
          tool: "get_course_state",
          arguments: {
            transcriptLimit: 10,
          },
        },
      },
      {
        type: "permission-request",
        request: {
          id: "1",
          action: "mcp",
          resource: "overlearn-teaching.get_course_state",
          metadata: {
            toolCallId: "mcp-call-1",
            kind: "execute",
            status: "pending",
          },
        },
        decision: {
          allowed: true,
          reason: "Overlearn teaching MCP reads are pre-approved.",
        },
      },
      {
        type: "text",
        text: "mcp permission granted by fake",
      },
      {
        type: "done",
        reason: "complete",
      },
    ]);
  });

  test("approves MCP tools named mcp__server__tool without an approval flag", async () => {
    const { adapter, session } = await createFakeSession(
      "claude-mcp-permission",
      {
        permissionPolicy: {
          allow: [
            {
              action: "mcp",
              resource: "overlearn-teaching.get_course_state",
              reason: "Overlearn teaching MCP reads are pre-approved.",
            },
          ],
        },
      },
    );
    const events = await collectEvents(
      adapter.prompt(session, "read course state"),
      "claude mcp permission events",
    );

    expect(events.map((event) => event.type)).toEqual([
      "tool-call",
      "permission-request",
      "text",
      "done",
    ]);
    expect(events[1]).toEqual({
      type: "permission-request",
      request: expect.objectContaining({
        action: "mcp",
        resource: "overlearn-teaching.get_course_state",
      }),
      decision: {
        allowed: true,
        reason: "Overlearn teaching MCP reads are pre-approved.",
      },
    });
    expect(events[2]).toEqual({
      type: "text",
      text: "claude mcp permission granted by fake",
    });
  });

  test("denies permissions by default when no allowlist rule matches", () => {
    expect(
      evaluatePermissionRequest({
        id: "permission-1",
        action: "write",
        resource: "lesson.md",
      }),
    ).toEqual({
      allowed: false,
      reason: "Permission was not pre-approved by the session policy.",
    });
  });

  test("matches directory resource allow rules with /** prefix semantics", () => {
    const policy = {
      allow: [
        {
          action: "write",
          resource: "/course/dir/**",
          reason: "Course writes are pre-approved.",
        },
      ],
      defaultDecision: "deny" as const,
    };

    expect(
      evaluatePermissionRequest(
        {
          id: "permission-1",
          action: "write",
          resource: "/course/dir/lessons/01-foo.md",
        },
        policy,
      ),
    ).toEqual({
      allowed: true,
      reason: "Course writes are pre-approved.",
    });
    expect(
      evaluatePermissionRequest(
        {
          id: "permission-2",
          action: "write",
          resource: "/course/dir",
        },
        policy,
      ),
    ).toEqual({
      allowed: true,
      reason: "Course writes are pre-approved.",
    });
    expect(
      evaluatePermissionRequest(
        {
          id: "permission-3",
          action: "write",
          resource: "/course/dirX/lessons/01-foo.md",
        },
        policy,
      ),
    ).toEqual({
      allowed: false,
      reason: "Permission was not pre-approved by the session policy.",
    });
  });

  test("cancel resolves an active stream with a terminal event", async () => {
    const { adapter, session } = await createFakeSession("never");
    const iterator = adapter.prompt(session, "wait forever")[Symbol.asyncIterator]();
    const first = await withTimeout(iterator.next(), 1_000, "first never event");

    expect(first).toEqual({
      done: false,
      value: {
        type: "thinking",
        text: "waiting forever",
      },
    });

    const cancel = adapter.cancel(session);
    const terminal = await withTimeout(
      iterator.next(),
      1_000,
      "cancel terminal event",
    );
    await withTimeout(cancel, 1_000, "cancel request");

    expect(terminal).toEqual({
      done: false,
      value: {
        type: "done",
        reason: "cancelled",
      },
    });
  });

  test("subprocess crashes become terminal error events", async () => {
    const { adapter, session } = await createFakeSession("crash-always");
    const events = await collectEvents(
      adapter.prompt(session, "crash"),
      "crash events",
    );

    expect(events[0]).toEqual({
      type: "thinking",
      text: "about to crash",
    });
    expect(events.at(-1)).toEqual({
      type: "error",
      message: "ACP subprocess exited with code 42.",
    });
  });

  test("malformed JSON becomes a terminal error event", async () => {
    const { adapter, session } = await createFakeSession("malformed");
    const events = await collectEvents(
      adapter.prompt(session, "malform"),
      "malformed events",
    );

    expect(events).toEqual([
      {
        type: "error",
        message: "Malformed JSON-RPC message: {malformed-json",
      },
    ]);
  });

  test("end reaps the ACP subprocess", async () => {
    const { adapter, session } = await createFakeSession("never");

    expect(isPidAlive(session.processId)).toBe(true);

    await withTimeout(adapter.end(session), 1_500, "end session");

    expect(isPidAlive(session.processId)).toBe(false);
  });
});
