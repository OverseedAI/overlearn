import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdir, rm } from "node:fs/promises";
import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import { dirname, join, resolve } from "node:path";

import packageJson from "../../package.json";
import { listHarnessAdapters } from "../adapter/registry";
import type { AdapterDetection } from "../adapter/types";
import {
  appendTranscriptEntry,
  appendTurnEvents,
  clearActiveFeynmanCheck,
  createCourse,
  endSession as endStoreSession,
  flattenTopicTree,
  getActiveFeynmanCheck,
  getCourse,
  getStoreDataDir,
  listCourses,
  listDemos,
  listGlossary,
  listLatestMasteryScores,
  listLessons,
  openStore,
  pageTranscript,
  patchCourse,
  readTopicTree,
  startSession,
  type Course,
  type CourseStatus as StoreCourseStatus,
  type Demo,
  type FeynmanCheck,
  type GlossaryEntry as StoreGlossaryEntry,
  type Lesson,
  type MasteryEvent,
  type Store,
  type Topic,
  type TranscriptEntry as StoreTranscriptEntry,
} from "../store";
import {
  createTeachingMcpHttpHandler,
  teachingTokenFromRequestPath,
  type TeachingWriteEvent,
} from "../mcp/teaching";
import { renderMarkdown } from "./markdown";
import {
  createDaemonTurnOrchestrator,
  type ActiveTeachingSessionRegistration,
  type AgentStreamPayload,
  type DaemonTurnOrchestrator,
  type TurnEvent,
  type TurnPayload,
  type TurnPromptMode,
} from "./orchestrator";
import {
  renderPage,
  type ActiveFeynmanCheck,
  type DemoEntry,
  type GlossaryEntry,
  type MasteryEntry,
  type TopicNode,
  type TranscriptEntry,
} from "./ui";

export type DaemonEndpoint = Readonly<{
  host: string;
  port: number;
}>;

export type CourseStatus = Readonly<{
  daemonAlive: boolean;
  waitPending: false;
  courseDir: null;
  activeCourseId: number | null;
}>;

export type AgentMessageSource =
  | Readonly<{ kind: "text"; text: string }>
  | Readonly<{ kind: "file"; path: string }>;

export type LearnerTurn = Readonly<{
  turnPath: string;
  courseDir: string;
}>;

export const REVIEW_WEAK_NAV_PATH = "overlearn:review-weak";

export class LearnCommandError extends Error {
  readonly exitCode: 1 | 2;

  constructor(exitCode: 1 | 2, message: string) {
    super(message);
    this.name = "LearnCommandError";
    this.exitCode = exitCode;
  }
}

type Env = Readonly<Record<string, string | undefined>>;

type DaemonMetadata = Readonly<{
  pid: number;
  port: number;
  startedAt: string;
}>;

type UiStatus =
  | "waiting-for-agent"
  | "agent-working"
  | "agent-failed"
  | "wrapping-up"
  | "session-ended";

type UiStatusPayload = Readonly<{
  courseId: number;
  status: UiStatus;
  hasSeenWait: boolean;
  message?: string;
}>;

type HarnessSummary = Readonly<{
  id: string;
  name: string;
  installed: boolean;
  authenticated: boolean;
  version?: string;
  selected: boolean;
}>;

type HarnessesPayload = Readonly<{
  courseId?: number;
  harnesses: readonly HarnessSummary[];
  switched: boolean;
}>;

type CourseRuntime = {
  courseId: number;
  orchestrator: DaemonTurnOrchestrator;
  runningTurn: boolean;
};

type TokenScope = Readonly<{
  courseId: number;
  sessionId?: number;
}>;

type MessageTurnEvent = Extract<TurnEvent, { type: "message" }>;
type FeynmanAnswerTurnEvent = Extract<TurnEvent, { type: "feynman-answer" }>;

type CourseCreateDraft = {
  title: string;
  description?: string | null;
  harnessId?: string | null;
  attachedDir?: string | null;
  sourceName?: string | null;
  status?: StoreCourseStatus;
};

type CoursePatchDraft = {
  title?: string;
  description?: string | null;
  harnessId?: string | null;
  attachedDir?: string | null;
  sourceName?: string | null;
  status?: StoreCourseStatus;
};

const LOCALHOST_BIND_HOST = "127.0.0.1";
const LOCALHOST_PRINT_HOST = "localhost";
const DAEMON_START_TIMEOUT_MS = 5_000;
const DAEMON_START_POLL_MS = 50;
const DAEMON_STOP_TIMEOUT_MS = 5_000;
const DAEMON_STOP_POLL_MS = 50;
const DEFAULT_HARNESS_ID = "claude-code";
const MAX_AGENT_STREAM_REPLAY = 200;

const sleep = async (milliseconds: number): Promise<void> => {
  await new Promise((resolveSleep) => setTimeout(resolveSleep, milliseconds));
};

const jsonResponse = (value: unknown, init?: ResponseInit): Response =>
  new Response(JSON.stringify(value), {
    ...init,
    headers: {
      "content-type": "application/json",
      ...init?.headers,
    },
  });

const textResponse = (text: string, status: number): Response =>
  new Response(text, {
    status,
    headers: {
      "content-type": "text/plain; charset=utf-8",
    },
  });

const emptyResponse = (status = 204): Response => new Response(null, { status });

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const hasErrorCode = (error: unknown, code: string): boolean =>
  isRecord(error) && error["code"] === code;

const isPidAlive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

const escapeHtml = (value: string): string =>
  value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");

const formatPublicUrl = (port: number): string =>
  `http://${LOCALHOST_PRINT_HOST}:${port}`;

const formatDaemonUrl = (port: number, path: string): string =>
  `http://${LOCALHOST_BIND_HOST}:${port}${path}`;

export const daemonMetadataPath = (env: Env = process.env): string =>
  join(getStoreDataDir(env), "daemon.json");

export const readDaemonMetadata = async (
  env: Env = process.env,
): Promise<DaemonMetadata | undefined> => {
  try {
    const parsed = JSON.parse(await Bun.file(daemonMetadataPath(env)).text()) as unknown;
    if (
      !isRecord(parsed) ||
      typeof parsed["pid"] !== "number" ||
      typeof parsed["port"] !== "number" ||
      typeof parsed["startedAt"] !== "string"
    ) {
      return undefined;
    }

    return {
      pid: parsed["pid"],
      port: parsed["port"],
      startedAt: parsed["startedAt"],
    };
  } catch (error) {
    if (hasErrorCode(error, "ENOENT")) {
      return undefined;
    }

    return undefined;
  }
};

const writeDaemonMetadata = async (
  metadata: DaemonMetadata,
  env: Env = process.env,
): Promise<void> => {
  const path = daemonMetadataPath(env);
  await mkdir(dirname(path), { recursive: true });
  await Bun.write(path, `${JSON.stringify(metadata, null, 2)}\n`);
};

