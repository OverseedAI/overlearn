import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { readDaemonMetadata, type TurnFile } from "../course";
import {
  buildCoursePermissionPolicy,
  buildTurnPrompt,
  nestedSessionEnvOverride,
  parseHarnessCommand,
  resolveTurnTimeoutMs,
} from "./orchestrator";

type ProcessResult = Readonly<{
  exitCode: number;
  stdout: string;
  stderr: string;
}>;

type SseEvent = Readonly<{
  event: string;
  data: unknown;
}>;

type ByteReader = Readonly<{
  read: () => Promise<Readonly<{ done: boolean; value?: unknown }>>;
}>;

type LogEntry = Record<string, unknown>;
type DaemonEnvContext = Readonly<{
  coursesDir: string;
  courseName: string;
  courseDir: string;
  logPath: string;
}>;
type DaemonExtraEnv =
  | Record<string, string>
  | ((context: DaemonEnvContext) => Record<string, string>);

const turn: TurnFile = {
  turn: 7,
  createdAt: "2026-01-01T00:00:00.000Z",
  events: [{ type: "message", text: "What is amortization?" }],
};

const cliPath = fileURLToPath(new URL("../cli/index.ts", import.meta.url));
const fixturePath = fileURLToPath(
  new URL("../../test/fixtures/fake-acp-agent.ts", import.meta.url),
);
const liveDaemonPids = new Set<number>();

const sleep = async (milliseconds: number): Promise<void> => {
  await new Promise((resolve) => setTimeout(resolve, milliseconds));
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

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

const streamText = async (
  stream: ReadableStream<Uint8Array> | null,
): Promise<string> => (stream === null ? "" : await new Response(stream).text());

const runLearn = async (
  args: readonly string[],
  env: Record<string, string>,
): Promise<ProcessResult> => {
  const child = Bun.spawn([process.execPath, cliPath, ...args], {
    env,
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  const exitCode = await withTimeout(child.exited, 5_000, args.join(" "));
  const [stdout, stderr] = await Promise.all([
    streamText(child.stdout),
    streamText(child.stderr),
  ]);

  return { exitCode, stdout, stderr };
};

const isPidAlive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

const killDaemon = async (pid: number): Promise<void> => {
  if (!isPidAlive(pid)) {
    liveDaemonPids.delete(pid);
    return;
  }

  process.kill(pid, "SIGTERM");

  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (!isPidAlive(pid)) {
      liveDaemonPids.delete(pid);
      return;
    }

    await sleep(25);
  }

  process.kill(pid, "SIGKILL");
  liveDaemonPids.delete(pid);
};

const waitForDaemonStopped = async (
  courseDir: string,
  pid: number,
): Promise<void> => {
  await withTimeout(
    (async () => {
      while (
        isPidAlive(pid) ||
        (await readDaemonMetadata(courseDir)) !== undefined
      ) {
        await sleep(25);
      }
      liveDaemonPids.delete(pid);
    })(),
    5_000,
    "daemon shutdown",
  );
};

const canBindLocalhost = async (): Promise<boolean> => {
  const server = createServer((_request, response) => {
    response.end("ok");
  });

  try {
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", () => resolve());
    });
  } catch {
    return false;
  } finally {
    if (server.listening) {
      await new Promise<void>((resolve) => {
        server.close(() => resolve());
      });
    }
  }

  return true;
};

const testEnv = (
  coursesDir: string,
  logPath: string,
  scenario: string,
  extra: Record<string, string> = {},
): Record<string, string> => {
  const env: Record<string, string> = {};

  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined) {
      env[key] = value;
    }
  }

  env["OVERLEARN_COURSES_DIR"] = coursesDir;
  env["OVERLEARN_NO_BROWSER"] = "1";
  env["OVERLEARN_ORCHESTRATED"] = "1";
  env["OVERLEARN_HARNESS_CMD"] = JSON.stringify([
    process.execPath,
    fixturePath,
    scenario,
  ]);
  env["FAKE_ACP_LOG"] = logPath;
  env["CLAUDECODE"] = "nested-agent";
  env["NO_COLOR"] = "1";
  delete env["FORCE_COLOR"];

  return { ...env, ...extra };
};

