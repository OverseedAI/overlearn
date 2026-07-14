import { useCallback, useEffect, useRef, useState } from "react";
import {
  ArrowUp,
  Bot,
  Check,
  ChevronDown,
  FileText,
  Globe,
  Image as ImageIcon,
  LoaderCircle,
  Paperclip,
  PanelRight,
  Sparkles,
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
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { AppScaleControls } from "@/components/app-scale-controls";
import { StudyRail, type RailTab } from "@/components/study-rail";
import { Transcript } from "@/components/transcript";
import { api, ApiError, subscribeEvents } from "@/lib/api";
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
  CourseResource,
  HarnessSummary,
  PromptAttachment,
  TopicNode,
  UiStatus,
} from "@/lib/types";

const RAIL_KEY = "overlearn-rail-open";

function hasDraggedFiles(dataTransfer: DataTransfer | null) {
  return dataTransfer !== null && Array.from(dataTransfer.types).includes("Files");
}

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

function useCourseHarnesses(courseId: number) {
  const [harnesses, setHarnesses] = useState<HarnessSummary[]>([]);
  const [optimisticSelectedId, setOptimisticSelectedId] = useState<string>();

  const applyHarnesses = useCallback((next: HarnessSummary[]) => {
    setHarnesses(next);
    setOptimisticSelectedId(undefined);
  }, []);

  const load = useCallback(
    (refresh = false) => {
      void api
        .listHarnesses({ courseId, refresh })
        .then(applyHarnesses)
        .catch(() => undefined);
    },
    [applyHarnesses, courseId],
  );

  const select = useCallback(
    async (id: string) => {
      setOptimisticSelectedId(id);
      try {
        await api.setCourseHarness(courseId, id);
        load();
      } catch (error) {
        setOptimisticSelectedId(undefined);
        throw error;
      }
    },
    [courseId, load],
  );

  useEffect(() => load(), [load]);

  useEffect(
    () =>
      subscribeEvents({
        harnesses: (payload) => {
          if (payload.courseId === courseId) {
            applyHarnesses(payload.harnesses);
          }
        },
      }),
    [applyHarnesses, courseId],
  );

  const displayedHarnesses =
    optimisticSelectedId === undefined
      ? harnesses
      : harnesses.map((harness) => ({
          ...harness,
          selected: harness.id === optimisticSelectedId,
        }));

  return { harnesses: displayedHarnesses, load, select };
}

