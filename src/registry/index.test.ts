import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  assertRegistryBundle,
  buildRegistryBundle,
  fetchCourse,
  parseCourseSlug,
  type RegistryBundle,
} from "./index";

const tempRoots = new Set<string>();

const writeJson = async (path: string, value: unknown): Promise<void> => {
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, "utf8");
};

const createFixtureCourse = async (): Promise<string> => {
  const root = await mkdtemp(join(tmpdir(), "overlearn-registry-"));
  tempRoots.add(root);

  const courseDir = join(root, "source");
  await mkdir(join(courseDir, "lessons"), { recursive: true });
  await mkdir(join(courseDir, "demos"), { recursive: true });
  await mkdir(join(courseDir, "instructions"), { recursive: true });
  await mkdir(join(courseDir, ".overlearn"), { recursive: true });

  await writeJson(join(courseDir, "course.json"), {
    formatVersion: 1,
    name: "Compound Interest",
    createdAt: "2026-01-01T00:00:00.000Z",
    topics: [
      {
        path: "growth",
        title: "Growth",
        lesson: "01-growth",
        current: true,
        demos: [
          {
            file: "growth.html",
            title: "Growth curve",
            addedAt: "2026-01-01T00:01:00.000Z",
          },
        ],
        children: [],
      },
    ],
    unassignedDemos: [],
  });
  await writeJson(join(courseDir, "glossary.json"), [
    {
      term: "Compounding",
      def: "Growth on prior growth.",
      addedAt: "2026-01-01T00:02:00.000Z",
    },
  ]);
  await writeFile(join(courseDir, "lessons", "01-growth.md"), "# Growth\n", "utf8");
  await writeFile(join(courseDir, "demos", "growth.html"), "<h1>Growth</h1>\n", "utf8");
  await writeFile(
    join(courseDir, "instructions", "coach.md"),
    "Teach with examples.\n",
    "utf8",
  );
  await writeFile(join(courseDir, "transcript.jsonl"), "private transcript\n", "utf8");
  await writeJson(join(courseDir, "mastery.json"), [{ private: true }]);
  await writeFile(join(courseDir, ".overlearn", "daemon.json"), "private\n", "utf8");

  return courseDir;
};

const mockBundleFetch = (bundle: RegistryBundle): (() => void) => {
  const originalFetch = globalThis.fetch;
  const mockedFetch = Object.assign(
    async (input: string | URL | Request) => {
      const url = new URL(input.toString());
      if (url.pathname === "/api/courses/compound-interest/bundle") {
        return Response.json(bundle);
      }

      return new Response("not found", { status: 404 });
    },
    { preconnect: originalFetch.preconnect },
  ) as typeof fetch;

  globalThis.fetch = mockedFetch;

  return () => {
    globalThis.fetch = originalFetch;
  };
};

afterEach(async () => {
  await Promise.all(
    [...tempRoots].map((root) => rm(root, { recursive: true, force: true })),
  );
  tempRoots.clear();
});

describe("registry source bundles", () => {
  test("include source files and exclude personal runtime data", async () => {
    const courseDir = await createFixtureCourse();
    const bundle = await buildRegistryBundle(courseDir);

    expect(Object.keys(bundle.files).sort()).toEqual([
      "course.json",
      "demos/growth.html",
      "glossary.json",
      "instructions/coach.md",
      "lessons/01-growth.md",
    ]);
    expect(JSON.stringify(bundle)).not.toContain("private transcript");
    expect(JSON.stringify(bundle)).not.toContain("mastery");
    expect(JSON.stringify(bundle)).not.toContain(".overlearn");
  });

  test("rejects private or unsafe bundle paths", () => {
    expect(() =>
      assertRegistryBundle({
        formatVersion: 1,
        files: {
          "course.json": "{}",
          "transcript.jsonl": "private",
        },
      }),
    ).toThrow("Invalid registry bundle path");

    expect(() =>
      assertRegistryBundle({
        formatVersion: 1,
        files: {
          "course.json": "{}",
          "../course.json": "escape",
        },
      }),
    ).toThrow("Invalid registry bundle path");
  });

  test("parses course slugs from direct values and registry URLs", () => {
    expect(parseCourseSlug("compound-interest")).toBe("compound-interest");
    expect(parseCourseSlug("https://overlearn.org/c/compound-interest")).toBe(
      "compound-interest",
    );
    expect(
      parseCourseSlug("https://overlearn.org/api/courses/compound-interest/bundle"),
    ).toBe("compound-interest");
  });
});

describe("registry fetch", () => {
  test("downloads a source bundle and refuses overwrites without force", async () => {
    const sourceDir = await createFixtureCourse();
    const bundle = await buildRegistryBundle(sourceDir);
    const restoreFetch = mockBundleFetch(bundle);
    const registryUrl = "https://registry.test";
    const coursesDir = await mkdtemp(join(tmpdir(), "overlearn-fetch-"));
    tempRoots.add(coursesDir);

    try {
      const output = await fetchCourse({
        input: `${registryUrl}/c/compound-interest`,
        force: false,
        json: true,
        env: {
          OVERLEARN_COURSES_DIR: coursesDir,
          OVERLEARN_REGISTRY_URL: registryUrl,
        },
      });
      const parsed = JSON.parse(output) as { courseDir: string; slug: string };

      expect(parsed.slug).toBe("compound-interest");
      await expect(readFile(join(parsed.courseDir, "course.json"), "utf8")).resolves.toContain(
        "Compound Interest",
      );
      await expect(readFile(join(parsed.courseDir, "lessons", "01-growth.md"), "utf8")).resolves.toBe(
        "# Growth\n",
      );
      await expect(readFile(join(parsed.courseDir, "transcript.jsonl"), "utf8")).rejects.toThrow();
      await expect(readFile(join(parsed.courseDir, "mastery.json"), "utf8")).rejects.toThrow();

      await expect(
        fetchCourse({
          input: "compound-interest",
          force: false,
          json: false,
          env: {
            OVERLEARN_COURSES_DIR: coursesDir,
            OVERLEARN_REGISTRY_URL: registryUrl,
          },
        }),
      ).rejects.toThrow("Refusing to overwrite existing course directory");

      await expect(
        fetchCourse({
          input: "compound-interest",
          force: true,
          json: false,
          env: {
            OVERLEARN_COURSES_DIR: coursesDir,
            OVERLEARN_REGISTRY_URL: registryUrl,
          },
        }),
      ).resolves.toBe(join(coursesDir, "compound-interest"));
    } finally {
      restoreFetch();
    }
  });
});