const clearDaemonMetadata = async (env: Env = process.env): Promise<void> => {
  await rm(daemonMetadataPath(env), { force: true });
};

const readDaemonHealth = async (
  metadata: DaemonMetadata,
): Promise<Record<string, unknown> | undefined> => {
  try {
    const response = await fetch(formatDaemonUrl(metadata.port, "/api/health"));
    if (!response.ok) {
      return undefined;
    }

    const body = (await response.json()) as unknown;
    return isRecord(body) ? body : undefined;
  } catch {
    return undefined;
  }
};

const isUsableDaemon = async (
  metadata: DaemonMetadata,
): Promise<boolean> =>
  isPidAlive(metadata.pid) && (await readDaemonHealth(metadata))?.["ok"] === true;

const getDaemonSpawnCommand = (): readonly string[] => {
  const executable = process.argv[0] ?? process.execPath;
  const scriptPath = process.argv[1];

  if (
    scriptPath !== undefined &&
    (scriptPath.endsWith(".ts") || scriptPath.endsWith(".js"))
  ) {
    return [executable, scriptPath, "__daemon"];
  }

  return [process.execPath, "__daemon"];
};

const spawnDaemonProcess = (env: Env): void => {
  const [command, ...args] = getDaemonSpawnCommand();
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

const waitForDaemonMetadata = async (env: Env): Promise<DaemonMetadata> => {
  const startedAt = Date.now();

  while (Date.now() - startedAt < DAEMON_START_TIMEOUT_MS) {
    const metadata = await readDaemonMetadata(env);
    if (metadata !== undefined && (await isUsableDaemon(metadata))) {
      return metadata;
    }

    await sleep(DAEMON_START_POLL_MS);
  }

  throw new LearnCommandError(1, "Daemon did not start within 5 seconds.");
};

const waitForDaemonShutdown = async (
  env: Env,
  pid: number,
): Promise<boolean> => {
  const startedAt = Date.now();

  while (Date.now() - startedAt < DAEMON_STOP_TIMEOUT_MS) {
    if (!isPidAlive(pid) && (await readDaemonMetadata(env)) === undefined) {
      return true;
    }

    await sleep(DAEMON_STOP_POLL_MS);
  }

  return !isPidAlive(pid) && (await readDaemonMetadata(env)) === undefined;
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
    // Opening the browser is best-effort.
  }
};

const findCourseByName = (store: Store, name: string): Course | undefined =>
  listCourses(store).find(
    (course) =>
      course.status !== "archived" &&
      (course.sourceName === name || course.title === name),
  );

const createCourseForStart = (name: string | undefined, env: Env): void => {
  if (name === undefined || name.trim().length === 0) {
    return;
  }

  const store = openStore({ env });
  try {
    if (findCourseByName(store, name) === undefined) {
      createCourse(store, {
        title: name,
        sourceName: name,
        status: "active",
      });
    }
  } finally {
    store.close();
  }
};

const startAppDaemon = async (
  env: Env = process.env,
  options: Readonly<{ createCourseName?: string }> = {},
): Promise<string> => {
  if (options.createCourseName !== undefined) {
    createCourseForStart(options.createCourseName, env);
  }

  const existingMetadata = await readDaemonMetadata(env);
  if (existingMetadata !== undefined && (await isUsableDaemon(existingMetadata))) {
    const url = formatPublicUrl(existingMetadata.port);
    openBrowser(url, env);
    return url;
  }

  if (existingMetadata !== undefined) {
    await clearDaemonMetadata(env);
  }

  spawnDaemonProcess(env);
  const metadata = await waitForDaemonMetadata(env);
  const url = formatPublicUrl(metadata.port);
  openBrowser(url, env);

  return url;
};

export const startCourseDaemon = async (
  name: string | undefined,
  env: Env = process.env,
): Promise<string> =>
  name === undefined
    ? startAppDaemon(env)
    : startAppDaemon(env, { createCourseName: name });

export const resumeCourseDaemon = async (
  _name: string,
  env: Env = process.env,
): Promise<string> => startAppDaemon(env);

export const waitForLearnerTurn = async (
  ...args: readonly unknown[]
): Promise<LearnerTurn> => {
  void args;
  throw new LearnCommandError(
    2,
    "learn wait has been removed. Use the app-level daemon course API instead.",
  );
};

export const getCourseStatus = async (
  _name: string | undefined,
  env: Env = process.env,
): Promise<CourseStatus> => {
  const metadata = await readDaemonMetadata(env);
  if (metadata === undefined || !isPidAlive(metadata.pid)) {
    return {
      daemonAlive: false,
      waitPending: false,
      courseDir: null,
      activeCourseId: null,
    };
  }

  const health = await readDaemonHealth(metadata);
  if (health?.["ok"] !== true) {
    return {
      daemonAlive: false,
      waitPending: false,
      courseDir: null,
      activeCourseId: null,
    };
  }

  const activeCourseId =
    typeof health["activeCourseId"] === "number" ? health["activeCourseId"] : null;

  return {
    daemonAlive: true,
    waitPending: false,
    courseDir: null,
    activeCourseId,
  };
};

export const stopCourseDaemon = async (
  _name: string | undefined,
  env: Env = process.env,
): Promise<string> => {
  const metadata = await readDaemonMetadata(env);
  if (metadata === undefined) {
    return "No overlearn daemon is running.";
  }

  if (!isPidAlive(metadata.pid)) {
    await clearDaemonMetadata(env);
    return "No overlearn daemon is running.";
  }

  try {
    const response = await fetch(
      formatDaemonUrl(metadata.port, "/api/shutdown"),
      { method: "POST" },
    );

    if (!response.ok) {
      throw new Error(`Shutdown failed with HTTP ${response.status}.`);
    }
  } catch {
    try {
      process.kill(metadata.pid, "SIGTERM");
    } catch {
      await clearDaemonMetadata(env);
      return "No overlearn daemon is running.";
    }
  }

  if (!(await waitForDaemonShutdown(env, metadata.pid))) {
    throw new LearnCommandError(1, "Daemon did not stop within 5 seconds.");
  }

  return "Stopped overlearn daemon.";
};

const readAgentMessageText = async (
  source: AgentMessageSource,
  cwd: string,
): Promise<string> =>
  source.kind === "text"
    ? source.text
    : await Bun.file(resolve(cwd, source.path)).text();

export const sayAgentMessage = async (
  name: string | undefined,
  source: AgentMessageSource,
  env: Env = process.env,
  cwd = process.cwd(),
): Promise<string | undefined> => {
  if (name === undefined) {
    throw new LearnCommandError(1, "learn say now requires a store course name.");
  }

  const text = await readAgentMessageText(source, cwd);
  if (text.trim().length === 0) {
    throw new LearnCommandError(1, "Agent message text cannot be empty.");
  }

  const store = openStore({ env });
  try {
    const course = findCourseByName(store, name);
    if (course === undefined) {
      throw new LearnCommandError(1, `No store course found: ${name}`);
    }

    appendTranscriptEntry(store, course.id, {
      role: "agent",
      kind: "text",
      content: text,
    });
    return undefined;
  } finally {
    store.close();
  }
};

