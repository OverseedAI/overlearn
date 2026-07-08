import { useEffect, useState, type KeyboardEvent } from "react";
import { toast } from "sonner";
import { CornerDownRight, Plus, Trash2 } from "lucide-react";
import { AppHeader } from "@/components/app-chrome";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";
import { Textarea } from "@/components/ui/textarea";
import { api } from "@/lib/api";
import { useCourseStore } from "@/lib/course-store";
import { Markdown } from "@/lib/markdown";
import { useRoute } from "@/lib/router";
import type { TopicNode, TopicTreeInput, TranscriptEntry } from "@/lib/types";
import { cn } from "@/lib/utils";

type EditableTopic = {
  id: string;
  title: string;
  summary: string;
  children: EditableTopic[];
};

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function makeTopic(): EditableTopic {
  return { id: crypto.randomUUID(), title: "New topic", summary: "", children: [] };
}

function toEditable(nodes: TopicNode[]): EditableTopic[] {
  return nodes.map((node) => ({
    id: crypto.randomUUID(),
    title: node.title,
    summary: node.body ?? "",
    children: toEditable(node.children),
  }));
}

function updateTopicField(
  nodes: EditableTopic[],
  id: string,
  patch: Partial<Pick<EditableTopic, "title" | "summary">>,
): EditableTopic[] {
  return nodes.map((node) =>
    node.id === id
      ? { ...node, ...patch }
      : { ...node, children: updateTopicField(node.children, id, patch) },
  );
}

function addChildTopic(nodes: EditableTopic[], parentId: string): EditableTopic[] {
  return nodes.map((node) =>
    node.id === parentId
      ? { ...node, children: [...node.children, makeTopic()] }
      : { ...node, children: addChildTopic(node.children, parentId) },
  );
}

function addSiblingTopic(nodes: EditableTopic[], siblingId: string): EditableTopic[] {
  const index = nodes.findIndex((node) => node.id === siblingId);
  if (index !== -1) {
    const next = [...nodes];
    next.splice(index + 1, 0, makeTopic());
    return next;
  }
  return nodes.map((node) => ({
    ...node,
    children: addSiblingTopic(node.children, siblingId),
  }));
}

function removeTopicNode(nodes: EditableTopic[], id: string): EditableTopic[] {
  return nodes
    .filter((node) => node.id !== id)
    .map((node) => ({ ...node, children: removeTopicNode(node.children, id) }));
}

function slugify(value: string): string {
  const base = value
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/(^-+|-+$)/g, "");
  return base.length > 0 ? base : "topic";
}

function buildTopicTree(nodes: EditableTopic[], parentPath: string): TopicTreeInput[] {
  const used = new Set<string>();
  const result: TopicTreeInput[] = [];

  for (const node of nodes) {
    const title = node.title.trim();
    if (title.length === 0) {
      continue;
    }

    const slug = slugify(title);
    let candidate = slug;
    let counter = 2;
    while (used.has(candidate)) {
      candidate = `${slug}-${counter}`;
      counter += 1;
    }
    used.add(candidate);

    const path = parentPath.length > 0 ? `${parentPath}/${candidate}` : candidate;
    const summary = node.summary.trim();
    const children = buildTopicTree(node.children, path);

    result.push({
      path,
      title,
      ...(summary.length > 0 ? { summary } : {}),
      ...(children.length > 0 ? { children } : {}),
    });
  }

  return result;
}

function transcriptRoleLabel(entry: TranscriptEntry): string {
  if (entry.role === "agent") {
    return "Agent";
  }
  if (entry.role === "learner") {
    return "You";
  }
  return "System";
}

function TranscriptEntryBody({ entry }: { entry: TranscriptEntry }) {
  if (entry.kind === "demo") {
    return (
      <p className="text-xs italic text-muted-foreground">
        Demo added: {entry.title ?? entry.file}
      </p>
    );
  }
  if (entry.kind === "lesson") {
    return (
      <p className="text-xs italic text-muted-foreground">Lesson updated.</p>
    );
  }
  if (entry.kind === "feynman-check") {
    return <Markdown text={entry.prompt} />;
  }
  if (entry.kind === "tool-call") {
    return <p className="text-xs italic text-muted-foreground">{entry.text}</p>;
  }
  // Remaining kinds are "feynman-answer" or the default learner/agent text
  // entry (kind undefined | "text"); both expose a plain `text` field.
  return <Markdown text={entry.text} />;
}

