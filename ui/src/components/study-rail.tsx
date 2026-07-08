import { ExternalLink, FileText } from "lucide-react";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { api } from "@/lib/api";
import { Markdown } from "@/lib/markdown";
import type { GlossaryEntry, TopicJournalEntry, TopicNode } from "@/lib/types";

export type RailTab = "journal" | "glossary";

function JournalEntryLine({
  courseId,
  entry,
}: {
  courseId: number;
  entry: TopicJournalEntry;
}) {
  if (entry.kind === "demo") {
    const demo = entry.demo;
    const title =
      demo?.title ?? demo?.fileName ?? demo?.file ?? `Demo ${entry.demoId ?? ""}`;

    return (
      <div className="px-4 py-3">
        {demo === null || demo === undefined ? (
          <p className="text-sm text-muted-foreground">{title}</p>
        ) : (
          <a
            href={api.demoUrl(courseId, demo.file)}
            target="_blank"
            rel="noreferrer"
            className="flex min-w-0 items-center gap-2 rounded-md px-2 py-1.5 text-sm font-medium hover:bg-accent"
          >
            <ExternalLink className="size-4 shrink-0 text-muted-foreground" />
            <span className="truncate">{title}</span>
          </a>
        )}
      </div>
    );
  }

  const isSummary = entry.kind === "summary";

  return (
    <div
      className={
        isSummary
          ? "border-l-2 border-primary/60 bg-muted/40 px-4 py-3"
          : "px-4 py-3"
      }
    >
      {isSummary ? (
        <p className="mb-2 flex items-center gap-2 text-sm font-medium">
          <FileText className="size-4 shrink-0 text-primary" />
          Topic summary
        </p>
      ) : null}
      <Markdown
        text={entry.bodyMarkdown ?? ""}
        className="text-sm text-pretty"
      />
    </div>
  );
}

function JournalRail({
  courseId,
  topic,
}: {
  courseId: number;
  topic: TopicNode | undefined;
}) {
  const journal = topic?.journal;
  const entries = journal?.entries ?? [];

  if (entries.length === 0) {
    return (
      <p className="px-4 py-6 text-sm text-pretty text-muted-foreground">
        No notes yet — the mentor writes study notes here as you explore this
        topic.
      </p>
    );
  }

  return (
    <div className="min-h-0 flex-1 overflow-y-auto">
      <div className="border-b px-4 py-3">
        <h2 className="truncate text-sm font-medium">
          {topic?.title ?? "Topic journal"}
        </h2>
      </div>
      <div className="divide-y">
        {entries.map((entry) => (
          <JournalEntryLine
            key={entry.id}
            courseId={courseId}
            entry={entry}
          />
        ))}
      </div>
    </div>
  );
}

export function StudyRail({
  courseId,
  topic,
  glossary,
  tab,
  onTabChange,
}: {
  courseId: number;
  topic: TopicNode | undefined;
  glossary: GlossaryEntry[];
  tab: RailTab;
  onTabChange: (tab: RailTab) => void;
}) {
  const noteCount = topic?.journal.totalCount ?? 0;

  return (
    <Tabs
      value={tab}
      onValueChange={(value) => onTabChange(value as RailTab)}
      className="flex h-full min-h-0 flex-col gap-0"
    >
      <div className="flex h-12 shrink-0 items-center border-b px-3">
        <TabsList className="w-full">
          <TabsTrigger value="journal">
            Journal
            {noteCount > 0 ? (
              <span className="text-muted-foreground tabular-nums">
                {noteCount}
              </span>
            ) : null}
          </TabsTrigger>
          <TabsTrigger value="glossary">
            Glossary
            {glossary.length > 0 ? (
              <span className="text-muted-foreground tabular-nums">
                {glossary.length}
              </span>
            ) : null}
          </TabsTrigger>
        </TabsList>
      </div>

      <TabsContent
        value="journal"
        className="flex min-h-0 flex-1 flex-col data-[state=inactive]:hidden"
      >
        <JournalRail courseId={courseId} topic={topic} />
      </TabsContent>

      <TabsContent
        value="glossary"
        className="min-h-0 flex-1 overflow-y-auto data-[state=inactive]:hidden"
      >
        {glossary.length === 0 ? (
          <p className="px-4 py-6 text-sm text-muted-foreground">
            No terms yet. The agent adds glossary entries as they come up.
          </p>
        ) : (
          <dl className="divide-y">
            {glossary.map((entry) => (
              <div key={entry.term} className="px-4 py-3">
                <dt className="text-sm font-medium">{entry.term}</dt>
                <dd className="mt-0.5 text-sm text-pretty text-muted-foreground">
                  {entry.def}
                </dd>
              </div>
            ))}
          </dl>
        )}
      </TabsContent>
    </Tabs>
  );
}
