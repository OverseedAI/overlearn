import { invoke, isTauri } from "@tauri-apps/api/core";
import type {
  CourseResource,
  CourseState,
  CourseStatus,
  HarnessSummary,
  LiveSessionSummary,
  OnboardingState,
  ProfileResource,
  PromptAttachment,
  ServerEvents,
  SessionSummary,
  TranscriptPage,
} from "./types";

type DaemonInfo = {
  port: number;
  token: string;
};

type ApiRuntime = {
  baseUrl: string;
  token?: string;
};

export class ApiError extends Error {
  constructor(
    public readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

let runtime: ApiRuntime = { baseUrl: "" };

const resolveRuntime = async (): Promise<ApiRuntime> => {
  try {
    if (!isTauri()) {
      return runtime;
    }

    const info = await invoke<DaemonInfo>("daemon_info");
    return {
      baseUrl: `http://127.0.0.1:${info.port}`,
      token: info.token,
    };
  } catch (error) {
    console.warn(
      "Falling back to same-origin daemon API after daemon_info failed.",
      error,
    );
    return { baseUrl: "" };
  }
};

export const apiReady = resolveRuntime().then((resolved) => {
  runtime = resolved;
  return resolved;
});

const apiUrl = (path: string, apiRuntime: ApiRuntime = runtime): string =>
  `${apiRuntime.baseUrl}${path}`;

const eventSourceUrl = (apiRuntime: ApiRuntime): string => {
  if (!apiRuntime.token) {
    return apiUrl("/api/events", apiRuntime);
  }

  const url = new URL(apiUrl("/api/events", apiRuntime), window.location.href);
  url.searchParams.set("token", apiRuntime.token);
  return url.toString();
};

const demoFileUrl = (
  courseId: number,
  file: string,
  apiRuntime: ApiRuntime = runtime,
): string => {
  const path = `/api/courses/${courseId}/demos/${encodeURIComponent(file)}`;
  if (!apiRuntime.token) {
    return apiUrl(path, apiRuntime);
  }

  const url = new URL(apiUrl(path, apiRuntime), window.location.href);
  url.searchParams.set("token", apiRuntime.token);
  return url.toString();
};

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const apiRuntime = await apiReady;
  const headers = new Headers(init?.headers);
  if (init?.body !== undefined && !headers.has("content-type")) {
    headers.set("content-type", "application/json");
  }
  if (apiRuntime.token) {
    headers.set("Authorization", `Bearer ${apiRuntime.token}`);
  }

  const response = await fetch(apiUrl(path, apiRuntime), { ...init, headers });

  if (!response.ok) {
    // The daemon returns plain-text error bodies.
    throw new ApiError(response.status, await response.text());
  }

  if (response.status === 204) {
    return undefined as T;
  }

  return (await response.json()) as T;
}

const get = <T>(path: string) => request<T>(path);
const post = <T>(path: string, body?: unknown) =>
  request<T>(path, {
    method: "POST",
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
const patch = <T>(path: string, body: unknown) =>
  request<T>(path, { method: "PATCH", body: JSON.stringify(body) });
const del = <T>(path: string) => request<T>(path, { method: "DELETE" });

export const api = {
  health: () =>
    get<{ ok: boolean; version: string; liveSessions: LiveSessionSummary[] }>(
      "/api/health",
    ),
  listSessions: () => get<SessionSummary[]>("/api/sessions"),

  // Profile / onboarding
  getProfile: () => get<ProfileResource>("/api/profile"),
  patchProfile: (body: {
    name?: string;
    settings?: Record<string, unknown>;
    preferredHarness?: string | null;
  }) => patch<ProfileResource>("/api/profile", body),
  getOnboarding: () =>
    get<{ state: OnboardingState; profile: ProfileResource }>(
      "/api/onboarding",
    ),
  setOnboarding: (state: OnboardingState) =>
    post<{ state: OnboardingState; profile: ProfileResource }>(
      "/api/onboarding",
      { state },
    ),
  createTutorial: () => post<{ courseId: number }>("/api/tutorial"),

  // Harnesses
  listHarnesses: (
    opts:
      | { courseId: number; refresh?: boolean }
      | { scope: "profile"; refresh?: boolean },
  ) => {
    const params = new URLSearchParams();
    if ("courseId" in opts) {
      params.set("courseId", String(opts.courseId));
    } else {
      params.set("scope", opts.scope);
    }
    if (opts.refresh) {
      params.set("refresh", "1");
    }
    const query = params.toString();
    return get<HarnessSummary[]>(`/api/harnesses?${query}`);
  },
  harnessLogin: (id: string) =>
    post<{ manual: boolean; spawned: boolean; command: string; note: string }>(
      `/api/harnesses/${encodeURIComponent(id)}/login`,
    ),

  // Courses — collection
  listCourses: (status?: CourseStatus) =>
    get<CourseResource[]>(
      status ? `/api/courses?status=${status}` : "/api/courses",
    ),
  createCourse: (body: {
    title: string;
    description?: string;
    harnessId?: string;
    model?: string;
    effort?: string;
    attachedDir?: string;
    sourceName?: string;
  }) => post<CourseResource>("/api/courses", body),
  createCourseFromSeed: (seed: string) =>
    post<{ ok: true; course: CourseResource; turn: number }>(
      "/api/courses",
      { seed },
    ),
  importCourse: (path: string) =>
    post<{ courseId: number; warnings: string[] }>("/api/import", { path }),

  // Courses — item
  getCourse: (id: number) => get<CourseState>(`/api/courses/${id}`),
  pageTranscript: (
    id: number,
    opts: { before?: number; limit?: number } = {},
  ) => {
    const params = new URLSearchParams();
    if (opts.before !== undefined) {
      params.set("before", String(opts.before));
    }
    if (opts.limit !== undefined) {
      params.set("limit", String(opts.limit));
    }

    const query = params.toString();
    return get<TranscriptPage>(
      `/api/courses/${id}/transcript${query.length > 0 ? `?${query}` : ""}`,
    );
  },
  patchCourse: (
    id: number,
    body: Partial<{
      title: string;
      description: string;
      harnessId: string;
      attachedDir: string;
      sourceName: string;
      status: CourseStatus;
    }>,
  ) => patch<CourseResource>(`/api/courses/${id}`, body),
  deleteCourse: (id: number) => del<CourseResource>(`/api/courses/${id}`),
  submit: (
    id: number,
    text: string,
    attachments?: readonly PromptAttachment[],
  ) =>
    post<{ ok: true; turn: number }>(`/api/courses/${id}/submit`, {
      text,
      ...(attachments === undefined ? {} : { attachments }),
    }),
  nav: (id: number, path: string, options: { cardId?: string } = {}) =>
    post<{ ok: true; turn?: number }>(`/api/courses/${id}/nav`, {
      path,
      ...(options.cardId === undefined ? {} : { cardId: options.cardId }),
    }),
  reviewWeak: (id: number) =>
    post<{ ok: true; turn: number }>(`/api/courses/${id}/nav`, {
      path: "overlearn:review-weak",
    }),
  doneLearning: (id: number) =>
    post<{ ok: true; turn: number }>(`/api/courses/${id}/done`),
  feynmanAnswer: (
    id: number,
    body: { concept: string; text: string; keyPoints: string[] },
  ) =>
    post<{ ok: true; turn: number }>(
      `/api/courses/${id}/feynman-answer`,
      body,
    ),
  setCourseHarness: (id: number, harnessId: string) =>
    post<{ ok: true; harness: string; swapped: boolean }>(
      `/api/courses/${id}/harness`,
      { id: harnessId },
    ),
  setCourseAgentConfig: (
    id: number,
    body: { model?: string | null; effort?: string | null },
  ) =>
    post<{ ok: true; model: string | null; effort: string | null }>(
      `/api/courses/${id}/agent-config`,
      body,
    ),
  setCourseWebSearch: (id: number, enabled: boolean) =>
    post<{
      ok: true;
      enabled: boolean;
      reset: boolean;
      supported: boolean;
    }>(`/api/courses/${id}/web-search`, { enabled }),
  exportCourse: (id: number, includeTranscript: boolean) =>
    post<unknown>(`/api/courses/${id}/export`, { includeTranscript }),

  demoUrl: demoFileUrl,
};

export type ServerEventHandlers = {
  [K in keyof ServerEvents]?: (payload: ServerEvents[K]) => void;
};

/**
 * Subscribe to the daemon's SSE stream. On connect the server replays current
 * status/courses/harnesses plus recent agent-stream events, so handlers must
 * be idempotent (course view dedupes agent-stream by turn/sequence).
 */
export function subscribeEvents(
  handlers: ServerEventHandlers,
  onConnectionChange?: (connected: boolean) => void,
): () => void {
  let source: EventSource | undefined;
  let closed = false;

  const attachHandlers = (nextSource: EventSource) => {
    for (const [name, handler] of Object.entries(handlers)) {
      if (!handler) {
        continue;
      }
      nextSource.addEventListener(name, (event) => {
        let payload: unknown;
        try {
          payload = JSON.parse((event as MessageEvent<string>).data);
        } catch {
          return;
        }
        (handler as (payload: unknown) => void)(payload);
      });
    }

    nextSource.onopen = () => onConnectionChange?.(true);
    nextSource.onerror = () => onConnectionChange?.(false);
  };

  void apiReady
    .then((apiRuntime) => {
      if (closed) {
        return;
      }

      source = new EventSource(eventSourceUrl(apiRuntime));
      attachHandlers(source);
    })
    .catch(() => onConnectionChange?.(false));

  return () => {
    closed = true;
    source?.close();
  };
}
