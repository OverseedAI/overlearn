import { spawn } from "node:child_process";
import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";

import {
  appendLearnerTranscript,
  clearDaemonMetadata,
  DEFAULT_COURSE_NAME,
  ensureCourseScaffold,
  getCoursePaths,
  readCourseManifest,
  readDaemonMetadata,
  readPendingEvents,
  resolveCourseDirForWait,
  writeDaemonMetadata,
  writePendingEvents,
  writeTurnFile,
  type DaemonMetadata,
  type TurnEvent,
} from "../course";

export type DaemonEndpoint = Readonly<{
  host: string;
  port: number;
}>;

type Env = Readonly<Record<string, string | undefined>>;

type UiStatus = "waiting-for-agent" | "agent-working";

type Waiter = Readonly<{
  id: number;
  resolve: (turnPath: string) => void;
}>;

type WaitSetup =
  | Readonly<{ kind: "response"; response: Response }>
  | Readonly<{ kind: "wait"; response: Promise<Response> }>;

export class LearnCommandError extends Error {
  readonly exitCode: 1 | 2;

  constructor(exitCode: 1 | 2, message: string) {
    super(message);
    this.name = "LearnCommandError";
    this.exitCode = exitCode;
  }
}

const LOCALHOST_BIND_HOST = "127.0.0.1";
const LOCALHOST_PRINT_HOST = "localhost";
const DAEMON_START_TIMEOUT_MS = 5_000;
const DAEMON_START_POLL_MS = 50;

const sleep = async (milliseconds: number): Promise<void> => {
  await new Promise((resolve) => setTimeout(resolve, milliseconds));
};

const jsonResponse = (value: unknown, init?: ResponseInit): Response =>
  new Response(JSON.stringify(value), {
    ...init,
    headers: {
      "content-type": "application/json",
      ...init?.headers,
    },
  });

const textResponse = (
  text: string,
  status: number,
): Response =>
  new Response(text, {
    status,
    headers: {
      "content-type": "text/plain; charset=utf-8",
    },
  });

const formatPublicUrl = (port: number): string =>
  `http://${LOCALHOST_PRINT_HOST}:${port}`;

const formatDaemonUrl = (port: number, path: string): string =>
  `http://${LOCALHOST_BIND_HOST}:${port}${path}`;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const isPidAlive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

const healthMatchesCourse = async (
  courseDir: string,
  metadata: DaemonMetadata,
): Promise<boolean> => {
  try {
    const response = await fetch(formatDaemonUrl(metadata.port, "/api/health"));
    if (!response.ok) {
      return false;
    }

    const body = (await response.json()) as unknown;
    return isRecord(body) && body["coursePath"] === courseDir;
  } catch {
    return false;
  }
};

const isUsableDaemon = async (
  courseDir: string,
  metadata: DaemonMetadata,
): Promise<boolean> =>
  isPidAlive(metadata.pid) && (await healthMatchesCourse(courseDir, metadata));

const getDaemonSpawnCommand = (courseDir: string): readonly string[] => {
  const executable = process.argv[0] ?? process.execPath;
  const scriptPath = process.argv[1];

  if (
    scriptPath !== undefined &&
    (scriptPath.endsWith(".ts") || scriptPath.endsWith(".js"))
  ) {
    return [executable, scriptPath, "__daemon", courseDir];
  }

  return [process.execPath, "__daemon", courseDir];
};

const spawnDaemonProcess = (courseDir: string, env: Env): void => {
  const [command, ...args] = getDaemonSpawnCommand(courseDir);
  if (command === undefined) {
    throw new LearnCommandError(1, "Unable to determine daemon command.");
  }

  const child = spawn(command, args, {
    detached: true,
    env: {
      ...process.env,
      ...env,
    },
    stdio: "ignore",
  });

  child.unref();
};