export const notifyAgentTranscriptEntry = async (
  ...args: readonly unknown[]
): Promise<string | undefined> => {
  void args;
  return undefined;
};

const createSseHub = (
  getStatusPayloads: () => readonly UiStatusPayload[],
  getHarnesses: (courseId?: number) => HarnessesPayload,
  getCourses: () => unknown,
) => {
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

  const broadcast = (event: string, value: unknown): void => {
    for (const subscriber of subscribers) {
      writeEvent(subscriber, event, value);
    }
  };

  const connect = (_request: IncomingMessage, response: ServerResponse): void => {
    response.writeHead(200, {
      "cache-control": "no-cache",
      connection: "keep-alive",
      "content-type": "text/event-stream",
    });
    subscribers.add(response);

    for (const status of getStatusPayloads()) {
      writeEvent(response, "status", status);
    }
    writeEvent(response, "courses", getCourses());
    writeEvent(response, "harnesses", getHarnesses());

    response.on("close", () => {
      subscribers.delete(response);
    });
  };

  const closeAll = (): void => {
    for (const subscriber of subscribers) {
      subscriber.end();
    }
    subscribers.clear();
  };

  return { broadcast, closeAll, connect };
};

const readRequestBody = async (request: IncomingMessage): Promise<Uint8Array> => {
  const chunks: Uint8Array[] = [];

  for await (const chunk of request) {
    chunks.push(chunk instanceof Uint8Array ? chunk : Buffer.from(chunk));
  }

  const length = chunks.reduce((total, chunk) => total + chunk.byteLength, 0);
  const body = new Uint8Array(length);
  let offset = 0;

  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }

  return body;
};

const headersFromIncoming = (
  request: IncomingMessage,
): Headers => {
  const headers = new Headers();

  for (const [key, value] of Object.entries(request.headers)) {
    if (value === undefined) {
      continue;
    }

    if (Array.isArray(value)) {
      headers.set(key, value.join(", "));
    } else {
      headers.set(key, value);
    }
  }

  return headers;
};

const webRequestFromIncoming = async (
  request: IncomingMessage,
  port: number,
): Promise<Request> => {
  const method = request.method ?? "GET";
  const url = `http://${LOCALHOST_BIND_HOST}:${port}${request.url ?? "/"}`;
  const body =
    method === "GET" || method === "HEAD"
      ? undefined
      : await readRequestBody(request);

  return new Request(url, {
    method,
    headers: headersFromIncoming(request),
    ...(body === undefined ? {} : { body }),
  });
};

const writeWebResponse = async (
  target: ServerResponse,
  response: Response,
): Promise<void> => {
  target.writeHead(
    response.status,
    Object.fromEntries(response.headers.entries()),
  );

  if (response.body === null) {
    target.end();
    return;
  }

  const reader = response.body.getReader();
  while (true) {
    const chunk = await reader.read();
    if (chunk.done) {
      target.end();
      return;
    }

    if (!target.write(Buffer.from(chunk.value))) {
      await new Promise<void>((resolveDrain) => {
        target.once("drain", () => resolveDrain());
      });
    }
  }
};

const readJsonBody = async (request: Request): Promise<unknown> => {
  const text = await request.text();
  if (text.trim().length === 0) {
    return {};
  }

  return JSON.parse(text) as unknown;
};

const optionalStringField = (
  record: Record<string, unknown>,
  key: string,
): string | null | undefined => {
  if (!Object.hasOwn(record, key)) {
    return undefined;
  }

  const value = record[key];
  if (value === null) {
    return null;
  }

  if (typeof value !== "string") {
    throw new Error(`${key} must be a string or null.`);
  }

  return value;
};

const requiredStringField = (
  record: Record<string, unknown>,
  key: string,
): string => {
  const value = record[key];
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`${key} is required.`);
  }

  return value;
};

const parseCourseStatus = (value: string | null): StoreCourseStatus | undefined => {
  if (value === null) {
    return undefined;
  }

  if (value === "draft" || value === "active" || value === "archived") {
    return value;
  }

  throw new Error("status must be draft, active, or archived.");
};

const courseResource = (course: Course): Record<string, unknown> => ({
  id: course.id,
  title: course.title,
  description: course.description,
  harnessId: course.harnessId,
  attachedDir: course.attachedDir,
  status: course.status,
  sourceName: course.sourceName,
  manifestExtra: course.manifestExtra,
  createdAt: course.createdAt,
  updatedAt: course.updatedAt,
});

const demoKey = (demo: Demo): string => {
  if (demo.fileName !== null && demo.fileName.endsWith(".html")) {
    return demo.fileName;
  }

  return `demo-${demo.id}.html`;
};

const uiDemo = (demo: Demo): DemoEntry => ({
  file: demoKey(demo),
  ...(demo.title === null ? {} : { title: demo.title }),
  addedAt: demo.addedAt,
});

const uiGlossaryEntry = (entry: StoreGlossaryEntry): GlossaryEntry => ({
  term: entry.term,
  def: entry.definition,
  ...(entry.lessonId === null ? {} : { lesson: entry.lessonId }),
  addedAt: entry.addedAt,
});

const uiMasteryEntry = (entry: MasteryEvent): MasteryEntry => ({
  concept: entry.concept,
  score: entry.score,
  ...(entry.gaps === null ? {} : { gaps: entry.gaps }),
  at: entry.ts,
});

const demosByTopicId = (
  demos: readonly Demo[],
): ReadonlyMap<number | null, readonly DemoEntry[]> => {
  const grouped = new Map<number | null, DemoEntry[]>();

  for (const demo of demos) {
    const existing = grouped.get(demo.topicId) ?? [];
    existing.push(uiDemo(demo));
    grouped.set(demo.topicId, existing);
  }

  return grouped;
};

const uiTopic = (
  topic: Topic,
  groupedDemos: ReadonlyMap<number | null, readonly DemoEntry[]>,
): TopicNode => ({
  path: topic.path,
  title: topic.title,
  ...(topic.lessonId === null ? {} : { lesson: topic.lessonId }),
  ...(topic.enteredAt === null ? {} : { enteredAt: topic.enteredAt }),
  current: topic.isCurrent,
  demos: groupedDemos.get(topic.id) ?? [],
  children: topic.children.map((child) => uiTopic(child, groupedDemos)),
});

