import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { readDaemonMetadata, type TurnFile } from "../course";

type ProcessResult = Readonly<{
  exitCode: number;
  stdout: string;
  stderr: string;
}>;

type ByteReader = Readonly<{
  read: () => Promise<Readonly<{ done: boolean; value?: unknown }>>;
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

const readStatusFromSse = async (
  reader: ByteReader,
  status: string,
): Promise<void> => {
  const decoder = new TextDecoder();
  let buffer = "";

  await withTimeout(
    (async () => {
      while (true) {
        const chunk = await reader.read();
        if (chunk.done) {
          throw new Error("SSE stream closed before status arrived.");
        }

        if (!(chunk.value instanceof Uint8Array)) {
          throw new Error("SSE stream returned a non-byte chunk.");
        }

        buffer += decoder.decode(chunk.value, { stream: true });
        if (buffer.includes(`"status":"${status}"`)) {
          return;
        }
      }
    })(),
    2_000,
    `SSE status ${status}`,
  );
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

      const firstSseAbort = new AbortController();
      const firstSse = await fetch(`${url}/api/events`, {
        signal: firstSseAbort.signal,
      });
      const firstReader = firstSse.body?.getReader();
      if (firstReader === undefined) {
        throw new Error("SSE stream did not open.");
      }

      const wait = spawnLearn(["wait"], env);
      await readStatusFromSse(firstReader, "waiting-for-agent");
      await submitMessage(url, "hello from the browser");

      const waitResult = await collectProcess(wait, "learn wait");
      firstSseAbort.abort();

      expect(waitResult.exitCode).toBe(0);
      expect(waitResult.stderr).toBe("");

      const turnPath = waitResult.stdout.trim();
      expect(turnPath).toBe(join(courseDir, ".overlearn", "turns", "turn-1.json"));

      const turn = JSON.parse(await readFile(turnPath, "utf8")) as TurnFile;
      expect(turn).toEqual({
        turn: 1,
        createdAt: expect.any(String),
        events: [{ type: "message", text: "hello from the browser" }],
      });

      const transcriptLines = (
        await readFile(join(courseDir, "transcript.jsonl"), "utf8")
      )
        .trim()
        .split("\n");
      expect(transcriptLines).toHaveLength(1);
      expect(JSON.parse(transcriptLines[0] ?? "{}")).toEqual({
        role: "learner",
        text: "hello from the browser",
        at: expect.any(String),
      });

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

      await readStatusFromSse(secondReader, "agent-working");

      const secondWait = spawnLearn(["wait"], env);
      await readStatusFromSse(secondReader, "waiting-for-agent");

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
  }, 10_000);
});