const waitForDaemonMetadata = async (
  courseDir: string,
): Promise<DaemonMetadata> => {
  const startedAt = Date.now();

  while (Date.now() - startedAt < DAEMON_START_TIMEOUT_MS) {
    const metadata = await readDaemonMetadata(courseDir);
    if (
      metadata !== undefined &&
      (await isUsableDaemon(courseDir, metadata))
    ) {
      return metadata;
    }

    await sleep(DAEMON_START_POLL_MS);
  }

  throw new LearnCommandError(1, "Daemon did not start within 5 seconds.");
};

const openBrowser = (url: string, env: Env): void => {
  if (env["OVERLEARN_NO_BROWSER"] === "1") {
    return;
  }

  const command = process.platform === "darwin" ? "open" : "xdg-open";

  try {
    const child = spawn(command, [url], {
      detached: true,
      stdio: "ignore",
    });
    child.unref();
  } catch {
    // Opening the browser is best-effort by contract.
  }
};

export const startCourseDaemon = async (
  name = DEFAULT_COURSE_NAME,
  env: Env = process.env,
): Promise<string> => {
  const paths = await ensureCourseScaffold(name, env);
  const existingMetadata = await readDaemonMetadata(paths.courseDir);

  if (
    existingMetadata !== undefined &&
    (await isUsableDaemon(paths.courseDir, existingMetadata))
  ) {
    const url = formatPublicUrl(existingMetadata.port);
    openBrowser(url, env);
    return url;
  }

  if (existingMetadata !== undefined) {
    await clearDaemonMetadata(paths.courseDir);
  }

  spawnDaemonProcess(paths.courseDir, env);
  const metadata = await waitForDaemonMetadata(paths.courseDir);
  const url = formatPublicUrl(metadata.port);

  openBrowser(url, env);

  return url;
};

const parseWaitResponse = async (response: Response): Promise<string> => {
  const body = (await response.json()) as unknown;
  if (!isRecord(body) || typeof body["turnPath"] !== "string") {
    throw new LearnCommandError(2, "Daemon returned an invalid wait response.");
  }

  return body["turnPath"];
};

export const waitForLearnerTurn = async (
  name: string | undefined,
  env: Env = process.env,
  cwd = process.cwd(),
): Promise<string> => {
  const courseDir = await resolveCourseDirForWait(name, env, cwd);
  const metadata = await readDaemonMetadata(courseDir);

  if (metadata === undefined || !isPidAlive(metadata.pid)) {
    throw new LearnCommandError(
      2,
      `Daemon is not running for course: ${courseDir}`,
    );
  }

  let response: Response;
  try {
    response = await fetch(formatDaemonUrl(metadata.port, "/api/wait"));
  } catch {
    throw new LearnCommandError(
      2,
      "Daemon died while waiting for learner input.",
    );
  }

  if (!response.ok) {
    const body = await response.text();
    throw new LearnCommandError(
      2,
      body.trim().length > 0
        ? `Daemon wait failed: ${body.trim()}`
        : `Daemon wait failed with HTTP ${response.status}`,
    );
  }

  return parseWaitResponse(response);
};

const escapeHtml = (value: string): string =>
  value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");

const renderPage = (courseName: string): string => `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${escapeHtml(courseName)} - overlearn</title>
  <style>
    body { font-family: sans-serif; margin: 2rem; max-width: 42rem; }
    form { display: flex; gap: 0.5rem; }
    input { flex: 1; }
  </style>
</head>
<body>
  <h1>${escapeHtml(courseName)}</h1>
  <p id="status">agent is working&hellip;</p>
  <form id="turn-form">
    <input id="message" name="message" autocomplete="off" disabled>
    <button id="submit" type="submit" disabled>Submit</button>
  </form>
  <script>
    const form = document.querySelector("#turn-form");
    const input = document.querySelector("#message");
    const button = document.querySelector("#submit");
    const statusLine = document.querySelector("#status");

    const applyStatus = (status) => {
      const waiting = status === "waiting-for-agent";
      statusLine.textContent = waiting ? "waiting for agent" : "agent is working\\u2026";
      input.disabled = !waiting;
      button.disabled = !waiting || input.value.trim().length === 0;
      if (waiting) input.focus();
    };

    input.addEventListener("input", () => {
      button.disabled = input.disabled || input.value.trim().length === 0;
    });

    form.addEventListener("submit", async (event) => {
      event.preventDefault();
      const text = input.value.trim();
      if (text.length === 0) return;

      applyStatus("agent-working");
      input.value = "";

      await fetch("/api/submit", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ text }),
      });
    });

    const events = new EventSource("/api/events");
    events.addEventListener("status", (event) => {
      applyStatus(JSON.parse(event.data).status);
    });
  </script>
</body>
</html>`;

