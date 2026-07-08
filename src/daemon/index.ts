import { randomBytes } from "node:crypto";
import { mkdir, rm } from "node:fs/promises";
import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import { dirname, join } from "node:path";
import { spawn as spawnChildProcess } from "node:child_process";

import packageJson from "../../package.json";
import {
  getHarnessAdapterDefinition,
  listHarnessAdapters,
  type HarnessCommand,
} from "../adapter/registry";
import type { AdapterDetection, HarnessAdapterId } from "../adapter/types";
import {
  appendTranscriptEntry,
  appendTurnEvents,
  clearActiveFeynmanCheck,
  createCourse,
  deleteCourse,
  demoFileKey,
  endSession as endStoreSession,
  flattenTopicTree,
  getActiveFeynmanCheck,
  getCourse,
  getProfile,
  getStoreDataDir,
  listCourses,
  listDemos,
  listGlossary,
  listLatestMasteryScores,
  listLessons,
  openStore,
  pageTranscript,
  patchProfile,
  patchCourse,
  readTopicTree,
  replaceTopicTree,
  startSession,
  withStoreTransaction,
  type Course,
  type CourseStatus as StoreCourseStatus,
  type Demo,
  type FeynmanCheck,
  type GlossaryEntry as StoreGlossaryEntry,
  type Lesson,
  type MasteryEvent,
  type Profile,
  type Store,
  type Topic,
  type TopicTreeInput,
  type TranscriptEntry as StoreTranscriptEntry,
} from "../store";
import {
  exportCourseBundle,
  importCoursePath,
  type ExportCourseBundleOptions,
} from "../store/bundle";
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
import { createTutorialCourse } from "./tutorial";

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

export const REVIEW_WEAK_NAV_PATH = "overlearn:review-weak";

type Env = Readonly<Record<string, string | undefined>>;

type DaemonMetadata = Readonly<{
  pid: number;
  port: number;
  token: string;
  startedAt: string;
}>;

