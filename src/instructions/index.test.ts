import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  assembleInstructionModules,
  formatInstructions,
  formatInstructionsJson,
  getUserInstructionDir,
  resolveModule,
} from "./index";

type NamedModule = Readonly<{ name: string }>;

const writeModule = async (
  dir: string,
  name: string,
  content: string,
): Promise<string> => {
  await mkdir(dir, { recursive: true });

  const path = join(dir, `${name}.md`);
  await writeFile(path, content, "utf8");
  return path;
};

const moduleByName = <T extends NamedModule>(
  modules: readonly T[],
  name: string,
): T => {
  const module = modules.find((candidate) => candidate.name === name);

  if (module === undefined) {
    throw new Error(`Missing module: ${name}`);
  }

  return module;
};

describe("instructions", () => {
  test("resolves built-in modules", () => {
    expect(resolveModule("pedagogy")).toEqual({
      source: "builtin",
      content: expect.stringContaining("Ask ONE question at a time."),
    });
  });

  test("assembles modules with stable separators", () => {
    const text = formatInstructions();

    expect(text).toContain("## module: pedagogy");
    expect(text).toContain("## module: protocol");
    expect(text).toContain("## module: demos");
    expect(text).toContain("## module: grading");
    expect(text).toContain("The daemon injects this protocol");
    expect(text).toContain("overlearn-teaching");
    expect(text).toContain("get_course_state");
    expect(text).toContain('{"type":"session-done"}');
    expect(text).toContain("The daemon will close the harness session");
  });

  test("formats JSON with module metadata and assembled text", () => {
    const parsed = JSON.parse(formatInstructionsJson()) as {
      modules: readonly { name: string; source: string; path: string | null }[];
      text: string;
    };

    expect(parsed.modules).toHaveLength(assembleInstructionModules().length);
    expect(parsed.modules[0]).toEqual(
      expect.objectContaining({
        name: "pedagogy",
        source: "builtin",
        path: null,
      }),
    );
    expect(parsed.text).toContain("## module: pedagogy");
  });

  test("resolves user-only, course-only, and both-present layer precedence", async () => {
    const home = await mkdtemp(join(tmpdir(), "overlearn-home-"));
    const courseDir = await mkdtemp(join(tmpdir(), "overlearn-course-"));
    const userDir = getUserInstructionDir({ OVERLEARN_HOME: home });
    const courseInstructionsDir = join(courseDir, "instructions");

    try {
      const userOnlyDemos = await writeModule(
        userDir,
        "demos",
        "# User Demos\n",
      );
      const userOnlyProtocol = await writeModule(
        userDir,
        "protocol",
        "# User Protocol\n",
      );
      expect(resolveModule("demos", { env: { OVERLEARN_HOME: home } })).toEqual({
        source: "user",
        path: userOnlyDemos,
        content: "# User Demos",
      });
      expect(
        resolveModule("protocol", { env: { OVERLEARN_HOME: home } }),
      ).toEqual({
        source: "user",
        path: userOnlyProtocol,
        content: "# User Protocol",
      });

      await rm(userDir, { force: true, recursive: true });

      const courseOnlyDemos = await writeModule(
        courseInstructionsDir,
        "demos",
        "# Course Demos\n",
      );
      const courseOnlyProtocol = await writeModule(
        courseInstructionsDir,
        "protocol",
        "# Course Protocol\n",
      );
      expect(
        resolveModule("demos", {
          courseDir,
          env: { OVERLEARN_HOME: home },
        }),
      ).toEqual({
        source: "course",
        path: courseOnlyDemos,
        content: "# Course Demos",
      });
      expect(
        resolveModule("protocol", {
          courseDir,
          env: { OVERLEARN_HOME: home },
        }),
      ).toEqual({
        source: "course",
        path: courseOnlyProtocol,
        content: "# Course Protocol",
      });

      const userDemos = await writeModule(userDir, "demos", "# User Demos\n");
      const courseDemos = await writeModule(
        courseInstructionsDir,
        "demos",
        "# Course Demos\n",
      );
      const userProtocol = await writeModule(
        userDir,
        "protocol",
        "# User Protocol\n",
      );
      const courseProtocol = await writeModule(
        courseInstructionsDir,
        "protocol",
        "# Course Protocol\n",
      );

      expect(
        resolveModule("demos", {
          courseDir,
          env: { OVERLEARN_HOME: home },
        }),
      ).toEqual({
        source: "user",
        path: userDemos,
        content: "# User Demos",
      });
      expect(courseDemos).toBe(join(courseInstructionsDir, "demos.md"));

      expect(
        resolveModule("protocol", {
          courseDir,
          env: { OVERLEARN_HOME: home },
        }),
      ).toEqual({
        source: "course",
        path: courseProtocol,
        content: "# Course Protocol",
      });
      expect(userProtocol).toBe(join(userDir, "protocol.md"));
    } finally {
      await rm(home, { force: true, recursive: true });
      await rm(courseDir, { force: true, recursive: true });
    }
  });

  test("enforces style-vs-content precedence for every course-shipped module", async () => {
    const home = await mkdtemp(join(tmpdir(), "overlearn-home-"));
    const courseDir = await mkdtemp(join(tmpdir(), "overlearn-course-"));
    const userDir = getUserInstructionDir({ OVERLEARN_HOME: home });
    const courseInstructionsDir = join(courseDir, "instructions");

    try {
      await Promise.all([
        writeModule(userDir, "pedagogy", "# User Pedagogy\n"),
        writeModule(courseInstructionsDir, "pedagogy", "# Course Pedagogy\n"),
        writeModule(userDir, "demos", "# User Demos\n"),
        writeModule(courseInstructionsDir, "demos", "# Course Demos\n"),
        writeModule(userDir, "protocol", "# User Protocol\n"),
        writeModule(courseInstructionsDir, "protocol", "# Course Protocol\n"),
        writeModule(userDir, "grading", "# User Grading\n"),
        writeModule(courseInstructionsDir, "grading", "# Course Grading\n"),
      ]);

      const options = { courseDir, env: { OVERLEARN_HOME: home } };

      expect(resolveModule("pedagogy", options)).toEqual(
        expect.objectContaining({
          source: "user",
          content: "# User Pedagogy",
        }),
      );
      expect(resolveModule("demos", options)).toEqual(
        expect.objectContaining({
          source: "user",
          content: "# User Demos",
        }),
      );
      expect(resolveModule("protocol", options)).toEqual(
        expect.objectContaining({
          source: "course",
          content: "# Course Protocol",
        }),
      );
      expect(resolveModule("grading", options)).toEqual(
        expect.objectContaining({
          source: "course",
          content: "# Course Grading",
        }),
      );
    } finally {
      await rm(home, { force: true, recursive: true });
      await rm(courseDir, { force: true, recursive: true });
    }
  });

  test("formats provenance annotations for resolved modules", async () => {
    const home = await mkdtemp(join(tmpdir(), "overlearn-home-"));
    const userDir = getUserInstructionDir({ OVERLEARN_HOME: home });

    try {
      await writeModule(userDir, "demos", "# User Demos\n");
      const modules = assembleInstructionModules({
        env: { OVERLEARN_HOME: home },
      });

      const text = formatInstructions(modules);
      expect(text).toContain("## module: pedagogy (builtin)");
      expect(text).toContain("## module: demos (user override)");

      const parsed = JSON.parse(formatInstructionsJson(modules)) as {
        modules: readonly { name: string; source: string; path: string | null }[];
      };
      const demosModule = parsed.modules.find((module) => module.name === "demos");
      expect(demosModule).toEqual(
        expect.objectContaining({
          source: "user",
          path: join(userDir, "demos.md"),
        }),
      );
    } finally {
      await rm(home, { force: true, recursive: true });
    }
  });

  test("user demos override changes only demos output", async () => {
    const home = await mkdtemp(join(tmpdir(), "overlearn-home-"));
    const userDir = getUserInstructionDir({ OVERLEARN_HOME: home });

    try {
      await writeModule(userDir, "demos", "# Custom Demo Design\n");

      const modules = assembleInstructionModules({
        env: { OVERLEARN_HOME: home },
      });
      const pedagogy = moduleByName(modules, "pedagogy");
      const demos = moduleByName(modules, "demos");

      expect(demos).toEqual(
        expect.objectContaining({
          source: "user",
          content: "# Custom Demo Design",
        }),
      );
      expect(pedagogy).toEqual(
        expect.objectContaining({
          source: "builtin",
          content: expect.stringContaining("Ask ONE question at a time."),
        }),
      );
    } finally {
      await rm(home, { force: true, recursive: true });
    }
  });
});
