import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useReducer,
  useRef,
  type ReactNode,
} from "react";
import { api, subscribeEvents } from "./api";
import type {
  ActiveFeynmanCheck,
  AgentStreamPayload,
  CourseState,
  GlossaryEntry,
  MasteryEntry,
  TopicNode,
  TranscriptEntry,
  UiStatus,
} from "./types";

export type ToolActivity = {
  id: string;
  name?: string | undefined;
  status: "started" | "delta" | "completed" | "failed";
  detail?: string | undefined;
};

/** Live accumulation of the agent's in-flight turn (from agent-stream SSE). */
export type AgentActivity = {
  turn: number;
  thinking: string;
  text: string;
  tools: ToolActivity[];
  error?: string | undefined;
};

export type CourseStore = {
  loading: boolean;
  loadError?: string | undefined;
  state?: CourseState | undefined;
  status?: UiStatus | undefined;
  statusMessage?: string | undefined;
  activity?: AgentActivity | undefined;
  connected: boolean;
};

type Action =
  | { type: "loaded"; state: CourseState }
  | { type: "load-error"; message: string }
  | { type: "status"; status: UiStatus; message?: string }
  | { type: "message"; entry: TranscriptEntry }
  | { type: "transcript"; entries: TranscriptEntry[] }
  | { type: "prepend-transcript"; entries: TranscriptEntry[] }
  | { type: "glossary"; entries: GlossaryEntry[] }
  | { type: "topics"; topics: TopicNode[] }
  | { type: "mastery"; entries: MasteryEntry[] }
  | { type: "feynman"; activeCheck: ActiveFeynmanCheck | null }
  | { type: "agent-stream"; payload: AgentStreamPayload }
  | { type: "connection"; connected: boolean }
  | { type: "refresh-lessons"; state: CourseState };

function withState(
  store: CourseStore,
  update: Partial<CourseState>,
): CourseStore {
  return store.state ? { ...store, state: { ...store.state, ...update } } : store;
}

function uniqueTranscriptEntries(
  entries: readonly TranscriptEntry[],
): TranscriptEntry[] {
  const seen = new Set<number>();
  const result: TranscriptEntry[] = [];

  for (const entry of entries) {
    if (seen.has(entry.id)) {
      continue;
    }
    seen.add(entry.id);
    result.push(entry);
  }

  return result;
}

function applyAgentStream(
  store: CourseStore,
  payload: AgentStreamPayload,
): CourseStore {
  const event = payload.event;
  const current =
    store.activity?.turn === payload.turn
      ? store.activity
      : { turn: payload.turn, thinking: "", text: "", tools: [] };

  switch (event.type) {
    case "thinking":
      return {
        ...store,
        activity: { ...current, thinking: current.thinking + event.text },
      };
    case "text":
      return {
        ...store,
        activity: { ...current, text: current.text + event.text },
      };
    case "tool-call": {
      const existing = current.tools.find((tool) => tool.id === event.id);
      const updated: ToolActivity = {
        id: event.id,
        name: event.name ?? existing?.name,
        status: event.status,
        detail: event.text ?? event.error ?? existing?.detail,
      };
      return {
        ...store,
        activity: {
          ...current,
          tools: existing
            ? current.tools.map((tool) => (tool.id === event.id ? updated : tool))
            : [...current.tools, updated],
        },
      };
    }
    case "error":
      return { ...store, activity: { ...current, error: event.message } };
    case "done":
      return { ...store, activity: undefined };
    default:
      return store;
  }
}

function reduce(store: CourseStore, action: Action): CourseStore {
  switch (action.type) {
    case "loaded":
      return { ...store, loading: false, state: action.state };
    case "load-error":
      return { ...store, loading: false, loadError: action.message };
    case "status":
      return {
        ...store,
        status: action.status,
        ...(action.message !== undefined
          ? { statusMessage: action.message }
          : { statusMessage: undefined }),
        // A finished turn means live activity is stale.
        ...(action.status === "waiting-for-agent" || action.status === "session-ended"
          ? { activity: undefined }
          : {}),
      };
    case "message": {
      if (!store.state) {
        return store;
      }
      // The final agent text arrives as a message; clear the live buffer.
      const clearsActivity =
        action.entry.role === "agent" && (action.entry.kind ?? "text") === "text";
      return {
        ...withState(store, {
          transcript: uniqueTranscriptEntries([
            ...store.state.transcript,
            action.entry,
          ]),
        }),
        ...(clearsActivity && store.activity
          ? { activity: { ...store.activity, text: "" } }
          : {}),
      };
    }
    case "transcript": {
      if (!store.state) {
        return store;
      }
      const firstTailId = action.entries[0]?.id;
      const retainedOlder =
        firstTailId === undefined
          ? []
          : store.state.transcript.filter((entry) => entry.id < firstTailId);

      return withState(store, {
        transcript: uniqueTranscriptEntries([...retainedOlder, ...action.entries]),
      });
    }
    case "prepend-transcript":
      return store.state
        ? withState(store, {
            transcript: uniqueTranscriptEntries([
              ...action.entries,
              ...store.state.transcript,
            ]),
          })
        : store;
    case "glossary":
      return withState(store, { glossary: action.entries });
    case "topics":
      return withState(store, { topics: action.topics });
    case "mastery":
      return withState(store, { mastery: action.entries });
    case "feynman":
      return withState(store, { activeFeynmanCheck: action.activeCheck });
    case "agent-stream":
      return applyAgentStream(store, action.payload);
    case "connection":
      return { ...store, connected: action.connected };
    case "refresh-lessons":
      return withState(store, {
        lessons: action.state.lessons,
        demos: action.state.demos,
      });
    default:
      return store;
  }
}

