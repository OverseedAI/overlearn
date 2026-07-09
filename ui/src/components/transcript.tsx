import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import {
  BookOpenText,
  Check,
  ChevronRight,
  CircleAlert,
  FileText,
  Loader2,
  Sparkles,
  Wrench,
  X,
} from "lucide-react";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
import { DemoCard } from "@/components/demo-card";
import { FeynmanPanel } from "@/components/feynman-panel";
import { Markdown } from "@/lib/markdown";
import { cn } from "@/lib/utils";
import type { AgentActivity, ToolActivity } from "@/lib/course-store";
import type {
  TopicProposalCardTopic,
  TranscriptEntry,
  TranscriptPage,
} from "@/lib/types";

const CHAT_TEXT_CLASS = "text-[15pt] leading-[1.55]";

type NavigateTopicCard = (path: string, cardId: string) => void | Promise<void>;

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

function ToolActivityBlock({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <div className="overflow-hidden rounded-lg border bg-muted/30">
      <p className="flex items-center gap-2 px-3 py-2 font-mono text-[11px] font-medium tracking-wide text-muted-foreground uppercase">
        <Wrench className="size-4 shrink-0" />
        Tool activity
      </p>
      <div className="space-y-1.5 border-t px-3 py-2.5">{children}</div>
    </div>
  );
}

function ThinkingBlock({ text }: { text: string }) {
  return (
    <Collapsible className="overflow-hidden rounded-lg border bg-muted/30">
      <CollapsibleTrigger className="group/thinking flex w-full items-center gap-2 px-3 py-2 font-mono text-[11px] font-medium tracking-wide text-muted-foreground uppercase">
        <Sparkles className="size-4 shrink-0" />
        Thinking
        <ChevronRight className="ml-auto size-3 shrink-0 transition-transform group-data-[state=open]/thinking:rotate-90" />
      </CollapsibleTrigger>
      <CollapsibleContent>
        <p className="border-t px-3 py-2.5 font-mono text-xs leading-relaxed whitespace-pre-wrap text-muted-foreground">
          {text}
        </p>
      </CollapsibleContent>
    </Collapsible>
  );
}

function TopicChangeDivider({ text }: { text: string }) {
  return (
    <div className="flex items-center gap-3 py-1 text-center text-xs text-muted-foreground/80">
      <span className="h-px flex-1 bg-border" aria-hidden="true" />
      <Markdown
        text={text}
        className="max-w-[70%] text-xs leading-snug prose-p:m-0 prose-strong:font-medium prose-strong:text-muted-foreground"
      />
      <span className="h-px flex-1 bg-border" aria-hidden="true" />
    </div>
  );
}

