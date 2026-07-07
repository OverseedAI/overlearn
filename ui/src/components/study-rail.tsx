import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { LessonHtml } from "@/components/lesson-html";
import type { GlossaryEntry, LessonSnapshot } from "@/lib/types";

export type RailTab = "lesson" | "glossary";

export function StudyRail({
  courseId,
  lessons,
  glossary,
  tab,
  onTabChange,
  selectedLessonId,
  onSelectLesson,
}: {
  courseId: number;
  lessons: LessonSnapshot;
  glossary: GlossaryEntry[];
  tab: RailTab;
  onTabChange: (tab: RailTab) => void;
  selectedLessonId: string | undefined;
  onSelectLesson: (id: string) => void;
}) {
  const sorted = [...lessons.lessons].sort(
    (a, b) => b.modifiedAtMs - a.modifiedAtMs,
  );
  const selected =
    sorted.find((lesson) => lesson.id === selectedLessonId) ?? sorted[0];

  return (
    <Tabs
      value={tab}
      onValueChange={(value) => onTabChange(value as RailTab)}
      className="flex h-full min-h-0 flex-col gap-0"
    >
      <div className="flex h-12 shrink-0 items-center border-b px-3">
        <TabsList className="w-full">
          <TabsTrigger value="lesson">Lesson</TabsTrigger>
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
        value="lesson"
        className="flex min-h-0 flex-1 flex-col data-[state=inactive]:hidden"
      >
        {sorted.length === 0 ? (
          <p className="px-4 py-6 text-sm text-muted-foreground">
            No lesson yet. The agent writes lessons here as you learn.
          </p>
        ) : (
          <>
            {sorted.length > 1 ? (
              <div className="shrink-0 border-b p-3">
                <Select
                  value={selected?.id ?? ""}
                  onValueChange={onSelectLesson}
                >
                  <SelectTrigger size="sm" className="w-full" aria-label="Lesson">
                    <SelectValue placeholder="Choose a lesson" />
                  </SelectTrigger>
                  <SelectContent>
                    {sorted.map((lesson) => (
                      <SelectItem key={lesson.id} value={lesson.id}>
                        {lesson.id}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            ) : null}
            <div className="min-h-0 flex-1 overflow-y-auto p-4">
              {selected ? (
                <LessonHtml html={selected.html} courseId={courseId} />
              ) : null}
            </div>
          </>
        )}
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
