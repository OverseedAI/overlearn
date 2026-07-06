import { afterEach, describe, expect, test } from "bun:test";
import { rm } from "node:fs/promises";
import { join } from "node:path";

import { readCourseManifest } from "../../src/course";
import {
  canBindLocalhost,
  createFakeHarnessPath,
  createSseClient,
  harnessById,
  harnessPayloadHasSelected,
  isRecord,
  promptText,
  submitDone,
  submitMessage,
  waitForDaemonStopped,
  waitForLogEntries,
  waitForPidStopped,
} from "../helpers/daemon";
import {
  checkContractRuntime,
  readTurnFile,
  resolveContractRuntime,
  startContractDaemon,
  type StartedContractDaemon,
} from "./runtime";

const runtime = resolveContractRuntime();
const runtimeIssue = checkContractRuntime(runtime);
const contractTest = runtimeIssue === undefined ? test : test.skip;
const activeDaemons = new Set<StartedContractDaemon>();

const ensureLocalhost = async (): Promise<boolean> => {
  if (await canBindLocalhost()) {
    return true;
  }

  if (process.env["CI"] === "true") {
    throw new Error("Localhost binding is unavailable; contract tests cannot run.");
  }

  return false;
};

const withFakeHarnessPath = async (): Promise<
  Readonly<{ binDir: string; path: string }>
> => {
  const binDir = await createFakeHarnessPath();
  const existingPath = process.env["PATH"];
  const path =
    existingPath === undefined || existingPath.length === 0
      ? binDir
      : `${binDir}:${existingPath}`;

  return { binDir, path };
};

const start = async (
  options: Parameters<typeof startContractDaemon>[1] = {},
): Promise<StartedContractDaemon> => {
  const daemon = await startContractDaemon(runtime, options);
  activeDaemons.add(daemon);

  return daemon;
};

afterEach(async () => {
  await Promise.all([...activeDaemons].map((daemon) => daemon.cleanup()));
  activeDaemons.clear();
});

