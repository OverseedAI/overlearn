import { useEffect, useRef } from "react";
import {
  BookOpenText,
  Check,
  ChevronRight,
  CircleAlert,
  Loader2,
  Wrench,
  X,
} from "lucide-react";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
import { DemoCard } from "@/components/demo-card";
import { Markdown } from "@/lib/markdown";
import { cn } from "@/lib/utils";
import type { AgentActivity, ToolActivity } from "@/lib/course-store";
import type { TranscriptEntry } from "@/lib/types";

const CHAT_TEXT_CLASS = "text-[15pt] leading-[1.55]";

function EntryShell({
  label,
  children,
  className,
}: {
  label: string;
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <div className={cn("group", className)}>
      <p className="mb-1.5 text-xs font-medium text-muted-foreground">{label}</p>
      {children}
    </div>
  );
}

function LearnerBubble({ label, text }: { label: string; text: string }) {
  return (
    <EntryShell label={label} className="flex flex-col items-end text-right">
      <div className="max-w-[85%] rounded-lg bg-muted px-4 py-2.5 text-left">
        <Markdown text={text} className={CHAT_TEXT_CLASS} />
      </div>
    </EntryShell>
  );
}

function ToolLine({ tool }: { tool: ToolActivity }) {
  const icon =
    tool.status === "completed" ? (
      <Check className="size-4 shrink-0 text-success" />
    ) : tool.status === "failed" ? (
      <X className="size-4 shrink-0 text-destructive" />
    ) : (
      <Loader2 className="size-4 shrink-0 animate-spin text-muted-foreground" />
    );

  return (
    <div className="flex items-center gap-2 font-mono text-xs text-muted-foreground">
      {icon}
      <span className="truncate">
        {tool.name ?? "tool"}
        {tool.detail ? ` — ${tool.detail}` : ""}
      </span>
    </div>
  );
}

export function LiveActivity({ activity }: { activity: AgentActivity }) {
  const hasAnything =
    activity.thinking.length > 0 ||
    activity.text.length > 0 ||
    activity.tools.length > 0 ||
    activity.error !== undefined;

  if (!hasAnything) {
    return null;
  }

  return (
    <EntryShell label="Agent">
      <div className="space-y-3">
        {activity.thinking.length > 0 ? (
          <Collapsible>
            <CollapsibleTrigger className="group/thinking flex items-center gap-1 text-xs text-muted-foreground/80 italic">
              <ChevronRight className="size-3 shrink-0 transition-transform group-data-[state=open]/thinking:rotate-90" />
              Thinking…
            </CollapsibleTrigger>
            <CollapsibleContent>
              <p className="mt-1 border-l-2 pl-3 text-sm whitespace-pre-wrap text-muted-foreground italic">
                {activity.thinking}
              </p>
            </CollapsibleContent>
          </Collapsible>
        ) : null}
        {activity.tools.length > 0 ? (
          <div className="space-y-1">
            {activity.tools.map((tool) => (
              <ToolLine key={tool.id} tool={tool} />
            ))}
          </div>
        ) : null}
        {activity.text.length > 0 ? (
          <Markdown text={activity.text} className={CHAT_TEXT_CLASS} />
        ) : null}
        {activity.error !== undefined ? (
          <p className="flex items-center gap-2 text-sm text-destructive">
            <CircleAlert className="size-4 shrink-0" />
            {activity.error}
          </p>
        ) : null}
      </div>
    </EntryShell>
  );
}

export function TypingIndicator() {
  return (
    <EntryShell label="Agent">
      <div className="flex gap-1 py-1" aria-label="Agent is responding">
        {[0, 150, 300].map((delay) => (
          <span
            key={delay}
            className="size-1.5 animate-pulse rounded-full bg-muted-foreground/60 [animation-duration:900ms]"
            style={{ animationDelay: `${delay}ms` }}
          />
        ))}
      </div>
    </EntryShell>
  );
}

