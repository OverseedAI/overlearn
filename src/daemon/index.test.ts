import { describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { daemonMetadataPath, isLegalOnboardingTransition } from "./index";

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
});