const activeFeynman = (check: FeynmanCheck | null): ActiveFeynmanCheck | undefined =>
  check === null
    ? undefined
    : {
        concept: check.concept,
        prompt: check.prompt,
        keyPoints: check.keyPoints,
        issuedAt: check.issuedAt,
        ...(check.replacedConcept === null ||
        check.replacedIssuedAt === null ||
        check.replacedAt === null
          ? {}
          : {
              replaced: {
                concept: check.replacedConcept,
                issuedAt: check.replacedIssuedAt,
                replacedAt: check.replacedAt,
              },
            }),
      };

const transcriptPayloadRecord = (
  entry: StoreTranscriptEntry,
): Record<string, unknown> =>
  isRecord(entry.payload) ? entry.payload : {};

const uiTranscriptEntry = (entry: StoreTranscriptEntry): TranscriptEntry => {
  const payload = transcriptPayloadRecord(entry);
  const at = entry.ts;

  if (entry.kind === "feynman-answer") {
    return {
      role: "learner",
      kind: "feynman-answer",
      concept:
        typeof payload["concept"] === "string" ? payload["concept"] : "unknown",
      text: entry.content,
      at,
    };
  }

  if (entry.kind === "tool-call") {
    return {
      role: "system",
      kind: "tool-call",
      text: entry.content,
      at,
      tool: typeof payload["tool"] === "string" ? payload["tool"] : "tool",
    };
  }

  return {
    role: entry.role === "agent" ? "agent" : "learner",
    text: entry.content,
    at,
  };
};

const readTranscriptTail = (
  store: Store,
  courseId: number,
): readonly TranscriptEntry[] => {
  let afterId: number | undefined;
  let tail: readonly StoreTranscriptEntry[] = [];

  while (true) {
    const page = pageTranscript(store, courseId, {
      ...(afterId === undefined ? {} : { afterId }),
      limit: 200,
    });
    tail = [...tail, ...page.entries].slice(-200);

    if (page.nextAfterId === null) {
      break;
    }

    afterId = page.nextAfterId;
  }

  return tail.map(uiTranscriptEntry);
};

const lessonSnapshot = (
  lessons: readonly Lesson[],
  glossary: readonly GlossaryEntry[],
  demoFiles: ReadonlySet<string>,
) => {
  const rendered = lessons.map((lesson) => ({
    id: lesson.lessonId,
    html: renderMarkdown(lesson.bodyMarkdown, { glossary, demoFiles }),
    modifiedAtMs:
      lesson.sourceMtimeMs ??
      Date.parse(lesson.updatedAt) ??
      Date.parse(lesson.createdAt),
  }));
  const selected = rendered.reduce<
    { id: string; modifiedAtMs: number } | undefined
  >((latest, lesson) => {
    if (latest === undefined || lesson.modifiedAtMs >= latest.modifiedAtMs) {
      return { id: lesson.id, modifiedAtMs: lesson.modifiedAtMs };
    }

    return latest;
  }, undefined);

  return {
    lessons: rendered,
    selectedLessonId: selected?.id,
  };
};

const courseView = (store: Store, courseId: number) => {
  const course = getCourse(store, courseId);
  if (course === undefined) {
    return undefined;
  }

  const demos = listDemos(store, courseId);
  const groupedDemos = demosByTopicId(demos);
  const demoFiles = new Set(demos.map(demoKey));
  const glossary = listGlossary(store, courseId).map(uiGlossaryEntry);

  return {
    course,
    transcript: readTranscriptTail(store, courseId),
    lessons: lessonSnapshot(listLessons(store, courseId), glossary, demoFiles),
    glossary,
    topics: readTopicTree(store, courseId).map((topic) =>
      uiTopic(topic, groupedDemos),
    ),
    unassignedDemos: groupedDemos.get(null) ?? [],
    masteryScores: listLatestMasteryScores(store, courseId).map(uiMasteryEntry),
    demoFiles,
    activeFeynmanCheck: activeFeynman(getActiveFeynmanCheck(store, courseId)),
  };
};

const courseState = (store: Store, courseId: number): Record<string, unknown> | undefined => {
  const view = courseView(store, courseId);
  if (view === undefined) {
    return undefined;
  }

  return {
    course: courseResource(view.course),
    lessons: view.lessons,
    topics: view.topics,
    glossary: view.glossary,
    mastery: view.masteryScores,
    demos: listDemos(store, courseId).map((demo) => ({
      id: demo.id,
      topicId: demo.topicId,
      fileName: demo.fileName,
      key: demoKey(demo),
      title: demo.title,
      bodyFormat: demo.bodyFormat,
      addedAt: demo.addedAt,
    })),
    activeFeynmanCheck: view.activeFeynmanCheck ?? null,
    transcript: view.transcript,
  };
};

const renderCoursePicker = (courses: readonly Course[]): Response => {
  const rows =
    courses.length === 0
      ? '<p class="empty">No courses yet.</p>'
      : `<ul>${courses
          .map(
            (course) =>
              `<li><a href="/?course=${course.id}">${escapeHtml(course.title)}</a><span>${escapeHtml(course.status)}</span></li>`,
          )
          .join("")}</ul>`;

  return new Response(
    `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>overlearn</title>
  <style>
    body { margin: 0; min-height: 100vh; font: 16px system-ui, sans-serif; background: #11110f; color: #ece8dc; }
    main { width: min(44rem, calc(100vw - 2rem)); margin: 0 auto; padding: 3rem 0; }
    h1 { font-size: 1.6rem; margin: 0 0 1.5rem; }
    ul { list-style: none; padding: 0; display: grid; gap: .5rem; }
    li { display: flex; justify-content: space-between; gap: 1rem; border: 1px solid #33362d; border-radius: 8px; padding: .85rem 1rem; }
    a { color: #dcefc7; text-decoration: none; font-weight: 700; }
    span, .empty { color: #aaa493; }
    form { display: grid; gap: .65rem; margin-top: 2rem; }
    input, button { font: inherit; border-radius: 8px; border: 1px solid #33362d; padding: .75rem .85rem; }
    input { background: #1a1b18; color: #ece8dc; }
    button { background: #8fbf73; color: #11110f; border: 0; font-weight: 700; cursor: pointer; }
  </style>
</head>
<body>
  <main>
    <h1>overlearn courses</h1>
    ${rows}
    <form id="create-course">
      <input name="title" placeholder="New course title" required>
      <button type="submit">Create course</button>
    </form>
  </main>
  <script>
    document.querySelector("#create-course").addEventListener("submit", async (event) => {
      event.preventDefault();
      const title = new FormData(event.currentTarget).get("title");
      const response = await fetch("/api/courses", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ title })
      });
      if (response.ok) {
        const created = await response.json();
        location.href = "/?course=" + created.id;
      }
    });
  </script>
</body>
</html>`,
    {
      headers: { "content-type": "text/html; charset=utf-8" },
    },
  );
};

