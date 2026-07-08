/*
 * Protocol types mirrored from the daemon (src/daemon/ui.ts, src/daemon/index.ts,
 * src/daemon/orchestrator.ts, src/adapter/types.ts). The daemon has no shared
 * type package yet, so keep these in sync by hand.
 */

export type CourseStatus = "draft" | "active" | "archived";

export type CourseResource = {
  id: number;
  title: string;
  description: string | null;
  harnessId: string | null;
  attachedDir: string | null;
  status: CourseStatus;
  sourceName: string | null;
  manifestExtra: Record<string, unknown> | null;
  createdAt: string;
  updatedAt: string;
};

export type OnboardingState =
  | "welcome"
  | "connect-agent"
  | "tutorial-offer"
  | "done";

export type ProfileResource = {
  name: string | null;
  onboardingState: OnboardingState;
  settings: Record<string, unknown>;
  preferredHarness: string | null;
  dataDir: string;
  createdAt: string;
  updatedAt: string;
};

export type HarnessSummary = {
  id: string;
  name: string;
  installed: boolean;
  authenticated: boolean;
  version?: string;
  selected: boolean;
  login: { command: string; manual: boolean; note: string };
  install: { command: string; docsUrl: string };
};

export type DemoEntry = {
  file: string;
  title?: string;
  addedAt: string;
};

export type GlossaryEntry = {
  term: string;
  def: string;
  topicId: number | null;
  addedAt: string;
};

export type MasteryEntry = {
  concept: string;
  score: number;
  gaps?: string;
  at: string;
};

export type TopicNode = {
  path: string;
  title: string;
  body?: string;
  enteredAt?: string;
  current: boolean;
  state: "frontier" | "visited" | "current";
  demos?: DemoEntry[];
  children: TopicNode[];
};

export type ActiveFeynmanCheck = {
  concept: string;
  prompt: string;
  keyPoints: string[];
  issuedAt: string;
  replaced?: { concept: string; issuedAt: string; replacedAt: string };
};

export type TranscriptEntry =
  | {
      role: "learner" | "agent";
      text: string;
      at: string;
      kind?: "text";
      turn?: number;
    }
  | {
      role: "agent";
      kind: "demo";
      file: string;
      title?: string;
      at: string;
      turn?: number;
    }
  | { role: "agent"; kind: "lesson"; lesson: string; at: string; turn?: number }
  | {
      role: "agent";
      kind: "feynman-check";
      concept: string;
      prompt: string;
      at: string;
      turn?: number;
    }
  | {
      role: "learner";
      kind: "feynman-answer";
      concept: string;
      text: string;
      at: string;
      turn?: number;
    }
  | {
      role: "system";
      kind: "tool-call";
      text: string;
      at: string;
      tool: string;
      turn?: number;
    };

export type RenderedLesson = {
  id: string;
  html: string;
  modifiedAtMs: number;
};

export type LessonSnapshot = {
  lessons: RenderedLesson[];
  selectedLessonId: string | undefined;
};

export type CourseDemo = {
  id: number;
  topicId: number | null;
  fileName: string | null;
  key: string;
  title: string | null;
  bodyFormat: string | null;
  addedAt: string;
};

export type CourseState = {
  course: CourseResource;
  lessons: LessonSnapshot;
  topics: TopicNode[];
  glossary: GlossaryEntry[];
  mastery: MasteryEntry[];
  demos: CourseDemo[];
  activeFeynmanCheck: ActiveFeynmanCheck | null;
  transcript: TranscriptEntry[];
};

export type AgentEvent =
  | { type: "thinking"; text: string }
  | { type: "text"; text: string }
  | {
      type: "tool-call";
      id: string;
      status: "started" | "delta" | "completed" | "failed";
      name?: string;
      input?: unknown;
      text?: string;
      result?: unknown;
      error?: string;
    }
  | { type: "permission-request"; request: unknown; decision: unknown }
  | { type: "done"; reason: "complete" | "cancelled" }
  | { type: "error"; message: string };

export type AgentStreamPayload = {
  courseId: number;
  turn: number;
  sequence: number;
  event: AgentEvent;
};

export type UiStatus =
  | "waiting-for-agent"
  | "agent-working"
  | "agent-failed"
  | "wrapping-up"
  | "session-ended";

export type StatusPayload = {
  courseId: number;
  status: UiStatus;
  hasSeenWait: boolean;
  message?: string;
};

export type LiveSessionSummary = {
  courseId: number;
  harnessId: string;
  state: "turn-running" | "idle";
};

export type CoursesPayload = {
  courses: CourseResource[];
  liveSessions: LiveSessionSummary[];
};

export type HarnessesPayload = {
  courseId?: number;
  scope?: "profile";
  harnesses: HarnessSummary[];
  switched: boolean;
};

/** SSE event name → payload, as broadcast by the daemon on /api/events. */
export type ServerEvents = {
  status: StatusPayload;
  courses: CoursesPayload;
  harnesses: HarnessesPayload;
  message: { courseId: number; entry: TranscriptEntry };
  transcript: { courseId: number; entries: TranscriptEntry[] };
  glossary: { courseId: number; entries: GlossaryEntry[] };
  topics: { courseId: number; topics: TopicNode[]; unassignedDemos: DemoEntry[] };
  mastery: { courseId: number; entries: MasteryEntry[] };
  feynman: { courseId: number; activeCheck: ActiveFeynmanCheck | null };
  "tool-write": { courseId: number } & Record<string, unknown>;
  "agent-stream": AgentStreamPayload;
  lesson: { courseId: number } & Record<string, unknown>;
};

export type TopicTreeInput = {
  path: string;
  title: string;
  summary?: string;
  body?: string;
  children?: TopicTreeInput[];
};
