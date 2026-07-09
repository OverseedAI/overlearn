import { useCallback, useEffect, useRef, useState } from "react";
import {
  ArrowUp,
  Bot,
  ChevronDown,
  FileText,
  Image as ImageIcon,
  LoaderCircle,
  Paperclip,
  PanelRight,
  X,
} from "lucide-react";
import { toast } from "sonner";
import { AppHeader } from "@/components/app-chrome";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Skeleton } from "@/components/ui/skeleton";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { AppScaleControls } from "@/components/app-scale-controls";
import { StudyRail, type RailTab } from "@/components/study-rail";
import { Transcript } from "@/components/transcript";
import { api, ApiError } from "@/lib/api";
import {
  ATTACHMENT_ACCEPT,
  attachmentKind,
  attachmentMimeType,
  readFileAsBase64,
  validateAttachmentFile,
} from "@/lib/attachments";
import { useCourseStore } from "@/lib/course-store";
import { cn } from "@/lib/utils";
import type {
  HarnessSummary,
  PromptAttachment,
  TopicNode,
  UiStatus,
} from "@/lib/types";

const RAIL_KEY = "overlearn-rail-open";

function flattenTopics(topics: readonly TopicNode[]): TopicNode[] {
  return topics.flatMap((topic) => [topic, ...flattenTopics(topic.children)]);
}

function StatusDot({
  status,
  message,
}: {
  status: UiStatus | undefined;
  message?: string | undefined;
}) {
  const { color, label, pulse } =
    status === "agent-working"
      ? {
          color: "bg-warning",
          label: message ?? "Preparing your next step…",
          pulse: true,
        }
      : status === "wrapping-up"
        ? {
            color: "bg-warning",
            label: message ?? "Saving your progress…",
            pulse: true,
          }
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
  type ComposerAttachment = Readonly<{
    id: string;
    kind: PromptAttachment["kind"];
    name: string;
    mimeType: string;
    status: "pending" | "ready" | "error";
    data?: string;
    error?: string;
  }>;

  const [text, setText] = useState("");
  const [attachments, setAttachments] = useState<ComposerAttachment[]>([]);
  const [attachmentError, setAttachmentError] = useState<string>();
  const [sending, setSending] = useState(false);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const nextAttachmentId = useRef(1);

  const updateAttachment = (
    id: string,
    update: Partial<ComposerAttachment>,
  ) => {
    setAttachments((current) =>
      current.map((attachment) =>
        attachment.id === id ? { ...attachment, ...update } : attachment,
      ),
    );
  };

  const addFiles = (files: FileList | null) => {
    if (files === null) {
      return;
    }

    setAttachmentError(undefined);
    for (const file of files) {
      const id = `attachment-${nextAttachmentId.current}`;
      nextAttachmentId.current += 1;
      const mimeType = attachmentMimeType(file);
      const kind = attachmentKind(mimeType);
      const validationError = validateAttachmentFile(file, mimeType);
      const attachment: ComposerAttachment = {
        id,
        kind,
        name: file.name,
        mimeType,
        status: validationError === undefined ? "pending" : "error",
        ...(validationError === undefined ? {} : { error: validationError }),
      };
      setAttachments((current) => [...current, attachment]);

      if (validationError !== undefined) {
        setAttachmentError(validationError);
        continue;
      }

      void readFileAsBase64(file)
        .then((data) => updateAttachment(id, { status: "ready", data }))
        .catch((error: unknown) => {
          const message =
            error instanceof Error ? error.message : `Couldn’t read ${file.name}.`;
          updateAttachment(id, { status: "error", error: message });
          setAttachmentError(message);
        });
    }

    if (fileInputRef.current !== null) {
      fileInputRef.current.value = "";
    }
  };

  const removeAttachment = (id: string) => {
    setAttachments((current) => current.filter((attachment) => attachment.id !== id));
    setAttachmentError(undefined);
  };

  const send = async () => {
    const value = text.trim();
    if (
      value.length === 0 ||
      sending ||
      disabled ||
      attachments.some((attachment) => attachment.status === "pending")
    ) {
      return;
    }

    const readyAttachments = attachments.flatMap(
      (attachment): readonly PromptAttachment[] =>
        attachment.status === "ready" && attachment.data !== undefined
          ? [
              {
                kind: attachment.kind,
                name: attachment.name,
                mimeType: attachment.mimeType,
                data: attachment.data,
              },
            ]
          : [],
    );
    setSending(true);
    try {
      await api.submit(
        courseId,
        value,
        readyAttachments.length === 0 ? undefined : readyAttachments,
      );
      setText("");
      setAttachments([]);
      setAttachmentError(undefined);
    } catch (error) {
      const message = error instanceof ApiError ? error.message : "Couldn’t send.";
      setAttachmentError(message);
      toast.error(message);
    } finally {
      setSending(false);
      textareaRef.current?.focus();
    }
  };

  return (
    <form
      className="space-y-2"
      onSubmit={(event) => {
        event.preventDefault();
        void send();
      }}
    >
      {attachments.length > 0 && (
        <div className="flex flex-wrap gap-2" aria-label="Attachments">
          {attachments.map((attachment) => {
            const status = sending && attachment.status === "ready"
              ? "Sending"
              : attachment.status === "pending"
                ? "Preparing"
                : attachment.status === "ready"
                  ? "Ready"
                  : "Error";
            const AttachmentIcon =
              attachment.kind === "image" ? ImageIcon : FileText;

            return (
              <div
                key={attachment.id}
                title={attachment.error}
                className={cn(
                  "flex max-w-64 items-center gap-2 rounded-lg border bg-card px-2.5 py-1.5 text-sm",
                  attachment.status === "error" && "border-destructive/50",
                )}
              >
                {attachment.status === "pending" ||
                (sending && attachment.status === "ready") ? (
                  <LoaderCircle className="size-4 shrink-0 animate-spin text-muted-foreground" />
                ) : (
                  <AttachmentIcon className="size-4 shrink-0 text-muted-foreground" />
                )}
                <span className="min-w-0">
                  <span className="block truncate">{attachment.name}</span>
                  <span
                    className={cn(
                      "block text-xs text-muted-foreground",
                      attachment.status === "error" && "text-destructive",
                    )}
                  >
                    {status}
                  </span>
                </span>
                <button
                  type="button"
                  aria-label={`Remove ${attachment.name}`}
                  disabled={sending}
                  onClick={() => removeAttachment(attachment.id)}
                  className="rounded-sm text-muted-foreground hover:text-foreground disabled:opacity-50"
                >
                  <X className="size-3.5" />
                </button>
              </div>
            );
          })}
        </div>
      )}
      {attachmentError !== undefined && (
        <p role="alert" className="text-sm text-destructive">
          {attachmentError}
        </p>
      )}
      <div className="relative">
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
          className="max-h-48 min-h-16 resize-none bg-card px-12 text-[15pt] leading-[1.45] md:text-[15pt]"
        />
        <input
          ref={fileInputRef}
          type="file"
          multiple
          accept={ATTACHMENT_ACCEPT}
          aria-label="Attach images or files"
          className="sr-only"
          onChange={(event) => addFiles(event.target.files)}
        />
        <Button
          type="button"
          size="icon"
          variant="ghost"
          aria-label="Attach images or files"
          disabled={disabled || sending}
          onClick={() => fileInputRef.current?.click()}
          className="absolute bottom-2 left-2 size-8 rounded-full"
        >
          <Paperclip className="size-4" />
        </Button>
        <Button
          type="submit"
          size="icon"
          aria-label="Send"
          disabled={
            disabled ||
            sending ||
            text.trim().length === 0 ||
            attachments.some((attachment) => attachment.status === "pending")
          }
          className="absolute right-2 bottom-2 size-8 rounded-full"
        >
          <ArrowUp className="size-4" />
        </Button>
      </div>
    </form>
  );
}

