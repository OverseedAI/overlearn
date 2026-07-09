import { expect } from "bun:test";
import { chmod, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { readDaemonMetadata } from "../../src/daemon";

export type ProcessResult = Readonly<{
  exitCode: number;
  stdout: string;
  stderr: string;
}>;

export type SseEvent = Readonly<{
  event: string;
  data: unknown;
}>;

type ByteReader = Readonly<{
  read: () => Promise<Readonly<{ done: boolean; value?: unknown }>>;
}>;

export type LogEntry = Record<string, unknown>;

export const sleep = async (milliseconds: number): Promise<void> => {
  await new Promise((resolve) => setTimeout(resolve, milliseconds));
};

export const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

export const withTimeout = async <T>(
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

export const streamText = async (
  stream: ReadableStream<Uint8Array> | null,
): Promise<string> => (stream === null ? "" : await new Response(stream).text());

export const runProcess = async (
  command: readonly string[],
  env: Record<string, string>,
  label = command.join(" "),
): Promise<ProcessResult> => {
  const child = Bun.spawn([...command], {
    env,
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  const exitCode = await withTimeout(child.exited, 5_000, label);
  const [stdout, stderr] = await Promise.all([
    streamText(child.stdout),
    streamText(child.stderr),
  ]);

  return { exitCode, stdout, stderr };
};

export const isPidAlive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

export const killDaemon = async (pid: number): Promise<void> => {
  if (!isPidAlive(pid)) {
    return;
  }

  process.kill(pid, "SIGTERM");

  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (!isPidAlive(pid)) {
      return;
    }

    await sleep(25);
  }

  process.kill(pid, "SIGKILL");
};

export const waitForDaemonStopped = async (
  dataDir: string,
  pid: number,
): Promise<void> => {
  await withTimeout(
    (async () => {
      while (
        isPidAlive(pid) ||
        (await readDaemonMetadata({ OVERLEARN_DATA_DIR: dataDir })) !== undefined
      ) {
        await sleep(25);
      }
    })(),
    5_000,
    "daemon shutdown",
  );
};

export const waitForPidStopped = async (pid: number): Promise<void> => {
  await withTimeout(
    (async () => {
      while (isPidAlive(pid)) {
        await sleep(25);
      }
    })(),
    5_000,
    `pid ${pid} shutdown`,
  );
};

export const canBindLocalhost = async (): Promise<boolean> => {
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

export const createFakeHarnessPath = async (): Promise<string> => {
  const binDir = await mkdtemp(join(tmpdir(), "overlearn-harness-bin-"));
  const commands = [
    "claude",
    "codex",
    "claude-code-acp",
    "codex-acp",
    "gemini",
  ];

  await Promise.all(
    commands.map(async (command) => {
      const path = join(binDir, command);
      await writeFile(
        path,
        [
          "#!/bin/sh",
          "if [ \"$1\" = \"--version\" ]; then",
          `  echo "${command} 9.9.9"`,
          "  exit 0",
          "fi",
          "exit 0",
          "",
        ].join("\n"),
        "utf8",
      );
      await chmod(path, 0o755);
    }),
  );

  return binDir;
};

export const harnessById = (
  harnesses: unknown,
  id: string,
): Record<string, unknown> => {
  if (!Array.isArray(harnesses)) {
    throw new Error("Expected harness list.");
  }

  const harness = harnesses.find(
    (candidate) => isRecord(candidate) && candidate["id"] === id,
  );
  if (!isRecord(harness)) {
    throw new Error(`Missing harness ${id}.`);
  }

  return harness;
};

export const harnessPayloadHasSelected = (
  payload: unknown,
  id: string,
  switched?: boolean,
): boolean => {
  if (!isRecord(payload) || !Array.isArray(payload["harnesses"])) {
    return false;
  }

  if (switched !== undefined && payload["switched"] !== switched) {
    return false;
  }

  return payload["harnesses"].some(
    (candidate) =>
      isRecord(candidate) &&
      candidate["id"] === id &&
      candidate["selected"] === true,
  );
};

export const daemonAuthHeaders = (
  token: string,
  headers: Record<string, string> = {},
): Record<string, string> => ({
  authorization: `Bearer ${token}`,
  ...headers,
});

export const submitCourseMessage = async (
  url: string,
  token: string,
  courseId: number,
  text: string,
  attachments?: readonly Readonly<{
    kind: "image" | "file";
    name: string;
    mimeType: string;
    data: string;
  }>[],
): Promise<void> => {
  const response = await fetch(`${url}/api/courses/${courseId}/submit`, {
    method: "POST",
    headers: daemonAuthHeaders(token, { "content-type": "application/json" }),
    body: JSON.stringify({
      text,
      ...(attachments === undefined ? {} : { attachments }),
    }),
  });

  expect(response.status).toBe(200);
};

export const submitCourseDone = async (
  url: string,
  token: string,
  courseId: number,
): Promise<void> => {
  const response = await fetch(`${url}/api/courses/${courseId}/done`, {
    method: "POST",
    headers: daemonAuthHeaders(token),
  });

  expect(response.status).toBe(200);
};

export const readLogEntries = async (
  logPath: string,
): Promise<readonly LogEntry[]> => {
  if (!(await Bun.file(logPath).exists())) {
    return [];
  }

  const contents = await readFile(logPath, "utf8");
  return contents
    .trim()
    .split("\n")
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line) as LogEntry);
};

export const waitForLogEntries = async (
  logPath: string,
  predicate: (entries: readonly LogEntry[]) => boolean,
  label: string,
): Promise<readonly LogEntry[]> =>
  withTimeout(
    (async () => {
      while (true) {
        const entries = await readLogEntries(logPath);
        if (predicate(entries)) {
          return entries;
        }

        await sleep(25);
      }
    })(),
    5_000,
    label,
  );

export const promptText = (entry: LogEntry): string => {
  const prompt = entry["prompt"];
  if (!Array.isArray(prompt)) {
    return "";
  }

  const [first] = prompt;
  if (!isRecord(first) || typeof first["text"] !== "string") {
    return "";
  }

  return first["text"];
};

const parseSseBlock = (block: string): SseEvent | undefined => {
  let event = "message";
  let data = "";

  for (const line of block.split("\n")) {
    if (line.startsWith("event: ")) {
      event = line.slice("event: ".length);
    }

    if (line.startsWith("data: ")) {
      data += line.slice("data: ".length);
    }
  }

  if (data.length === 0) {
    return undefined;
  }

  return {
    event,
    data: JSON.parse(data) as unknown,
  };
};

export const createSseClient = async (
  url: string,
  token: string,
): Promise<
  Readonly<{
    waitFor: (
      eventName: string,
      predicate: (data: unknown) => boolean,
      label: string,
      milliseconds?: number,
    ) => Promise<SseEvent>;
    events: () => readonly SseEvent[];
    close: () => void;
  }>
> => {
  const abort = new AbortController();
  const response = await fetch(`${url}/api/events`, {
    headers: daemonAuthHeaders(token),
    signal: abort.signal,
  });
  if (!response.ok) {
    throw new Error(`SSE stream did not open: HTTP ${response.status}.`);
  }

  const reader = response.body?.getReader();
  if (reader === undefined) {
    throw new Error("SSE stream did not open.");
  }

  const decoder = new TextDecoder();
  const queue: SseEvent[] = [];
  const history: SseEvent[] = [];
  let buffer = "";

  const readNext = async (byteReader: ByteReader): Promise<void> => {
    const chunk = await byteReader.read();
    if (chunk.done) {
      throw new Error("SSE stream closed.");
    }

    if (!(chunk.value instanceof Uint8Array)) {
      throw new Error("SSE stream returned a non-byte chunk.");
    }

    buffer += decoder.decode(chunk.value, { stream: true });
    while (true) {
      const boundary = buffer.indexOf("\n\n");
      if (boundary === -1) {
        return;
      }

      const block = buffer.slice(0, boundary);
      buffer = buffer.slice(boundary + 2);
      const parsed = parseSseBlock(block);
      if (parsed !== undefined) {
        history.push(parsed);
        queue.push(parsed);
      }
    }
  };

  return {
    waitFor: async (eventName, predicate, label, milliseconds = 5_000) =>
      withTimeout(
        (async () => {
          while (true) {
            const matchIndex = queue.findIndex(
              (event) => event.event === eventName && predicate(event.data),
            );
            if (matchIndex !== -1) {
              const [event] = queue.splice(matchIndex, 1);
              if (event === undefined) {
                throw new Error("SSE event disappeared.");
              }

              return event;
            }

            await readNext(reader);
          }
        })(),
        milliseconds,
        label,
      ),
    events: () => [...history],
    close: () => abort.abort(),
  };
};
