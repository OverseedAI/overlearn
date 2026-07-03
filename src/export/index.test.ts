import { afterEach, describe, expect, test } from "bun:test";
import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, sep } from "node:path";

import { exportCourse } from "./index";

const tempRoots = new Set<string>();

const toSitePath = (path: string): string => path.split(sep).join("/");

const writeJson = async (path: string, value: unknown): Promise<void> => {
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, "utf8");
};

const listFiles = async (
  directory: string,
  prefix = "",
): Promise<readonly string[]> => {
  const entries = await readdir(directory, { withFileTypes: true });
  const files: string[] = [];

  for (const entry of entries) {
    const relativePath = prefix.length === 0 ? entry.name : join(prefix, entry.name);
    const absolutePath = join(directory, entry.name);

    if (entry.isDirectory()) {
      files.push(...(await listFiles(absolutePath, relativePath)));
    } else {
      files.push(toSitePath(relativePath));
    }
  }

  return files.sort((left, right) => left.localeCompare(right));
};

const createFixtureCourse = async (): Promise<string> => {
  const root = await mkdtemp(join(tmpdir(), "overlearn-export-"));
  tempRoots.add(root);

  const courseDir = join(root, "course");
  await mkdir(join(courseDir, "lessons"), { recursive: true });
  await mkdir(join(courseDir, "demos"), { recursive: true });
  await mkdir(join(courseDir, ".overlearn"), { recursive: true });

  await writeJson(join(courseDir, "course.json"), {
    formatVersion: 1,
    name: "compound-course",
    createdAt: "2026-01-01T00:00:00.000Z",
    topics: [
      {
        path: "growth",
        title: "Growth",
        lesson: "01-growth",
        enteredAt: "2026-01-01T00:00:00.000Z",
        current: true,
        demos: [
          {
            file: "growth.html",
            title: "Growth curve",
            addedAt: "2026-01-01T00:01:00.000Z",
          },
        ],
        children: [
          {
            path: "growth/rate",
            title: "Rate",
            lesson: "02-rate",
            enteredAt: "2026-01-01T00:02:00.000Z",
            current: false,
            children: [],
          },
        ],
      },
    ],
    unassignedDemos: [
      {
        file: "calculator.html",
        title: "Calculator",
        addedAt: "2026-01-01T00:03:00.000Z",
      },
    ],
  });

  await writeFile(
    join(courseDir, "lessons", "01-growth.md"),
    [
      "# Growth Basics",
      "",
      "Compounding turns growth into growth-on-growth.",
      "",
      "External reading becomes inert in export: [reference](https://example.com).",
      "",
      ':::demo growth.html "Growth curve"',
      "",
    ].join("\n"),
    "utf8",
  );
  await writeFile(
    join(courseDir, "lessons", "02-rate.md"),
    "# Rate\n\nA rate describes how fast compounding happens.\n",
    "utf8",
  );
  await writeFile(
    join(courseDir, "demos", "growth.html"),
    "<!doctype html><html><body><h1>Growth demo</h1><script>document.body.dataset.ready = 'yes';</script></body></html>\n",
    "utf8",
  );
  await writeFile(
    join(courseDir, "demos", "calculator.html"),
    "<!doctype html><html><body><h1>Calculator demo</h1></body></html>\n",
    "utf8",
  );
  await writeJson(join(courseDir, "glossary.json"), [
    {
      term: "Compounding",
      def: "Growth that earns growth on prior growth.",
      lesson: "01-growth",
      addedAt: "2026-01-01T00:04:00.000Z",
    },
  ]);
  await writeJson(join(courseDir, "mastery.json"), [
    { topic: "private mastery", status: "practiced" },
  ]);
  await writeFile(
    join(courseDir, "transcript.jsonl"),
    [
      JSON.stringify({
        role: "learner",
        text: "private learner note about compounding",
        at: "2026-01-01T00:05:00.000Z",
      }),
      JSON.stringify({
        role: "agent",
        kind: "demo",
        file: "calculator.html",
        title: "Calculator",
        at: "2026-01-01T00:06:00.000Z",
      }),
    ].join("\n") + "\n",
    "utf8",
  );
  await writeFile(join(courseDir, ".overlearn", "secret.txt"), "runtime secret\n", "utf8");

  return courseDir;
};

afterEach(async () => {
  await Promise.all(
    [...tempRoots].map((root) => rm(root, { recursive: true, force: true })),
  );
  tempRoots.clear();
});