describe(`daemon contract (${runtime.name})`, () => {
  contractTest(
    "exposes orchestrated health, harness snapshots, wait rejection, agent stream, and turn files",
    async () => {
      if (!(await ensureLocalhost())) {
        return;
      }

      const fakeHarness = await withFakeHarnessPath();
      const daemon = await start({
        scenario: "normal",
        extraEnv: {
          PATH: fakeHarness.path,
          OVERLEARN_HARNESS: "codex",
          ANTHROPIC_API_KEY: "test-anthropic",
          OPENAI_API_KEY: "test-openai",
          GEMINI_API_KEY: "test-gemini",
        },
      });
      const sse = await createSseClient(daemon.url);

      try {
        const health = (await (
          await fetch(`${daemon.url}/api/health`)
        ).json()) as Record<string, unknown>;
        expect(health).toMatchObject({
          ok: true,
          orchestrated: true,
          waitPending: false,
          hasSeenWait: true,
          coursePath: daemon.courseDir,
        });

        const waitResponse = await fetch(`${daemon.url}/api/wait`);
        expect(waitResponse.status).toBe(409);
        await expect(waitResponse.text()).resolves.toContain(
          "learn wait is disabled",
        );

        const harnessResponse = await fetch(`${daemon.url}/api/harnesses`);
        expect(harnessResponse.status).toBe(200);
        const harnesses = (await harnessResponse.json()) as unknown;
        expect(harnessById(harnesses, "claude-code")).toMatchObject({
          installed: true,
          authenticated: true,
          selected: false,
          version: "claude-code-acp 9.9.9",
        });
        expect(harnessById(harnesses, "codex")).toMatchObject({
          installed: true,
          authenticated: true,
          selected: true,
          version: "codex-acp 9.9.9",
        });
        expect(harnessById(harnesses, "gemini")).toMatchObject({
          installed: true,
          authenticated: true,
          selected: false,
          version: "gemini 9.9.9",
        });

        await sse.waitFor(
          "status",
          (data) => isRecord(data) && data["status"] === "waiting-for-agent",
          "initial orchestrated status",
        );
        await sse.waitFor(
          "harnesses",
          (data) => harnessPayloadHasSelected(data, "codex", false),
          "initial harness snapshot",
        );

        await submitMessage(daemon.url, "contract hello");
        await sse.waitFor(
          "status",
          (data) => isRecord(data) && data["status"] === "agent-working",
          "agent-working status",
        );
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
          event: { type: "thinking", text: "considering the lesson" },
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
          "status after turn",
        );

        const turnPath = join(
          daemon.courseDir,
          ".overlearn",
          "turns",
          "turn-1.json",
        );
        await expect(readTurnFile(turnPath)).resolves.toEqual({
          turn: 1,
          createdAt: expect.any(String),
          events: [{ type: "message", text: "contract hello" }],
        });

        const logs = await waitForLogEntries(
          daemon.logPath,
          (entries) =>
            entries.some((entry) => entry["event"] === "session/prompt"),
          "first prompt log",
        );
        expect(
          logs.find((entry) => entry["event"] === "initialize"),
        ).toMatchObject({
          env: { CLAUDECODE: null },
        });
        const firstPrompt = promptText(
          logs.find((entry) => entry["event"] === "session/prompt") ?? {},
        );
        expect(firstPrompt).toContain("## Turn payload");
        expect(firstPrompt).toContain('"text": "contract hello"');
        expect(firstPrompt).toContain("## Resume context required");
      } finally {
        sse.close();
        await rm(fakeHarness.binDir, { force: true, recursive: true });
      }
    },
    15_000,
  );

  contractTest(
    "replays in-flight agent-stream events to clients that connect mid-turn",
    async () => {
      if (!(await ensureLocalhost())) {
        return;
      }

      const daemon = await start({ scenario: "never" });
      const first = await createSseClient(daemon.url);
      let second: Awaited<ReturnType<typeof createSseClient>> | undefined;

      try {
        await submitMessage(daemon.url, "stream while reconnecting");
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

        second = await createSseClient(daemon.url);
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
      }
    },
    15_000,
  );

  contractTest(
    "swaps active harnesses mid-course and runs a resume-context greeting turn",
    async () => {
      if (!(await ensureLocalhost())) {
        return;
      }

      const fakeHarness = await withFakeHarnessPath();
      const daemon = await start({
        scenario: "normal",
        extraEnv: {
          PATH: fakeHarness.path,
          ANTHROPIC_API_KEY: "test-anthropic",
          OPENAI_API_KEY: "test-openai",
          GEMINI_API_KEY: "test-gemini",
        },
      });
      const firstClient = await createSseClient(daemon.url);
      const secondClient = await createSseClient(daemon.url);

      try {
        await submitMessage(daemon.url, "start on adapter A");
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

        const response = await fetch(`${daemon.url}/api/harness`, {
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
        await expect(readCourseManifest(daemon.courseDir)).resolves.toMatchObject({
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
          daemon.logPath,
          (entries) =>
            entries.filter((entry) => entry["event"] === "session/new").length >=
              2 &&
            entries.filter((entry) => entry["event"] === "session/prompt")
              .length >= 2,
          "swap sessions and prompts",
        );
        const sessionNews = logEntries.filter(
          (entry) => entry["event"] === "session/new",
        );
        expect(sessionNews).toHaveLength(2);
        const firstPid = sessionNews[0]?.["pid"];
        const secondPid = sessionNews[1]?.["pid"];
        if (typeof firstPid !== "number" || typeof secondPid !== "number") {
          throw new Error("Expected two fake adapter process ids.");
        }
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

        const greetingTurnPath = join(
          daemon.courseDir,
          ".overlearn",
          "turns",
          "turn-2.json",
        );
        await expect(readTurnFile(greetingTurnPath)).resolves.toMatchObject({
          turn: 2,
          events: [
            { type: "harness-swapped", from: "claude-code", to: "codex" },
          ],
        });
      } finally {
        firstClient.close();
        secondClient.close();
        await rm(fakeHarness.binDir, { force: true, recursive: true });
      }
    },
    15_000,
  );

  contractTest(
    "runs the final wrap-up turn, emits session-ended, and exits on done",
    async () => {
      if (!(await ensureLocalhost())) {
        return;
      }

      const daemon = await start({ scenario: "normal" });
      const sse = await createSseClient(daemon.url);

      try {
        await submitDone(daemon.url);
        await sse.waitFor(
          "status",
          (data) => isRecord(data) && data["status"] === "wrapping-up",
          "wrapping status",
        );
        await sse.waitFor(
          "agent-stream",
          (data) =>
            isRecord(data) &&
            data["turn"] === 1 &&
            isRecord(data["event"]) &&
            data["event"]["type"] === "done",
          "wrap-up done stream",
        );

        const entries = await waitForLogEntries(
          daemon.logPath,
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

        const doneTurnPath = join(
          daemon.courseDir,
          ".overlearn",
          "turns",
          "turn-1.json",
        );
        await expect(readTurnFile(doneTurnPath)).resolves.toEqual({
          turn: 1,
          createdAt: expect.any(String),
          events: [{ type: "session-done" }],
        });

        await sse.waitFor(
          "status",
          (data) => isRecord(data) && data["status"] === "session-ended",
          "session-ended status",
        );
        await waitForDaemonStopped(daemon.courseDir, daemon.pid);
      } finally {
        sse.close();
      }
    },
    15_000,
  );

  contractTest(
    "preserves the legacy wait/turn round trip when orchestration is disabled",
    async () => {
      if (!(await ensureLocalhost())) {
        return;
      }

      const daemon = await start({
        scenario: "normal",
        orchestrated: false,
      });
      const sse = await createSseClient(daemon.url);

      try {
        const health = (await (
          await fetch(`${daemon.url}/api/health`)
        ).json()) as Record<string, unknown>;
        expect(health).toMatchObject({
          ok: true,
          orchestrated: false,
          waitPending: false,
          hasSeenWait: false,
          coursePath: daemon.courseDir,
        });

        await sse.waitFor(
          "status",
          (data) => isRecord(data) && data["status"] === "agent-working",
          "initial legacy status",
        );

        const wait = fetch(`${daemon.url}/api/wait`);
        await sse.waitFor(
          "status",
          (data) => isRecord(data) && data["status"] === "waiting-for-agent",
          "legacy waiting status",
        );

        const waitingHealth = (await (
          await fetch(`${daemon.url}/api/health`)
        ).json()) as Record<string, unknown>;
        expect(waitingHealth).toMatchObject({
          orchestrated: false,
          waitPending: true,
          hasSeenWait: true,
        });

        await submitMessage(daemon.url, "legacy browser turn");
        const waitResponse = await wait;
        expect(waitResponse.status).toBe(200);
        const waitPayload = (await waitResponse.json()) as Record<string, unknown>;
        expect(typeof waitPayload["turnPath"]).toBe("string");
        const turnPath = waitPayload["turnPath"] as string;
        expect(turnPath).toBe(
          join(daemon.courseDir, ".overlearn", "turns", "turn-1.json"),
        );
        await expect(readTurnFile(turnPath)).resolves.toEqual({
          turn: 1,
          createdAt: expect.any(String),
          events: [{ type: "message", text: "legacy browser turn" }],
        });
        await sse.waitFor(
          "status",
          (data) => isRecord(data) && data["status"] === "agent-working",
          "legacy working status after turn",
        );
      } finally {
        sse.close();
      }
    },
    15_000,
  );
});