const selectedHarnessId = (
  store: Store,
  courseId: number | undefined,
  env: Env,
): string => {
  if (courseId !== undefined) {
    const course = getCourse(store, courseId);
    if (course?.harnessId !== null && course?.harnessId !== undefined) {
      return course.harnessId;
    }
  }

  return env["OVERLEARN_HARNESS"] ?? DEFAULT_HARNESS_ID;
};

const detectHarnesses = (): Map<string, AdapterDetection> => {
  const detections = new Map<string, AdapterDetection>();

  for (const adapter of listHarnessAdapters()) {
    detections.set(adapter.id, adapter.detect());
  }

  return detections;
};

const harnessSummaries = (
  store: Store,
  courseId: number | undefined,
  env: Env,
  cache: { value?: Map<string, AdapterDetection> },
  refresh = false,
): readonly HarnessSummary[] => {
  if (cache.value === undefined || refresh) {
    cache.value = detectHarnesses();
  }

  const selected = selectedHarnessId(store, courseId, env);

  return listHarnessAdapters().map((adapter) => {
    const detection = cache.value?.get(adapter.id) ?? {
      installed: false,
      authenticated: false,
    };

    return {
      id: adapter.id,
      name: adapter.name,
      installed: detection.installed,
      authenticated: detection.authenticated,
      ...(detection.version === undefined ? {} : { version: detection.version }),
      selected: adapter.id === selected,
    };
  });
};

const nextTurnNumber = (store: Store, courseId: number): number => {
  const transcriptRow = store.db
    .query(
      "SELECT COALESCE(MAX(turn), 0) AS turn FROM transcript WHERE course_id = ?1",
    )
    .get(courseId) as { turn: number | bigint } | undefined;
  const eventsRow = store.db
    .query(
      "SELECT COALESCE(MAX(turn), 0) AS turn FROM turn_events WHERE course_id = ?1",
    )
    .get(courseId) as { turn: number | bigint } | undefined;
  const transcriptTurn =
    typeof transcriptRow?.turn === "bigint"
      ? Number(transcriptRow.turn)
      : (transcriptRow?.turn ?? 0);
  const eventsTurn =
    typeof eventsRow?.turn === "bigint"
      ? Number(eventsRow.turn)
      : (eventsRow?.turn ?? 0);

  return Math.max(transcriptTurn, eventsTurn) + 1;
};

const appendUiTranscript = (
  store: Store,
  courseId: number,
  input: Parameters<typeof appendTranscriptEntry>[2],
): TranscriptEntry => uiTranscriptEntry(appendTranscriptEntry(store, courseId, input));

const routeCourseRequest = (
  path: string,
): Readonly<{ courseId: number; rest: readonly string[] }> | undefined => {
  const segments = path.split("/").filter((segment) => segment.length > 0);
  if (segments[0] !== "api" || segments[1] !== "courses") {
    return undefined;
  }

  const rawCourseId = segments[2];
  if (rawCourseId === undefined) {
    return undefined;
  }

  const courseId = Number(rawCourseId);
  if (!Number.isInteger(courseId) || courseId <= 0) {
    return undefined;
  }

  return {
    courseId,
    rest: segments.slice(3),
  };
};

const demoResponse = (store: Store, courseId: number, file: string): Response => {
  const demo = listDemos(store, courseId).find((candidate) => demoKey(candidate) === file);
  if (demo === undefined) {
    return textResponse("Demo not found.", 404);
  }

  if (demo.bodyFormat === "html") {
    return new Response(demo.body, {
      headers: {
        "content-type": "text/html; charset=utf-8",
        "content-security-policy":
          "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data:;",
      },
    });
  }

  const html =
    demo.bodyFormat === "markdown"
      ? renderMarkdown(demo.body)
      : `<pre>${escapeHtml(demo.body)}</pre>`;

  return new Response(`<!doctype html><meta charset="utf-8">${html}`, {
    headers: {
      "content-type": "text/html; charset=utf-8",
      "content-security-policy": "default-src 'none'; style-src 'unsafe-inline';",
    },
  });
};