function HarnessPicker({
  harnesses,
  loadHarnesses,
  selectHarness,
  disabled,
}: {
  harnesses: HarnessSummary[];
  loadHarnesses: (refresh?: boolean) => void;
  selectHarness: (id: string) => Promise<void>;
  disabled: boolean;
}) {
  const selected = harnesses.find((harness) => harness.selected);

  const choose = async (id: string) => {
    try {
      await selectHarness(id);
    } catch (error) {
      toast.error(
        error instanceof ApiError ? error.message : "Couldn’t switch agent.",
      );
    }
  };

  return (
    <DropdownMenu onOpenChange={(open) => open && loadHarnesses(true)}>
      <DropdownMenuTrigger asChild>
        <Button type="button" variant="ghost" size="sm" disabled={disabled}>
          <Bot className="size-4 shrink-0" />
          <span className="max-w-32 truncate">
            {selected?.name ?? "Agent"}
          </span>
          <ChevronDown className="size-4 shrink-0 text-muted-foreground" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-64">
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
  course,
  harness,
  harnesses,
  loadHarnesses,
  selectHarness,
  disabled,
  placeholder,
  registerFileDrop,
}: {
  courseId: number;
  course: CourseResource;
  harness: HarnessSummary | undefined;
  harnesses: HarnessSummary[];
  loadHarnesses: (refresh?: boolean) => void;
  selectHarness: (id: string) => Promise<void>;
  disabled: boolean;
  placeholder: string;
  registerFileDrop: (handler: ((files: FileList) => void) | null) => void;
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
  const [customModelOpen, setCustomModelOpen] = useState(false);
  const [customModelText, setCustomModelText] = useState("");
  const [webSearchEnabled, setWebSearchEnabled] = useState(
    course.webSearchEnabled,
  );
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const nextAttachmentId = useRef(1);

  useEffect(() => {
    setWebSearchEnabled(course.webSearchEnabled);
  }, [course.webSearchEnabled]);

  const chooseHarness = async (id: string) => {
    try {
      await selectHarness(id);
    } catch (error) {
      toast.error(
        error instanceof ApiError ? error.message : "Couldn’t switch agent.",
      );
    }
  };

  const configure = async (config: {
    model: string | null;
    effort: string | null;
  }) => {
    try {
      await api.setCourseAgentConfig(courseId, config);
      loadHarnesses();
    } catch (error) {
      toast.error(
        error instanceof ApiError
          ? error.message
          : "Couldn’t update agent settings.",
      );
    }
  };

  const usingCustomModel =
    harness !== undefined &&
    harness.selectedModel !== null &&
    !harness.models.some((model) => model.id === harness.selectedModel);

  const openCustomModel = () => {
    setCustomModelText(usingCustomModel ? (harness?.selectedModel ?? "") : "");
    setCustomModelOpen(true);
  };

  const submitCustomModel = () => {
    const model = customModelText.trim();
    if (model.length === 0) {
      return;
    }

    setCustomModelOpen(false);
    void configure({ model, effort: harness?.selectedEffort ?? null });
  };

  const toggleWebSearch = async () => {
    const enabled = !webSearchEnabled;
    setWebSearchEnabled(enabled);
    try {
      const result = await api.setCourseWebSearch(courseId, enabled);
      setWebSearchEnabled(result.enabled);
    } catch (error) {
      setWebSearchEnabled(course.webSearchEnabled);
      toast.error(
        error instanceof ApiError
          ? error.message
          : "Couldn’t update web search.",
      );
    }
  };

  const updateAttachment = useCallback(
    (id: string, update: Partial<ComposerAttachment>) => {
      setAttachments((current) =>
        current.map((attachment) =>
          attachment.id === id ? { ...attachment, ...update } : attachment,
        ),
      );
    },
    [],
  );

  const addFiles = useCallback((files: FileList | null) => {
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
  }, [updateAttachment]);

  useEffect(() => {
    registerFileDrop((files) => {
      if (!disabled && !sending) {
        addFiles(files);
      }
    });
    return () => registerFileDrop(null);
  }, [addFiles, disabled, sending, registerFileDrop]);

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
      <div className="relative rounded-md border border-input bg-card shadow-xs transition-[color,box-shadow] focus-within:border-ring focus-within:ring-[3px] focus-within:ring-ring/50">
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
          className="max-h-48 min-h-16 resize-none rounded-b-none border-0 bg-transparent px-3 pt-3 pb-2 text-[15pt] leading-[1.45] shadow-none focus-visible:border-transparent focus-visible:ring-0 md:text-[15pt] dark:bg-transparent"
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
        <div className="flex min-w-0 items-center justify-between gap-2 border-t border-input/50 px-2 py-2">
          <div className="flex min-w-0 flex-1 items-center gap-1.5">
            <Button
              type="button"
              size="icon"
              variant="ghost"
              aria-label="Attach images or files"
              disabled={disabled || sending}
              onClick={() => fileInputRef.current?.click()}
              className="size-8 rounded-full"
            >
              <Paperclip className="size-4" />
            </Button>

            <DropdownMenu
              onOpenChange={(open) => open && loadHarnesses(true)}
            >
              <DropdownMenuTrigger asChild>
                <Button
                  type="button"
                  size="sm"
                  variant="ghost"
                  aria-label="Choose teaching agent"
                  disabled={disabled || sending}
                  className="min-w-0 max-w-36 shrink rounded-full px-2.5 text-muted-foreground"
                >
                  <Bot className="size-4 shrink-0" />
                  <span className="min-w-0 truncate">
                    {harness?.name ?? "Agent"}
                  </span>
                  <ChevronDown className="size-3.5 shrink-0" />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="start" className="w-64">
                <DropdownMenuLabel>Teaching agent</DropdownMenuLabel>
                <DropdownMenuSeparator />
                {harnesses.map((option) => (
                  <DropdownMenuItem
                    key={option.id}
                    disabled={!option.installed}
                    onSelect={() => void chooseHarness(option.id)}
                  >
                    <span className="flex-1 truncate">{option.name}</span>
                    <span className="text-xs text-muted-foreground">
                      {option.selected
                        ? "Selected"
                        : !option.installed
                          ? "Not installed"
                          : !option.authenticated
                            ? "Not logged in"
                            : ""}
                    </span>
                  </DropdownMenuItem>
                ))}
              </DropdownMenuContent>
            </DropdownMenu>

            {harness && harness.models.length > 0 ? (
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <Button
                    type="button"
                    size="sm"
                    variant="ghost"
                    aria-label="Choose model and effort"
                    disabled={disabled || sending}
                    className="min-w-0 max-w-56 shrink rounded-full px-2.5 text-muted-foreground"
                  >
                    <Sparkles className="size-4 shrink-0" />
                    <span className="min-w-0 truncate">
                      {harness.models.find(
                        (model) => model.id === harness.selectedModel,
                      )?.label ?? harness.selectedModel ?? "Model"}
                      {harness.efforts.length > 0 && harness.selectedEffort ? (
                        <>
                          {" · "}
                          <span className="capitalize">
                            {harness.selectedEffort}
                          </span>
                        </>
                      ) : null}
                    </span>
                    <ChevronDown className="size-3.5 shrink-0" />
                  </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="start" className="w-52">
                  {harness.efforts.length === 0 ? (
                    <DropdownMenuRadioGroup value={harness.selectedModel ?? ""}>
                      {harness.models.map((model) => (
                        <DropdownMenuRadioItem
                          key={model.id}
                          value={model.id}
                          onSelect={() =>
                            void configure({
                              model: model.id,
                              effort: harness.selectedEffort,
                            })
                          }
                        >
                          {model.label}
                        </DropdownMenuRadioItem>
                      ))}
                    </DropdownMenuRadioGroup>
                  ) : (
                    harness.models.map((model) => (
                      <DropdownMenuSub key={model.id}>
                        <DropdownMenuSubTrigger className="relative pl-8">
                          <span className="pointer-events-none absolute left-2 flex size-3.5 items-center justify-center">
                            {model.id === harness.selectedModel ? (
                              <Check className="size-4" />
                            ) : null}
                          </span>
                          <span className="min-w-0 flex-1 truncate">
                            {model.label}
                          </span>
                        </DropdownMenuSubTrigger>
                        <DropdownMenuSubContent>
                          <DropdownMenuRadioGroup
                            value={
                              model.id === harness.selectedModel
                                ? (harness.selectedEffort ?? "")
                                : ""
                            }
                          >
                            {harness.efforts.map((effort) => (
                              <DropdownMenuRadioItem
                                key={effort}
                                value={effort}
                                className="capitalize"
                                onSelect={() =>
                                  void configure({ model: model.id, effort })
                                }
                              >
                                {effort}
                              </DropdownMenuRadioItem>
                            ))}
                          </DropdownMenuRadioGroup>
                        </DropdownMenuSubContent>
                      </DropdownMenuSub>
                    ))
                  )}
                  {harness.customModels ? (
                    <>
                      <DropdownMenuSeparator />
                      <DropdownMenuItem
                        className="relative pl-8"
                        onSelect={openCustomModel}
                      >
                        <span className="pointer-events-none absolute left-2 flex size-3.5 items-center justify-center">
                          {usingCustomModel ? <Check className="size-4" /> : null}
                        </span>
                        <span className="min-w-0 flex-1 truncate">
                          Custom model…
                        </span>
                      </DropdownMenuItem>
                    </>
                  ) : null}
                </DropdownMenuContent>
              </DropdownMenu>
            ) : null}

            <Tooltip>
              <TooltipTrigger asChild>
                {harness?.id !== "claude-code" ? (
                  <span
                    tabIndex={0}
                    className="inline-flex min-w-0 shrink rounded-full"
                  >
                    <Button
                      type="button"
                      size="sm"
                      variant="ghost"
                      aria-label="Web search unavailable"
                      disabled
                      className="min-w-0 max-w-28 shrink rounded-full px-2.5 text-muted-foreground"
                    >
                      <Globe className="size-4 shrink-0" />
                      <span className="min-w-0 truncate">Search</span>
                    </Button>
                  </span>
                ) : (
                  <Button
                    type="button"
                    size="sm"
                    variant={webSearchEnabled ? "secondary" : "ghost"}
                    aria-label="Toggle web search"
                    aria-pressed={webSearchEnabled}
                    disabled={disabled || sending}
                    onClick={() => void toggleWebSearch()}
                    className={cn(
                      "min-w-0 max-w-28 shrink rounded-full px-2.5",
                      !webSearchEnabled && "text-muted-foreground",
                    )}
                  >
                    <Globe className="size-4 shrink-0" />
                    <span className="min-w-0 truncate">Search</span>
                  </Button>
                )}
              </TooltipTrigger>
              <TooltipContent className="max-w-xs text-pretty">
                {harness?.id !== "claude-code"
                  ? "Web search is available with the Claude Code agent."
                  : webSearchEnabled && course.attachedDir
                    ? "The agent can access the web and your attached directory, which may expose attached data to external sites."
                    : "Lets the teaching agent search and fetch live web sources."}
              </TooltipContent>
            </Tooltip>
          </div>

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
            className="size-8 rounded-full"
          >
            <ArrowUp className="size-4" />
          </Button>
        </div>
      </div>

      <Dialog open={customModelOpen} onOpenChange={setCustomModelOpen}>
        <DialogContent className="sm:max-w-sm">
          <DialogHeader>
            <DialogTitle>Custom model</DialogTitle>
            <DialogDescription>
              Exact model id passed to {harness?.name ?? "the agent"} as-is. An
              id the harness doesn’t recognize will fail the next turn.
            </DialogDescription>
          </DialogHeader>
          <Input
            autoFocus
            value={customModelText}
            placeholder={harness?.defaultModel ?? "model-id"}
            onChange={(event) => setCustomModelText(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter") {
                event.preventDefault();
                submitCustomModel();
              }
            }}
          />
          <DialogFooter>
            <Button
              type="button"
              variant="ghost"
              onClick={() => setCustomModelOpen(false)}
            >
              Cancel
            </Button>
            <Button
              type="button"
              disabled={customModelText.trim().length === 0}
              onClick={submitCustomModel}
            >
              Use model
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </form>
  );
}