function TopicProposalCards({
  cardId,
  state,
  topics,
  onNavigateTopic,
}: {
  cardId: string;
  state: "active" | "acted" | "skipped";
  topics: TopicProposalCardTopic[];
  onNavigateTopic?: NavigateTopicCard | undefined;
}) {
  const [pendingPath, setPendingPath] = useState<string | undefined>();

  if (state === "skipped") {
    return null;
  }

  const active = state === "active";
  const choose = async (topic: TopicProposalCardTopic) => {
    if (!active || pendingPath !== undefined || onNavigateTopic === undefined) {
      return;
    }

    setPendingPath(topic.path);
    try {
      await onNavigateTopic(topic.path, cardId);
    } finally {
      setPendingPath(undefined);
    }
  };

  return (
    <EntryShell label={active ? "Agent · Topic options" : "Agent · Topic chosen"}>
      <div className="grid gap-2 sm:grid-cols-3">
        {topics.map((topic) => (
          <button
            key={topic.path}
            type="button"
            disabled={
              !active || pendingPath !== undefined || onNavigateTopic === undefined
            }
            onClick={() => void choose(topic)}
            className={cn(
              "min-h-32 rounded-lg border bg-card p-3 text-left transition-colors",
              "focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none",
              active
                ? "hover:border-primary/60 hover:bg-accent"
                : "border-muted bg-muted/30 text-muted-foreground",
            )}
          >
            <span className="mb-2 flex items-center gap-2 text-sm font-medium">
              {pendingPath === topic.path ? (
                <Loader2 className="size-4 shrink-0 animate-spin" />
              ) : (
                <Sparkles className="size-4 shrink-0 text-primary" />
              )}
              <span className="line-clamp-2">{topic.title}</span>
            </span>
            <span className="block text-sm leading-snug text-muted-foreground">
              {topic.blurb}
            </span>
          </button>
        ))}
      </div>
    </EntryShell>
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
          <ThinkingBlock text={activity.thinking} />
        ) : null}
        {activity.tools.length > 0 ? (
          <ToolActivityBlock>
            {activity.tools.map((tool) => (
              <ToolLine key={tool.id} tool={tool} />
            ))}
          </ToolActivityBlock>
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

export function TypingIndicator({ message }: { message: string }) {
  return (
    <EntryShell label="Agent">
      <div
        className="flex items-center gap-2 py-1 text-sm text-muted-foreground"
        aria-label={message}
      >
        <span className="flex gap-1" aria-hidden="true">
          {[0, 150, 300].map((delay) => (
            <span
              key={delay}
              className="size-1.5 animate-pulse rounded-full bg-muted-foreground/60 [animation-duration:900ms]"
              style={{ animationDelay: `${delay}ms` }}
            />
          ))}
        </span>
        <span>{message}</span>
      </div>
    </EntryShell>
  );
}

function Entry({
  entry,
  courseId,
  cardActionsDisabled,
  onNavigateTopic,
}: {
  entry: TranscriptEntry;
  courseId: number;
  cardActionsDisabled: boolean;
  onNavigateTopic?: NavigateTopicCard | undefined;
}) {
  const kind = "kind" in entry ? (entry.kind ?? "text") : "text";

  if (kind === "topic-change" && entry.role === "system" && "text" in entry) {
    return <TopicChangeDivider text={entry.text} />;
  }

  if (kind === "thinking" && entry.role === "agent" && "text" in entry) {
    return (
      <EntryShell label="Agent">
        <ThinkingBlock text={entry.text} />
      </EntryShell>
    );
  }

  if (kind === "tool-call" && entry.role === "system") {
    return (
      <ToolActivityBlock>
        <div className="flex items-center gap-2 font-mono text-xs text-muted-foreground">
          <Check className="size-4 shrink-0 text-success" />
          <span className="truncate">{"text" in entry ? entry.text : ""}</span>
        </div>
      </ToolActivityBlock>
    );
  }

  if (kind === "demo" && "file" in entry) {
    return (
      <EntryShell label="Agent · Demo">
        <DemoCard courseId={courseId} file={entry.file} title={entry.title} />
      </EntryShell>
    );
  }

  if (kind === "journal-note" && "markdown" in entry) {
    return (
      <EntryShell label="Agent · Study note">
        <div className="rounded-lg border bg-card px-4 py-3">
          <p className="mb-2 flex items-center gap-2 text-sm font-medium">
            <FileText className="size-4 shrink-0 text-primary" />
            Journal note
          </p>
          <Markdown text={entry.markdown} className="text-sm" />
        </div>
      </EntryShell>
    );
  }

  if (kind === "feynman-check" && "concept" in entry && "prompt" in entry) {
    if (entry.state === "skipped") {
      return null;
    }

    return (
      <EntryShell label="Agent · Feynman check">
        <FeynmanPanel
          courseId={courseId}
          check={entry}
          state={entry.state}
          disabled={cardActionsDisabled}
        />
      </EntryShell>
    );
  }

  if (
    kind === "topic-proposals" &&
    "cardId" in entry &&
    "state" in entry &&
    "topics" in entry
  ) {
    return (
      <TopicProposalCards
        cardId={entry.cardId}
        state={entry.state}
        topics={entry.topics}
        onNavigateTopic={onNavigateTopic}
      />
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
 * ("recorded mastery …", "upserted glossary …") keep their readable rows.
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
  loadingMessage,
  cardActionsDisabled,
  onLoadOlder,
  onPrependEntries,
  onNavigateTopic,
}: {
  entries: TranscriptEntry[];
  courseId: number;
  activity?: AgentActivity | undefined;
  showTyping: boolean;
  loadingMessage: string;
  cardActionsDisabled: boolean;
  onLoadOlder?: (beforeId: number) => Promise<TranscriptPage>;
  onPrependEntries?: (entries: TranscriptEntry[]) => void;
  onNavigateTopic?: NavigateTopicCard | undefined;
}) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const pinnedToBottom = useRef(true);
  const prependAnchor = useRef<
    { scrollHeight: number; scrollTop: number } | undefined
  >(undefined);
  const [loadingOlder, setLoadingOlder] = useState(false);
  const [historyExhausted, setHistoryExhausted] = useState(false);

  useEffect(() => {
    setHistoryExhausted(false);
  }, [courseId]);

  const loadOlder = useCallback(async () => {
    const node = scrollRef.current;
    const beforeId = entries[0]?.id;
    if (
      !node ||
      beforeId === undefined ||
      loadingOlder ||
      historyExhausted ||
      onLoadOlder === undefined ||
      onPrependEntries === undefined
    ) {
      return;
    }

    const scrollHeight = node.scrollHeight;
    const scrollTop = node.scrollTop;
    setLoadingOlder(true);

    try {
      const page = await onLoadOlder(beforeId);
      if (page.entries.length > 0) {
        prependAnchor.current = { scrollHeight, scrollTop };
        onPrependEntries(page.entries);
      }
      if (!page.hasMore || page.entries.length === 0) {
        setHistoryExhausted(true);
      }
    } catch (error) {
      console.warn("Unable to load earlier transcript entries.", error);
    } finally {
      setLoadingOlder(false);
    }
  }, [
    entries,
    historyExhausted,
    loadingOlder,
    onLoadOlder,
    onPrependEntries,
  ]);

  useLayoutEffect(() => {
    const anchor = prependAnchor.current;
    const node = scrollRef.current;
    if (!anchor || !node) {
      return;
    }

    node.scrollTop =
      anchor.scrollTop + (node.scrollHeight - anchor.scrollHeight);
    prependAnchor.current = undefined;
  }, [entries]);

  useEffect(() => {
    const node = scrollRef.current;
    if (!node) {
      return;
    }
    const onScroll = () => {
      pinnedToBottom.current =
        node.scrollHeight - node.scrollTop - node.clientHeight < 120;
      if (node.scrollTop < 80) {
        void loadOlder();
      }
    };
    node.addEventListener("scroll", onScroll, { passive: true });
    return () => node.removeEventListener("scroll", onScroll);
  }, [loadOlder]);

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
      {loadingOlder ? (
        <div
          className="sticky top-2 z-10 flex h-0 justify-center"
          aria-live="polite"
        >
          <Loader2 className="size-4 animate-spin text-muted-foreground" />
          <span className="sr-only">Loading earlier transcript entries</span>
        </div>
      ) : null}
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
        {coalesceAgentText(entries).map((entry) => (
          <Entry
            key={entry.id}
            entry={entry}
            courseId={courseId}
            cardActionsDisabled={cardActionsDisabled}
            onNavigateTopic={onNavigateTopic}
          />
        ))}
        {activity ? <LiveActivity activity={activity} /> : null}
        {showTyping ? <TypingIndicator message={loadingMessage} /> : null}
      </div>
    </div>
  );
}