const startOrchestratedDaemon = async (
  scenario: string,
  extraEnv: DaemonExtraEnv = {},
): Promise<
  Readonly<{
    coursesDir: string;
    courseName: string;
    courseDir: string;
    env: Record<string, string>;
    logPath: string;
    url: string;
    pid: number;
  }>
> => {
  const coursesDir = await mkdtemp(join(tmpdir(), "overlearn-orch-"));
  const logPath = join(coursesDir, "fake-acp.jsonl");
  const courseName = `course-${scenario}-${Date.now()}`;
  const courseDir = join(coursesDir, courseName);
  const resolvedExtraEnv =
    typeof extraEnv === "function"
      ? extraEnv({ coursesDir, courseName, courseDir, logPath })
      : extraEnv;
  const env = testEnv(coursesDir, logPath, scenario, resolvedExtraEnv);
  const start = await runLearn(["start", courseName], env);

  expect(start.exitCode).toBe(0);
  expect(start.stderr).toBe("");
  expect(start.stdout.trim()).toMatch(/^http:\/\/localhost:\d+$/);

  const metadata = await readDaemonMetadata(courseDir);
  expect(metadata).not.toBeUndefined();
  if (metadata === undefined) {
    throw new Error("Daemon metadata was not written.");
  }
  liveDaemonPids.add(metadata.pid);

  return {
    coursesDir,
    courseName,
    courseDir,
    env,
    logPath,
    url: start.stdout.trim(),
    pid: metadata.pid,
  };
};

const submitMessage = async (url: string, text: string): Promise<void> => {
  const response = await fetch(`${url}/api/submit`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ text }),
  });

  expect(response.status).toBe(200);
};

const submitDone = async (url: string): Promise<void> => {
  const response = await fetch(`${url}/api/done`, { method: "POST" });

  expect(response.status).toBe(200);
};

const readLogEntries = async (logPath: string): Promise<readonly LogEntry[]> => {
  if (!(await Bun.file(logPath).exists())) {
    return [];
  }

  const contents = await readFile(logPath, "utf8");
  return contents
    .trim()
    .split("\n")
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line) as LogEntry);
};

const waitForLogEntries = async (
  logPath: string,
  predicate: (entries: readonly LogEntry[]) => boolean,
  label: string,
): Promise<readonly LogEntry[]> =>
  withTimeout(
    (async () => {
      while (true) {
        const entries = await readLogEntries(logPath);
        if (predicate(entries)) {
          return entries;
        }

        await sleep(25);
      }
    })(),
    5_000,
    label,
  );

const promptText = (entry: LogEntry): string => {
  const prompt = entry["prompt"];
  if (!Array.isArray(prompt)) {
    return "";
  }

  const [first] = prompt;
  if (!isRecord(first) || typeof first["text"] !== "string") {
    return "";
  }

  return first["text"];
};

const parseSseBlock = (block: string): SseEvent | undefined => {
  let event = "message";
  let data = "";

  for (const line of block.split("\n")) {
    if (line.startsWith("event: ")) {
      event = line.slice("event: ".length);
    }

    if (line.startsWith("data: ")) {
      data += line.slice("data: ".length);
    }
  }

  if (data.length === 0) {
    return undefined;
  }

  return {
    event,
    data: JSON.parse(data) as unknown,
  };
};

const createSseClient = async (
  url: string,
): Promise<
  Readonly<{
    waitFor: (
      eventName: string,
      predicate: (data: unknown) => boolean,
      label: string,
      milliseconds?: number,
    ) => Promise<SseEvent>;
    events: () => readonly SseEvent[];
    close: () => void;
  }>
