import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  readDaemonMetadata,
  type TranscriptEntry,
  type TurnFile,
} from "../course";
import { REVIEW_WEAK_NAV_PATH } from "../daemon";

type ProcessResult = Readonly<{
  exitCode: number;
  stdout: string;
  stderr: string;
}>;

type ByteReader = Readonly<{
  read: () => Promise<Readonly<{ done: boolean; value?: unknown }>>;
}>;

type SseProbe = Readonly<{
  waitForStatus: (status: string) => Promise<void>;
  waitForText: (
    needle: string,
    label: string,
    milliseconds?: number,
  ) => Promise<void>;
}>;

const cliPath = fileURLToPath(new URL("./index.ts", import.meta.url));
const liveDaemonPids = new Set<number>();

const sleep = async (milliseconds: number): Promise<void> => {
  await new Promise((resolve) => setTimeout(resolve, milliseconds));
};

const withTimeout = async <T>(
  promise: Promise<T>,
  milliseconds: number,
  label: string,
): Promise<T> => {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  const timeoutPromise = new Promise<never>((_, reject) => {
    timeout = setTimeout(
      () => reject(new Error(`${label} timed out after ${milliseconds}ms`)),
      milliseconds,
    );
  });

  try {
    return await Promise.race([promise, timeoutPromise]);
  } finally {
    if (timeout !== undefined) {
      clearTimeout(timeout);
    }
  }
};

const testEnv = (coursesDir: string): Record<string, string> => {
  const env: Record<string, string> = {};

  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined) {
      env[key] = value;
    }
  }

  env["OVERLEARN_COURSES_DIR"] = coursesDir;
  env["OVERLEARN_NO_BROWSER"] = "1";
  env["OVERLEARN_ORCHESTRATED"] = "0";
  env["NO_COLOR"] = "1";
  delete env["FORCE_COLOR"];

  return env;
};

const streamText = async (
  stream: ReadableStream<Uint8Array> | null,
): Promise<string> => (stream === null ? "" : await new Response(stream).text());

const spawnLearn = (
  args: readonly string[],
  env: Record<string, string>,
): Bun.Subprocess<"ignore", "pipe", "pipe"> =>
  Bun.spawn([process.execPath, cliPath, ...args], {
    env,
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });

const collectProcess = async (
  process: Bun.Subprocess<"ignore", "pipe", "pipe">,
  label: string,
): Promise<ProcessResult> => {
  const exitCode = await withTimeout(process.exited, 5_000, label);
  const [stdout, stderr] = await Promise.all([
    streamText(process.stdout),
    streamText(process.stderr),
  ]);

  return { exitCode, stdout, stderr };
};

const runLearn = async (
  args: readonly string[],
  env: Record<string, string>,
): Promise<ProcessResult> => collectProcess(spawnLearn(args, env), args.join(" "));

const readTranscriptJsonl = async (
  courseDir: string,
): Promise<readonly TranscriptEntry[]> => {
  const contents = await readFile(join(courseDir, "transcript.jsonl"), "utf8");

  return contents
    .trim()
    .split("\n")
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line) as TranscriptEntry);
};

const expectWaitGuidance = (stderr: string, course: string): void => {
  expect(stderr).toContain(`learn wait ${course}`);
  expect(stderr).toContain("foreground blocking command on Codex");
};

const isPidAlive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

const killDaemon = async (pid: number): Promise<void> => {
  if (!isPidAlive(pid)) {
    liveDaemonPids.delete(pid);
    return;
  }

  process.kill(pid, "SIGTERM");

  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (!isPidAlive(pid)) {
      liveDaemonPids.delete(pid);
      return;
    }

    await sleep(25);
  }

  process.kill(pid, "SIGKILL");
  liveDaemonPids.delete(pid);
};

const waitForDaemonStopped = async (
  courseDir: string,
  pid: number,
): Promise<void> => {
  await withTimeout(
    (async () => {
      while (isPidAlive(pid) || (await readDaemonMetadata(courseDir)) !== undefined) {
        await sleep(25);
      }
      liveDaemonPids.delete(pid);
    })(),
    5_000,
    "daemon shutdown",
  );
};

