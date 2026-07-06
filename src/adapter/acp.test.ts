import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import {
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
  | "never"
  | "crash-always"
  | "malformed";
type LiveSession = Readonly<{
  adapter: HarnessAdapter;
  session: SessionRef;
}>;

const fixturePath = fileURLToPath(
  new URL("../../test/fixtures/fake-acp-agent.ts", import.meta.url),
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
): Promise<LiveSession> => {
  const cwd = await createTempDir();
  tempDirs.push(cwd);

  const adapter = createAcpHarnessAdapter(fakeDefinition(scenario), {
    requestTimeoutMs: 1_000,
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
    1_500,
    label,
  );

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
