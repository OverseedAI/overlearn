import { describe, expect, test } from "bun:test";

import type {
  AgentEvent,
  HarnessAdapter,
  HarnessSessionConfig,
} from "../adapter/types";
import { teachingMcpServerName } from "../mcp/teaching";
import {
  buildCoursePermissionPolicy,
  buildTurnPrompt,
  createDaemonTurnOrchestrator,
  nestedSessionEnvOverride,
  parseHarnessCommand,
  resolveHarnessAdapter,
  resolveTurnTimeoutMs,
  type AgentStreamPayload,
  type TurnPayload,
} from "./orchestrator";

const turn: TurnPayload = {
  turn: 7,
  createdAt: "2026-01-01T00:00:00.000Z",
  events: [{ type: "message", text: "What is amortization?" }],
};

const promptInput = {
  courseId: 42,
  courseTitle: "Finance",
  turn,
  instructions: "## module: protocol (builtin)\n\nEach teaching turn...",
  includeResumeContext: true,
} as const;

const collect = async <T>(values: AsyncIterable<T>): Promise<readonly T[]> => {
  const collected: T[] = [];

  for await (const value of values) {
    collected.push(value);
  }

  return collected;
};

describe("daemon turn orchestration helpers", () => {
  test("assembles a MCP-only teaching prompt from protocol text and turn payload", () => {
    const prompt = buildTurnPrompt({
      ...promptInput,
      mode: "teaching",
    });

    expect(prompt).toContain("## Teaching protocol");
    expect(prompt).toContain("## module: protocol (builtin)");
    expect(prompt).toContain("## Resume context required");
    expect(prompt).toContain("get_course_state");
    expect(prompt).toContain("Do not write course files directly");
    expect(prompt).toContain("no sidecar callback commands are available");
    expect(prompt).toContain("## Turn payload");
    expect(prompt).toContain('"turn": 7');
    expect(prompt).toContain('"type": "message"');
    expect(prompt).toContain('"text": "What is amortization?"');
  });

  test("adds final wrap-up directions for session-done turns", () => {
    const prompt = buildTurnPrompt({
      ...promptInput,
      includeResumeContext: false,
      mode: "wrap-up",
      turn: {
        turn: 8,
        createdAt: "2026-01-01T00:00:00.000Z",
        events: [{ type: "session-done" }],
      },
    });

    expect(prompt).toContain("## Final wrap-up turn");
    expect(prompt).toContain("record final mastery with MCP tools");
    expect(prompt).toContain("The daemon will end the harness session and stop");
    expect(prompt).toContain('"type": "session-done"');
  });

  test("adds continuity greeting directions for harness swap turns", () => {
    const prompt = buildTurnPrompt({
      ...promptInput,
      mode: "greeting",
      turn: {
        turn: 8,
        createdAt: "2026-01-01T00:00:00.000Z",
        events: [
          { type: "harness-swapped", from: "claude-code", to: "codex" },
        ],
      },
    });

    expect(prompt).toContain("## Harness swap greeting turn");
    expect(prompt).toContain("get_course_state");
    expect(prompt).toContain("one short continuity greeting");
    expect(prompt).toContain('"type": "harness-swapped"');
    expect(prompt).toContain("## Resume context required");
  });

  test("adds ideation directions with propose_course_plan", () => {
    const prompt = buildTurnPrompt({
      ...promptInput,
      includeResumeContext: false,
      mode: "ideation",
      turn: {
        turn: 1,
        createdAt: "2026-01-01T00:00:00.000Z",
        events: [{ type: "ideation", text: "Teach me investing." }],
      },
    });

    expect(prompt).toContain("## Course ideation turn");
    expect(prompt).toContain("propose_course_plan");
    expect(prompt).toContain("Teach me investing.");
  });

  test("builds a read-only attached-dir permission policy", () => {
    const policy = buildCoursePermissionPolicy("/repos/example");

    expect(policy.defaultDecision).toBe("deny");
    expect(policy.allow).toEqual(expect.arrayContaining([
      {
        action: "mcp",
        resource: `${teachingMcpServerName}.get_course_state`,
        reason:
          "Overlearn teaching MCP tools are pre-approved for this learning session.",
      },
      {
        action: "read",
        resource: "/repos/example/**",
        reason:
          "Attached directory reads are pre-approved for this learning session.",
      },
      {
        action: "search",
        resource: "/repos/example/**",
        reason:
          "Attached directory reads are pre-approved for this learning session.",
      },
    ]));
    expect(policy.allow).toHaveLength(9);
  });

  test("default permission policy only allows Overlearn MCP without an attached dir", () => {
    const policy = buildCoursePermissionPolicy(null);

    expect(policy).toEqual({
      allow: expect.arrayContaining([
        {
          action: "mcp",
          resource: `${teachingMcpServerName}.get_course_state`,
          reason:
            "Overlearn teaching MCP tools are pre-approved for this learning session.",
        },
        {
          action: "mcp",
          resource: `${teachingMcpServerName}.propose_course_plan`,
          reason:
            "Overlearn teaching MCP tools are pre-approved for this learning session.",
        },
      ]),
      defaultDecision: "deny",
      defaultReason: "Permission was not pre-approved by the course daemon.",
    });
    expect(policy.allow).toHaveLength(7);
  });

  test("parses harness command override strings and JSON arrays", () => {
    expect(parseHarnessCommand('bun "fake agent.ts" normal')).toEqual([
      "bun",
      "fake agent.ts",
      "normal",
    ]);
    expect(parseHarnessCommand('["bun","fake-acp-agent.ts","never"]')).toEqual([
      "bun",
      "fake-acp-agent.ts",
      "never",
    ]);
  });

  test("unsets nested-session guard env vars with undefined values", () => {
    const env: Readonly<Record<string, string | undefined>> =
      nestedSessionEnvOverride();

    expect(Object.hasOwn(env, "CLAUDECODE")).toBe(true);
    expect(env["CLAUDECODE"]).toBeUndefined();
  });

  test("uses a generous default turn timeout and accepts env override", () => {
    expect(resolveTurnTimeoutMs({})).toBe(600_000);
    expect(resolveTurnTimeoutMs({ OVERLEARN_TURN_TIMEOUT_MS: "25" })).toBe(25);
  });

  test("prefers course harness selection over env selection", () => {
    expect(
      resolveHarnessAdapter({ OVERLEARN_HARNESS: "gemini" }, "codex").id,
    ).toBe("codex");
    expect(resolveHarnessAdapter({ OVERLEARN_HARNESS: "gemini" }).id).toBe(
      "gemini",
    );
    expect(resolveHarnessAdapter({}).id).toBe("claude-code");
    expect(() => resolveHarnessAdapter({}, "missing")).toThrow(
      "Unknown harness adapter: missing",
    );
  });
});