const canBindLocalhost = async (): Promise<boolean> => {
  const server = createServer((_request, response) => {
    response.end("ok");
  });

  try {
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", () => resolve());
    });
  } catch {
    return false;
  } finally {
    if (server.listening) {
      await new Promise<void>((resolve) => {
        server.close(() => resolve());
      });
    }
  }

  return true;
};

const submitMessage = async (url: string, text: string): Promise<void> => {
  const response = await fetch(`${url}/api/submit`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ text }),
  });

  expect(response.status).toBe(200);
};

const submitNav = async (url: string, path: string): Promise<void> => {
  const response = await fetch(`${url}/api/nav`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ path }),
  });

  expect(response.status).toBe(200);
};

const submitDone = async (url: string): Promise<void> => {
  const response = await fetch(`${url}/api/done`, { method: "POST" });

  expect(response.status).toBe(200);
};

const submitFeynmanAnswer = async (
  url: string,
  concept: string,
  text: string,
): Promise<void> => {
  const response = await fetch(`${url}/api/feynman-answer`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ concept, text }),
  });

  expect(response.status).toBe(200);
};

const createSseProbe = (reader: ByteReader): SseProbe => {
  const decoder = new TextDecoder();
  let buffer = "";

  const waitForText = async (
    needle: string,
    label: string,
    milliseconds = 2_000,
  ): Promise<void> => {
    await withTimeout(
      (async () => {
        while (true) {
          if (buffer.includes(needle)) {
            return;
          }

          const chunk = await reader.read();
          if (chunk.done) {
            throw new Error(`SSE stream closed before ${label} arrived.`);
          }

          if (!(chunk.value instanceof Uint8Array)) {
            throw new Error("SSE stream returned a non-byte chunk.");
          }

          buffer += decoder.decode(chunk.value, { stream: true });
        }
      })(),
      milliseconds,
      label,
    );
  };

  return {
    waitForStatus: async (status) =>
      waitForText(`"status":"${status}"`, `SSE status ${status}`),
    waitForText,
  };
};

afterEach(async () => {
  await Promise.all([...liveDaemonPids].map((pid) => killDaemon(pid)));
});

