import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { readCourseManifest, readDaemonMetadata, type TurnFile } from "../course";
import {
  canBindLocalhost,
  createFakeHarnessPath,
  createSseClient,
  harnessById,
  harnessPayloadHasSelected,
  isRecord,
  killDaemon,
  type ProcessResult,
  promptText,
  readLogEntries,
  runProcess,
  sleep,
  submitDone,
  submitMessage,
  waitForDaemonStopped,
  waitForLogEntries,
  waitForPidStopped,
} from "../../test/helpers/daemon";
import {
  buildCoursePermissionPolicy,
  buildTurnPrompt,
  nestedSessionEnvOverride,
  orchestratedTurnsEnabled,
  parseHarnessCommand,
  resolveHarnessAdapter,
  resolveTurnTimeoutMs,
} from "./orchestrator";

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

const runLearn = async (
  args: readonly string[],
  env: Record<string, string>,
): Promise<ProcessResult> =>
  runProcess([process.execPath, cliPath, ...args], env, args.join(" "));

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

afterEach(async () => {
  await Promise.all(
    [...liveDaemonPids].map(async (pid) => {
      await killDaemon(pid);
      liveDaemonPids.delete(pid);
    }),
  );
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

  test("adds continuity greeting directions for harness swap turns", () => {
    const prompt = buildTurnPrompt({
      courseName: "finance",
      courseDir: "/courses/finance",
      turnPath: "/courses/finance/.overlearn/turns/turn-8.json",
      turn: {
        turn: 8,
        createdAt: "2026-01-01T00:00:00.000Z",
        events: [
          { type: "harness-swapped", from: "claude-code", to: "codex" },
        ],
      },
      instructions: "protocol text",
      includeResumeContext: true,
      mode: "greeting",
    });

    expect(prompt).toContain("## Harness swap greeting turn");
    expect(prompt).toContain("Rebuild context from disk before speaking");
    expect(prompt).toContain("one short continuity greeting");
    expect(prompt).toContain('"type": "harness-swapped"');
    expect(prompt).toContain("## Resume context required");
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

  test("enables orchestrated turns unless explicitly opted out", () => {
    expect(orchestratedTurnsEnabled({})).toBe(true);
    expect(orchestratedTurnsEnabled({ OVERLEARN_ORCHESTRATED: "1" })).toBe(true);
    expect(orchestratedTurnsEnabled({ OVERLEARN_ORCHESTRATED: "true" })).toBe(true);
    expect(orchestratedTurnsEnabled({ OVERLEARN_ORCHESTRATED: "0" })).toBe(false);
    expect(orchestratedTurnsEnabled({ OVERLEARN_ORCHESTRATED: "false" })).toBe(false);
    expect(orchestratedTurnsEnabled({ OVERLEARN_ORCHESTRATED: "FALSE" })).toBe(false);
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

describe("daemon harness API", () => {
  test("lists cached harness detection state and exposes orchestrated health", async () => {
    if (!(await canBindLocalhost())) {
      if (process.env["CI"] === "true") {
        throw new Error("Localhost binding is unavailable; E2E cannot run.");
      }

      return;
    }

    const binDir = await createFakeHarnessPath();
    const run = await startOrchestratedDaemon("normal", {
      PATH: binDir,
      OVERLEARN_HARNESS: "codex",
      ANTHROPIC_API_KEY: "test-anthropic",
      OPENAI_API_KEY: "test-openai",
      GEMINI_API_KEY: "test-gemini",
    });

    try {
      const health = (await (await fetch(`${run.url}/api/health`)).json()) as {
        orchestrated: boolean;
      };
      expect(health.orchestrated).toBe(true);

      const response = await fetch(`${run.url}/api/harnesses`);
      expect(response.status).toBe(200);
      const harnesses = (await response.json()) as unknown;
      const claude = harnessById(harnesses, "claude-code");
      const codex = harnessById(harnesses, "codex");
      const gemini = harnessById(harnesses, "gemini");

      expect(claude).toMatchObject({
        id: "claude-code",
        name: "Claude Code",
        installed: true,
        authenticated: true,
        selected: false,
        version: "claude-code-acp 9.9.9",
      });
      expect(codex).toMatchObject({
        id: "codex",
        name: "Codex",
        installed: true,
        authenticated: true,
        selected: true,
        version: "codex-acp 9.9.9",
      });
      expect(gemini).toMatchObject({
        id: "gemini",
        name: "Gemini",
        installed: true,
        authenticated: true,
        selected: false,
        version: "gemini 9.9.9",
      });

      const stop = await runLearn(["stop", run.courseName], run.env);
      expect(stop.exitCode).toBe(0);
      await waitForDaemonStopped(run.courseDir, run.pid);
    } finally {
      await killDaemon(run.pid);
      await rm(run.coursesDir, { force: true, recursive: true });
      await rm(binDir, { force: true, recursive: true });
    }
  }, 12_000);

  test("persists course harness selection, validates ids, and lets course beat env", async () => {
    if (!(await canBindLocalhost())) {
      if (process.env["CI"] === "true") {
        throw new Error("Localhost binding is unavailable; E2E cannot run.");
      }

      return;
    }

    const binDir = await createFakeHarnessPath();
    const run = await startOrchestratedDaemon("normal", {
      PATH: binDir,
      OVERLEARN_HARNESS: "gemini",
      ANTHROPIC_API_KEY: "test-anthropic",
      OPENAI_API_KEY: "test-openai",
      GEMINI_API_KEY: "test-gemini",
    });

    try {
      const invalid = await fetch(`${run.url}/api/harness`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ id: "missing" }),
      });
      expect(invalid.status).toBe(400);
      await expect(invalid.text()).resolves.toContain(
        "Unknown harness adapter: missing",
      );

      const selectedFromEnv = await (await fetch(`${run.url}/api/harnesses`)).json();
      expect(harnessById(selectedFromEnv, "gemini")["selected"]).toBe(true);

      const response = await fetch(`${run.url}/api/harness`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ id: "codex" }),
      });
      expect(response.status).toBe(200);
      await expect(response.json()).resolves.toMatchObject({
        ok: true,
        harness: "codex",
      });
      await expect(readCourseManifest(run.courseDir)).resolves.toMatchObject({
        harness: "codex",
      });

      const selectedFromCourse = await (
        await fetch(`${run.url}/api/harnesses?refresh=1`)
      ).json();
      expect(harnessById(selectedFromCourse, "codex")["selected"]).toBe(true);
      expect(harnessById(selectedFromCourse, "gemini")["selected"]).toBe(false);

      const stop = await runLearn(["stop", run.courseName], run.env);
      expect(stop.exitCode).toBe(0);
      await waitForDaemonStopped(run.courseDir, run.pid);
    } finally {
      await killDaemon(run.pid);
      await rm(run.coursesDir, { force: true, recursive: true });
      await rm(binDir, { force: true, recursive: true });
    }
  }, 12_000);

  test("swaps an idle active session and immediately runs a continuity greeting", async () => {
    if (!(await canBindLocalhost())) {
      if (process.env["CI"] === "true") {
        throw new Error("Localhost binding is unavailable; E2E cannot run.");
      }

      return;
    }

    const run = await startOrchestratedDaemon("normal");
    const firstClient = await createSseClient(run.url);
    const secondClient = await createSseClient(run.url);

    try {
      await submitMessage(run.url, "start on adapter A");
      await firstClient.waitFor(
        "agent-stream",
        (data) =>
          isRecord(data) &&
          data["turn"] === 1 &&
          isRecord(data["event"]) &&
          data["event"]["type"] === "done",
        "first adapter turn done",
      );
      await firstClient.waitFor(
        "status",
        (data) => isRecord(data) && data["status"] === "waiting-for-agent",
        "idle after first turn",
      );

      const response = await fetch(`${run.url}/api/harness`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ id: "codex" }),
      });
      expect(response.status).toBe(200);
      await expect(response.json()).resolves.toMatchObject({
        ok: true,
        harness: "codex",
        swapped: true,
      });

      await expect(readCourseManifest(run.courseDir)).resolves.toMatchObject({
        harness: "codex",
      });

      await firstClient.waitFor(
        "harnesses",
        (data) => harnessPayloadHasSelected(data, "codex", true),
        "first client selected codex",
      );
      await secondClient.waitFor(
        "harnesses",
        (data) => harnessPayloadHasSelected(data, "codex", true),
        "second client selected codex",
      );
      await firstClient.waitFor(
        "agent-stream",
        (data) =>
          isRecord(data) &&
          data["turn"] === 2 &&
          isRecord(data["event"]) &&
          data["event"]["type"] === "thinking",
        "greeting turn started",
      );
      await firstClient.waitFor(
        "agent-stream",
        (data) =>
          isRecord(data) &&
          data["turn"] === 2 &&
          isRecord(data["event"]) &&
          data["event"]["type"] === "done",
        "greeting turn done",
      );
      await firstClient.waitFor(
        "status",
        (data) => isRecord(data) && data["status"] === "waiting-for-agent",
        "idle after greeting",
      );

      const logEntries = await waitForLogEntries(
        run.logPath,
        (entries) =>
          entries.filter((entry) => entry["event"] === "session/new")
            .length >= 2 &&
          entries.filter((entry) => entry["event"] === "session/prompt")
            .length >= 2,
        "swap sessions and prompts",
      );
      const sessionNews = logEntries.filter(
        (entry) => entry["event"] === "session/new",
      );
      const firstPid = sessionNews[0]?.["pid"];
      const secondPid = sessionNews[1]?.["pid"];
      if (typeof firstPid !== "number" || typeof secondPid !== "number") {
        throw new Error("Expected two fake adapter process ids.");
      }

      expect(sessionNews).toHaveLength(2);
      expect(secondPid).not.toBe(firstPid);
      await waitForPidStopped(firstPid);

      const prompts = logEntries.filter(
        (entry) => entry["event"] === "session/prompt",
      );
      const swapPrompt = promptText(prompts[1] ?? {});
      expect(swapPrompt).toContain("## Harness swap greeting turn");
      expect(swapPrompt).toContain("## Resume context required");
      expect(swapPrompt).toContain('"type": "harness-swapped"');
      expect(swapPrompt).toContain('"from": "claude-code"');
      expect(swapPrompt).toContain('"to": "codex"');

      const stop = await runLearn(["stop", run.courseName], run.env);
      expect(stop.exitCode).toBe(0);
      await waitForDaemonStopped(run.courseDir, run.pid);
    } finally {
      firstClient.close();
      secondClient.close();
      await killDaemon(run.pid);
      await rm(run.coursesDir, { force: true, recursive: true });
    }
  }, 12_000);

  test("persisting a harness selection with no active session does not greet", async () => {
    if (!(await canBindLocalhost())) {
      if (process.env["CI"] === "true") {
        throw new Error("Localhost binding is unavailable; E2E cannot run.");
      }

      return;
    }

    const run = await startOrchestratedDaemon("normal");
    const sse = await createSseClient(run.url);

    try {
      const response = await fetch(`${run.url}/api/harness`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ id: "codex" }),
      });
      expect(response.status).toBe(200);
      await expect(response.json()).resolves.toMatchObject({
        ok: true,
        harness: "codex",
        swapped: false,
      });

      await sse.waitFor(
        "harnesses",
        (data) => harnessPayloadHasSelected(data, "codex", false),
        "selected codex without swap",
      );
      await expect(readCourseManifest(run.courseDir)).resolves.toMatchObject({
        harness: "codex",
      });

      await sleep(100);
      expect(await readLogEntries(run.logPath)).toHaveLength(0);

      const stop = await runLearn(["stop", run.courseName], run.env);
      expect(stop.exitCode).toBe(0);
      await waitForDaemonStopped(run.courseDir, run.pid);
    } finally {
      sse.close();
      await killDaemon(run.pid);
      await rm(run.coursesDir, { force: true, recursive: true });
    }
  }, 12_000);

  test("rejects harness changes while an orchestrated turn is running", async () => {
    if (!(await canBindLocalhost())) {
      if (process.env["CI"] === "true") {
        throw new Error("Localhost binding is unavailable; E2E cannot run.");
      }

      return;
    }

    const run = await startOrchestratedDaemon("never");
    const sse = await createSseClient(run.url);

    try {
      await submitMessage(run.url, "keep working");
      await sse.waitFor(
        "agent-stream",
        (data) =>
          isRecord(data) &&
          isRecord(data["event"]) &&
          data["event"]["type"] === "thinking",
        "running turn thinking",
      );

      const response = await fetch(`${run.url}/api/harness`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ id: "codex" }),
      });
      expect(response.status).toBe(409);
      await expect(response.text()).resolves.toContain(
        "Cannot change harness while a turn is running",
      );
    } finally {
      sse.close();
      await killDaemon(run.pid);
      await rm(run.coursesDir, { force: true, recursive: true });
    }
  }, 12_000);
});

