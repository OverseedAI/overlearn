import { useCallback, useEffect, useRef, useState } from "react";
import { ArrowUp, Bot, ChevronDown, PanelRight } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Skeleton } from "@/components/ui/skeleton";
import { SidebarTrigger } from "@/components/ui/sidebar";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { FeynmanPanel } from "@/components/feynman-panel";
import { StudyRail, type RailTab } from "@/components/study-rail";
import { Transcript } from "@/components/transcript";
import { api, ApiError } from "@/lib/api";
import { useCourseStore } from "@/lib/course-store";
import { cn } from "@/lib/utils";
import type { HarnessSummary, UiStatus } from "@/lib/types";

const RAIL_KEY = "overlearn-rail-open";

function StatusDot({ status }: { status: UiStatus | undefined }) {
  const { color, label, pulse } =
    status === "agent-working"
      ? { color: "bg-warning", label: "Agent working", pulse: true }
      : status === "wrapping-up"
        ? { color: "bg-warning", label: "Wrapping up", pulse: true }
        : status === "agent-failed"
          ? { color: "bg-destructive", label: "Agent failed", pulse: false }
          : status === "session-ended"
            ? { color: "bg-muted-foreground", label: "Session ended", pulse: false }
            : { color: "bg-success", label: "Ready", pulse: false };

  return (
    <span className="flex items-center gap-1.5 text-sm text-muted-foreground">
      <span
        className={cn("size-1.5 rounded-full", color, pulse && "animate-pulse")}
      />
      {label}
    </span>
  );
}

