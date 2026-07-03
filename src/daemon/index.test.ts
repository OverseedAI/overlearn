import { describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { ensureCourseScaffold } from "../course";
import { sayAgentMessage } from "./index";

describe("sayAgentMessage", () => {
  test("appends to transcript when the daemon is unavailable", async () => {
    const coursesDir = await mkdtemp(join(tmpdir(), "overlearn-say-"));
    const env = { OVERLEARN_COURSES_DIR: coursesDir };

    try {
      const paths = await ensureCourseScaffold("offline", env);
      const warning = await sayAgentMessage(
        "offline",
        { kind: "text", text: "agent reply" },
        env,
        tmpdir(),
      );

      expect(warning).toContain("appended agent message to transcript only");

      const transcript = await readFile(paths.transcriptJsonl, "utf8");
      expect(JSON.parse(transcript.trim())).toEqual({
        role: "agent",
        text: "agent reply",
        at: expect.any(String),
      });
    } finally {
      await rm(coursesDir, { force: true, recursive: true });
    }
  });
});
