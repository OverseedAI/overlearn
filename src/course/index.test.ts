import { describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  ensureCourseScaffold,
  requireCourse,
  resolveCourseDirForWait,
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