function HarnessPicker({
  courseId,
  disabled,
}: {
  courseId: number;
  disabled: boolean;
}) {
  const [harnesses, setHarnesses] = useState<HarnessSummary[]>([]);

  const load = useCallback(
    (refresh = false) => {
      void api
        .listHarnesses({ courseId, refresh })
        .then(setHarnesses)
        .catch(() => undefined);
    },
    [courseId],
  );

  useEffect(() => load(), [load]);

  const selected = harnesses.find((harness) => harness.selected);

  const choose = async (id: string) => {
    try {
      await api.setCourseHarness(courseId, id);
      load();
    } catch (error) {
      toast.error(
        error instanceof ApiError ? error.message : "Couldn’t switch agent.",
      );
    }
  };

  return (
    <DropdownMenu onOpenChange={(open) => open && load(true)}>
      <DropdownMenuTrigger asChild>
        <Button type="button" variant="ghost" size="sm" disabled={disabled}>
          <Bot className="size-4 shrink-0" />
          <span className="max-w-32 truncate">
            {selected?.name ?? "Agent"}
          </span>
          <ChevronDown className="size-4 shrink-0 text-muted-foreground" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-56">
        <DropdownMenuLabel>Teaching agent</DropdownMenuLabel>
        <DropdownMenuSeparator />
        {harnesses.map((harness) => (
          <DropdownMenuItem
            key={harness.id}
            disabled={!harness.installed}
            onSelect={() => void choose(harness.id)}
          >
            <span className="flex-1 truncate">{harness.name}</span>
            <span className="text-xs text-muted-foreground">
              {harness.selected
                ? "Selected"
                : !harness.installed
                  ? "Not installed"
                  : !harness.authenticated
                    ? "Not logged in"
                    : ""}
            </span>
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function Composer({
  courseId,
  disabled,
  placeholder,
}: {
  courseId: number;
  disabled: boolean;
  placeholder: string;
}) {
  const [text, setText] = useState("");
  const [sending, setSending] = useState(false);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  const send = async () => {
    const value = text.trim();
    if (value.length === 0 || sending || disabled) {
      return;
    }
    setSending(true);
    try {
      await api.submit(courseId, value);
      setText("");
    } catch (error) {
      toast.error(error instanceof ApiError ? error.message : "Couldn’t send.");
    } finally {
      setSending(false);
      textareaRef.current?.focus();
    }
  };

  return (
    <form
      className="relative"
      onSubmit={(event) => {
        event.preventDefault();
        void send();
      }}
    >
      <Textarea
        ref={textareaRef}
        name="message"
        aria-label="Message the agent"
        placeholder={placeholder}
        value={text}
        disabled={disabled || sending}
        onChange={(event) => setText(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === "Enter" && !event.shiftKey) {
            event.preventDefault();
            void send();
          }
        }}
        className="max-h-48 min-h-12 resize-none bg-card pr-12"
      />
      <Button
        type="submit"
        size="icon"
        aria-label="Send"
        disabled={disabled || sending || text.trim().length === 0}
        className="absolute right-2 bottom-2 size-8 rounded-full"
      >
        <ArrowUp className="size-4" />
      </Button>
    </form>
  );
}

export function CourseScreen() {
  const { store, courseId } = useCourseStore();
  const [railOpen, setRailOpen] = useState(
    () => localStorage.getItem(RAIL_KEY) !== "closed",
  );
  const [railTab, setRailTab] = useState<RailTab>("lesson");
  const [selectedLessonId, setSelectedLessonId] = useState<string>();

  const toggleRail = () => {
    setRailOpen((current) => {
      localStorage.setItem(RAIL_KEY, current ? "closed" : "open");
      return !current;
    });
  };

  const openLesson = (lessonId: string) => {
    setSelectedLessonId(lessonId);
    setRailTab("lesson");
    if (!railOpen) {
      toggleRail();
    }
  };

  if (store.loading) {
    return (
      <div className="space-y-4 p-6">
        <Skeleton className="h-6 w-64" />
        <Skeleton className="h-4 w-full max-w-xl" />
        <Skeleton className="h-4 w-full max-w-lg" />
      </div>
    );
  }

  if (store.loadError !== undefined || !store.state) {
    return (
      <div className="grid flex-1 place-items-center p-8">
        <p className="max-w-sm text-center text-sm text-pretty text-muted-foreground">
          {store.loadError ?? "Course not found."}
        </p>
      </div>
    );
  }

  const { course, transcript, glossary, lessons, activeFeynmanCheck } =
    store.state;
  const busy = store.status === "agent-working" || store.status === "wrapping-up";
  const ended = store.status === "session-ended";
  const composerDisabled = busy || ended;

  return (
    <div className="flex h-dvh min-w-0 flex-col">
      <header className="flex h-12 shrink-0 items-center gap-2 border-b px-4">
        <SidebarTrigger />
        <h1 className="min-w-0 truncate text-sm font-medium">{course.title}</h1>
        <StatusDot status={store.status} />
        <div className="ms-auto flex items-center gap-1">
          <HarnessPicker courseId={courseId} disabled={busy || ended} />
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                type="button"
                variant="ghost"
                size="icon"
                aria-label={railOpen ? "Hide study rail" : "Show study rail"}
                aria-pressed={railOpen}
                onClick={toggleRail}
                className="size-8"
              >
                <PanelRight className="size-4" />
              </Button>
            </TooltipTrigger>
            <TooltipContent>Study rail</TooltipContent>
          </Tooltip>
        </div>
      </header>

      <div className="flex min-h-0 flex-1">
        <div className="flex min-w-0 flex-1 flex-col">
          <Transcript
            entries={transcript}
            courseId={courseId}
            activity={store.activity}
            showTyping={busy && !store.activity}
            onOpenLesson={openLesson}
          />

          <div className="shrink-0 border-t">
            <div className="mx-auto w-full max-w-3xl px-6 py-4">
              {store.status === "agent-failed" &&
              store.statusMessage !== undefined ? (
                <p className="mb-3 text-sm text-destructive">
                  {store.statusMessage}
                </p>
              ) : null}
              {ended ? (
                <p className="py-2 text-center text-sm text-muted-foreground">
                  Session ended. Overlearn saved your progress — reopen the app
                  to keep learning.
                </p>
              ) : activeFeynmanCheck ? (
                <FeynmanPanel
                  courseId={courseId}
                  check={activeFeynmanCheck}
                  disabled={composerDisabled}
                />
              ) : (
                <Composer
                  courseId={courseId}
                  disabled={composerDisabled}
                  placeholder={
                    busy ? "The agent is working…" : "Ask, answer, or explore…"
                  }
                />
              )}
            </div>
          </div>
        </div>

        {railOpen ? (
          <aside className="hidden w-80 shrink-0 border-l lg:block">
            <StudyRail
              lessons={lessons}
              glossary={glossary}
              tab={railTab}
              onTabChange={setRailTab}
              selectedLessonId={selectedLessonId ?? lessons.selectedLessonId}
              onSelectLesson={setSelectedLessonId}
            />
          </aside>
        ) : null}
      </div>
    </div>
  );
}