> => {
  const abort = new AbortController();
  const response = await fetch(`${url}/api/events`, { signal: abort.signal });
  const reader = response.body?.getReader();
  if (reader === undefined) {
    throw new Error("SSE stream did not open.");
  }

  const decoder = new TextDecoder();
  const queue: SseEvent[] = [];
  const history: SseEvent[] = [];
  let buffer = "";

  const readNext = async (byteReader: ByteReader): Promise<void> => {
    const chunk = await byteReader.read();
    if (chunk.done) {
      throw new Error("SSE stream closed.");
    }

    if (!(chunk.value instanceof Uint8Array)) {
      throw new Error("SSE stream returned a non-byte chunk.");
    }

    buffer += decoder.decode(chunk.value, { stream: true });
    while (true) {
      const boundary = buffer.indexOf("\n\n");
      if (boundary === -1) {
        return;
      }

      const block = buffer.slice(0, boundary);
      buffer = buffer.slice(boundary + 2);
      const parsed = parseSseBlock(block);
      if (parsed !== undefined) {
        history.push(parsed);
        queue.push(parsed);
      }
    }
  };

  return {
    waitFor: async (eventName, predicate, label, milliseconds = 5_000) =>
      withTimeout(
        (async () => {
          while (true) {
            const matchIndex = queue.findIndex(
              (event) => event.event === eventName && predicate(event.data),
            );
            if (matchIndex !== -1) {
              const [event] = queue.splice(matchIndex, 1);
              if (event === undefined) {
                throw new Error("SSE event disappeared.");
              }

              return event;
            }

            await readNext(reader);
          }
        })(),
        milliseconds,
        label,
      ),
    events: () => [...history],
    close: () => abort.abort(),
  };
};

afterEach(async () => {
  await Promise.all([...liveDaemonPids].map((pid) => killDaemon(pid)));
});