function Entry({
  entry,
  courseId,
  onOpenLesson,
}: {
  entry: TranscriptEntry;
  courseId: number;
  onOpenLesson: (lessonId: string) => void;
}) {
  const kind = "kind" in entry ? (entry.kind ?? "text") : "text";

  if (kind === "tool-call" && entry.role === "system") {
    return (
      <div className="flex items-center gap-2 font-mono text-xs text-muted-foreground/70">
        <Wrench className="size-4 shrink-0" />
        <span className="truncate">{"text" in entry ? entry.text : ""}</span>
      </div>
    );
  }

  if (kind === "demo" && "file" in entry) {
    return (
      <EntryShell label="Agent · Demo">
        <DemoCard courseId={courseId} file={entry.file} title={entry.title} />
      </EntryShell>
    );
  }

  if (kind === "lesson" && "lesson" in entry) {
    return (
      <EntryShell label="Agent · Lesson">
        <button
          type="button"
          onClick={() => onOpenLesson(entry.lesson)}
          className="flex w-full items-center gap-3 rounded-lg border bg-card px-4 py-3 text-left transition-colors hover:bg-accent"
        >
          <BookOpenText className="size-4 shrink-0 text-primary" />
          <span className="min-w-0 flex-1">
            <span className="block truncate text-sm font-medium">
              {entry.lesson}
            </span>
            <span className="block text-sm text-muted-foreground">
              Lesson updated — open in the study rail
            </span>
          </span>
          <ChevronRight className="size-4 shrink-0 text-muted-foreground" />
        </button>
      </EntryShell>
    );
  }

  if (kind === "feynman-check" && "concept" in entry && "prompt" in entry) {
    return (
      <EntryShell label="Agent · Feynman check">
        <div className="rounded-lg border border-warning/40 bg-warning/5 px-4 py-3">
          <p className="text-sm font-medium">{entry.concept}</p>
          <div className="mt-1">
            <Markdown text={entry.prompt} className={CHAT_TEXT_CLASS} />
          </div>
        </div>
      </EntryShell>
    );
  }

  if (kind === "feynman-answer" && "text" in entry) {
    return <LearnerBubble label="You · Check answer" text={entry.text} />;
  }

  if ("text" in entry) {
    if (entry.role === "learner") {
      return <LearnerBubble label="You" text={entry.text} />;
    }
    return (
      <EntryShell label="Agent">
        <Markdown text={entry.text} className={CHAT_TEXT_CLASS} />
      </EntryShell>
    );
  }

  return null;
}

/**
 * Older courses persisted streamed agent text as one row per chunk. Merge
 * consecutive agent text entries from the same turn (falling back to a
 * close-timestamp heuristic when turn is missing) so they read as one
 * message. New turns are persisted whole by the daemon.
 */
/**
 * Older daemons persisted a row per generic harness tool call, with the raw
 * ACP call id when the harness sent no name ("call_abc123 completed").
 * These are working noise, not learning record — hide them. Teaching writes
 * ("recorded mastery …", "wrote lesson …") keep their readable rows.
 */
function isLegacyToolCallNoise(entry: TranscriptEntry): boolean {
  return (
    entry.role === "system" &&
    "kind" in entry &&
    entry.kind === "tool-call" &&
    "text" in entry &&
    /^call_[\w-]+ (completed|failed)/.test(entry.text)
  );
}

function coalesceAgentText(entries: TranscriptEntry[]): TranscriptEntry[] {
  const result: TranscriptEntry[] = [];
  for (const entry of entries) {
    if (isLegacyToolCallNoise(entry)) {
      continue;
    }
    const previous = result[result.length - 1];
    const sameTurn =
      previous?.turn !== undefined && entry.turn !== undefined
        ? previous.turn === entry.turn
        : Math.abs(
            Date.parse(entry.at) - Date.parse(previous?.at ?? entry.at),
          ) < 15_000;
    if (
      previous !== undefined &&
      previous.role === "agent" &&
      entry.role === "agent" &&
      ("kind" in previous ? (previous.kind ?? "text") : "text") === "text" &&
      ("kind" in entry ? (entry.kind ?? "text") : "text") === "text" &&
      "text" in previous &&
      "text" in entry &&
      sameTurn
    ) {
      result[result.length - 1] = {
        ...previous,
        text: previous.text + entry.text,
      };
    } else {
      result.push(entry);
    }
  }
  return result;
}

export function Transcript({
  entries,
  courseId,
  activity,
  showTyping,
  onOpenLesson,
}: {
  entries: TranscriptEntry[];
  courseId: number;
  activity?: AgentActivity | undefined;
  showTyping: boolean;
  onOpenLesson: (lessonId: string) => void;
}) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const pinnedToBottom = useRef(true);

  useEffect(() => {
    const node = scrollRef.current;
    if (!node) {
      return;
    }
    const onScroll = () => {
      pinnedToBottom.current =
        node.scrollHeight - node.scrollTop - node.clientHeight < 120;
    };
    node.addEventListener("scroll", onScroll, { passive: true });
    return () => node.removeEventListener("scroll", onScroll);
  }, []);

  useEffect(() => {
    const node = scrollRef.current;
    if (node && pinnedToBottom.current) {
      node.scrollTop = node.scrollHeight;
    }
  });

  return (
    <div
      ref={scrollRef}
      className="min-h-0 flex-1 overflow-y-auto"
      aria-live="polite"
    >
      <div className="mx-auto w-full max-w-3xl space-y-6 px-6 py-8">
        {entries.length === 0 && !activity && !showTyping ? (
          <div className="py-24 text-center">
            <BookOpenText className="mx-auto size-4 text-muted-foreground" />
            <p className="mt-3 text-[15pt] leading-[1.45] text-pretty text-muted-foreground">
              Your agent teaches through conversation. Say hello, ask for the
              first topic, or pick one from the sidebar.
            </p>
          </div>
        ) : null}
        {coalesceAgentText(entries).map((entry, index) => (
          <Entry
            key={`${entry.at}-${index}`}
            entry={entry}
            courseId={courseId}
            onOpenLesson={onOpenLesson}
          />
        ))}
        {activity ? <LiveActivity activity={activity} /> : null}
        {showTyping ? <TypingIndicator /> : null}
      </div>
    </div>
  );
}