describe("learn start/wait browser round trip", () => {
  test("creates a course, delivers browser input, reconnects, and reports daemon death", async () => {
    if (!(await canBindLocalhost())) {
      if (process.env["CI"] === "true") {
        throw new Error("Localhost binding is unavailable; E2E cannot run.");
      }

      return;
    }

    const coursesDir = await mkdtemp(join(tmpdir(), "overlearn-e2e-"));
    const env = testEnv(coursesDir);
    const courseName = "round-trip";
    const courseDir = join(coursesDir, courseName);

    try {
      const start = await runLearn(["start", courseName], env);

      expect(start.exitCode).toBe(0);
      expect(start.stderr).toBe("");

      const url = start.stdout.trim();
      expect(url).toMatch(/^http:\/\/localhost:\d+$/);

      const daemon = await readDaemonMetadata(courseDir);
      expect(daemon).not.toBeUndefined();

      if (daemon === undefined) {
        throw new Error("Daemon metadata was not written.");
      }

      liveDaemonPids.add(daemon.pid);

      const initialHealth = (await (
        await fetch(`${url}/api/health`)
      ).json()) as { waitPending: boolean };
      expect(initialHealth.waitPending).toBe(false);

      const firstSseAbort = new AbortController();
      const firstSse = await fetch(`${url}/api/events`, {
        signal: firstSseAbort.signal,
      });
      const firstReader = firstSse.body?.getReader();
      if (firstReader === undefined) {
        throw new Error("SSE stream did not open.");
      }
      const firstProbe = createSseProbe(firstReader);

      const lessonPath = join(courseDir, "lessons", "01-intro.md");
      await writeFile(
        lessonPath,
        "# Lesson One\n\nFresh **content** about Gradient.\n\n<script>alert(1)</script>",
        "utf8",
      );
      await firstProbe.waitForText("event: lesson", "SSE lesson event", 1_000);
      await firstProbe.waitForText(
        "<h1>Lesson One</h1>",
        "SSE rendered lesson heading",
        1_000,
      );
      await firstProbe.waitForText(
        "<strong>content</strong>",
        "SSE rendered lesson emphasis",
        1_000,
      );
      await firstProbe.waitForText(
        "&lt;script&gt;alert(1)&lt;/script&gt;",
        "SSE sanitized lesson script",
        1_000,
      );

      await writeFile(
        lessonPath,
        "# Lesson Revised\n\nUpdated **lesson** about Gradient.",
        "utf8",
      );
      await firstProbe.waitForText(
        "<h1>Lesson Revised</h1>",
        "SSE updated lesson heading",
        1_000,
      );
      await firstProbe.waitForText(
        "<strong>lesson</strong>",
        "SSE updated lesson emphasis",
        1_000,
      );

      const emitGlossary = await runLearn(
        [
          "emit",
          "glossary",
          courseName,
          "--term",
          "Gradient",
          "--def",
          "Direction of steepest increase.",
          "--lesson",
          "01-intro",
          "--json",
        ],
        env,
      );

      expect(emitGlossary.exitCode).toBe(0);
      expect(emitGlossary.stderr).toBe("");
      expect(JSON.parse(emitGlossary.stdout) as unknown).toEqual({
        ok: true,
        kind: "glossary",
        action: "created",
        coursePath: courseDir,
        entry: {
          term: "Gradient",
          def: "Direction of steepest increase.",
          lesson: "01-intro",
          addedAt: expect.any(String),
        },
      });

      await firstProbe.waitForText("event: glossary", "SSE glossary event");
      await firstProbe.waitForText(
        "Direction of steepest increase.",
        "SSE glossary definition",
      );
      await firstProbe.waitForText(
        'class=\\"term\\" data-term=\\"Gradient\\"',
        "SSE glossary-linked lesson",
      );

      const updateGlossary = await runLearn(
        [
          "emit",
          "glossary",
          courseName,
          "--term",
          "gradient",
          "--def",
          "Updated direction definition.",
        ],
        env,
      );

      expect(updateGlossary.exitCode).toBe(0);
      expect(updateGlossary.stderr).toBe("");
      expect(updateGlossary.stdout.trim()).toBe("updated glossary term: gradient");

      await firstProbe.waitForText(
        "Updated direction definition.",
        "SSE updated glossary definition",
      );

      const glossaryFile = JSON.parse(
        await readFile(join(courseDir, "glossary.json"), "utf8"),
      ) as unknown;
      expect(glossaryFile).toEqual([
        {
          term: "gradient",
          def: "Updated direction definition.",
          lesson: "01-intro",
          addedAt: expect.any(String),
        },
      ]);

      const emitTopic = await runLearn(
        [
          "emit",
          "topic",
          courseName,
          "--enter",
          "indexes/btree",
          "--title",
          "B-tree",
          "--lesson",
          "01-intro",
          "--json",
        ],
        env,
      );

      expect(emitTopic.exitCode).toBe(0);
      expect(emitTopic.stderr).toBe("");
      expect(JSON.parse(emitTopic.stdout) as unknown).toEqual({
        ok: true,
        kind: "topic",
        action: "created",
        coursePath: courseDir,
        topic: {
          path: "indexes/btree",
          title: "B-tree",
          lesson: "01-intro",
          enteredAt: expect.any(String),
          current: true,
          children: [],
        },
        topics: [
          {
            path: "indexes",
            title: "indexes",
            current: false,
            children: [
              {
                path: "indexes/btree",
                title: "B-tree",
                lesson: "01-intro",
                enteredAt: expect.any(String),
                current: true,
                children: [],
              },
            ],
          },
        ],
      });

      await firstProbe.waitForText("event: topics", "SSE topics event");
      await firstProbe.waitForText(
        '"path":"indexes/btree"',
        "SSE topic path",
      );
      await firstProbe.waitForText('"current":true', "SSE current topic");

      const courseFile = JSON.parse(
        await readFile(join(courseDir, "course.json"), "utf8"),
      ) as unknown;
      expect(courseFile).toMatchObject({
        topics: [
          {
            path: "indexes",
            children: [
              {
                path: "indexes/btree",
                title: "B-tree",
                lesson: "01-intro",
                current: true,
              },
            ],
          },
        ],
      });

      const wait = spawnLearn(["wait"], env);
      await firstProbe.waitForStatus("waiting-for-agent");

      const waitingStatus = await runLearn(["status", courseName, "--json"], env);
      expect(waitingStatus.exitCode).toBe(0);
      expect(waitingStatus.stderr).toBe("");
      expect(JSON.parse(waitingStatus.stdout)).toEqual({
        daemonAlive: true,
        waitPending: true,
        courseDir,
      });

      await submitMessage(url, "hello from the browser");

      const waitResult = await collectProcess(wait, "learn wait");

      expect(waitResult.exitCode).toBe(0);
      expectWaitGuidance(waitResult.stderr, courseName);

      const turnPath = waitResult.stdout.trim();
      expect(turnPath).toBe(join(courseDir, ".overlearn", "turns", "turn-1.json"));

      const workingStatus = await runLearn(["status", courseName, "--json"], env);
      expect(JSON.parse(workingStatus.stdout)).toEqual({
        daemonAlive: true,
        waitPending: false,
        courseDir,
      });

      const turn = JSON.parse(await readFile(turnPath, "utf8")) as TurnFile;
      expect(turn).toEqual({
        turn: 1,
        createdAt: expect.any(String),
        events: [{ type: "message", text: "hello from the browser" }],
      });

      const navWait = spawnLearn(["wait"], env);
      await firstProbe.waitForStatus("waiting-for-agent");

      await submitNav(url, "indexes/btree");

      const navWaitResult = await collectProcess(navWait, "learn wait nav");
      expect(navWaitResult.exitCode).toBe(0);
      expectWaitGuidance(navWaitResult.stderr, courseName);

      const navTurnPath = navWaitResult.stdout.trim();
      expect(navTurnPath).toBe(
        join(courseDir, ".overlearn", "turns", "turn-2.json"),
      );

      const navTurn = JSON.parse(
        await readFile(navTurnPath, "utf8"),
      ) as TurnFile;
      expect(navTurn).toEqual({
        turn: 2,
        createdAt: expect.any(String),
        events: [{ type: "nav", path: "indexes/btree" }],
      });

      await submitNav(url, "indexes/btree");

      const queuedNavWait = await runLearn(["wait", courseName], env);
      expect(queuedNavWait.exitCode).toBe(0);
      expectWaitGuidance(queuedNavWait.stderr, courseName);

      const queuedNavTurnPath = queuedNavWait.stdout.trim();
      expect(queuedNavTurnPath).toBe(
        join(courseDir, ".overlearn", "turns", "turn-3.json"),
      );

      const queuedNavTurn = JSON.parse(
        await readFile(queuedNavTurnPath, "utf8"),
      ) as TurnFile;
      expect(queuedNavTurn).toEqual({
        turn: 3,
        createdAt: expect.any(String),
        events: [{ type: "nav", path: "indexes/btree" }],
      });

      const emitFeynman = await runLearn(
        [
          "emit",
          "feynman",
          courseName,
          "--concept",
          "gradient-basics",
          "--prompt",
          "Explain what a gradient tells you and how you would use it.",
          "--key-points",
          "direction of steepest increase, local rate of change",
          "--json",
        ],
        env,
      );

      expect(emitFeynman.exitCode).toBe(0);
      expect(emitFeynman.stderr).toBe("");
      expect(JSON.parse(emitFeynman.stdout) as unknown).toEqual({
        ok: true,
        kind: "feynman",
        coursePath: courseDir,
        activeCheck: {
          concept: "gradient-basics",
          prompt: "Explain what a gradient tells you and how you would use it.",
          keyPoints: ["direction of steepest increase", "local rate of change"],
          issuedAt: expect.any(String),
        },
      });

      await firstProbe.waitForText("event: feynman", "SSE feynman event", 1_000);
      await firstProbe.waitForText(
        '"concept":"gradient-basics"',
        "SSE feynman concept",
        1_000,
      );

      const feynmanPage = await fetch(url);
      expect(feynmanPage.status).toBe(200);
      const feynmanHtml = await feynmanPage.text();
      expect(feynmanHtml).toContain("Feynman check");
      expect(feynmanHtml).toContain("Explain it back");
      expect(feynmanHtml).toContain(
        "Explain what a gradient tells you and how you would use it.",
      );
      expect(feynmanHtml).toContain("gradient-basics");

      const feynmanWait = spawnLearn(["wait", courseName], env);
      await submitFeynmanAnswer(
        url,
        "gradient-basics",
        "A gradient points in the direction where the output rises fastest, and its size tells the local rate of change.",
      );

      const feynmanWaitResult = await collectProcess(
        feynmanWait,
        "learn wait feynman",
      );
      expect(feynmanWaitResult.exitCode).toBe(0);
      expectWaitGuidance(feynmanWaitResult.stderr, courseName);

      const feynmanTurnPath = feynmanWaitResult.stdout.trim();
      expect(feynmanTurnPath).toBe(
        join(courseDir, ".overlearn", "turns", "turn-4.json"),
      );

      const feynmanTurn = JSON.parse(
        await readFile(feynmanTurnPath, "utf8"),
      ) as TurnFile;
      expect(feynmanTurn).toEqual({
        turn: 4,
        createdAt: expect.any(String),
        events: [
          {
            type: "feynman-answer",
            concept: "gradient-basics",
            text: "A gradient points in the direction where the output rises fastest, and its size tells the local rate of change.",
            keyPoints: ["direction of steepest increase", "local rate of change"],
          },
        ],
      });

      const firstMastery = await runLearn(
        [
          "emit",
          "mastery",
          courseName,
          "--concept",
          "gradient-basics",
          "--score",
          "78",
          "--gaps",
          "needs clearer mechanism",
          "--json",
        ],
        env,
      );
      const secondMastery = await runLearn(
        [
          "emit",
          "mastery",
          courseName,
          "--concept",
          "gradient-basics",
          "--score",
          "91",
          "--gaps",
          "minor precision gap",
          "--json",
        ],
        env,
      );
      const btreeMastery = await runLearn(
        [
          "emit",
          "mastery",
          courseName,
          "--concept",
          "btree",
          "--score",
          "44",
          "--gaps",
          "needs clearer branching-factor explanation",
          "--json",
        ],
        env,
      );
      const indexesMastery = await runLearn(
        [
          "emit",
          "mastery",
          courseName,
          "--concept",
          "indexes",
          "--score",
          "70",
          "--gaps",
          "needs more practice choosing index types",
          "--json",
        ],
        env,
      );

      expect(firstMastery.exitCode).toBe(0);
      expect(firstMastery.stderr).toBe("");
      expect(secondMastery.exitCode).toBe(0);
      expect(secondMastery.stderr).toBe("");
      expect(btreeMastery.exitCode).toBe(0);
      expect(btreeMastery.stderr).toBe("");
      expect(indexesMastery.exitCode).toBe(0);
      expect(indexesMastery.stderr).toBe("");
      expect(JSON.parse(firstMastery.stdout) as unknown).toMatchObject({
        ok: true,
        kind: "mastery",
        coursePath: courseDir,
        entry: {
          concept: "gradient-basics",
          score: 78,
          gaps: "needs clearer mechanism",
          at: expect.any(String),
        },
      });
      expect(JSON.parse(secondMastery.stdout) as unknown).toMatchObject({
        ok: true,
        kind: "mastery",
        coursePath: courseDir,
        entry: {
          concept: "gradient-basics",
          score: 91,
          gaps: "minor precision gap",
          at: expect.any(String),
        },
      });
      expect(JSON.parse(btreeMastery.stdout) as unknown).toMatchObject({
        ok: true,
        kind: "mastery",
        coursePath: courseDir,
        entry: {
          concept: "btree",
          score: 44,
          gaps: "needs clearer branching-factor explanation",
          at: expect.any(String),
        },
      });
      expect(JSON.parse(indexesMastery.stdout) as unknown).toMatchObject({
        ok: true,
        kind: "mastery",
        coursePath: courseDir,
        entry: {
          concept: "indexes",
          score: 70,
          gaps: "needs more practice choosing index types",
          at: expect.any(String),
        },
      });

      const masteryFile = JSON.parse(
        await readFile(join(courseDir, "mastery.json"), "utf8"),
      ) as readonly { concept: string; score: number; gaps: string; at: string }[];
      expect(masteryFile).toEqual([
        {
          concept: "gradient-basics",
          score: 78,
          gaps: "needs clearer mechanism",
          at: expect.any(String),
        },
        {
          concept: "gradient-basics",
          score: 91,
          gaps: "minor precision gap",
          at: expect.any(String),
        },
        {
          concept: "btree",
          score: 44,
          gaps: "needs clearer branching-factor explanation",
          at: expect.any(String),
        },
        {
          concept: "indexes",
          score: 70,
          gaps: "needs more practice choosing index types",
          at: expect.any(String),
        },
      ]);
      expect(masteryFile[0]?.at).not.toBe(masteryFile[1]?.at);
      await firstProbe.waitForText("event: mastery", "SSE mastery event", 1_000);
      await firstProbe.waitForText(
        '"concept":"btree"',
        "SSE mastery concept",
        1_000,
      );

      const reviewWait = spawnLearn(["wait", courseName], env);
      await firstProbe.waitForStatus("waiting-for-agent");

      await submitNav(url, REVIEW_WEAK_NAV_PATH);

      const reviewWaitResult = await collectProcess(
        reviewWait,
        "learn wait review weak",
      );
      expect(reviewWaitResult.exitCode).toBe(0);
      expectWaitGuidance(reviewWaitResult.stderr, courseName);

      const reviewTurnPath = reviewWaitResult.stdout.trim();
      expect(reviewTurnPath).toBe(
        join(courseDir, ".overlearn", "turns", "turn-5.json"),
      );

      const reviewTurn = JSON.parse(
        await readFile(reviewTurnPath, "utf8"),
      ) as TurnFile;
      expect(reviewTurn).toEqual({
        turn: 5,
        createdAt: expect.any(String),
        events: [{ type: "review-weak", concepts: ["btree", "indexes"] }],
      });

      await writeFile(
        join(courseDir, "demos", "growth.html"),
        [
          "<!doctype html>",
          "<html>",
          "<body><button id=\"count\">0</button>",
          "<script>",
          "count.addEventListener('click', () => { count.textContent = String(Number(count.textContent) + 1); });",
          "</script></body>",
          "</html>",
        ].join(""),
        "utf8",
      );

      const emitDemo = await runLearn(
        [
          "emit",
          "demo",
          courseName,
          "--file",
          "growth.html",
          "--topic",
          "indexes/btree",
          "--title",
          "Growth curve",
          "--json",
        ],
        env,
      );

      expect(emitDemo.exitCode).toBe(0);
      expect(emitDemo.stderr).toBe("");
      expect(JSON.parse(emitDemo.stdout) as unknown).toMatchObject({
        ok: true,
        kind: "demo",
        action: "created",
        coursePath: courseDir,
        demo: {
          file: "growth.html",
          title: "Growth curve",
          addedAt: expect.any(String),
        },
        topic: {
          path: "indexes/btree",
          demos: [
            {
              file: "growth.html",
              title: "Growth curve",
              addedAt: expect.any(String),
            },
          ],
        },
      });

      await firstProbe.waitForText("event: message", "SSE demo message", 1_000);
      await firstProbe.waitForText('"kind":"demo"', "SSE demo kind", 1_000);
      await firstProbe.waitForText(
        'sandbox=\\"allow-scripts\\"',
        "SSE sandboxed demo iframe",
        1_000,
      );
      await firstProbe.waitForText(
        '"demos":[{"file":"growth.html"',
        "SSE demo topic leaf",
        1_000,
      );

      const servedDemo = await fetch(`${url}/demos/growth.html`);
      expect(servedDemo.status).toBe(200);
      expect(servedDemo.headers.get("content-security-policy")).toBe(
        "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data:;",
      );
      expect(servedDemo.headers.get("content-type")).toContain("text/html");
      expect(await servedDemo.text()).toContain("count.addEventListener");

      const traversalDemo = await fetch(`${url}/demos/../course.json`);
      expect(traversalDemo.status).toBe(404);

      await writeFile(
        join(courseDir, "lessons", "02-demo.md"),
        '# Demo Lesson\n\n:::demo growth.html "Inline lesson demo"',
        "utf8",
      );
      await firstProbe.waitForText(
        "Inline lesson demo",
        "SSE lesson demo directive",
        1_000,
      );

      const agentText = [
        "Agent **reply** about Gradient",
        "",
        "```ts",
        "const value = 1;",
        "```",
        "",
        "| item | value |",
        "| --- | --- |",
        "| status | persisted |",
        "",
        "[bad](javascript:alert(1))",
        "<script>alert(1)</script>",
      ].join("\n");
      const say = await runLearn(["say", courseName, "--text", agentText], env);

      expect(say.exitCode).toBe(0);
      expect(say.stdout).toBe("");
      expect(say.stderr).toBe("");

      await firstProbe.waitForText("\"role\":\"agent\"", "SSE agent message");
      await firstProbe.waitForText("Agent **reply**", "SSE agent markdown");
      firstSseAbort.abort();

      const transcriptEntries = await readTranscriptJsonl(courseDir);
      expect(transcriptEntries.map((entry) => entry.kind ?? "text")).toEqual([
        "lesson",
        "text",
        "feynman-check",
        "feynman-answer",
        "demo",
        "lesson",
        "text",
      ]);
      expect(transcriptEntries).toEqual([
        {
          role: "agent",
          kind: "lesson",
          lesson: "01-intro",
          at: expect.any(String),
        },
        {
          role: "learner",
          text: "hello from the browser",
          at: expect.any(String),
        },
        {
          role: "agent",
          kind: "feynman-check",
          concept: "gradient-basics",
          prompt: "Explain what a gradient tells you and how you would use it.",
          at: expect.any(String),
        },
        {
          role: "learner",
          kind: "feynman-answer",
          concept: "gradient-basics",
          text: "A gradient points in the direction where the output rises fastest, and its size tells the local rate of change.",
          at: expect.any(String),
        },
        {
          role: "agent",
          kind: "demo",
          file: "growth.html",
          title: "Growth curve",
          at: expect.any(String),
        },
        {
          role: "agent",
          kind: "lesson",
          lesson: "02-demo",
          at: expect.any(String),
        },
        {
          role: "agent",
          text: agentText,
          at: expect.any(String),
        },
      ]);

      const reloadedPage = await fetch(url);
      expect(reloadedPage.status).toBe(200);

      const reloadedHtml = await reloadedPage.text();
      expect(reloadedHtml).toContain("01-intro");
      expect(reloadedHtml).toContain("B-tree");
      expect(reloadedHtml).toContain('data-topic-path="indexes/btree"');
      expect(reloadedHtml).toContain("<h1>Lesson Revised</h1>");
      expect(reloadedHtml).toContain("<strong>lesson</strong>");
      expect(reloadedHtml).toContain('class="term" data-term="gradient"');
      expect(reloadedHtml).toContain("Updated direction definition.");
      expect(reloadedHtml).toContain("hello from the browser");
      expect(reloadedHtml).toContain("Agent **reply**");
      expect(reloadedHtml).toContain("Growth curve");
      expect(reloadedHtml).toContain('sandbox=\\"allow-scripts\\"');
      expect(reloadedHtml).not.toContain("allow-same-origin");
      expect(reloadedHtml).toContain('data-demo-file="growth.html"');
      expect(reloadedHtml).toContain("| item | value |");
      expect(reloadedHtml).toContain(
        "\\u003Cscript\\u003Ealert(1)\\u003C/script\\u003E",
      );

      const reconnect = await runLearn(["start", courseName], env);
      expect(reconnect.exitCode).toBe(0);
      expect(reconnect.stderr).toBe("");
      expect(reconnect.stdout.trim()).toBe(url);

      const reconnectedDaemon = await readDaemonMetadata(courseDir);
      expect(reconnectedDaemon?.pid).toBe(daemon.pid);

      const secondSseAbort = new AbortController();
      const secondSse = await fetch(`${url}/api/events`, {
        signal: secondSseAbort.signal,
      });
      const secondReader = secondSse.body?.getReader();
      if (secondReader === undefined) {
        throw new Error("SSE stream did not open.");
      }
      const secondProbe = createSseProbe(secondReader);

      await secondProbe.waitForStatus("agent-working");

      const secondWait = spawnLearn(["wait"], env);
      await secondProbe.waitForStatus("waiting-for-agent");

      await killDaemon(daemon.pid);
      secondSseAbort.abort();

      const secondWaitResult = await collectProcess(
        secondWait,
        "learn wait after daemon kill",
      );
      expect(secondWaitResult.exitCode).toBe(2);
      expect(secondWaitResult.stdout).toBe("");
      expect(secondWaitResult.stderr.trim()).toBe(
        "Daemon died while waiting for learner input.",
      );
    } finally {
      await rm(coursesDir, { force: true, recursive: true });
    }
  }, 15_000);

  test("queues session-done and shuts down cleanly through learn stop", async () => {
    if (!(await canBindLocalhost())) {
      if (process.env["CI"] === "true") {
        throw new Error("Localhost binding is unavailable; E2E cannot run.");
      }

      return;
    }

    const coursesDir = await mkdtemp(join(tmpdir(), "overlearn-done-"));
    const env = testEnv(coursesDir);
    const courseName = "done-flow";
    const courseDir = join(coursesDir, courseName);

    try {
      const start = await runLearn(["start", courseName], env);
      expect(start.exitCode).toBe(0);
      expect(start.stderr).toBe("");
      const url = start.stdout.trim();

      const daemon = await readDaemonMetadata(courseDir);
      expect(daemon).not.toBeUndefined();
      if (daemon === undefined) {
        throw new Error("Daemon metadata was not written.");
      }
      liveDaemonPids.add(daemon.pid);

      const sse = await fetch(`${url}/api/events`);
      const reader = sse.body?.getReader();
      if (reader === undefined) {
        throw new Error("SSE stream did not open.");
      }
      const probe = createSseProbe(reader);

      const wait = spawnLearn(["wait", courseName], env);
      await probe.waitForStatus("waiting-for-agent");
      await submitDone(url);
      await probe.waitForStatus("wrapping-up");

      const waitResult = await collectProcess(wait, "learn wait session done");
      expect(waitResult.exitCode).toBe(0);
      expectWaitGuidance(waitResult.stderr, courseName);

      const turnPath = waitResult.stdout.trim();
      expect(turnPath).toBe(join(courseDir, ".overlearn", "turns", "turn-1.json"));
      const turn = JSON.parse(await readFile(turnPath, "utf8")) as TurnFile;
      expect(turn).toEqual({
        turn: 1,
        createdAt: expect.any(String),
        events: [{ type: "session-done" }],
      });

      const wrapUp = "Final wrap-up: covered the basics and next steps.";
      const say = await runLearn(["say", courseName, "--text", wrapUp], env);
      expect(say.exitCode).toBe(0);
      expect(say.stdout).toBe("");
      expect(say.stderr).toBe("");
      await probe.waitForText(wrapUp, "SSE wrap-up message");

      const endedStatus = probe.waitForStatus("session-ended");
      const stop = await runLearn(["stop", courseName], env);
      expect(stop.exitCode).toBe(0);
      expect(stop.stderr).toBe("");
      expect(stop.stdout.trim()).toBe(`Stopped daemon for course: ${courseDir}`);
      await endedStatus;
      await waitForDaemonStopped(courseDir, daemon.pid);

      const stoppedStatus = await runLearn(["status", courseName, "--json"], env);
      expect(JSON.parse(stoppedStatus.stdout)).toEqual({
        daemonAlive: false,
        waitPending: false,
        courseDir,
      });

      const secondStop = await runLearn(["done", courseName], env);
      expect(secondStop.exitCode).toBe(0);
      expect(secondStop.stderr).toBe("");
      expect(secondStop.stdout.trim()).toBe(
        `No daemon is running for course: ${courseDir}`,
      );
    } finally {
      await rm(coursesDir, { force: true, recursive: true });
    }
  }, 10_000);
});
