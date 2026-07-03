import { describe, expect, test } from "bun:test";
import {
  mkdir,
  mkdtemp,
  rm,
  utimes,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  createLessonEventEmitter,
  readLessonSnapshot,
  type LessonEvent,
} from "./lessons";

const sleep = async (milliseconds: number): Promise<void> => {
  await new Promise((resolve) => setTimeout(resolve, milliseconds));
};

const waitFor = async (
  condition: () => boolean,
  label: string,
): Promise<void> => {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (condition()) {
      return;
    }

    await sleep(10);
  }

  throw new Error(`Timed out waiting for ${label}.`);
};

describe("lessons", () => {
  test("reads lessons ordered by filename and selects the most recently modified lesson", async () => {
    const courseDir = await mkdtemp(join(tmpdir(), "overlearn-lessons-"));
    const lessonsDir = join(courseDir, "lessons");

    try {
      await mkdir(lessonsDir);

      const newerPath = join(lessonsDir, "01-newer.md");
      const olderPath = join(lessonsDir, "02-older.md");
      await writeFile(newerPath, "# Newer\n\nFresh **lesson**", "utf8");
      await writeFile(olderPath, "# Older\n", "utf8");
      await utimes(
        olderPath,
        new Date("2026-01-01T00:00:00Z"),
        new Date("2026-01-01T00:00:00Z"),
      );
      await utimes(
        newerPath,
        new Date("2026-01-02T00:00:00Z"),
        new Date("2026-01-02T00:00:00Z"),
      );

      const snapshot = await readLessonSnapshot(lessonsDir);

      expect(snapshot.lessons.map((lesson) => lesson.id)).toEqual([
        "01-newer",
        "02-older",
      ]);
      expect(snapshot.selectedLessonId).toBe("01-newer");
      expect(snapshot.lessons[0]?.html).toContain("<strong>lesson</strong>");
    } finally {
      await rm(courseDir, { force: true, recursive: true });
    }
  });

  test("debounces lesson file events and emits rendered upsert and delete events", async () => {
    const courseDir = await mkdtemp(join(tmpdir(), "overlearn-lessons-"));
    const lessonsDir = join(courseDir, "lessons");
    const events: LessonEvent[] = [];

    try {
      await mkdir(lessonsDir);
      const lessonPath = join(lessonsDir, "01-intro.md");
      const emitter = createLessonEventEmitter({
        lessonsDir,
        debounceMs: 20,
        emit: (event) => {
          events.push(event);
        },
      });

      try {
        await writeFile(lessonPath, "# First\n", "utf8");
        emitter.scheduleFile("01-intro.md");
        await writeFile(lessonPath, "# Second\n\nUpdated **content**", "utf8");
        emitter.scheduleFile("01-intro.md");

        await waitFor(() => events.length === 1, "lesson upsert event");

        expect(events[0]).toEqual({
          action: "upsert",
          lesson: {
            id: "01-intro",
            html: "<h1>Second</h1><p>Updated <strong>content</strong></p>",
            modifiedAtMs: expect.any(Number),
          },
        });

        await rm(lessonPath);
        emitter.scheduleFile("01-intro.md");

        await waitFor(() => events.length === 2, "lesson delete event");

        expect(events[1]).toEqual({
          action: "delete",
          id: "01-intro",
        });
      } finally {
        emitter.close();
      }
    } finally {
      await rm(courseDir, { force: true, recursive: true });
    }
  });
});