function TopicEditor({
  node,
  depth,
  onChange,
  onAddChild,
  onAddSibling,
  onRemove,
}: {
  node: EditableTopic;
  depth: number;
  onChange: (id: string, patch: Partial<Pick<EditableTopic, "title" | "summary">>) => void;
  onAddChild: (id: string) => void;
  onAddSibling: (id: string) => void;
  onRemove: (id: string) => void;
}) {
  return (
    <div className={cn("space-y-3", depth > 0 && "border-l pl-4")}>
      <div className="space-y-2 rounded-md border bg-muted/30 p-3">
        <div className="flex items-start gap-2">
          <div className="flex-1 space-y-2">
            <Label htmlFor={`topic-title-${node.id}`} className="sr-only">
              Topic title
            </Label>
            <Input
              id={`topic-title-${node.id}`}
              name="topicTitle"
              placeholder="Topic title"
              value={node.title}
              onChange={(event) => onChange(node.id, { title: event.target.value })}
            />
            <Label htmlFor={`topic-summary-${node.id}`} className="sr-only">
              Topic summary
            </Label>
            <Textarea
              id={`topic-summary-${node.id}`}
              name="topicSummary"
              rows={2}
              placeholder="Summary"
              value={node.summary}
              onChange={(event) =>
                onChange(node.id, { summary: event.target.value })
              }
            />
          </div>
          <div className="flex flex-col gap-1">
            <Button
              type="button"
              variant="ghost"
              size="icon-sm"
              aria-label="Add sub-topic"
              onClick={() => onAddChild(node.id)}
            >
              <CornerDownRight className="size-4 shrink-0" />
            </Button>
            <Button
              type="button"
              variant="ghost"
              size="icon-sm"
              aria-label="Add topic after"
              onClick={() => onAddSibling(node.id)}
            >
              <Plus className="size-4 shrink-0" />
            </Button>
            <Button
              type="button"
              variant="ghost"
              size="icon-sm"
              aria-label="Remove topic"
              onClick={() => onRemove(node.id)}
            >
              <Trash2 className="size-4 shrink-0" />
            </Button>
          </div>
        </div>
      </div>
      {node.children.map((child) => (
        <TopicEditor
          key={child.id}
          node={child}
          depth={depth + 1}
          onChange={onChange}
          onAddChild={onAddChild}
          onAddSibling={onAddSibling}
          onRemove={onRemove}
        />
      ))}
    </div>
  );
}

function Composer({ courseId, disabled }: { courseId: number; disabled: boolean }) {
  const [text, setText] = useState("");
  const [sending, setSending] = useState(false);

  const send = async () => {
    const trimmed = text.trim();
    if (trimmed.length === 0 || sending) {
      return;
    }
    setSending(true);
    try {
      await api.submit(courseId, trimmed);
      setText("");
    } catch (error) {
      toast.error(errorMessage(error));
    } finally {
      setSending(false);
    }
  };

  const handleKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      void send();
    }
  };

  return (
    <div className="flex items-end gap-2 border-t p-3">
      <Label htmlFor="wizard-reply" className="sr-only">
        Reply to agent
      </Label>
      <Textarea
        id="wizard-reply"
        name="reply"
        rows={2}
        className="flex-1"
        placeholder="Refine the goal, constraints, or pacing…"
        value={text}
        disabled={disabled || sending}
        onChange={(event) => setText(event.target.value)}
        onKeyDown={handleKeyDown}
      />
      <Button
        type="button"
        variant="secondary"
        size="sm"
        disabled={disabled || sending || text.trim().length === 0}
        onClick={() => void send()}
      >
        Send
      </Button>
    </div>
  );
}