describe("daemon orchestrated turns", () => {
  test("replays buffered agent-stream events to clients that connect mid-turn", async () => {
    if (!(await canBindLocalhost())) {
      if (process.env["CI"] === "true") {
        throw new Error("Localhost binding is unavailable; E2E cannot run.");
      }

      return;
    }

    const run = await startOrchestratedDaemon("never");
    const first = await createSseClient(run.url);
    let second:
      | Awaited<ReturnType<typeof createSseClient>>
      | undefined;

    try {
      await submitMessage(run.url, "stream for a while");
      const streamed = await first.waitFor(
        "agent-stream",
        (data) =>
          isRecord(data) &&
          data["turn"] === 1 &&
          isRecord(data["event"]) &&
          data["event"]["type"] === "thinking" &&
          data["event"]["text"] === "waiting forever",
        "first client thinking event",
      );
      expect(streamed.data).toMatchObject({
        turn: 1,
        sequence: 1,
        event: { type: "thinking", text: "waiting forever" },
      });

      second = await createSseClient(run.url);
      const replayed = await second.waitFor(
        "agent-stream",
        (data) =>
          isRecord(data) &&
          data["turn"] === 1 &&
          data["sequence"] === 1 &&
          isRecord(data["event"]) &&
          data["event"]["type"] === "thinking",
        "replayed thinking event",
      );
      expect(replayed.data).toEqual(streamed.data);
    } finally {
      first.close();
      second?.close();
      await killDaemon(run.pid);
      await rm(run.coursesDir, { force: true, recursive: true });
    }
  }, 12_000);

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
