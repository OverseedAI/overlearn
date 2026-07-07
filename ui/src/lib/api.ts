import type {
  CourseResource,
  CourseState,
  CourseStatus,
  HarnessSummary,
  OnboardingState,
  ProfileResource,
  ServerEvents,
  TopicTreeInput,
} from "./types";

export class ApiError extends Error {
  constructor(
    public readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const headers = new Headers(init?.headers);
  if (init?.body !== undefined && !headers.has("content-type")) {
    headers.set("content-type", "application/json");
  }
  const response = await fetch(path, { ...init, headers });

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
    get<{ ok: boolean; version: string; activeCourseId: number | null }>(
      "/api/health",
    ),

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
  listHarnesses: (opts?: { courseId?: number; refresh?: boolean }) => {
    const params = new URLSearchParams();
    if (opts?.courseId !== undefined) {
      params.set("courseId", String(opts.courseId));
    }
    if (opts?.refresh) {
      params.set("refresh", "1");
    }
    const query = params.toString();
    return get<HarnessSummary[]>(`/api/harnesses${query ? `?${query}` : ""}`);
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
    attachedDir?: string;
    sourceName?: string;
  }) => post<CourseResource>("/api/courses", body),
  ideate: (seed: string) =>
    post<{ ok: true; course: CourseResource; turn: number }>(
      "/api/courses/ideate",
      { seed },
    ),
  importCourse: (path: string) =>
    post<{ courseId: number; warnings: string[] }>("/api/import", { path }),

  // Courses — item
  getCourse: (id: number) => get<CourseState>(`/api/courses/${id}`),
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
  deleteCourse: (id: number) =>
    del<CourseResource | { ok: true; deleted: true }>(`/api/courses/${id}`),
  submit: (id: number, text: string) =>
    post<{ ok: true; turn: number }>(`/api/courses/${id}/submit`, { text }),
  acceptPlan: (
    id: number,
    body: { title?: string; description?: string; topics?: TopicTreeInput[] },
  ) =>
    post<{ ok: true; course: CourseResource; greetingQueued: true }>(
      `/api/courses/${id}/accept-plan`,
      body,
    ),
  nav: (id: number, path: string) =>
    post<{ ok: true; turn: number }>(`/api/courses/${id}/nav`, { path }),
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
  exportCourse: (id: number, includeTranscript: boolean) =>
    post<unknown>(`/api/courses/${id}/export`, { includeTranscript }),

  demoUrl: (courseId: number, file: string) =>
    `/api/courses/${courseId}/demos/${encodeURIComponent(file)}`,
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
  const source = new EventSource("/api/events");

  for (const [name, handler] of Object.entries(handlers)) {
    if (!handler) {
      continue;
    }
    source.addEventListener(name, (event) => {
      let payload: unknown;
      try {
        payload = JSON.parse((event as MessageEvent<string>).data);
      } catch {
        return;
      }
      (handler as (payload: unknown) => void)(payload);
    });
  }

  source.onopen = () => onConnectionChange?.(true);
  source.onerror = () => onConnectionChange?.(false);

  return () => source.close();
}
