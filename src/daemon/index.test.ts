import { describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  createCourse,
  openStore,
  pageTranscript,
} from "../store";
import {
  daemonMetadataPath,
  LearnCommandError,
  notifyAgentTranscriptEntry,
  sayAgentMessage,
  waitForLearnerTurn,
} from "./index";

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

  test("learn wait reports the removed command clearly", async () => {
    await expect(waitForLearnerTurn("course")).rejects.toMatchObject({
      exitCode: 2,
      message: expect.stringContaining("learn wait has been removed"),
    });
  });

  test("learn wait rejection remains a LearnCommandError", async () => {
    try {
      await waitForLearnerTurn();
    } catch (error) {
      expect(error).toBeInstanceOf(LearnCommandError);
      return;
    }

    throw new Error("Expected waitForLearnerTurn to throw.");
  });

  test("sayAgentMessage appends an agent transcript entry to a store course", async () => {
    const dataDir = await mkdtemp(join(tmpdir(), "overlearn-say-store-"));
    const env = { OVERLEARN_DATA_DIR: dataDir };
    const setupStore = openStore({ env });

    try {
      createCourse(setupStore, {
        title: "Offline Course",
        sourceName: "offline",
      });
    } finally {
      setupStore.close();
    }

    try {
      await expect(
        sayAgentMessage(
          "offline",
          { kind: "text", text: "agent reply" },
          env,
          tmpdir(),
        ),
      ).resolves.toBeUndefined();

      const verifyStore = openStore({ env });
      try {
        const transcript = pageTranscript(verifyStore, 1).entries;
        expect(transcript).toHaveLength(1);
        expect(transcript[0]).toMatchObject({
          role: "agent",
          kind: "text",
          content: "agent reply",
        });
      } finally {
        verifyStore.close();
      }
    } finally {
      await rm(dataDir, { force: true, recursive: true });
    }
  });

  test("legacy transcript notification is a no-op until CLI cleanup", async () => {
    await expect(notifyAgentTranscriptEntry("course", {})).resolves.toBeUndefined();
  });
});