const CourseStoreContext = createContext<
  | {
      store: CourseStore;
      courseId: number;
      prependTranscript: (entries: TranscriptEntry[]) => void;
    }
  | undefined
>(undefined);

export function CourseStoreProvider({
  courseId,
  children,
}: {
  courseId: number;
  children: ReactNode;
}) {
  const [store, dispatch] = useReducer(reduce, {
    loading: true,
    connected: false,
  });
  // Replayed agent-stream events must be applied at most once.
  const seenStreamEvents = useRef(new Set<string>());
  const prependTranscript = useCallback((entries: TranscriptEntry[]) => {
    dispatch({ type: "prepend-transcript", entries });
  }, []);

  useEffect(() => {
    let cancelled = false;
    seenStreamEvents.current = new Set();

    api
      .getCourse(courseId)
      .then((state) => {
        if (!cancelled) {
          dispatch({ type: "loaded", state });
        }
      })
      .catch((error: unknown) => {
        if (!cancelled) {
          dispatch({
            type: "load-error",
            message: error instanceof Error ? error.message : String(error),
          });
        }
      });

    const forCourse =
      <T extends { courseId?: number }>(handler: (payload: T) => void) =>
      (payload: T) => {
        if (payload.courseId === courseId) {
          handler(payload);
        }
      };

    const unsubscribe = subscribeEvents(
      {
        status: forCourse((payload) =>
          dispatch({
            type: "status",
            status: payload.status,
            ...(payload.message !== undefined
              ? { message: payload.message }
              : {}),
          }),
        ),
        message: forCourse((payload) =>
          dispatch({ type: "message", entry: payload.entry }),
        ),
        transcript: forCourse((payload) =>
          dispatch({ type: "transcript", entries: payload.entries }),
        ),
        glossary: forCourse((payload) =>
          dispatch({ type: "glossary", entries: payload.entries }),
        ),
        topics: forCourse((payload) =>
          dispatch({ type: "topics", topics: payload.topics }),
        ),
        mastery: forCourse((payload) =>
          dispatch({ type: "mastery", entries: payload.entries }),
        ),
        feynman: forCourse((payload) =>
          dispatch({ type: "feynman", activeCheck: payload.activeCheck }),
        ),
        "agent-stream": forCourse((payload) => {
          const key = `${payload.turn}:${payload.sequence}`;
          if (seenStreamEvents.current.has(key)) {
            return;
          }
          seenStreamEvents.current.add(key);
          dispatch({ type: "agent-stream", payload });
        }),
        lesson: forCourse(() => {
          // Lesson files changed on disk; refetch the rendered snapshot.
          void api
            .getCourse(courseId)
            .then((state) => dispatch({ type: "refresh-lessons", state }))
            .catch(() => undefined);
        }),
      },
      (connected) => dispatch({ type: "connection", connected }),
    );

    return () => {
      cancelled = true;
      unsubscribe();
    };
  }, [courseId]);

  const value = useMemo(
    () => ({ store, courseId, prependTranscript }),
    [store, courseId, prependTranscript],
  );

  return (
    <CourseStoreContext.Provider value={value}>
      {children}
    </CourseStoreContext.Provider>
  );
}

export function useCourseStore() {
  const context = useContext(CourseStoreContext);
  if (!context) {
    throw new Error("useCourseStore must be used within CourseStoreProvider");
  }
  return context;
}

/** Sidebar wants course context when present but must not crash outside it. */
export function useOptionalCourseStore() {
  return useContext(CourseStoreContext);
}