const createSseHub = (getStatus: () => UiStatus) => {
  const subscribers = new Set<ServerResponse>();

  const writeEvent = (
    response: ServerResponse,
    event: string,
    value: unknown,
  ): void => {
    if (response.writableEnded) {
      subscribers.delete(response);
      return;
    }

    response.write(`event: ${event}\ndata: ${JSON.stringify(value)}\n\n`);
  };

  const broadcastStatus = (status: UiStatus): void => {
    for (const subscriber of subscribers) {
      writeEvent(subscriber, "status", { status });
    }
  };

  const connect = (
    request: IncomingMessage,
    response: ServerResponse,
  ): void => {
    response.writeHead(200, {
      "cache-control": "no-cache",
      connection: "keep-alive",
      "content-type": "text/event-stream",
    });
    subscribers.add(response);
    writeEvent(response, "status", { status: getStatus() });

    request.on("close", () => {
      subscribers.delete(response);
    });
  };

  return { broadcastStatus, connect };
};

const createSerializer = () => {
  let current = Promise.resolve();

  return async <T>(operation: () => Promise<T>): Promise<T> => {
    const next = current.then(operation, operation);
    current = next.then(
      () => undefined,
      () => undefined,
    );

    return next;
  };
};

const parseSubmitText = (bodyText: string): string => {
  const body = JSON.parse(bodyText) as unknown;
  if (!isRecord(body) || typeof body["text"] !== "string") {
    throw new Error("Expected JSON body with a text field.");
  }

  const text = body["text"].trim();
  if (text.length === 0) {
    throw new Error("Message text cannot be empty.");
  }

  return text;
};

const readRequestBody = async (request: IncomingMessage): Promise<string> => {
  const chunks: string[] = [];

  await new Promise<void>((resolve, reject) => {
    request.setEncoding("utf8");
    request.on("data", (chunk: string) => {
      chunks.push(chunk);
    });
    request.on("end", () => resolve());
    request.on("error", reject);
  });

  return chunks.join("");
};

const sendResponse = async (
  target: ServerResponse,
  response: Response,
): Promise<void> => {
  target.statusCode = response.status;
  response.headers.forEach((value, key) => {
    target.setHeader(key, value);
  });

  target.end(await response.text());
};