export function CourseScreen() {
  const { store, courseId, prependTranscript } = useCourseStore();
  const {
    harnesses,
    load: loadHarnesses,
    select: selectHarness,
  } = useCourseHarnesses(courseId);
  const [railOpen, setRailOpen] = useState(
    () => localStorage.getItem(RAIL_KEY) !== "closed",
  );
  const [railTab, setRailTab] = useState<RailTab>("journal");
  const [draggingFiles, setDraggingFiles] = useState(false);
  const dragDepth = useRef(0);
  const fileDropHandler = useRef<((files: FileList) => void) | null>(null);

  const registerFileDrop = useCallback(
    (handler: ((files: FileList) => void) | null) => {
      fileDropHandler.current = handler;
    },
    [],
  );

  useEffect(() => {
    // Stray-drop navigation is prevented globally in main.tsx; this only
    // resets the highlight when a drag ends outside the chat column.
    const clearFileDrag = () => {
      dragDepth.current = 0;
      setDraggingFiles(false);
    };

    window.addEventListener("drop", clearFileDrag);
    return () => {
      window.removeEventListener("drop", clearFileDrag);
    };
  }, []);

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
  const selectedHarness = harnesses.find((harness) => harness.selected);

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
        <HarnessPicker
          harnesses={harnesses}
          loadHarnesses={loadHarnesses}
          selectHarness={selectHarness}
          disabled={busy || ended}
        />
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
        <div
          className="relative flex min-w-0 flex-1 flex-col"
          onDragEnter={(event) => {
            if (!hasDraggedFiles(event.dataTransfer)) {
              return;
            }
            event.preventDefault();
            if (composerDisabled) {
              return;
            }
            dragDepth.current += 1;
            setDraggingFiles(true);
          }}
          onDragOver={(event) => {
            if (!hasDraggedFiles(event.dataTransfer)) {
              return;
            }
            event.preventDefault();
            if (composerDisabled) {
              return;
            }
            event.dataTransfer.dropEffect = "copy";
          }}
          onDragLeave={(event) => {
            if (!hasDraggedFiles(event.dataTransfer) || composerDisabled) {
              return;
            }
            event.preventDefault();
            dragDepth.current = Math.max(0, dragDepth.current - 1);
            if (dragDepth.current === 0) {
              setDraggingFiles(false);
            }
          }}
          onDrop={(event) => {
            if (!hasDraggedFiles(event.dataTransfer)) {
              return;
            }
            event.preventDefault();
            dragDepth.current = 0;
            setDraggingFiles(false);
            if (!composerDisabled) {
              fileDropHandler.current?.(event.dataTransfer.files);
            }
          }}
        >
          {draggingFiles ? (
            <div className="pointer-events-none absolute inset-0 z-10 bg-background/60">
              <div className="absolute inset-3 flex items-center justify-center rounded-lg border-2 border-dashed border-ring bg-card/80 text-sm font-medium text-foreground">
                Drop files to attach
              </div>
            </div>
          ) : null}
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
                  course={course}
                  harness={selectedHarness}
                  harnesses={harnesses}
                  loadHarnesses={loadHarnesses}
                  selectHarness={selectHarness}
                  disabled={composerDisabled}
                  placeholder={
                    busy
                      ? (store.statusMessage ?? "Preparing your next step…")
                      : "Ask, answer, or explore…"
                  }
                  registerFileDrop={registerFileDrop}
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