export function WizardScreen() {
  const { navigate } = useRoute();
  const { store, courseId } = useCourseStore();
  const [localTitle, setLocalTitle] = useState("");
  const [localDescription, setLocalDescription] = useState("");
  const [localTopics, setLocalTopics] = useState<EditableTopic[]>([]);
  const [dirty, setDirty] = useState(false);
  const [accepting, setAccepting] = useState(false);
  const [discardOpen, setDiscardOpen] = useState(false);
  const [discarding, setDiscarding] = useState(false);

  const topics = store.state?.topics;
  const courseTitle = store.state?.course.title;
  const courseDescription = store.state?.course.description;

  useEffect(() => {
    if (dirty || topics === undefined) {
      return;
    }
    setLocalTitle(courseTitle ?? "");
    setLocalDescription(courseDescription ?? "");
    setLocalTopics(toEditable(topics));
  }, [dirty, topics, courseTitle, courseDescription]);

  if (store.loading) {
    return (
      <div className="flex flex-1 items-center justify-center">
        <Skeleton className="h-8 w-48" />
      </div>
    );
  }

  if (store.loadError !== undefined || store.state === undefined) {
    return (
      <div className="flex flex-1 items-center justify-center p-8">
        <p className="max-w-sm text-center text-sm text-pretty text-muted-foreground">
          {store.loadError ?? "This draft could not be loaded."}
        </p>
      </div>
    );
  }

  const transcript = store.state.transcript;
  const activity = store.activity;
  const busy = store.status === "agent-working";

  const handleTopicChange = (
    id: string,
    patch: Partial<Pick<EditableTopic, "title" | "summary">>,
  ) => {
    setDirty(true);
    setLocalTopics((prev) => updateTopicField(prev, id, patch));
  };

  const handleAddChild = (id: string) => {
    setDirty(true);
    setLocalTopics((prev) => addChildTopic(prev, id));
  };

  const handleAddSibling = (id: string) => {
    setDirty(true);
    setLocalTopics((prev) => addSiblingTopic(prev, id));
  };

  const handleRemove = (id: string) => {
    setDirty(true);
    setLocalTopics((prev) => removeTopicNode(prev, id));
  };

  const handleAddRoot = () => {
    setDirty(true);
    setLocalTopics((prev) => [...prev, makeTopic()]);
  };

  const handleAccept = async () => {
    const treeTopics = buildTopicTree(localTopics, "");
    if (treeTopics.length === 0) {
      toast.error("Add at least one topic before accepting.");
      return;
    }
    setAccepting(true);
    try {
      const body: Parameters<typeof api.acceptPlan>[1] = { topics: treeTopics };
      const title = localTitle.trim();
      const description = localDescription.trim();
      if (title.length > 0) {
        body.title = title;
      }
      if (description.length > 0) {
        body.description = description;
      }
      const result = await api.acceptPlan(courseId, body);
      navigate({ view: "course", courseId: result.course.id });
    } catch (error) {
      toast.error(errorMessage(error));
    } finally {
      setAccepting(false);
    }
  };

  const handleDiscard = async () => {
    if (discarding) {
      return;
    }
    setDiscarding(true);
    try {
      await api.deleteCourse(courseId);
      navigate({ view: "library" });
    } catch (error) {
      toast.error(errorMessage(error));
    } finally {
      setDiscarding(false);
    }
  };

  return (
    <>
      <AppHeader title={store.state.course.title || "Course plan review"}>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          onClick={() => setDiscardOpen(true)}
        >
          Discard draft
        </Button>
        <Button
          type="button"
          size="sm"
          disabled={accepting || localTopics.length === 0}
          onClick={() => void handleAccept()}
        >
          Accept plan
        </Button>
      </AppHeader>

      <div className="grid min-h-0 flex-1 grid-cols-1 grid-rows-[minmax(0,1fr)_minmax(0,1fr)] overflow-hidden lg:grid-cols-[1fr_1fr] lg:grid-rows-1">
        <section className="flex min-h-0 flex-col overflow-hidden border-b lg:border-r lg:border-b-0">
          <div className="flex-1 space-y-4 overflow-y-auto p-4">
            {transcript.length === 0 ? (
              <p className="text-sm text-muted-foreground">
                No ideation messages yet. Say what you want to learn below.
              </p>
            ) : (
              transcript.map((entry, index) => (
                <div key={index} className="space-y-1">
                  <p className="text-xs font-medium text-muted-foreground">
                    {transcriptRoleLabel(entry)}
                  </p>
                  <TranscriptEntryBody entry={entry} />
                </div>
              ))
            )}
            {activity && (activity.thinking.length > 0 || activity.text.length > 0) && (
              <div className="space-y-1">
                <p className="text-xs font-medium text-muted-foreground">Agent</p>
                {activity.thinking.length > 0 && (
                  <p className="line-clamp-1 text-xs italic text-muted-foreground">
                    {activity.thinking}
                  </p>
                )}
                {activity.text.length > 0 && <Markdown text={activity.text} />}
              </div>
            )}
          </div>
          <Composer courseId={courseId} disabled={busy} />
        </section>

        <section className="flex min-h-0 flex-col overflow-y-auto">
          <div className="space-y-3 border-b p-4">
            <div className="space-y-1.5">
              <Label htmlFor="wizard-title">Title</Label>
              <Input
                id="wizard-title"
                name="title"
                autoComplete="off"
                value={localTitle}
                onChange={(event) => {
                  setDirty(true);
                  setLocalTitle(event.target.value);
                }}
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="wizard-description">Description</Label>
              <Textarea
                id="wizard-description"
                name="description"
                rows={2}
                value={localDescription}
                onChange={(event) => {
                  setDirty(true);
                  setLocalDescription(event.target.value);
                }}
              />
            </div>
          </div>

          <div className="flex items-center justify-between px-4 pt-4">
            <div>
              <h3 className="text-sm font-medium">Topics</h3>
              <p className="text-xs text-muted-foreground">
                Edit, add, or remove topics before accepting.
              </p>
            </div>
            <Button type="button" variant="ghost" size="sm" onClick={handleAddRoot}>
              <Plus className="size-4 shrink-0" />
              Add topic
            </Button>
          </div>

          <div className="flex-1 space-y-3 p-4">
            {localTopics.length === 0 ? (
              <p className="text-sm text-muted-foreground">
                The agent has not proposed a course plan yet.
              </p>
            ) : (
              localTopics.map((node) => (
                <TopicEditor
                  key={node.id}
                  node={node}
                  depth={0}
                  onChange={handleTopicChange}
                  onAddChild={handleAddChild}
                  onAddSibling={handleAddSibling}
                  onRemove={handleRemove}
                />
              ))
            )}
          </div>
        </section>
      </div>

      <Dialog open={discardOpen} onOpenChange={setDiscardOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Discard draft?</DialogTitle>
            <DialogDescription>
              This permanently deletes this draft and its ideation
              conversation. This can’t be undone.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button
              type="button"
              variant="secondary"
              size="sm"
              onClick={() => setDiscardOpen(false)}
            >
              Cancel
            </Button>
            <Button
              type="button"
              variant="destructive"
              size="sm"
              disabled={discarding}
              onClick={() => void handleDiscard()}
            >
              Discard
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