describe("daemon turn orchestration helpers", () => {
  test("assembles a full turn prompt from protocol text and turn payload", () => {
    const prompt = buildTurnPrompt({
      courseName: "finance",
      courseDir: "/courses/finance",
      turnPath: "/courses/finance/.overlearn/turns/turn-7.json",
      turn,
      instructions: "## module: protocol (builtin)\n\nEach teaching turn...",
      includeResumeContext: true,
      mode: "teaching",
    });

    expect(prompt).toContain("## Teaching protocol");
    expect(prompt).toContain("## module: protocol (builtin)");
    expect(prompt).toContain("## Resume context required");
    expect(prompt).toContain("rebuild context only from on-disk course state");
    expect(prompt).toContain("## Turn payload");
    expect(prompt).toContain('"turn": 7');
    expect(prompt).toContain('"type": "message"');
    expect(prompt).toContain('"text": "What is amortization?"');
    expect(prompt).toContain("never block on `learn wait`");
  });

  test("adds final wrap-up directions for session-done turns", () => {
    const prompt = buildTurnPrompt({
      courseName: "finance",
      courseDir: "/courses/finance",
      turnPath: "/courses/finance/.overlearn/turns/turn-8.json",
      turn: {
        turn: 8,
        createdAt: "2026-01-01T00:00:00.000Z",
        events: [{ type: "session-done" }],
      },
      instructions: "protocol text",
      includeResumeContext: false,
      mode: "wrap-up",
    });

    expect(prompt).toContain("## Final wrap-up turn");
    expect(prompt).toContain("optionally emit final mastery");
    expect(prompt).toContain("Do not run `learn stop`");
    expect(prompt).toContain('"type": "session-done"');
  });

  test("builds a default-deny course permission policy", () => {
    const policy = buildCoursePermissionPolicy(
      "/courses/finance",
      "/repos/example",
    );

    expect(policy.defaultDecision).toBe("deny");
    expect(policy.allow).toContainEqual({
      action: "write",
      resource: "/courses/finance/**",
      reason: "Course directory writes are pre-approved for this learning session.",
    });
    expect(policy.allow).toContainEqual({
      action: "read",
      resource: "/courses/finance/**",
      reason: "Course and working-directory reads are pre-approved for this learning session.",
    });
    expect(policy.allow).toContainEqual({
      action: "search",
      resource: "/repos/example/**",
      reason: "Course and working-directory reads are pre-approved for this learning session.",
    });
    expect(policy.allow).toContainEqual({
      action: "execute",
      resource: "learn",
      reason: "The learn CLI is pre-approved for course callbacks.",
    });
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
});

describe("daemon orchestrated turns", () => {
  test("submits learner turns to one reused harness session and streams agent events", async () => {
    if (!(await canBindLocalhost())) {
      if (process.env["CI"] === "true") {
        throw new Error("Localhost binding is unavailable; E2E cannot run.");
      }

      return;
    }

    const run = await startOrchestratedDaemon("normal");
    const sse = await createSseClient(run.url);

    try {
      await sse.waitFor(
        "status",
        (data) => isRecord(data) && data["status"] === "waiting-for-agent",
        "initial learner-ready status",
      );

      await submitMessage(run.url, "hello from the browser");

      const stream = await sse.waitFor(
        "agent-stream",
        (data) =>
          isRecord(data) &&
          data["turn"] === 1 &&
          isRecord(data["event"]) &&
          data["event"]["type"] === "thinking",
        "first streamed agent event",
      );
      expect(stream.data).toMatchObject({
        turn: 1,
        sequence: 1,
        event: {
          type: "thinking",
          text: "considering the lesson",
        },
      });
      await sse.waitFor(
        "agent-stream",
        (data) =>
          isRecord(data) &&
          data["turn"] === 1 &&
          isRecord(data["event"]) &&
          data["event"]["type"] === "done",
        "first turn done stream",
      );
      await sse.waitFor(
        "status",
        (data) => isRecord(data) && data["status"] === "waiting-for-agent",
        "status after first turn",
      );

      const turnPath = join(run.courseDir, ".overlearn", "turns", "turn-1.json");
      const firstTurn = JSON.parse(await readFile(turnPath, "utf8")) as TurnFile;
      expect(firstTurn).toEqual({
        turn: 1,
        createdAt: expect.any(String),
        events: [{ type: "message", text: "hello from the browser" }],
      });

      let logEntries = await waitForLogEntries(
        run.logPath,
        (entries) =>
          entries.filter((entry) => entry["event"] === "session/prompt")
            .length >= 1,
        "first prompt log",
      );
      const firstPrompt = promptText(
        logEntries.find((entry) => entry["event"] === "session/prompt") ?? {},
      );
      expect(firstPrompt).toContain("## module: protocol");
      expect(firstPrompt).toContain("## Turn payload");
      expect(firstPrompt).toContain('"text": "hello from the browser"');
      expect(firstPrompt).toContain("## Resume context required");
      expect(
        logEntries.find((entry) => entry["event"] === "initialize"),
      ).toMatchObject({
        env: { CLAUDECODE: null },
      });

      await submitMessage(run.url, "second browser turn");
      await sse.waitFor(
        "agent-stream",
        (data) =>
          isRecord(data) &&
          data["turn"] === 2 &&
          isRecord(data["event"]) &&
          data["event"]["type"] === "done",
        "second turn done stream",
      );

      logEntries = await waitForLogEntries(
        run.logPath,
        (entries) =>
          entries.filter((entry) => entry["event"] === "session/prompt")
            .length >= 2,
        "second prompt log",
      );
      expect(
        logEntries.filter((entry) => entry["event"] === "session/new"),
      ).toHaveLength(1);

      const stop = await runLearn(["stop", run.courseName], run.env);
      expect(stop.exitCode).toBe(0);
      await waitForDaemonStopped(run.courseDir, run.pid);
    } finally {
      sse.close();
      await killDaemon(run.pid);
      await rm(run.coursesDir, { force: true, recursive: true });
    }
  }, 12_000);

  test("pre-approves course lesson writes and streams the permission decision", async () => {
    if (!(await canBindLocalhost())) {
      if (process.env["CI"] === "true") {
        throw new Error("Localhost binding is unavailable; E2E cannot run.");
      }

      return;
    }

    const run = await startOrchestratedDaemon("permission", ({ courseDir }) => ({
      FAKE_ACP_PERMISSION_PATH: join(courseDir, "lessons", "lesson.md"),
    }));
    const coursePermissionPath = join(run.courseDir, "lessons", "lesson.md");
    const sse = await createSseClient(run.url);

    try {
      await sse.waitFor(
        "status",
        (data) => isRecord(data) && data["status"] === "waiting-for-agent",
        "initial learner-ready status",
      );

      await submitMessage(run.url, "please write a lesson");

      const permission = await sse.waitFor(
        "agent-stream",
        (data) =>
          isRecord(data) &&
          data["turn"] === 1 &&
          isRecord(data["event"]) &&
          data["event"]["type"] === "permission-request" &&
          isRecord(data["event"]["decision"]) &&
          data["event"]["decision"]["allowed"] === true,
        "allowed permission stream",
      );
      expect(permission.data).toMatchObject({
        turn: 1,
        event: {
          type: "permission-request",
          request: {
            action: "edit",
            resource: coursePermissionPath,
          },
          decision: {
            allowed: true,
            reason:
              "Course directory writes are pre-approved for this learning session.",
          },
        },
      });
      await sse.waitFor(
        "agent-stream",
        (data) =>
          isRecord(data) &&
          isRecord(data["event"]) &&
          data["event"]["type"] === "text" &&
          data["event"]["text"] === "permission granted by fake",
        "permission granted text stream",
      );
      await sse.waitFor(
        "agent-stream",
        (data) =>
          isRecord(data) &&
          data["turn"] === 1 &&
          isRecord(data["event"]) &&
          data["event"]["type"] === "done",
        "permission turn done stream",
      );
      await sse.waitFor(
        "status",
        (data) => isRecord(data) && data["status"] === "waiting-for-agent",
        "status after permission turn",
      );

      const stop = await runLearn(["stop", run.courseName], run.env);
      expect(stop.exitCode).toBe(0);
      await waitForDaemonStopped(run.courseDir, run.pid);
    } finally {
      sse.close();
      await killDaemon(run.pid);
      await rm(run.coursesDir, { force: true, recursive: true });
    }
  }, 12_000);

  test("done sends a final wrap-up prompt and then shuts down", async () => {
    if (!(await canBindLocalhost())) {
      if (process.env["CI"] === "true") {
        throw new Error("Localhost binding is unavailable; E2E cannot run.");
      }

      return;
    }

    const run = await startOrchestratedDaemon("normal");
    const sse = await createSseClient(run.url);

    try {
      await submitDone(run.url);
      await sse.waitFor(
        "status",
        (data) => isRecord(data) && data["status"] === "wrapping-up",
        "wrapping status",
      );

      const entries = await waitForLogEntries(
        run.logPath,
        (logs) =>
          logs.some(
            (entry) =>
              entry["event"] === "session/prompt" &&
              promptText(entry).includes('"type": "session-done"'),
          ),
        "wrap-up prompt log",
      );
      const wrapPrompt = promptText(
        entries.find(
          (entry) =>
            entry["event"] === "session/prompt" &&
            promptText(entry).includes('"type": "session-done"'),
        ) ?? {},
      );
      expect(wrapPrompt).toContain("## Final wrap-up turn");
      expect(wrapPrompt).toContain("Do not run `learn stop`");

      await sse.waitFor(
        "status",
        (data) => isRecord(data) && data["status"] === "session-ended",
        "session-ended status",
      );
      await waitForDaemonStopped(run.courseDir, run.pid);
    } finally {
      sse.close();
      await killDaemon(run.pid);
      await rm(run.coursesDir, { force: true, recursive: true });
    }
  }, 12_000);

  test("crashed turns retry once with a fresh resumed session and can succeed", async () => {
    if (!(await canBindLocalhost())) {
      if (process.env["CI"] === "true") {
        throw new Error("Localhost binding is unavailable; E2E cannot run.");
      }

      return;
    }

    const markerDir = await mkdtemp(join(tmpdir(), "overlearn-crash-once-"));
    const markerPath = join(markerDir, "marker");
    const run = await startOrchestratedDaemon("crash-once", {
      FAKE_ACP_CRASH_MARKER: markerPath,
    });
    const sse = await createSseClient(run.url);

    try {
      await sse.waitFor(
        "status",
        (data) => isRecord(data) && data["status"] === "waiting-for-agent",
        "initial learner-ready status",
      );

      await submitMessage(run.url, "please survive the retry");
      await sse.waitFor(
        "agent-stream",
        (data) =>
          isRecord(data) &&
          data["turn"] === 1 &&
          isRecord(data["event"]) &&
          data["event"]["type"] === "done",
        "retry success done stream",
      );
      await sse.waitFor(
        "status",
        (data) => isRecord(data) && data["status"] === "waiting-for-agent",
        "status after retry success",
      );

      const entries = await waitForLogEntries(
        run.logPath,
        (logs) =>
          logs.filter((entry) => entry["event"] === "session/prompt").length >=
          2,
        "crash-once retry prompts",
      );
      expect(
        entries.filter((entry) => entry["event"] === "session/new"),
      ).toHaveLength(2);

      const prompts = entries.filter(
        (entry) => entry["event"] === "session/prompt",
      );
      expect(prompts).toHaveLength(2);
      expect(promptText(prompts[1] ?? {})).toContain(
        "## Resume context required",
      );
      expect(
        sse
          .events()
          .filter(
            (event) =>
              event.event === "status" &&
              isRecord(event.data) &&
              event.data["status"] === "agent-failed",
          ),
      ).toHaveLength(0);

      const stop = await runLearn(["stop", run.courseName], run.env);
      expect(stop.exitCode).toBe(0);
      await waitForDaemonStopped(run.courseDir, run.pid);
    } finally {
      sse.close();
      await killDaemon(run.pid);
      await rm(run.coursesDir, { force: true, recursive: true });
      await rm(markerDir, { force: true, recursive: true });
    }
  }, 12_000);

  test("crashed turns retry once and surface a learner-visible failure", async () => {
    if (!(await canBindLocalhost())) {
      if (process.env["CI"] === "true") {
        throw new Error("Localhost binding is unavailable; E2E cannot run.");
      }

      return;
    }

    const run = await startOrchestratedDaemon("crash-always");
    const sse = await createSseClient(run.url);

    try {
      await submitMessage(run.url, "please crash");
      await sse.waitFor(
        "status",
        (data) =>
          isRecord(data) &&
          data["status"] === "agent-failed" &&
          typeof data["message"] === "string" &&
          data["message"].includes("crashed"),
        "agent crashed status",
      );

      const entries = await waitForLogEntries(
        run.logPath,
        (logs) =>
          logs.filter((entry) => entry["event"] === "session/new").length >= 2,
        "crash retry sessions",
      );
      expect(
        entries.filter((entry) => entry["event"] === "session/prompt"),
      ).toHaveLength(2);

      const health = (await (await fetch(`${run.url}/api/health`)).json()) as {
        ok: boolean;
      };
      expect(health.ok).toBe(true);
    } finally {
      sse.close();
      await killDaemon(run.pid);
      await rm(run.coursesDir, { force: true, recursive: true });
    }
  }, 12_000);

  test("timed out turns cancel the prompt and surface failure without stopping the daemon", async () => {
    if (!(await canBindLocalhost())) {
      if (process.env["CI"] === "true") {
        throw new Error("Localhost binding is unavailable; E2E cannot run.");
      }

      return;
    }

    const run = await startOrchestratedDaemon("never", {
      OVERLEARN_TURN_TIMEOUT_MS: "25",
    });
    const sse = await createSseClient(run.url);

    try {
      await submitMessage(run.url, "wait forever");
      await sse.waitFor(
        "agent-stream",
        (data) =>
          isRecord(data) &&
          isRecord(data["event"]) &&
          data["event"]["type"] === "thinking",
        "never scenario thinking event",
      );
      await sse.waitFor(
        "status",
        (data) =>
          isRecord(data) &&
          data["status"] === "agent-failed" &&
          typeof data["message"] === "string" &&
          data["message"].includes("timed out"),
        "timeout failure status",
      );

      const entries = await waitForLogEntries(
        run.logPath,
        (logs) =>
          logs.some((entry) => entry["event"] === "session/cancel"),
        "cancel log",
      );
      expect(entries.some((entry) => entry["event"] === "session/cancel")).toBe(
        true,
      );

      const health = (await (await fetch(`${run.url}/api/health`)).json()) as {
        ok: boolean;
      };
      expect(health.ok).toBe(true);
    } finally {
      sse.close();
      await killDaemon(run.pid);
      await rm(run.coursesDir, { force: true, recursive: true });
    }
  }, 12_000);
});