describe("static course export", () => {
  test("refuses a nonempty output directory without force", async () => {
    const courseDir = await createFixtureCourse();
    const outDir = join(courseDir, "site");
    await mkdir(outDir);
    await writeFile(join(outDir, "stale.txt"), "stale\n", "utf8");

    await expect(exportCourse({ courseDir, outDir })).rejects.toThrow(
      "Refusing to write into nonempty export directory",
    );
  });

  test("refuses dangerous output directories even with force", async () => {
    const courseDir = await createFixtureCourse();

    await expect(
      exportCourse({ courseDir, outDir: courseDir, force: true }),
    ).rejects.toThrow("contains the course directory");

    await expect(
      exportCourse({
        courseDir,
        outDir: join(courseDir, ".overlearn", "export"),
        force: true,
      }),
    ).rejects.toThrow("runtime directory");
  });

  test("excludes personal runtime data by default", async () => {
    const courseDir = await createFixtureCourse();
    const outDir = join(courseDir, "site");
    const result = await exportCourse({ courseDir, outDir });
    const files = await listFiles(outDir);
    const indexHtml = await readFile(join(outDir, "index.html"), "utf8");

    expect(result.files).toContain("index.html");
    expect(files).toContain("assets/site.css");
    expect(files).toContain("assets/site.js");
    expect(files).not.toContain("transcript.html");
    expect(files).not.toContain("transcript.jsonl");
    expect(files).not.toContain("mastery.json");
    expect(files.some((file) => file.startsWith(".overlearn/"))).toBe(false);
    expect(indexHtml).not.toContain("private learner note");
    expect(indexHtml).not.toContain("private mastery");
    expect(indexHtml).not.toContain("runtime secret");
  });

  test("includes rendered transcript only when requested", async () => {
    const courseDir = await createFixtureCourse();
    const outDir = join(courseDir, "site");

    await exportCourse({ courseDir, outDir, includeTranscript: true });

    const files = await listFiles(outDir);
    const transcriptHtml = await readFile(join(outDir, "transcript.html"), "utf8");

    expect(files).toContain("transcript.html");
    expect(files).not.toContain("transcript.jsonl");
    expect(transcriptHtml).toContain("private learner note about");
    expect(transcriptHtml).toContain('data-term="Compounding"');
    expect(transcriptHtml).toContain("Calculator");
  });

  test("writes only relative generated href and src references", async () => {
    const courseDir = await createFixtureCourse();
    const outDir = join(courseDir, "site");
    await exportCourse({ courseDir, outDir });

    const htmlFiles = (await listFiles(outDir)).filter((file) =>
      file.endsWith(".html"),
    );

    for (const file of htmlFiles) {
      const html = await readFile(join(outDir, ...file.split("/")), "utf8");
      const refs = [...html.matchAll(/\b(?:href|src)=["']([^"']+)["']/g)].map(
        (match) => match[1] ?? "",
      );

      for (const ref of refs) {
        expect(
          ref.startsWith("./") || ref.startsWith("../") || ref.startsWith("#"),
        ).toBe(true);
      }
    }

    const siteJs = await readFile(join(outDir, "assets", "site.js"), "utf8");
    expect(siteJs).not.toMatch(/\b(fetch|XMLHttpRequest|EventSource)\b/);
  });

  test("copies demo files verbatim", async () => {
    const courseDir = await createFixtureCourse();
    const outDir = join(courseDir, "site");
    await exportCourse({ courseDir, outDir });

    await expect(
      readFile(join(outDir, "demos", "growth.html"), "utf8"),
    ).resolves.toBe(
      "<!doctype html><html><body><h1>Growth demo</h1><script>document.body.dataset.ready = 'yes';</script></body></html>\n",
    );
  });

  test("renders lessons, glossary hovers, topic links, and demo iframes", async () => {
    const courseDir = await createFixtureCourse();
    const outDir = join(courseDir, "site");
    await exportCourse({ courseDir, outDir });

    const indexHtml = await readFile(join(outDir, "index.html"), "utf8");
    const lessonHtml = await readFile(
      join(outDir, "lessons", "01-growth.html"),
      "utf8",
    );
    const glossaryHtml = await readFile(join(outDir, "glossary.html"), "utf8");

    expect(indexHtml).toContain('href="./lessons/01-growth.html"');
    expect(indexHtml).toContain('id="demo-growth-html"');
    expect(indexHtml).toContain('src="./demos/growth.html"');
    expect(lessonHtml).toContain(
      '<span class="term" data-term="Compounding" tabindex="0">Compounding</span>',
    );
    expect(lessonHtml).toContain('href="#"');
    expect(lessonHtml).toContain('src="../demos/growth.html"');
    expect(lessonHtml).toContain('sandbox="allow-scripts"');
    expect(glossaryHtml).toContain("Growth that earns growth on prior growth.");
    expect(glossaryHtml).toContain('href="./lessons/01-growth.html"');
  });
});