describe("daemon turn orchestrator", () => {
  test("injects HTTP MCP config, records session lifecycle, streams events, and retries once after a crash", async () => {
    const configs: HarnessSessionConfig[] = [];
    const endedSessions: string[] = [];
    const registered: string[] = [];
    const unregistered: string[] = [];
    const streamed: AgentStreamPayload[] = [];
    let promptCount = 0;

    const adapter: HarnessAdapter = {
      id: "codex",
      name: "Codex",
      detect: () => ({ installed: true, authenticated: true }),
      newSession: async (_cwd, config) => {
        configs.push(config ?? {});
        return {
          id: `session-${configs.length}`,
          adapterId: "codex",
          cwd: "/tmp",
          processId: configs.length,
        };
      },
      prompt: async function* (): AsyncIterable<AgentEvent> {
        promptCount += 1;

        if (promptCount === 1) {
          yield { type: "thinking", text: "about to fail" };
          yield { type: "error", message: "crashed" };
          return;
        }

        yield { type: "text", text: "Recovered explanation." };
        yield { type: "done", reason: "complete" };
      },
      cancel: async () => undefined,
      end: async (session) => {
        endedSessions.push(session.id);
      },
    };

    const orchestrator = createDaemonTurnOrchestrator({
      courseId: 42,
      courseTitle: "Finance",
      attachedDir: "/repos/example",
      cwd: "/tmp",
      mcpBaseUrl: "http://127.0.0.1:1234",
      adapter,
      onAgentEvent: (payload) => streamed.push(payload),
      registerTeachingSession: ({ courseId, harnessId }) => {
        const token = `token-${registered.length + 1}`;
        registered.push(`${courseId}:${harnessId}:${token}`);
        return { token, sessionId: registered.length };
      },
      unregisterTeachingSession: (registration, reason) => {
        unregistered.push(`${registration.token}:${reason}`);
      },
    });

    const result = await orchestrator.runTurn(turn, "teaching");

    expect(result).toEqual({ ok: true });
    expect(promptCount).toBe(2);
    expect(configs).toHaveLength(2);
    expect(configs[0]?.mcpServers).toEqual([
      {
        name: teachingMcpServerName,
        url: "http://127.0.0.1:1234/mcp/token-1",
      },
    ]);
    expect(configs[0]?.permissionPolicy).toEqual(
      buildCoursePermissionPolicy("/repos/example"),
    );
    expect(configs[1]?.mcpServers).toEqual([
      {
        name: teachingMcpServerName,
        url: "http://127.0.0.1:1234/mcp/token-2",
      },
    ]);
    expect(registered).toEqual(["42:codex:token-1", "42:codex:token-2"]);
    expect(unregistered).toContain("token-1:agent-crashed");
    expect(endedSessions).toEqual(["session-1"]);
    expect(streamed.map((payload) => payload.event.type)).toEqual([
      "thinking",
      "error",
      "text",
      "done",
    ]);

    await orchestrator.endSession("test-end");
    expect(unregistered).toContain("token-2:test-end");
    expect(endedSessions).toEqual(["session-1", "session-2"]);
  });

  test("can collect events from an async adapter stream", async () => {
    async function* events(): AsyncIterable<AgentEvent> {
      yield { type: "text", text: "one" };
      yield { type: "done", reason: "complete" };
    }

    await expect(collect(events())).resolves.toEqual([
      { type: "text", text: "one" },
      { type: "done", reason: "complete" },
    ]);
  });
});
