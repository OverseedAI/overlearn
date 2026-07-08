import { describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  daemonMetadataPath,
  expireIdleSessions,
  isLegalOnboardingTransition,
  resolveSessionIdleTtlMs,
} from "./index";

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