export function CourseScreen() {
  const { store, courseId, prependTranscript } = useCourseStore();
  const [railOpen, setRailOpen] = useState(
    () => localStorage.getItem(RAIL_KEY) !== "closed",
  );
  const [railTab, setRailTab] = useState<RailTab>("journal");

  const toggleRail = () => {
    setRailOpen((current) => {
      localStorage.setItem(RAIL_KEY, current ? "closed" : "open");
      return !current;
    });
  };

  const loadOlderTranscript = useCallback(
    (beforeId: number) =>
      api.pageTranscript(courseId, { before: beforeId, limit: 50 }),
    [courseId],
  );
  const navigateTopicCard = useCallback(
    async (path: string, cardId: string) => {
      try {
        await api.nav(courseId, path, { cardId });
      } catch (error) {
        toast.error(
          error instanceof ApiError ? error.message : "Couldn’t change topic.",
        );
      }
    },
    [courseId],
  );

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

  const { course, transcript, glossary, topics } = store.state;
  const flatTopics = flattenTopics(topics);
  const selectedTopic =
    flatTopics.find((topic) => topic.path === store.selectedTopicPath) ??
    flatTopics.find((topic) => topic.current) ??
    flatTopics[0];
  const busy = store.status === "agent-working" || store.status === "wrapping-up";
  const ended = store.status === "session-ended";
  const composerDisabled = busy || ended;

  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col">
      <AppHeader
        title={course.title}
        afterTitle={
          <StatusDot status={store.status} message={store.statusMessage} />
        }
        actionsClassName="gap-1"
      >
        <AppScaleControls />
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
      </AppHeader>

      <div className="flex min-h-0 flex-1">
        <div className="flex min-w-0 flex-1 flex-col">
          <Transcript
            entries={transcript}
            courseId={courseId}
            activity={store.activity}
            showTyping={busy && !store.activity}
            loadingMessage={store.statusMessage ?? "Preparing your next step…"}
            cardActionsDisabled={composerDisabled}
            onLoadOlder={loadOlderTranscript}
            onPrependEntries={prependTranscript}
            onNavigateTopic={navigateTopicCard}
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
              ) : (
                <Composer
                  courseId={courseId}
                  disabled={composerDisabled}
                  placeholder={
                    busy
                      ? (store.statusMessage ?? "Preparing your next step…")
                      : "Ask, answer, or explore…"
                  }
                />
              )}
            </div>
          </div>
        </div>

        {railOpen ? (
          <aside className="hidden w-80 shrink-0 border-l lg:block">
            <StudyRail
              courseId={courseId}
              topic={selectedTopic}
              glossary={glossary}
              tab={railTab}
              onTabChange={setRailTab}
            />
          </aside>
        ) : null}
      </div>
    </div>
  );
}
