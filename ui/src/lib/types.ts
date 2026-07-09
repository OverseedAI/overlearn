/*
 * Protocol types mirrored from the daemon (src/daemon/ui.ts, src/daemon/index.ts,
 * src/daemon/orchestrator.ts, src/adapter/types.ts). The daemon has no shared
 * type package yet, so keep these in sync by hand.
 */

export type CourseStatus = "active" | "archived";

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

export type JournalDemoRef = {
  id: number;
  file: string;
  title: string | null;
  fileName: string | null;
};

export type TopicJournalEntry = {
  id: number;
  kind: "note" | "demo" | "summary";
  topicId: number;
  bodyMarkdown?: string;
  demoId?: number | null;
  demo?: JournalDemoRef | null;
  turn: number | null;
  createdAt: string;
};

export type JournalSnapshot = {
  entries: TopicJournalEntry[];
  totalCount: number;
  limit: number | null;
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
  id: number;
  path: string;
  title: string;
  body?: string;
  enteredAt?: string;
  current: boolean;
  state: "frontier" | "visited" | "current";
  demos?: DemoEntry[];
  journal: JournalSnapshot;
  children: TopicNode[];
};

export type ActiveFeynmanCheck = {
  concept: string;
  prompt: string;
  keyPoints: string[];
  issuedAt: string;
  replaced?: { concept: string; issuedAt: string; replacedAt: string };
};

export type TopicProposalCardTopic = {
  path: string;
  title: string;
  blurb: string;
};

type TranscriptEntryBase = {
  id: number;
  topicId: number | null;
  at: string;
  turn?: number;
};

export type TranscriptEntry = TranscriptEntryBase &
  (
    | {
      role: "learner" | "agent";
      text: string;
      kind?: "text";
    }
    | {
      role: "agent";
      kind: "thinking";
      text: string;
    }
    | {
      role: "agent";
      kind: "demo";
      file: string;
      title?: string;
    }
    | { role: "agent"; kind: "journal-note"; markdown: string }
    | {
      role: "agent";
      kind: "feynman-check";
      cardId: string;
      state: "active" | "acted" | "skipped";
      concept: string;
      prompt: string;
      keyPoints: string[];
    }
    | {
      role: "agent";
      kind: "topic-proposals";
      cardId: string;
      state: "active" | "acted" | "skipped";
      topics: TopicProposalCardTopic[];
    }
    | {
      role: "learner";
      kind: "feynman-answer";
      concept: string;
      text: string;
    }
    | {
      role: "system";
      kind: "tool-call";
      text: string;
      tool: string;
    }
    | {
      role: "system";
      kind: "topic-change";
      text: string;
    }
  );

export type TranscriptPage = {
  entries: TranscriptEntry[];
  hasMore: boolean;
  nextBeforeId: number | null;
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

export type SessionSummary = LiveSessionSummary & {
  courseTitle: string;
  lastActivityAt: string;
  startedAt: string;
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
  sessions: SessionSummary[];
  harnesses: HarnessesPayload;
  message: { courseId: number; entry: TranscriptEntry };
  transcript: { courseId: number; entries: TranscriptEntry[] };
  glossary: { courseId: number; entries: GlossaryEntry[] };
  topics: { courseId: number; topics: TopicNode[]; unassignedDemos: DemoEntry[] };
  mastery: { courseId: number; entries: MasteryEntry[] };
  feynman: { courseId: number; activeCheck: ActiveFeynmanCheck | null };
  "tool-write": { courseId: number } & Record<string, unknown>;
  "agent-stream": AgentStreamPayload;
};
