import { describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  ensureCourseScaffold,
  requireCourse,
  resolveCourseDirForWait,
  upsertGlossaryEntry,
} from "./index";

describe("course resolution", () => {
  test("resolves the only course in OVERLEARN_COURSES_DIR for no-arg wait", async () => {
    const coursesDir = await mkdtemp(join(tmpdir(), "overlearn-courses-"));
    const env = { OVERLEARN_COURSES_DIR: coursesDir };

    try {
      const paths = await ensureCourseScaffold("single", env);

      await expect(resolveCourseDirForWait(undefined, env, tmpdir())).resolves.toBe(
        paths.courseDir,
      );
    } finally {
      await rm(coursesDir, { force: true, recursive: true });
    }
  });

  test("requires an existing course for resume", async () => {
    const coursesDir = await mkdtemp(join(tmpdir(), "overlearn-courses-"));
    const env = { OVERLEARN_COURSES_DIR: coursesDir };

    try {
      const paths = await ensureCourseScaffold("existing", env);

      await expect(requireCourse("existing", env)).resolves.toEqual(paths);
    } finally {
      await rm(coursesDir, { force: true, recursive: true });
    }
  });

  test("missing resume course reports available courses", async () => {
    const coursesDir = await mkdtemp(join(tmpdir(), "overlearn-courses-"));
    const env = { OVERLEARN_COURSES_DIR: coursesDir };

    try {
      await ensureCourseScaffold("alpha", env);
      await ensureCourseScaffold("beta", env);

      await expect(requireCourse("missing", env)).rejects.toThrow(
        [
          `Cannot resume course "missing": ${join(
            coursesDir,
            "missing",
            "course.json",
          )} does not exist.`,
          `Available courses in ${coursesDir}: alpha, beta.`,
        ].join("\n"),
      );
    } finally {
      await rm(coursesDir, { force: true, recursive: true });
    }
  });
});

describe("glossary storage", () => {
  test("creates and case-insensitively updates glossary entries", async () => {
    const coursesDir = await mkdtemp(join(tmpdir(), "overlearn-glossary-"));
    const env = { OVERLEARN_COURSES_DIR: coursesDir };

    try {
      const paths = await ensureCourseScaffold("glossary", env);
      await writeFile(join(paths.lessonsDir, "01-intro.md"), "# Intro\n", "utf8");

      const created = await upsertGlossaryEntry(
        paths.courseDir,
        {
          term: "State",
          def: "A remembered value.",
          lesson: "01-intro",
        },
        new Date("2026-01-01T00:00:00Z"),
      );

      expect(created).toEqual({
        action: "created",
        entry: {
          term: "State",
          def: "A remembered value.",
          lesson: "01-intro",
          addedAt: "2026-01-01T00:00:00.000Z",
        },
      });

      const updated = await upsertGlossaryEntry(paths.courseDir, {
        term: "state",
        def: "Updated definition.",
      });

      expect(updated).toEqual({
        action: "updated",
        entry: {
          term: "state",
          def: "Updated definition.",
          lesson: "01-intro",
          addedAt: "2026-01-01T00:00:00.000Z",
        },
      });

      const stored = JSON.parse(
        await readFile(paths.glossaryJson, "utf8"),
      ) as unknown;

      expect(stored).toEqual([
        {
          term: "state",
          def: "Updated definition.",
          lesson: "01-intro",
          addedAt: "2026-01-01T00:00:00.000Z",
        },
      ]);
    } finally {
      await rm(coursesDir, { force: true, recursive: true });
    }
  });

  test("rejects empty fields and missing lesson ids", async () => {
    const coursesDir = await mkdtemp(join(tmpdir(), "overlearn-glossary-"));
    const env = { OVERLEARN_COURSES_DIR: coursesDir };

    try {
      const paths = await ensureCourseScaffold("glossary", env);

      await expect(
        upsertGlossaryEntry(paths.courseDir, {
          term: " ",
          def: "Definition.",
        }),
      ).rejects.toThrow("Glossary term cannot be empty.");

      await expect(
        upsertGlossaryEntry(paths.courseDir, {
          term: "State",
          def: "Definition.",
          lesson: "missing",
        }),
      ).rejects.toThrow("Lesson does not exist: missing");
    } finally {
      await rm(coursesDir, { force: true, recursive: true });
    }
  });
});