export const runDaemon = async (env: Env = process.env): Promise<void> => {
  const store = openStore({ env });
  const tokenScopes = new Map<string, TokenScope>();
  const statuses = new Map<number, UiStatusPayload>();
  const activeTurnByCourse = new Map<number, number>();
  const agentStreamReplay: AgentStreamPayload[] = [];
  const harnessDetectionCache: { value?: Map<string, AdapterDetection> } = {};
  let runtime: CourseRuntime | undefined;
  let activeCourseId: number | undefined;
  let port = 0;
  let shuttingDown = false;

  const statusForCourse = (courseId: number): UiStatusPayload =>
    statuses.get(courseId) ?? {
      courseId,
      status: "waiting-for-agent",
      hasSeenWait: true,
    };

  const setStatus = (
    courseId: number,
    status: UiStatus,
    message?: string,
  ): void => {
    const payload = {
      courseId,
      status,
      hasSeenWait: true,
      ...(message === undefined ? {} : { message }),
    };
    statuses.set(courseId, payload);
    sseHub.broadcast("status", payload);
  };

  const coursesPayload = (): Record<string, unknown> => ({
    courses: listCourses(store).map(courseResource),
    activeCourseId: activeCourseId ?? null,
  });

  const harnessesPayload = (
    courseId: number | undefined,
    switched: boolean,
    refresh = false,
  ): HarnessesPayload => ({
    ...(courseId === undefined ? {} : { courseId }),
    harnesses: harnessSummaries(store, courseId, env, harnessDetectionCache, refresh),
    switched,
  });

  const sseHub = createSseHub(
    () => [...statuses.values()],
    (courseId) => harnessesPayload(courseId, false),
    coursesPayload,
  );

  const broadcastCourseCollections = (courseId: number): void => {
    const view = courseView(store, courseId);
    if (view === undefined) {
      return;
    }

    sseHub.broadcast("transcript", {
      courseId,
      entries: view.transcript,
    });
    sseHub.broadcast("glossary", {
      courseId,
      entries: view.glossary,
    });
    sseHub.broadcast("topics", {
      courseId,
      topics: view.topics,
      unassignedDemos: view.unassignedDemos,
    });
    sseHub.broadcast("mastery", {
      courseId,
      entries: view.masteryScores,
    });
    sseHub.broadcast("feynman", {
      courseId,
      activeCheck: view.activeFeynmanCheck ?? null,
    });
  };

  const onTeachingWrite = (event: TeachingWriteEvent): void => {
    const turn = activeTurnByCourse.get(event.courseId);
    const entry = appendUiTranscript(store, event.courseId, {
      ...(turn === undefined ? {} : { turn }),
      role: "system",
      kind: "tool-call",
      content: event.summary,
      payload: {
        tool: event.tool,
        summary: event.summary,
      },
    });

    sseHub.broadcast("message", { courseId: event.courseId, entry });
    sseHub.broadcast("tool-write", event);
    broadcastCourseCollections(event.courseId);
  };

  const teachingMcpHandler = createTeachingMcpHttpHandler({
    store,
    resolveScope: (token) => {
      const scope = tokenScopes.get(token);
      return scope === undefined ? null : { courseId: scope.courseId };
    },
    onWrite: onTeachingWrite,
  });

  const registerTeachingSession = (
    input: Readonly<{ courseId: number; harnessId: string }>,
  ): ActiveTeachingSessionRegistration => {
    const token = randomBytes(32).toString("base64url");
    const session = startSession(store, {
      courseId: input.courseId,
      harnessId: input.harnessId,
    });

    tokenScopes.set(token, {
      courseId: input.courseId,
      sessionId: session.id,
    });

    return { token, sessionId: session.id };
  };

  const unregisterTeachingSession = (
    registration: ActiveTeachingSessionRegistration,
    reason: string,
  ): void => {
    tokenScopes.delete(registration.token);

    if (registration.sessionId !== undefined) {
      endStoreSession(store, registration.sessionId, reason);
    }
  };

  const revokeTeachingTokensForCourse = (courseId: number, reason: string): void => {
    for (const [token, scope] of [...tokenScopes.entries()]) {
      if (scope.courseId !== courseId) {
        continue;
      }

      tokenScopes.delete(token);
      if (scope.sessionId !== undefined) {
        endStoreSession(store, scope.sessionId, reason);
      }
    }
  };

  const appendAgentEventTranscript = (payload: AgentStreamPayload): void => {
    const event = payload.event;

    if (event.type === "text") {
      const entry = appendUiTranscript(store, payload.courseId, {
        turn: payload.turn,
        role: "agent",
        kind: "text",
        content: event.text,
      });
      sseHub.broadcast("message", { courseId: payload.courseId, entry });
      return;
    }

    if (
      event.type === "tool-call" &&
      (event.status === "completed" || event.status === "failed")
    ) {
      const tool = event.name ?? event.id;
      const summary =
        event.status === "failed"
          ? `${tool} failed${event.error === undefined ? "" : `: ${event.error}`}`
          : `${tool} completed`;
      const entry = appendUiTranscript(store, payload.courseId, {
        turn: payload.turn,
        role: "system",
        kind: "tool-call",
        content: summary,
        payload: {
          tool,
          status: event.status,
        },
      });
      sseHub.broadcast("message", { courseId: payload.courseId, entry });
    }
  };

  const onAgentEvent = (payload: AgentStreamPayload): void => {
    const terminalWrapUp =
      payload.event.type === "done" &&
      statuses.get(payload.courseId)?.status === "wrapping-up";
    if (terminalWrapUp) {
      revokeTeachingTokensForCourse(payload.courseId, "done");
    }
    if (payload.event.type === "error") {
      revokeTeachingTokensForCourse(payload.courseId, "agent-crashed");
    }

    agentStreamReplay.push(payload);
    agentStreamReplay.splice(0, Math.max(0, agentStreamReplay.length - MAX_AGENT_STREAM_REPLAY));
    appendAgentEventTranscript(payload);
    sseHub.broadcast("agent-stream", payload);
  };

  const ensureRuntime = (course: Course): CourseRuntime => {
    if (runtime !== undefined && runtime.courseId === course.id) {
      return runtime;
    }

    const mcpBaseUrl = formatDaemonUrl(port, "");
    const orchestrator = createDaemonTurnOrchestrator({
      courseId: course.id,
      courseTitle: course.title,
      attachedDir: course.attachedDir,
      cwd: store.dataDir,
      mcpBaseUrl,
      env,
      getHarnessId: () => getCourse(store, course.id)?.harnessId ?? undefined,
      onAgentEvent,
      registerTeachingSession,
      unregisterTeachingSession,
    });

    runtime = {
      courseId: course.id,
      orchestrator,
      runningTurn: false,
    };
    activeCourseId = course.id;

    return runtime;
  };

  const rejectDifferentActiveCourse = (courseId: number): Response | undefined => {
    if (activeCourseId !== undefined && activeCourseId !== courseId) {
      // v1 keeps one active learning session explicit: callers must finish or
      // shut down the active course before starting another course.
      return textResponse(
        `Course ${activeCourseId} already has the active learning session.`,
        409,
      );
    }

    return undefined;
  };

  const runCourseTurn = (
    course: Course,
    events: readonly TurnEvent[],
    mode: TurnPromptMode,
    existingTurn?: number,
  ): Response => {
    const activeCourseRejection = rejectDifferentActiveCourse(course.id);
    if (activeCourseRejection !== undefined) {
      return activeCourseRejection;
    }

    const currentRuntime = ensureRuntime(course);
    if (currentRuntime.runningTurn) {
      return textResponse("A turn is already running for this course.", 409);
    }

    const turn: TurnPayload = {
      turn: existingTurn ?? nextTurnNumber(store, course.id),
      createdAt: new Date().toISOString(),
      events,
    };
    currentRuntime.runningTurn = true;
    activeTurnByCourse.set(course.id, turn.turn);
    setStatus(course.id, mode === "wrap-up" ? "wrapping-up" : "agent-working");
    appendTurnEvents(store, course.id, {
      turn: turn.turn,
      status: "pending",
      createdAt: turn.createdAt,
      events: turn.events.map((event) => ({ ...event })),
      importedFrom: null,
    });

    void (async () => {
      const result = await currentRuntime.orchestrator.runTurn(turn, mode);
      appendTurnEvents(store, course.id, {
        turn: turn.turn,
        status: "completed",
        createdAt: new Date().toISOString(),
        events: turn.events.map((event) => ({ ...event })),
        importedFrom: null,
      });

      currentRuntime.runningTurn = false;
      activeTurnByCourse.delete(course.id);

      if (!result.ok) {
        setStatus(course.id, "agent-failed", result.message);
        return;
      }

      if (mode === "wrap-up") {
        await currentRuntime.orchestrator.endSession("done");
        runtime = undefined;
        setStatus(course.id, "session-ended");
        setTimeout(() => {
          void shutdown();
        }, 250);
        return;
      }

      setStatus(course.id, "waiting-for-agent");
      broadcastCourseCollections(course.id);
    })().catch((error) => {
      currentRuntime.runningTurn = false;
      activeTurnByCourse.delete(course.id);
      setStatus(
        course.id,
        "agent-failed",
        error instanceof Error ? error.message : "Agent turn failed.",
      );
    });

    return jsonResponse({ ok: true, turn: turn.turn });
  };

  const parseSubmit = async (request: Request): Promise<MessageTurnEvent> => {
    const body = await readJsonBody(request);
    if (!isRecord(body)) {
      throw new Error("Submit body must be an object.");
    }

    return {
      type: "message",
      text: requiredStringField(body, "text"),
    };
  };

  const parseNav = async (request: Request, courseId: number): Promise<TurnEvent> => {
    const body = await readJsonBody(request);
    if (!isRecord(body)) {
      throw new Error("Nav body must be an object.");
    }

    const path = requiredStringField(body, "path");
    if (path === REVIEW_WEAK_NAV_PATH) {
      const weakest = flattenTopicTree(readTopicTree(store, courseId))
        .flatMap((topic) => {
          const score = listLatestMasteryScores(store, courseId).find(
            (entry) => entry.concept === topic.path || entry.concept === topic.path.split("/").at(-1),
          );
          return score === undefined ? [] : [score];
        })
        .sort((left, right) => left.score - right.score)
        .slice(0, 3)
        .map((entry) => entry.concept);

      return { type: "review-weak", concepts: weakest };
    }

    return { type: "nav", path };
  };

  const parseFeynmanAnswer = async (
    request: Request,
  ): Promise<FeynmanAnswerTurnEvent> => {
    const body = await readJsonBody(request);
    if (!isRecord(body)) {
      throw new Error("Feynman answer body must be an object.");
    }

    const keyPoints = body["keyPoints"];
    if (!Array.isArray(keyPoints) || !keyPoints.every((entry) => typeof entry === "string")) {
      throw new Error("keyPoints must be an array of strings.");
    }

    return {
      type: "feynman-answer",
      concept: requiredStringField(body, "concept"),
      text: requiredStringField(body, "text"),
      keyPoints,
    };
  };

  const handleCoursesRoot = async (
    request: Request,
    requestUrl: URL,
  ): Promise<Response> => {
    if (request.method === "GET") {
      const status = parseCourseStatus(requestUrl.searchParams.get("status"));
      return jsonResponse(listCourses(store, status).map(courseResource));
    }

    if (request.method === "POST") {
      const body = await readJsonBody(request);
      if (!isRecord(body)) {
        return textResponse("Course body must be an object.", 400);
      }

      try {
        const input: CourseCreateDraft = {
          title: requiredStringField(body, "title"),
        };
        const description = optionalStringField(body, "description");
        const harnessId = optionalStringField(body, "harnessId");
        const attachedDir = optionalStringField(body, "attachedDir");
        const sourceName = optionalStringField(body, "sourceName");

        if (description !== undefined) {
          input.description = description;
        }
        if (harnessId !== undefined) {
          input.harnessId = harnessId;
        }
        if (attachedDir !== undefined) {
          input.attachedDir = attachedDir;
        }
        if (sourceName !== undefined) {
          input.sourceName = sourceName;
        }

        const course = createCourse(store, input);
        sseHub.broadcast("courses", coursesPayload());
        return jsonResponse(courseResource(course), { status: 201 });
      } catch (error) {
        return textResponse(error instanceof Error ? error.message : "Invalid course.", 400);
      }
    }

    return emptyResponse(405);
  };

  const handleCourseApi = async (
    request: Request,
    _requestUrl: URL,
    courseId: number,
    rest: readonly string[],
  ): Promise<Response> => {
    const course = getCourse(store, courseId);
    if (course === undefined) {
      return textResponse("Course not found.", 404);
    }

    if (rest.length === 0) {
      if (request.method === "GET") {
        return jsonResponse(courseState(store, courseId));
      }

      if (request.method === "PATCH") {
        const body = await readJsonBody(request);
        if (!isRecord(body)) {
          return textResponse("Course patch must be an object.", 400);
        }

        try {
          const patch: CoursePatchDraft = {};

          if (Object.hasOwn(body, "title")) {
            patch.title = requiredStringField(body, "title");
          }
          if (Object.hasOwn(body, "description")) {
            const description = optionalStringField(body, "description");
            if (description !== undefined) {
              patch.description = description;
            }
          }
          if (Object.hasOwn(body, "harnessId")) {
            const harnessId = optionalStringField(body, "harnessId");
            if (harnessId !== undefined) {
              patch.harnessId = harnessId;
            }
          }
          if (Object.hasOwn(body, "attachedDir")) {
            const attachedDir = optionalStringField(body, "attachedDir");
            if (attachedDir !== undefined) {
              patch.attachedDir = attachedDir;
            }
          }
          if (Object.hasOwn(body, "sourceName")) {
            const sourceName = optionalStringField(body, "sourceName");
            if (sourceName !== undefined) {
              patch.sourceName = sourceName;
            }
          }
          if (Object.hasOwn(body, "status")) {
            const status = parseCourseStatus(
              optionalStringField(body, "status") ?? null,
            );
            if (status !== undefined) {
              patch.status = status;
            }
          }

          const patched = patchCourse(store, courseId, patch);
          sseHub.broadcast("courses", coursesPayload());
          return jsonResponse(courseResource(patched));
        } catch (error) {
          return textResponse(error instanceof Error ? error.message : "Invalid course patch.", 400);
        }
      }

      if (request.method === "DELETE") {
        const archived = patchCourse(store, courseId, { status: "archived" });
        sseHub.broadcast("courses", coursesPayload());
        return jsonResponse(courseResource(archived));
      }
    }

    const [action, extra] = rest;

    if (action === "submit" && extra === undefined && request.method === "POST") {
      try {
        const event = await parseSubmit(request);
        const turn = nextTurnNumber(store, courseId);
        const entry = appendUiTranscript(store, courseId, {
          turn,
          role: "learner",
          kind: "text",
          content: event.text,
        });
        sseHub.broadcast("message", { courseId, entry });
        return runCourseTurn(course, [event], "teaching", turn);
      } catch (error) {
        return textResponse(error instanceof Error ? error.message : "Invalid submit request.", 400);
      }
    }

    if (action === "nav" && extra === undefined && request.method === "POST") {
      try {
        return runCourseTurn(course, [await parseNav(request, courseId)], "teaching");
      } catch (error) {
        return textResponse(error instanceof Error ? error.message : "Invalid nav request.", 400);
      }
    }

    if (action === "done" && extra === undefined && request.method === "POST") {
      return runCourseTurn(course, [{ type: "session-done" }], "wrap-up");
    }

    if (
      action === "feynman-answer" &&
      extra === undefined &&
      request.method === "POST"
    ) {
      try {
        const event = await parseFeynmanAnswer(request);
        const turn = nextTurnNumber(store, courseId);
        const entry = appendUiTranscript(store, courseId, {
          turn,
          role: "learner",
          kind: "feynman-answer",
          content: event.text,
          payload: {
            concept: event.concept,
            keyPoints: event.keyPoints,
          },
        });
        clearActiveFeynmanCheck(store, courseId);
        sseHub.broadcast("message", { courseId, entry });
        broadcastCourseCollections(courseId);
        return runCourseTurn(course, [event], "teaching", turn);
      } catch (error) {
        return textResponse(error instanceof Error ? error.message : "Invalid Feynman answer.", 400);
      }
    }

    if (action === "harness" && extra === undefined && request.method === "POST") {
      const body = await readJsonBody(request);
      if (!isRecord(body)) {
        return textResponse("Harness body must be an object.", 400);
      }

      const id = requiredStringField(body, "id");
      const adapter = listHarnessAdapters().find((candidate) => candidate.id === id);
      if (adapter === undefined) {
        return textResponse(`Unknown harness adapter: ${id}`, 400);
      }

      if (runtime?.runningTurn === true) {
        return textResponse(
          "Cannot change harness while a turn is running. Try again after the agent stops.",
          409,
        );
      }

      const previousHarnessId = selectedHarnessId(store, courseId, env);
      patchCourse(store, courseId, { harnessId: id });
      const currentRuntime = runtime;
      const hadActiveSession =
        currentRuntime !== undefined && currentRuntime.courseId === courseId
          ? await currentRuntime.orchestrator.resetSession("harness-swap")
          : false;
      const payload = harnessesPayload(courseId, hadActiveSession, true);
      sseHub.broadcast("harnesses", payload);

      if (hadActiveSession) {
        runCourseTurn(
          getCourse(store, courseId) ?? course,
          [{ type: "harness-swapped", from: previousHarnessId, to: id }],
          "greeting",
        );
      }

      return jsonResponse({
        ok: true,
        harness: id,
        swapped: hadActiveSession,
      });
    }

    if (action === "activate" && extra === undefined && request.method === "POST") {
      const activeCourseRejection = rejectDifferentActiveCourse(courseId);
      if (activeCourseRejection !== undefined) {
        return activeCourseRejection;
      }

      ensureRuntime(course);
      return jsonResponse({ ok: true, activeCourseId: courseId });
    }

    if (action === "demos" && extra !== undefined && request.method === "GET") {
      return demoResponse(store, courseId, decodeURIComponent(extra));
    }

    return textResponse("Not found.", 404);
  };

  const healthPayload = (): Record<string, unknown> => ({
    ok: true,
    orchestrated: true,
    version: packageJson.version,
    activeCourseId: activeCourseId ?? null,
    waitPending: false,
    hasSeenWait: true,
    dataDir: store.dataDir,
  });

  const shutdown = async (): Promise<void> => {
    if (shuttingDown) {
      return;
    }

    shuttingDown = true;
    if (runtime !== undefined) {
      await runtime.orchestrator.endSession("shutdown");
      runtime = undefined;
    }
    tokenScopes.clear();
    await clearDaemonMetadata(env);
    sseHub.closeAll();
    await new Promise<void>((resolveClose) => {
      server.close(() => resolveClose());
    });
    store.close();
  };

  const handleRequest = async (request: Request): Promise<Response> => {
    const requestUrl = new URL(request.url);
    const method = request.method;

    if (method === "GET" && requestUrl.pathname === "/api/health") {
      return jsonResponse(healthPayload());
    }

    if (method === "POST" && requestUrl.pathname === "/api/shutdown") {
      setTimeout(() => {
        void shutdown();
      }, 0);
      return jsonResponse({ ok: true });
    }

    if (method === "GET" && requestUrl.pathname === "/api/harnesses") {
      const courseIdParam = requestUrl.searchParams.get("courseId");
      const courseId =
        courseIdParam === null || courseIdParam.length === 0
          ? activeCourseId
          : Number(courseIdParam);
      const validCourseId =
        typeof courseId === "number" && Number.isInteger(courseId)
          ? courseId
          : undefined;
      return jsonResponse(
        harnessSummaries(
          store,
          validCourseId,
          env,
          harnessDetectionCache,
          requestUrl.searchParams.get("refresh") === "1",
        ),
      );
    }

    if (requestUrl.pathname === "/api/courses") {
      return await handleCoursesRoot(request, requestUrl);
    }

    const courseRoute = routeCourseRequest(requestUrl.pathname);
    if (courseRoute !== undefined) {
      return await handleCourseApi(
        request,
        requestUrl,
        courseRoute.courseId,
        courseRoute.rest,
      );
    }

    if (requestUrl.pathname.startsWith("/mcp/")) {
      const token = teachingTokenFromRequestPath(request);
      if (token === undefined || !tokenScopes.has(token)) {
        return textResponse("Unknown teaching session token.", 404);
      }

      return await teachingMcpHandler(request);
    }

    if (method === "GET" && requestUrl.pathname === "/") {
      const courseParam = requestUrl.searchParams.get("course");
      if (courseParam !== null) {
        const courseId = Number(courseParam);
        if (Number.isInteger(courseId)) {
          const view = courseView(store, courseId);
          if (view === undefined) {
            return textResponse("Course not found.", 404);
          }

          statuses.set(courseId, statusForCourse(courseId));
          const html = renderPage(
            view.course.title,
            view.transcript,
            view.lessons,
            view.glossary,
            view.topics,
            view.unassignedDemos,
            view.masteryScores,
            view.demoFiles,
            view.activeFeynmanCheck,
            statusForCourse(courseId).status,
            true,
            {
              courseId,
              orchestrated: true,
              harnesses: harnessSummaries(
                store,
                courseId,
                env,
                harnessDetectionCache,
                false,
              ),
            },
          );

          return new Response(html, {
            headers: { "content-type": "text/html; charset=utf-8" },
          });
        }
      }

      return renderCoursePicker(listCourses(store, "active"));
    }

    return textResponse("Not found.", 404);
  };

  const server = createServer((incoming, outgoing) => {
    if (incoming.url === "/api/events" && incoming.method === "GET") {
      sseHub.connect(incoming, outgoing);
      for (const replay of agentStreamReplay) {
        outgoing.write(`event: agent-stream\ndata: ${JSON.stringify(replay)}\n\n`);
      }
      return;
    }

    void (async () => {
      const request = await webRequestFromIncoming(incoming, port);
      const response = await handleRequest(request);
      await writeWebResponse(outgoing, response);
    })().catch(async (error) => {
      const message = error instanceof Error ? error.message : "Internal daemon error.";
      await writeWebResponse(outgoing, textResponse(message, 500));
    });
  });

  server.keepAliveTimeout = 0;
  server.headersTimeout = 0;

  await new Promise<void>((resolveListen, rejectListen) => {
    server.once("error", rejectListen);
    server.listen(0, LOCALHOST_BIND_HOST, () => {
      const address = server.address();
      if (address === null || typeof address === "string") {
        rejectListen(new Error("Daemon did not bind to a TCP port."));
        return;
      }

      port = address.port;
      resolveListen();
    });
  });

  await writeDaemonMetadata(
    {
      pid: process.pid,
      port,
      startedAt: new Date().toISOString(),
    },
    env,
  );

  const cleanup = (): void => {
    void shutdown();
  };
  process.once("SIGTERM", cleanup);
  process.once("SIGINT", cleanup);

  await new Promise<void>((resolveClosed) => {
    server.once("close", () => resolveClosed());
  });
};