export type RunDaemonOptions = Readonly<{
  portFile?: string;
  harnessLoginSpawner?: (input: HarnessLoginSpawnInput) => void;
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

type DemoEntry = Readonly<{
  file: string;
  title?: string;
  addedAt: string;
}>;

type GlossaryEntry = Readonly<{
  term: string;
  def: string;
  topicId: number | null;
  addedAt: string;
}>;

type MasteryEntry = Readonly<{
  concept: string;
  score: number;
  gaps?: string;
  at: string;
}>;

type TopicNode = Readonly<{
  path: string;
  title: string;
  body?: string;
  enteredAt?: string;
  current: boolean;
  state: Topic["state"];
  demos?: readonly DemoEntry[];
  children: readonly TopicNode[];
}>;

type ActiveFeynmanCheck = Readonly<{
  concept: string;
  prompt: string;
  keyPoints: readonly string[];
  issuedAt: string;
  replaced?: Readonly<{
    concept: string;
    issuedAt: string;
    replacedAt: string;
  }>;
}>;

type TranscriptEntry =
  | Readonly<{
      role: "learner" | "agent";
      text: string;
      at: string;
      kind?: "text";
      turn?: number;
    }>
  | Readonly<{
      role: "agent";
      kind: "demo";
      file: string;
      title?: string;
      at: string;
      turn?: number;
    }>
  | Readonly<{
      role: "agent";
      kind: "lesson";
      lesson: string;
      at: string;
      turn?: number;
    }>
  | Readonly<{
      role: "agent";
      kind: "feynman-check";
      concept: string;
      prompt: string;
      at: string;
      turn?: number;
    }>
  | Readonly<{
      role: "learner";
      kind: "feynman-answer";
      concept: string;
      text: string;
      at: string;
      turn?: number;
    }>
  | Readonly<{
      role: "system";
      kind: "tool-call";
      text: string;
      at: string;
      tool: string;
      turn?: number;
    }>;

type HarnessSummary = Readonly<{
  id: string;
  name: string;
  installed: boolean;
  authenticated: boolean;
  version?: string;
  selected: boolean;
  login: Readonly<{
    command: string;
    manual: boolean;
    note: string;
  }>;
  install: Readonly<{
    command: string;
    docsUrl: string;
  }>;
}>;

type HarnessesPayload = Readonly<{
  courseId?: number;
  harnesses: readonly HarnessSummary[];
  switched: boolean;
}>;

type OnboardingState = "welcome" | "connect-agent" | "tutorial-offer" | "done";

type ProfileResource = Readonly<{
  name: string | null;
  onboardingState: OnboardingState;
  settings: Record<string, unknown>;
  preferredHarness: string | null;
  dataDir: string;
  createdAt: string;
  updatedAt: string;
}>;

type HarnessLoginSpawnInput = Readonly<{
  harnessId: string;
  command: string;
  args: readonly string[];
  displayCommand: string;
  cwd: string;
  env: Record<string, string>;
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
type IdeationTurnEvent = Extract<TurnEvent, { type: "ideation" }>;

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

type ProfilePatchDraft = {
  name?: string | null;
  onboardingState?: string;
  settings?: Record<string, unknown>;
  preferredHarness?: string | null;
};

const LOCALHOST_BIND_HOST = "127.0.0.1";
const DEFAULT_HARNESS_ID = "claude-code";
const MAX_AGENT_STREAM_REPLAY = 200;
const onboardingStates: readonly OnboardingState[] = [
  "welcome",
  "connect-agent",
  "tutorial-offer",
  "done",
];
const legalOnboardingTransitions: Readonly<
  Record<OnboardingState, readonly OnboardingState[]>
> = {
  welcome: ["welcome", "connect-agent"],
  "connect-agent": ["connect-agent", "tutorial-offer"],
  "tutorial-offer": ["tutorial-offer", "done"],
  done: ["done", "welcome"],
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

const CORS_BASE_ALLOWED_ORIGINS = [
  "tauri://localhost",
  "http://tauri.localhost",
] as const;
const CORS_ALLOWED_METHODS = "GET, POST, PATCH, DELETE, OPTIONS";
const CORS_ALLOWED_HEADERS = "Authorization, Content-Type";

const parseDevCorsOrigins = (value: string | undefined): readonly string[] =>
  value === undefined
    ? []
    : value
        .split(",")
        .map((origin) => origin.trim())
        .filter((origin) => origin.length > 0);

const corsAllowedOrigins = (env: Env): ReadonlySet<string> =>
  new Set([
    ...CORS_BASE_ALLOWED_ORIGINS,
    ...parseDevCorsOrigins(env["OVERLEARN_DEV_ORIGINS"]),
  ]);

const addVaryOrigin = (headers: Headers): void => {
  const vary = headers.get("vary");
  if (vary === null || vary.trim().length === 0) {
    headers.set("vary", "Origin");
    return;
  }

  const parts = vary.split(",").map((part) => part.trim().toLowerCase());
  if (!parts.includes("*") && !parts.includes("origin")) {
    headers.set("vary", `${vary}, Origin`);
  }
};

const addCorsHeaders = (
  headers: Headers,
  requestHeaders: Headers,
  allowedOrigins: ReadonlySet<string>,
  preflight = false,
): void => {
  const origin = requestHeaders.get("origin");
  if (origin === null) {
    return;
  }

  addVaryOrigin(headers);
  if (!allowedOrigins.has(origin)) {
    return;
  }

  headers.set("access-control-allow-origin", origin);
  headers.set("access-control-allow-credentials", "true");
  if (preflight) {
    headers.set("access-control-allow-methods", CORS_ALLOWED_METHODS);
    headers.set("access-control-allow-headers", CORS_ALLOWED_HEADERS);
  }
};

const corsHeaderRecord = (
  requestHeaders: Headers,
  allowedOrigins: ReadonlySet<string>,
  preflight = false,
): Record<string, string> => {
  const headers = new Headers();
  addCorsHeaders(headers, requestHeaders, allowedOrigins, preflight);
  return Object.fromEntries(headers.entries());
};

const responseWithCorsHeaders = (
  request: Request,
  response: Response,
  allowedOrigins: ReadonlySet<string>,
): Response => {
  const headers = new Headers(response.headers);
  addCorsHeaders(headers, request.headers, allowedOrigins);
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
};

const isCorsPreflight = (request: Request): boolean =>
  request.method === "OPTIONS" &&
  request.headers.has("origin") &&
  request.headers.has("access-control-request-method");

const corsPreflightResponse = (
  request: Request,
  allowedOrigins: ReadonlySet<string>,
): Response =>
  new Response(null, {
    status: 204,
    headers: corsHeaderRecord(request.headers, allowedOrigins, true),
  });

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const hasErrorCode = (error: unknown, code: string): boolean =>
  isRecord(error) && error["code"] === code;

const escapeHtml = (value: string): string =>
  value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");

const formatCommand = (command: HarnessCommand): string =>
  [command.command, ...command.args].join(" ");

const formatDaemonUrl = (port: number, path: string): string =>
  `http://${LOCALHOST_BIND_HOST}:${port}${path}`;

const isOnboardingState = (value: unknown): value is OnboardingState =>
  typeof value === "string" &&
  onboardingStates.includes(value as OnboardingState);

const normalizeOnboardingState = (value: string): OnboardingState =>
  isOnboardingState(value) ? value : "welcome";

export const isLegalOnboardingTransition = (
  current: string,
  next: string,
): boolean => {
  const normalizedCurrent = normalizeOnboardingState(current);
  if (!isOnboardingState(next)) {
    return false;
  }

  return legalOnboardingTransitions[normalizedCurrent].includes(next);
};

const profileResource = (profile: Profile, dataDir: string): ProfileResource => ({
  name: profile.name,
  onboardingState: normalizeOnboardingState(profile.onboardingState),
  settings: { ...profile.settings },
  preferredHarness: profile.preferredHarness,
  dataDir,
  createdAt: profile.createdAt,
  updatedAt: profile.updatedAt,
});

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
      typeof parsed["token"] !== "string" ||
      typeof parsed["startedAt"] !== "string"
    ) {
      return undefined;
    }

    return {
      pid: parsed["pid"],
      port: parsed["port"],
      token: parsed["token"],
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

  const connect = (
    _request: IncomingMessage,
    response: ServerResponse,
    headers: Record<string, string> = {},
  ): void => {
    response.writeHead(200, {
      "cache-control": "no-cache",
      connection: "keep-alive",
      "content-type": "text/event-stream",
      ...headers,
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

const bearerToken = (headers: Headers): string | undefined => {
  const authorization = headers.get("authorization");
  if (authorization === null) {
    return undefined;
  }

  const [scheme, token, extra] = authorization.split(/\s+/);
  if (scheme?.toLowerCase() !== "bearer" || token === undefined || extra !== undefined) {
    return undefined;
  }

  return token;
};

const requestHasDaemonToken = (request: Request, daemonToken: string): boolean =>
  bearerToken(request.headers) === daemonToken;

const isDemoFileApiRequest = (requestUrl: URL, method: string): boolean => {
  if (method !== "GET") {
    return false;
  }

  const segments = requestUrl.pathname.split("/").filter((segment) => segment.length > 0);
  if (
    segments.length !== 5 ||
    segments[0] !== "api" ||
    segments[1] !== "courses" ||
    segments[3] !== "demos"
  ) {
    return false;
  }

  const courseId = Number(segments[2]);
  return Number.isInteger(courseId) && courseId > 0 && (segments[4]?.length ?? 0) > 0;
};

const requestHasDemoQueryToken = (
  requestUrl: URL,
  method: string,
  daemonToken: string,
): boolean =>
  isDemoFileApiRequest(requestUrl, method) &&
  requestUrl.searchParams.get("token") === daemonToken;

const incomingHasDaemonToken = (
  request: IncomingMessage,
  daemonToken: string,
): boolean => {
  const headers = headersFromIncoming(request);
  return bearerToken(headers) === daemonToken;
};

const unauthorizedResponse = (): Response =>
  textResponse("Overlearn daemon authentication is required.", 401);

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

const optionalRecordField = (
  record: Record<string, unknown>,
  key: string,
): Record<string, unknown> | undefined => {
  if (!Object.hasOwn(record, key)) {
    return undefined;
  }

  const value = record[key];
  if (!isRecord(value)) {
    throw new Error(`${key} must be an object.`);
  }

  return value;
};

const optionalBooleanField = (
  record: Record<string, unknown>,
  key: string,
): boolean | undefined => {
  if (!Object.hasOwn(record, key)) {
    return undefined;
  }

  const value = record[key];
  if (typeof value !== "boolean") {
    throw new Error(`${key} must be a boolean.`);
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

const parseCommandOverride = (value: string, name: string): readonly string[] => {
  const trimmed = value.trim();
  if (trimmed.length === 0) {
    throw new Error(`${name} cannot be empty.`);
  }

  if (trimmed.startsWith("[")) {
    const parsed = JSON.parse(trimmed) as unknown;
    if (
      !Array.isArray(parsed) ||
      parsed.length === 0 ||
      !parsed.every((entry) => typeof entry === "string" && entry.length > 0)
    ) {
      throw new Error(`${name} JSON must be a non-empty string array.`);
    }

    return parsed;
  }

  const parts = trimmed.match(/(?:[^\s"']+|"[^"]*"|'[^']*')+/g) ?? [];
  const tokens = parts.map((part) =>
    part.replace(/^(['"])([\s\S]*)\1$/, "$2"),
  );
  if (tokens.length === 0) {
    throw new Error(`${name} cannot be empty.`);
  }

  return tokens;
};

const defaultHarnessLoginSpawner = (input: HarnessLoginSpawnInput): void => {
  const child = spawnChildProcess(input.command, [...input.args], {
    cwd: input.cwd,
    detached: true,
    env: input.env,
    stdio: "ignore",
  });
  child.unref();
};

const mergeStringEnv = (...envs: readonly Env[]): Record<string, string> => {
  const merged: Record<string, string> = {};

  for (const source of envs) {
    for (const [key, value] of Object.entries(source)) {
      if (value === undefined) {
        delete merged[key];
      } else {
        merged[key] = value;
      }
    }
  }

  return merged;
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


const uiDemo = (demo: Demo): DemoEntry => ({
  file: demoFileKey(demo),
  ...(demo.title === null ? {} : { title: demo.title }),
  addedAt: demo.addedAt,
});

const uiGlossaryEntry = (entry: StoreGlossaryEntry): GlossaryEntry => ({
  term: entry.term,
  def: entry.definition,
  topicId: entry.topicId,
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
  ...(topic.body.length === 0 ? {} : { body: topic.body }),
  ...(topic.enteredAt === null ? {} : { enteredAt: topic.enteredAt }),
  current: topic.isCurrent,
  state: topic.state,
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

  if (entry.kind === "demo") {
    const title = payload["title"];
    return {
      role: "agent",
      kind: "demo",
      file:
        typeof payload["file"] === "string" && payload["file"].length > 0
          ? payload["file"]
          : entry.content,
      ...(typeof title === "string" && title.length > 0 ? { title } : {}),
      at,
      turn: entry.turn,
    };
  }

  if (entry.kind === "lesson") {
    return {
      role: "agent",
      kind: "lesson",
      lesson:
        typeof payload["lessonId"] === "string" && payload["lessonId"].length > 0
          ? payload["lessonId"]
          : entry.content,
      at,
      turn: entry.turn,
    };
  }

  if (entry.kind === "feynman-check") {
    return {
      role: "agent",
      kind: "feynman-check",
      concept:
        typeof payload["concept"] === "string" ? payload["concept"] : "unknown",
      prompt: entry.content,
      at,
      turn: entry.turn,
    };
  }

  if (entry.kind === "feynman-answer") {
    return {
      role: "learner",
      kind: "feynman-answer",
      concept:
        typeof payload["concept"] === "string" ? payload["concept"] : "unknown",
      text: entry.content,
      at,
      turn: entry.turn,
    };
  }

  if (entry.kind === "tool-call") {
    return {
      role: "system",
      kind: "tool-call",
      text: entry.content,
      at,
      tool: typeof payload["tool"] === "string" ? payload["tool"] : "tool",
      turn: entry.turn,
    };
  }

  return {
    role: entry.role === "agent" ? "agent" : "learner",
    text: entry.content,
    at,
    turn: entry.turn,
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
  const demoFiles = new Set(demos.map(demoFileKey));
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
      key: demoFileKey(demo),
      title: demo.title,
      bodyFormat: demo.bodyFormat,
      addedAt: demo.addedAt,
    })),
    activeFeynmanCheck: view.activeFeynmanCheck ?? null,
    transcript: view.transcript,
  };
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

  const profile = getProfile(store);
  return (
    profile.preferredHarness ?? env["OVERLEARN_HARNESS"] ?? DEFAULT_HARNESS_ID
  );
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
    const definition = getHarnessAdapterDefinition(adapter.id);
    const detection = cache.value?.get(adapter.id) ?? {
      installed: false,
      authenticated: false,
    };
    if (definition === undefined) {
      throw new Error(`Missing harness adapter definition: ${adapter.id}`);
    }

    return {
      id: adapter.id,
      name: adapter.name,
      installed: detection.installed,
      authenticated: detection.authenticated,
      ...(detection.version === undefined ? {} : { version: detection.version }),
      selected: adapter.id === selected,
      login: {
        command: formatCommand(definition.loginCommand),
        manual: definition.loginCommand.interactive,
        note: definition.loginCommand.note,
      },
      install: {
        command: formatCommand(definition.install),
        docsUrl: definition.install.docsUrl,
      },
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

const routeHarnessLoginRequest = (path: string): string | undefined => {
  const segments = path.split("/").filter((segment) => segment.length > 0);
  if (
    segments.length !== 4 ||
    segments[0] !== "api" ||
    segments[1] !== "harnesses" ||
    segments[3] !== "login"
  ) {
    return undefined;
  }

  return segments[2] === undefined ? undefined : decodeURIComponent(segments[2]);
};

const demoResponse = (store: Store, courseId: number, file: string): Response => {
  const demo = listDemos(store, courseId).find((candidate) => demoFileKey(candidate) === file);
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

export const runDaemon = async (
  env: Env = process.env,
  options: RunDaemonOptions = {},
): Promise<void> => {
  const store = openStore({ env });
  const daemonToken = randomBytes(32).toString("base64url");
  const tokenScopes = new Map<string, TokenScope>();
  const statuses = new Map<number, UiStatusPayload>();
  const activeTurnByCourse = new Map<number, number>();
  const agentStreamReplay: AgentStreamPayload[] = [];
  const harnessDetectionCache: { value?: Map<string, AdapterDetection> } = {};
  const harnessLoginSpawner =
    options.harnessLoginSpawner ?? defaultHarnessLoginSpawner;
  const allowedCorsOrigins = corsAllowedOrigins(env);
  let runtime: CourseRuntime | undefined;
  let activeCourseId: number | undefined;
  let port = 0;
  let shuttingDown = false;

  const readProfileResource = (): ProfileResource => {
    const profile = getProfile(store);
    const normalized = normalizeOnboardingState(profile.onboardingState);
    if (profile.onboardingState !== normalized) {
      return profileResource(
        patchProfile(store, { onboardingState: normalized }),
        store.dataDir,
      );
    }

    return profileResource(profile, store.dataDir);
  };

  const patchProfileResource = (
    patch: ProfilePatchDraft,
  ): ProfileResource => profileResource(patchProfile(store, patch), store.dataDir);

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
    flushPendingAgentText(event.courseId);
    const turn = activeTurnByCourse.get(event.courseId);
    const attachment = event.attachment;
    // Demo and lesson writes render as rich transcript cards; every other
    // teaching write keeps its readable tool-call row.
    const entry =
      attachment?.kind === "demo"
        ? appendUiTranscript(store, event.courseId, {
            ...(turn === undefined ? {} : { turn }),
            role: "agent",
            kind: "demo",
            content: attachment.file,
            payload: {
              file: attachment.file,
              ...(attachment.title === undefined ? {} : { title: attachment.title }),
            },
          })
        : attachment?.kind === "lesson"
          ? appendUiTranscript(store, event.courseId, {
              ...(turn === undefined ? {} : { turn }),
              role: "agent",
              kind: "lesson",
              content: attachment.lessonId,
              payload: { lessonId: attachment.lessonId },
            })
          : appendUiTranscript(store, event.courseId, {
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
    if (attachment?.kind === "lesson") {
      sseHub.broadcast("lesson", { courseId: event.courseId });
    }
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

  // ACP harnesses stream agent text as per-chunk events; buffer them per
  // course/turn and persist one transcript row per contiguous message so the
  // stored transcript (and exports) aren't fragmented into token deltas.
  const pendingAgentText = new Map<number, { turn: number; text: string }>();

  const flushPendingAgentText = (courseId: number): void => {
    const pending = pendingAgentText.get(courseId);
    pendingAgentText.delete(courseId);
    if (pending === undefined || pending.text.length === 0) {
      return;
    }

    const entry = appendUiTranscript(store, courseId, {
      turn: pending.turn,
      role: "agent",
      kind: "text",
      content: pending.text,
    });
    sseHub.broadcast("message", { courseId, entry });
  };

  const appendAgentEventTranscript = (payload: AgentStreamPayload): void => {
    const event = payload.event;

    if (event.type === "text") {
      const pending = pendingAgentText.get(payload.courseId);
      if (pending !== undefined && pending.turn === payload.turn) {
        pending.text += event.text;
      } else {
        flushPendingAgentText(payload.courseId);
        pendingAgentText.set(payload.courseId, {
          turn: payload.turn,
          text: event.text,
        });
      }
      return;
    }

    if (event.type === "done" || event.type === "error") {
      flushPendingAgentText(payload.courseId);
    }

    // Generic harness tool calls are working noise, not part of the learning
    // record — the live activity stream shows them in flight, and meaningful
    // writes (lessons, mastery, glossary) get readable rows via
    // onTeachingWrite. Only agent text is persisted from the raw stream.
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
      getHarnessId: () => {
        const harnessId = getCourse(store, course.id)?.harnessId;
        return harnessId ?? getProfile(store).preferredHarness ?? undefined;
      },
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

  const parseIdeationSeed = async (request: Request): Promise<IdeationTurnEvent> => {
    const body = await readJsonBody(request);
    if (!isRecord(body)) {
      throw new Error("Ideation body must be an object.");
    }

    return {
      type: "ideation",
      text: requiredStringField(body, "seed"),
    };
  };

  const parsePlanTopic = (value: unknown, label: string): TopicTreeInput => {
    if (!isRecord(value)) {
      throw new Error(`${label} must be an object.`);
    }

    const path = requiredStringField(value, "path");
    const title = requiredStringField(value, "title");
    const rawBody = Object.hasOwn(value, "body")
      ? optionalStringField(value, "body")
      : optionalStringField(value, "summary");
    const rawChildren = value["children"];
    if (rawChildren !== undefined && !Array.isArray(rawChildren)) {
      throw new Error(`${label}.children must be an array.`);
    }

    const children = (rawChildren ?? []).map((child, index) =>
      parsePlanTopic(child, `${label}.children[${index}]`),
    );

    return {
      path,
      title,
      body: rawBody ?? "",
      ...(children.length === 0 ? {} : { children }),
    };
  };

  const parsePlanTopics = (value: unknown): readonly TopicTreeInput[] => {
    if (!Array.isArray(value)) {
      throw new Error("topics must be an array.");
    }

    if (value.length === 0) {
      throw new Error("topics cannot be empty.");
    }

    return value.map((topic, index) => parsePlanTopic(topic, `topics[${index}]`));
  };

  const handleIdeateCourse = async (request: Request): Promise<Response> => {
    if (request.method !== "POST") {
      return emptyResponse(405);
    }

    if (activeCourseId !== undefined) {
      return textResponse(
        `Course ${activeCourseId} already has the active learning session.`,
        409,
      );
    }

    try {
      const event = await parseIdeationSeed(request);
      const course = createCourse(store, {
        title: "Draft course",
        description: event.text,
        status: "draft",
      });
      const turn = nextTurnNumber(store, course.id);
      const entry = appendUiTranscript(store, course.id, {
        turn,
        role: "learner",
        kind: "ideation",
        content: event.text,
      });

      sseHub.broadcast("courses", coursesPayload());
      sseHub.broadcast("message", { courseId: course.id, entry });
      const turnResponse = runCourseTurn(course, [event], "ideation", turn);
      if (!turnResponse.ok) {
        return turnResponse;
      }

      return jsonResponse(
        {
          ok: true,
          course: courseResource(course),
          turn,
        },
        { status: 201 },
      );
    } catch (error) {
      return textResponse(
        error instanceof Error ? error.message : "Invalid ideation request.",
        400,
      );
    }
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

  const handleAcceptPlan = async (
    request: Request,
    course: Course,
  ): Promise<Response> => {
    // The review UI keeps edits client-side and submits the final plan here,
    // avoiding draft-only topic CRUD endpoints while preserving atomic accept.
    if (request.method !== "POST") {
      return emptyResponse(405);
    }

    if (course.status !== "draft") {
      return textResponse("Course plan can only be accepted from draft.", 409);
    }

    if (runtime?.courseId === course.id && runtime.runningTurn) {
      return textResponse(
        "Cannot accept the plan while the agent is still working.",
        409,
      );
    }

    const body = await readJsonBody(request);
    if (!isRecord(body)) {
      return textResponse("Accept-plan body must be an object.", 400);
    }

    try {
      const title = Object.hasOwn(body, "title")
        ? requiredStringField(body, "title")
        : course.title;
      let description: string | null = course.description;
      if (Object.hasOwn(body, "description")) {
        const parsedDescription = optionalStringField(body, "description");
        if (parsedDescription !== undefined) {
          description = parsedDescription;
        }
      }
      const topics = Object.hasOwn(body, "topics")
        ? parsePlanTopics(body["topics"])
        : undefined;
      const existingTopics = readTopicTree(store, course.id);
      if (topics === undefined && existingTopics.length === 0) {
        return textResponse("Draft course has no proposed plan.", 409);
      }

      const activated = withStoreTransaction(store, () => {
        if (topics !== undefined) {
          replaceTopicTree(store, course.id, topics);
        }

        return patchCourse(store, course.id, {
          title,
          description,
          status: "active",
        });
      });

      sseHub.broadcast("courses", coursesPayload());
      broadcastCourseCollections(course.id);

      const greeting = runCourseTurn(
        activated,
        [
          {
            type: "message",
            text:
              "The learner accepted the course plan. Greet them and start with the first useful next step.",
          },
        ],
        "greeting",
      );
      if (!greeting.ok) {
        return greeting;
      }

      return jsonResponse({
        ok: true,
        course: courseResource(activated),
        greetingQueued: true,
      });
    } catch (error) {
      return textResponse(
        error instanceof Error ? error.message : "Invalid course plan.",
        400,
      );
    }
  };

  const hardDeleteDraftCourse = async (course: Course): Promise<Response> => {
    if (runtime?.courseId === course.id && runtime.runningTurn) {
      return textResponse(
        "Cannot discard the draft while the agent is still working.",
        409,
      );
    }

    if (runtime?.courseId === course.id) {
      await runtime.orchestrator.endSession("draft-discarded");
      runtime = undefined;
      activeCourseId = undefined;
    }

    revokeTeachingTokensForCourse(course.id, "draft-discarded");
    statuses.delete(course.id);
    deleteCourse(store, course.id);
    sseHub.broadcast("courses", coursesPayload());
    sseHub.broadcast("status", {
      courseId: course.id,
      status: "session-ended",
      hasSeenWait: true,
    });

    return jsonResponse({ ok: true, deleted: true });
  };

  const parseNav = async (request: Request, courseId: number): Promise<TurnEvent> => {
    const body = await readJsonBody(request);
    if (!isRecord(body)) {
      throw new Error("Nav body must be an object.");
    }

    const path = requiredStringField(body, "path");
    if (path === REVIEW_WEAK_NAV_PATH) {
      const weakest = flattenTopicTree(readTopicTree(store, courseId))
        .filter((topic) => topic.state !== "frontier")
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

  const parsePreferredHarness = (
    value: string | null | undefined,
  ): string | null | undefined => {
    if (value === undefined || value === null) {
      return value;
    }

    const adapter = listHarnessAdapters().find(
      (candidate) => candidate.id === value,
    );
    if (adapter === undefined) {
      throw new Error(`Unknown harness adapter: ${value}`);
    }

    return value;
  };

  const handleProfileApi = async (request: Request): Promise<Response> => {
    if (request.method === "GET") {
      return jsonResponse(readProfileResource());
    }

    if (request.method !== "PATCH") {
      return emptyResponse(405);
    }

    const body = await readJsonBody(request);
    if (!isRecord(body)) {
      return textResponse("Profile patch must be an object.", 400);
    }

    try {
      const patch: ProfilePatchDraft = {};

      if (Object.hasOwn(body, "name")) {
        const name = optionalStringField(body, "name");
        if (name !== undefined) {
          patch.name = name;
        }
      }

      if (Object.hasOwn(body, "settings")) {
        const settings = optionalRecordField(body, "settings");
        if (settings !== undefined) {
          patch.settings = settings;
        }
      }

      if (Object.hasOwn(body, "preferredHarness")) {
        const preferredHarness = parsePreferredHarness(
          optionalStringField(body, "preferredHarness"),
        );
        if (preferredHarness !== undefined) {
          patch.preferredHarness = preferredHarness;
        }
      }

      const profile = patchProfileResource(patch);
      sseHub.broadcast("harnesses", harnessesPayload(activeCourseId, false, true));
      return jsonResponse(profile);
    } catch (error) {
      return textResponse(
        error instanceof Error ? error.message : "Invalid profile patch.",
        400,
      );
    }
  };

  const handleOnboardingApi = async (request: Request): Promise<Response> => {
    if (request.method === "GET") {
      const profile = readProfileResource();
      return jsonResponse({ state: profile.onboardingState, profile });
    }

    if (request.method !== "POST") {
      return emptyResponse(405);
    }

    const body = await readJsonBody(request);
    if (!isRecord(body)) {
      return textResponse("Onboarding body must be an object.", 400);
    }

    const state = body["state"];
    if (!isOnboardingState(state)) {
      return textResponse(
        "state must be welcome, connect-agent, tutorial-offer, or done.",
        400,
      );
    }

    const current = readProfileResource().onboardingState;
    if (!isLegalOnboardingTransition(current, state)) {
      return textResponse(
        `Illegal onboarding transition: ${current} -> ${state}.`,
        409,
      );
    }

    const profile = patchProfileResource({ onboardingState: state });
    return jsonResponse({ state: profile.onboardingState, profile });
  };

  const handleTutorialApi = (request: Request): Response => {
    if (request.method !== "POST") {
      return emptyResponse(405);
    }

    const course = createTutorialCourse(store);
    sseHub.broadcast("courses", coursesPayload());
    broadcastCourseCollections(course.id);

    return jsonResponse({ courseId: course.id });
  };

  const handleImportApi = async (request: Request): Promise<Response> => {
    if (request.method !== "POST") {
      return emptyResponse(405);
    }

    const body = await readJsonBody(request);
    if (!isRecord(body)) {
      return textResponse("Import body must be an object.", 400);
    }

    try {
      const result = await importCoursePath(store, requiredStringField(body, "path"));
      sseHub.broadcast("courses", coursesPayload());
      broadcastCourseCollections(result.course.id);

      return jsonResponse({
        courseId: result.course.id,
        warnings: result.warnings,
      });
    } catch (error) {
      return textResponse(
        error instanceof Error ? error.message : "Import failed.",
        400,
      );
    }
  };

  const parseExportOptions = async (
    request: Request,
  ): Promise<ExportCourseBundleOptions> => {
    const body = await readJsonBody(request);
    if (!isRecord(body)) {
      throw new Error("Export body must be an object.");
    }

    return {
      includeTranscript: optionalBooleanField(body, "includeTranscript") ?? false,
    };
  };

  const handleHarnessLoginApi = (harnessId: string): Response => {
    const definition = getHarnessAdapterDefinition(harnessId as HarnessAdapterId);
    if (definition === undefined) {
      return textResponse(`Unknown harness adapter: ${harnessId}`, 404);
    }

    const [summary] = harnessSummaries(
      store,
      activeCourseId,
      env,
      harnessDetectionCache,
      true,
    ).filter((candidate) => candidate.id === definition.id);
    if (summary?.installed !== true) {
      return textResponse(`${definition.name} is not installed.`, 409);
    }

    const displayCommand = formatCommand(definition.loginCommand);
    if (definition.loginCommand.interactive) {
      return jsonResponse({
        manual: true,
        spawned: false,
        command: displayCommand,
        note: definition.loginCommand.note,
      });
    }

    try {
      const override = env["OVERLEARN_HARNESS_LOGIN_CMD"];
      const commandLine =
        override === undefined
          ? [definition.loginCommand.command, ...definition.loginCommand.args]
          : parseCommandOverride(override, "OVERLEARN_HARNESS_LOGIN_CMD");
      const [command, ...args] = commandLine;
      if (command === undefined) {
        throw new Error("OVERLEARN_HARNESS_LOGIN_CMD cannot be empty.");
      }

      harnessLoginSpawner({
        harnessId: definition.id,
        command,
        args,
        displayCommand,
        cwd: store.dataDir,
        env: mergeStringEnv(process.env, env, {
          OVERLEARN_LOGIN_HARNESS_ID: definition.id,
          OVERLEARN_LOGIN_COMMAND: displayCommand,
          OVERLEARN_LOGIN_COMMAND_JSON: JSON.stringify([
            definition.loginCommand.command,
            ...definition.loginCommand.args,
          ]),
        }),
      });

      return jsonResponse({
        manual: false,
        spawned: true,
        command: displayCommand,
        note: definition.loginCommand.note,
      });
    } catch (error) {
      return textResponse(
        error instanceof Error ? error.message : "Harness login failed.",
        500,
      );
    }
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
        if (course.status === "draft") {
          return await hardDeleteDraftCourse(course);
        }

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
          kind: course.status === "draft" ? "ideation" : "text",
          content: event.text,
        });
        sseHub.broadcast("message", { courseId, entry });
        return runCourseTurn(
          course,
          [
            course.status === "draft"
              ? { type: "ideation", text: event.text }
              : event,
          ],
          course.status === "draft" ? "ideation" : "teaching",
          turn,
        );
      } catch (error) {
        return textResponse(error instanceof Error ? error.message : "Invalid submit request.", 400);
      }
    }

    if (action === "accept-plan" && extra === undefined) {
      return await handleAcceptPlan(request, course);
    }

    if (action === "export" && extra === undefined) {
      if (request.method !== "POST") {
        return emptyResponse(405);
      }

      let options: ExportCourseBundleOptions;
      try {
        options = await parseExportOptions(request);
      } catch (error) {
        return textResponse(
          error instanceof Error ? error.message : "Invalid export request.",
          400,
        );
      }

      try {
        return jsonResponse(await exportCourseBundle(store, courseId, options));
      } catch (error) {
        return textResponse(
          error instanceof Error ? error.message : "Export failed.",
          500,
        );
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
    if (isCorsPreflight(request)) {
      return corsPreflightResponse(request, allowedCorsOrigins);
    }

    const response = await handleRequestWithoutCors(request);
    return responseWithCorsHeaders(request, response, allowedCorsOrigins);
  };

  const handleRequestWithoutCors = async (request: Request): Promise<Response> => {
    const requestUrl = new URL(request.url);
    const method = request.method;

    if (
      requestUrl.pathname.startsWith("/api/") &&
      !requestHasDaemonToken(request, daemonToken) &&
      !requestHasDemoQueryToken(requestUrl, method, daemonToken)
    ) {
      return unauthorizedResponse();
    }

    if (method === "GET" && requestUrl.pathname === "/api/health") {
      return jsonResponse(healthPayload());
    }

    if (method === "POST" && requestUrl.pathname === "/api/shutdown") {
      setTimeout(() => {
        void shutdown();
      }, 0);
      return jsonResponse({ ok: true });
    }

    if (requestUrl.pathname === "/api/profile") {
      return await handleProfileApi(request);
    }

    if (requestUrl.pathname === "/api/onboarding") {
      return await handleOnboardingApi(request);
    }

    if (requestUrl.pathname === "/api/tutorial") {
      return handleTutorialApi(request);
    }

    if (requestUrl.pathname === "/api/import") {
      return await handleImportApi(request);
    }

    const harnessLoginId = routeHarnessLoginRequest(requestUrl.pathname);
    if (harnessLoginId !== undefined && method === "POST") {
      return handleHarnessLoginApi(harnessLoginId);
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

    if (requestUrl.pathname === "/api/courses/ideate") {
      return await handleIdeateCourse(request);
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

    if (
      !requestUrl.pathname.startsWith("/api") &&
      !requestUrl.pathname.startsWith("/mcp")
    ) {
      return jsonResponse({ error: "Not found." }, { status: 404 });
    }

    return textResponse("Not found.", 404);
  };

  const server = createServer((incoming, outgoing) => {
    const incomingUrl = new URL(
      incoming.url ?? "/",
      `http://${LOCALHOST_BIND_HOST}:${port}`,
    );

    if (incomingUrl.pathname === "/api/events" && incoming.method === "GET") {
      const incomingHeaders = headersFromIncoming(incoming);
      const corsHeaders = corsHeaderRecord(incomingHeaders, allowedCorsOrigins);
      const queryToken = incomingUrl.searchParams.get("token");
      if (
        !incomingHasDaemonToken(incoming, daemonToken) &&
        queryToken !== daemonToken
      ) {
        outgoing.writeHead(401, {
          "content-type": "text/plain; charset=utf-8",
          ...corsHeaders,
        });
        outgoing.end("Overlearn daemon authentication is required.");
        return;
      }

      sseHub.connect(incoming, outgoing, corsHeaders);
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
      token: daemonToken,
      startedAt: new Date().toISOString(),
    },
    env,
  );

  if (options.portFile !== undefined) {
    await mkdir(dirname(options.portFile), { recursive: true });
    await Bun.write(options.portFile, `${port}\n`);
  }

  const cleanup = (): void => {
    void shutdown();
  };
  process.once("SIGTERM", cleanup);
  process.once("SIGINT", cleanup);

  await new Promise<void>((resolveClosed) => {
    server.once("close", () => resolveClosed());
  });
};
