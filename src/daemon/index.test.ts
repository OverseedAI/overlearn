import { describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  daemonMetadataPath,
  expireIdleSessions,
  isLegalOnboardingTransition,
  parseAgentConfigPatch,
  parseMessageTurnEvent,
  resolveSessionIdleTtlMs,
} from "./index";
import { MAX_ATTACHMENT_BYTES } from "../attachments";

type TestRuntime = {
  courseId: number;
  runningTurn: boolean;
  lastActivityAt: number;
  orchestrator: {
    resetSession: (reason?: string) => Promise<boolean>;
  };
};

const testRuntime = (
  input: Readonly<{
    courseId?: number;
    runningTurn?: boolean;
    lastActivityAt: number;
    resetReasons: string[];
  }>,
): TestRuntime => ({
  courseId: input.courseId ?? 1,
  runningTurn: input.runningTurn ?? false,
  lastActivityAt: input.lastActivityAt,
  orchestrator: {
    resetSession: async (reason = "reset") => {
      input.resetReasons.push(reason);
      return true;
    },
  },
});

describe("app daemon helpers", () => {
  test("validates course agent config against harness capabilities", () => {
    expect(
      parseAgentConfigPatch("codex", {
        model: "gpt-5.6-sol",
        effort: "high",
      }),
    ).toEqual({ model: "gpt-5.6-sol", effort: "high" });
    expect(parseAgentConfigPatch("codex", {})).toEqual({
      model: null,
      effort: null,
    });
    expect(() =>
      parseAgentConfigPatch("codex", { model: "not-a-model" }),
    ).toThrow("Unknown model for codex: not-a-model");
    expect(() =>
      parseAgentConfigPatch("codex", { effort: "extreme" }),
    ).toThrow("Unknown effort for codex: extreme");
  });

  test("uses safe empty defaults for harnesses without agent config support", () => {
    expect(parseAgentConfigPatch("gemini", {})).toEqual({
      model: null,
      effort: null,
    });
    expect(() =>
      parseAgentConfigPatch("gemini", { model: "gemini-anything" }),
    ).toThrow("Harness gemini does not support model selection.");
    expect(() =>
      parseAgentConfigPatch("gemini", { effort: "high" }),
    ).toThrow("Harness gemini does not support effort selection.");
  });

  test("validates submit attachments while preserving the learner text", () => {
    const data = Buffer.from("image bytes").toString("base64");

    expect(
      parseMessageTurnEvent({
        text: "Keep this draft intact.",
        attachments: [
          {
            kind: "image",
            name: "diagram.png",
            mimeType: "image/png",
            data,
          },
        ],
      }),
    ).toEqual({
      type: "message",
      text: "Keep this draft intact.",
      attachments: [
        {
          kind: "image",
          name: "diagram.png",
          mimeType: "image/png",
          data,
        },
      ],
    });
  });

  test("rejects unsupported and oversized submit attachments", () => {
    expect(() =>
      parseMessageTurnEvent({
        text: "Do not discard this text.",
        attachments: [
          {
            kind: "file",
            name: "archive.zip",
            mimeType: "application/zip",
            data: "",
          },
        ],
      }),
    ).toThrow("unsupported format");

    expect(() =>
      parseMessageTurnEvent({
        text: "Do not discard this text either.",
        attachments: [
          {
            kind: "file",
            name: "large.pdf",
            mimeType: "application/pdf",
            data: Buffer.alloc(MAX_ATTACHMENT_BYTES + 1).toString("base64"),
          },
        ],
      }),
    ).toThrow("exceeds the 10 MB size limit");
  });

  test("uses the store data dir for daemon metadata", async () => {
    const dataDir = await mkdtemp(join(tmpdir(), "overlearn-daemon-meta-"));

    try {
      expect(daemonMetadataPath({ OVERLEARN_DATA_DIR: dataDir })).toBe(
        join(dataDir, "daemon.json"),
      );
    } finally {
      await rm(dataDir, { force: true, recursive: true });
    }
  });

  test("validates onboarding transitions and normalizes legacy new state", () => {
    expect(isLegalOnboardingTransition("new", "connect-agent")).toBe(true);
    expect(isLegalOnboardingTransition("welcome", "connect-agent")).toBe(true);
    expect(isLegalOnboardingTransition("connect-agent", "tutorial-offer")).toBe(
      true,
    );
    expect(isLegalOnboardingTransition("tutorial-offer", "done")).toBe(true);
    expect(isLegalOnboardingTransition("done", "welcome")).toBe(true);
    expect(isLegalOnboardingTransition("welcome", "done")).toBe(false);
    expect(isLegalOnboardingTransition("connect-agent", "done")).toBe(false);
  });

  test("uses a thirty minute idle TTL default and accepts env override", () => {
    expect(resolveSessionIdleTtlMs({})).toBe(1_800_000);
    expect(
      resolveSessionIdleTtlMs({ OVERLEARN_SESSION_IDLE_TTL_MS: "2500" }),
    ).toBe(2_500);
    expect(() =>
      resolveSessionIdleTtlMs({ OVERLEARN_SESSION_IDLE_TTL_MS: "0" }),
    ).toThrow("OVERLEARN_SESSION_IDLE_TTL_MS must be a positive integer.");
    expect(() =>
      resolveSessionIdleTtlMs({ OVERLEARN_SESSION_IDLE_TTL_MS: "1.5" }),
    ).toThrow("OVERLEARN_SESSION_IDLE_TTL_MS must be a positive integer.");
  });

  test("expires idle sessions through reset semantics and broadcasts once", async () => {
    const resetReasons: string[] = [];
    const runtime = testRuntime({ lastActivityAt: 1_000, resetReasons });
    const runtimes = new Map([[runtime.courseId, runtime]]);
    let broadcasts = 0;

    await expect(
      expireIdleSessions({
        runtimes,
        idleTtlMs: 5_000,
        now: () => 6_001,
        onExpired: () => {
          broadcasts += 1;
        },
      }),
    ).resolves.toBe(1);

    expect(runtimes.has(runtime.courseId)).toBe(false);
    expect(resetReasons).toEqual(["idle-ttl"]);
    expect(broadcasts).toBe(1);
  });

  test("does not expire running turns", async () => {
    const resetReasons: string[] = [];
    const runtime = testRuntime({
      lastActivityAt: 1_000,
      runningTurn: true,
      resetReasons,
    });
    const runtimes = new Map([[runtime.courseId, runtime]]);

    await expect(
      expireIdleSessions({
        runtimes,
        idleTtlMs: 5_000,
        now: () => 60_000,
      }),
    ).resolves.toBe(0);

    expect(runtimes.get(runtime.courseId)).toBe(runtime);
    expect(resetReasons).toEqual([]);
  });

  test("uses refreshed activity time before expiring a session", async () => {
    const resetReasons: string[] = [];
    const runtime = testRuntime({ lastActivityAt: 0, resetReasons });
    const runtimes = new Map([[runtime.courseId, runtime]]);

    await expect(
      expireIdleSessions({
        runtimes,
        idleTtlMs: 100,
        now: () => 50,
      }),
    ).resolves.toBe(0);

    runtime.lastActivityAt = 75;

    await expect(
      expireIdleSessions({
        runtimes,
        idleTtlMs: 100,
        now: () => 150,
      }),
    ).resolves.toBe(0);

    await expect(
      expireIdleSessions({
        runtimes,
        idleTtlMs: 100,
        now: () => 176,
      }),
    ).resolves.toBe(1);

    expect(runtimes.has(runtime.courseId)).toBe(false);
    expect(resetReasons).toEqual(["idle-ttl"]);
  });
});