export const runDaemon = async (courseDir: string): Promise<void> => {
  const coursePath = getCoursePaths(courseDir).courseDir;
  const manifest = await readCourseManifest(coursePath);

  let status: UiStatus = "agent-working";
  let waiter: Waiter | undefined;
  let nextWaiterId = 1;

  const serialize = createSerializer();
  const sseHub = createSseHub(() => status);

  const setStatus = (nextStatus: UiStatus): void => {
    status = nextStatus;
    sseHub.broadcastStatus(nextStatus);
  };

  const flushPendingTurn = async (): Promise<string | undefined> => {
    const events = await readPendingEvents(coursePath);
    if (events.length === 0) {
      return undefined;
    }

    const turnPath = await writeTurnFile(coursePath, events);
    await writePendingEvents(coursePath, []);
    setStatus("agent-working");

    return turnPath;
  };

  const maybeResolveWaiter = async (): Promise<void> => {
    if (waiter === undefined) {
      return;
    }

    const turnPath = await flushPendingTurn();
    if (turnPath === undefined) {
      return;
    }

    const currentWaiter = waiter;
    waiter = undefined;
    currentWaiter.resolve(turnPath);
  };

  const handleWait = async (
    onAbort: (listener: () => void) => void,
  ): Promise<Response> => {
    const setup = await serialize(async (): Promise<WaitSetup> => {
      setStatus("waiting-for-agent");

      const immediateTurnPath = await flushPendingTurn();
      if (immediateTurnPath !== undefined) {
        return {
          kind: "response",
          response: jsonResponse({ turnPath: immediateTurnPath }),
        };
      }

      if (waiter !== undefined) {
        return {
          kind: "response",
          response: textResponse("Another learn wait is already pending.", 409),
        };
      }

      const waiterId = nextWaiterId;
      nextWaiterId += 1;

      const response = new Promise<Response>((resolveResponse) => {
        waiter = {
          id: waiterId,
          resolve: (turnPath) => {
            resolveResponse(jsonResponse({ turnPath }));
          },
        };
      });

      onAbort(() => {
        if (waiter?.id === waiterId) {
          waiter = undefined;
          setStatus("agent-working");
        }
      });

      return { kind: "wait", response };
    });

    return setup.kind === "response" ? setup.response : await setup.response;
  };

  const handleSubmit = async (bodyText: string): Promise<Response> => {
    let text: string;
    try {
      text = parseSubmitText(bodyText);
    } catch (error) {
      const message =
        error instanceof Error ? error.message : "Invalid submit request.";
      return textResponse(message, 400);
    }

    await serialize(async () => {
      const at = new Date().toISOString();
      const event: TurnEvent = { type: "message", text };
      const pendingEvents = await readPendingEvents(coursePath);

      await writePendingEvents(coursePath, [...pendingEvents, event]);
      await appendLearnerTranscript(coursePath, text, at);
      await maybeResolveWaiter();

      if (waiter === undefined) {
        setStatus("agent-working");
      }
    });

    return jsonResponse({ ok: true });
  };

  const server = createServer((request, response) => {
    void (async () => {
      const method = request.method ?? "GET";
      const requestUrl = new URL(
        request.url ?? "/",
        `http://${LOCALHOST_BIND_HOST}`,
      );

      if (method === "GET" && requestUrl.pathname === "/") {
        await sendResponse(
          response,
          new Response(renderPage(manifest.name), {
            headers: { "content-type": "text/html; charset=utf-8" },
          }),
        );
        return;
      }

      if (method === "GET" && requestUrl.pathname === "/api/health") {
        await sendResponse(
          response,
          jsonResponse({
            ok: true,
            coursePath,
            name: manifest.name,
          }),
        );
        return;
      }

      if (method === "GET" && requestUrl.pathname === "/api/events") {
        sseHub.connect(request, response);
        return;
      }

      if (method === "GET" && requestUrl.pathname === "/api/wait") {
        await sendResponse(
          response,
          await handleWait((listener) => {
            request.on("close", listener);
          }),
        );
        return;
      }

      if (method === "POST" && requestUrl.pathname === "/api/submit") {
        const bodyText = await readRequestBody(request);
        await sendResponse(response, await handleSubmit(bodyText));
        return;
      }

      await sendResponse(response, textResponse("Not found", 404));
    })().catch((error: unknown) => {
      if (response.writableEnded) {
        return;
      }

      const message =
        error instanceof Error ? error.message : "Internal daemon error.";
      void sendResponse(response, textResponse(message, 500));
    });
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, LOCALHOST_BIND_HOST, () => resolve());
  });

  const address = server.address();
  if (address === null || typeof address === "string") {
    throw new Error("Daemon server did not bind a TCP port.");
  }

  const port = address.port;

  await writeDaemonMetadata(coursePath, {
    pid: process.pid,
    port,
    startedAt: new Date().toISOString(),
  });

  const cleanup = async (): Promise<void> => {
    server.close();
    await clearDaemonMetadata(coursePath);
  };

  process.on("SIGTERM", () => {
    void cleanup().finally(() => process.exit(0));
  });
  process.on("SIGINT", () => {
    void cleanup().finally(() => process.exit(0));
  });

  await new Promise<never>(() => undefined);
};
