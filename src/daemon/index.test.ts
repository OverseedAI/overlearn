import { describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  appendLessonTranscript,
  ensureCourseScaffold,
  readTranscript,
  type ActiveFeynmanCheck,
  type TranscriptEntry,
} from "../course";
import {
  appendFeynmanAnswerTimelineEntry,
  appendFirstSeenLessonTranscripts,
  appendNewFeynmanCheckTranscript,
  backfillLessonTranscripts,
  latestFeynmanCheckIssuedAt,
  lessonTranscriptIds,
  sayAgentMessage,
} from "./index";

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

describe("timeline transcript sync", () => {
  test("backfills unreferenced lesson files in file mtime order", async () => {
    const coursesDir = await mkdtemp(join(tmpdir(), "overlearn-backfill-"));
    const env = { OVERLEARN_COURSES_DIR: coursesDir };

    try {
      const paths = await ensureCourseScaffold("backfill", env);
      await appendLessonTranscript(
        paths.courseDir,
        "already-seen",
        "2026-01-01T00:00:00.000Z",
      );

      const alreadySeenPath = join(paths.lessonsDir, "already-seen.md");
      const laterPath = join(paths.lessonsDir, "02-later.md");
      const earlierPath = join(paths.lessonsDir, "01-earlier.md");
      await writeFile(alreadySeenPath, "# Already seen\n", "utf8");
      await writeFile(laterPath, "# Later\n", "utf8");
      await writeFile(earlierPath, "# Earlier\n", "utf8");

      const alreadySeenAt = new Date("2026-01-02T00:00:00.000Z");
      const laterAt = new Date("2026-01-04T00:00:00.000Z");
      const earlierAt = new Date("2026-01-03T00:00:00.000Z");
      await utimes(alreadySeenPath, alreadySeenAt, alreadySeenAt);
      await utimes(laterPath, laterAt, laterAt);
      await utimes(earlierPath, earlierAt, earlierAt);

      const seen = lessonTranscriptIds(await readTranscript(paths.courseDir));
      const broadcasts: TranscriptEntry[] = [];
      const entries = await backfillLessonTranscripts(
        paths.courseDir,
        paths.lessonsDir,
        seen,
        (entry) => broadcasts.push(entry),
      );

      expect(entries).toEqual([
        {
          role: "agent",
          kind: "lesson",
          lesson: "01-earlier",
          at: "2026-01-03T00:00:00.000Z",
        },
        {
          role: "agent",
          kind: "lesson",
          lesson: "02-later",
          at: "2026-01-04T00:00:00.000Z",
        },
      ]);
      expect(broadcasts).toEqual([...entries]);
      expect([...seen].sort()).toEqual([
        "01-earlier",
        "02-later",
        "already-seen",
      ]);
      await expect(readTranscript(paths.courseDir)).resolves.toEqual([
        {
          role: "agent",
          kind: "lesson",
          lesson: "already-seen",
          at: "2026-01-01T00:00:00.000Z",
        },
        ...entries,
      ]);
    } finally {
      await rm(coursesDir, { force: true, recursive: true });
    }
  });

  test("appends first-seen lesson watcher events once including snapshots", async () => {
    const coursesDir = await mkdtemp(join(tmpdir(), "overlearn-lessons-"));
    const env = { OVERLEARN_COURSES_DIR: coursesDir };

    try {
      const paths = await ensureCourseScaffold("lessons", env);
      const seen = lessonTranscriptIds(await readTranscript(paths.courseDir));
      const broadcasts: TranscriptEntry[] = [];

      const first = await appendFirstSeenLessonTranscripts(
        paths.courseDir,
        seen,
        {
          action: "upsert",
          lesson: {
            id: "01-intro",
            html: "<h1>Intro</h1>",
            modifiedAtMs: 1,
          },
        },
        (entry) => broadcasts.push(entry),
      );
      const duplicate = await appendFirstSeenLessonTranscripts(
        paths.courseDir,
        seen,
        {
          action: "upsert",
          lesson: {
            id: "01-intro",
            html: "<h1>Intro edited</h1>",
            modifiedAtMs: 2,
          },
        },
        (entry) => broadcasts.push(entry),
      );
      const snapshot = await appendFirstSeenLessonTranscripts(
        paths.courseDir,
        seen,
        {
          action: "snapshot",
          snapshot: {
            selectedLessonId: "02-next",
            lessons: [
              {
                id: "01-intro",
                html: "<h1>Intro</h1>",
                modifiedAtMs: 1,
              },
              {
                id: "02-next",
                html: "<h1>Next</h1>",
                modifiedAtMs: 2,
              },
            ],
          },
        },
        (entry) => broadcasts.push(entry),
      );

      expect(first).toHaveLength(1);
      expect(duplicate).toEqual([]);
      expect(snapshot).toHaveLength(1);
      expect(first[0]).toMatchObject({
        role: "agent",
        kind: "lesson",
        lesson: "01-intro",
      });
      expect(snapshot[0]).toMatchObject({
        role: "agent",
        kind: "lesson",
        lesson: "02-next",
      });
      expect(broadcasts).toEqual([...first, ...snapshot]);
      expect(
        (await readTranscript(paths.courseDir)).map((entry) =>
          entry.kind === "lesson" ? entry.lesson : undefined,
        ),
      ).toEqual(["01-intro", "02-next"]);
    } finally {
      await rm(coursesDir, { force: true, recursive: true });
    }
  });

  test("dedupes Feynman checks by issuedAt", async () => {
    const coursesDir = await mkdtemp(join(tmpdir(), "overlearn-feynman-"));
    const env = { OVERLEARN_COURSES_DIR: coursesDir };

    try {
      const paths = await ensureCourseScaffold("feynman", env);
      const broadcasts: TranscriptEntry[] = [];
      const firstCheck: ActiveFeynmanCheck = {
        concept: "rule-of-72",
        prompt: "Explain why 72 works.",
        keyPoints: ["doubling"],
        issuedAt: "2026-01-01T00:00:00.000Z",
      };
      const secondCheck: ActiveFeynmanCheck = {
        concept: "compound-growth",
        prompt: "Explain compounding.",
        keyPoints: [],
        issuedAt: "2026-01-02T00:00:00.000Z",
      };

      const first = await appendNewFeynmanCheckTranscript(
        paths.courseDir,
        firstCheck,
        latestFeynmanCheckIssuedAt(await readTranscript(paths.courseDir)),
        (entry) => broadcasts.push(entry),
      );
      const duplicate = await appendNewFeynmanCheckTranscript(
        paths.courseDir,
        firstCheck,
        first.lastRecordedIssuedAt,
        (entry) => broadcasts.push(entry),
      );
      const second = await appendNewFeynmanCheckTranscript(
        paths.courseDir,
        secondCheck,
        duplicate.lastRecordedIssuedAt,
        (entry) => broadcasts.push(entry),
      );

      expect(first.entry).toEqual({
        role: "agent",
        kind: "feynman-check",
        concept: "rule-of-72",
        prompt: "Explain why 72 works.",
        at: "2026-01-01T00:00:00.000Z",
      });
      expect(duplicate.entry).toBeUndefined();
      expect(second.entry).toEqual({
        role: "agent",
        kind: "feynman-check",
        concept: "compound-growth",
        prompt: "Explain compounding.",
        at: "2026-01-02T00:00:00.000Z",
      });
      if (first.entry === undefined || second.entry === undefined) {
        throw new Error("Expected Feynman check entries to be appended.");
      }

      expect(broadcasts).toEqual([first.entry, second.entry]);
      expect(latestFeynmanCheckIssuedAt(await readTranscript(paths.courseDir))).toBe(
        "2026-01-02T00:00:00.000Z",
      );
    } finally {
      await rm(coursesDir, { force: true, recursive: true });
    }
  });

  test("appends and broadcasts Feynman answers", async () => {
    const coursesDir = await mkdtemp(join(tmpdir(), "overlearn-answer-"));
    const env = { OVERLEARN_COURSES_DIR: coursesDir };

    try {
      const paths = await ensureCourseScaffold("answer", env);
      const broadcasts: TranscriptEntry[] = [];
      const entry = await appendFeynmanAnswerTimelineEntry(
        paths.courseDir,
        "rule-of-72",
        "It estimates doubling time from the growth rate.",
        "2026-01-01T00:00:00.000Z",
        (message) => broadcasts.push(message),
      );

      expect(entry).toEqual({
        role: "learner",
        kind: "feynman-answer",
        concept: "rule-of-72",
        text: "It estimates doubling time from the growth rate.",
        at: "2026-01-01T00:00:00.000Z",
      });
      expect(broadcasts).toEqual([entry]);
      await expect(readTranscript(paths.courseDir)).resolves.toEqual([entry]);
    } finally {
      await rm(coursesDir, { force: true, recursive: true });
    }
  });
});
