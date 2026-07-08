import {
  useCallback,
  useEffect,
  useMemo,
  useState,
  type FormEvent,
  type ReactNode,
} from "react";
import { toast } from "sonner";
import {
  Archive as ArchiveIcon,
  ArchiveRestore,
  Download,
  Inbox,
  MoreHorizontal,
  Plus,
  Sparkles,
  Upload,
} from "lucide-react";
import { AppHeader } from "@/components/app-chrome";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Textarea } from "@/components/ui/textarea";
import { api, subscribeEvents } from "@/lib/api";
import { useProfile } from "@/lib/profile";
import { useRoute } from "@/lib/router";
import type { CourseResource, HarnessSummary } from "@/lib/types";
import { cn } from "@/lib/utils";

function formatDate(iso: string): string {
  try {
    return new Intl.DateTimeFormat(undefined, { dateStyle: "medium" }).format(
      new Date(iso),
    );
  } catch {
    return iso;
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function slugify(value: string): string {
  const base = value
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/(^-+|-+$)/g, "");
  return base.length > 0 ? base : "course";
}

function downloadJson(data: unknown, filename: string): void {
  const blob = new Blob([JSON.stringify(data, null, 2)], {
    type: "application/json",
  });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  document.body.append(anchor);
  anchor.click();
  anchor.remove();
  URL.revokeObjectURL(url);
}

function EmptyState({
  message,
  action,
}: {
  message: string;
  action?: { label: string; onClick: () => void };
}) {
  return (
    <div className="flex flex-col items-center gap-3 rounded-lg border border-dashed py-16 text-center">
      <Inbox className="size-8 shrink-0 text-muted-foreground" />
      <p className="max-w-xs text-pretty text-sm text-muted-foreground">
        {message}
      </p>
      {action && (
        <Button type="button" variant="secondary" size="sm" onClick={action.onClick}>
          {action.label}
        </Button>
      )}
    </div>
  );
}

function CourseCard({
  course,
  navigable,
  onNavigate,
  menu,
}: {
  course: CourseResource;
  navigable: boolean;
  onNavigate: () => void;
  menu: ReactNode;
}) {
  return (
    <Card
      className={cn(
        "gap-3 py-4",
        navigable && "cursor-pointer transition-colors hover:bg-accent/40",
      )}
      role={navigable ? "button" : undefined}
      tabIndex={navigable ? 0 : undefined}
      onClick={navigable ? onNavigate : undefined}
      onKeyDown={
        navigable
          ? (event) => {
              if (event.key === "Enter" || event.key === " ") {
                event.preventDefault();
                onNavigate();
              }
            }
          : undefined
      }
    >
      <CardHeader className="gap-1.5 px-4">
        <div className="flex items-start justify-between gap-2">
          <CardTitle className="truncate text-sm">{course.title}</CardTitle>
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button
                type="button"
                variant="ghost"
                size="icon-sm"
                aria-label="Course actions"
                onClick={(event) => event.stopPropagation()}
              >
                <MoreHorizontal className="size-4 shrink-0" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">{menu}</DropdownMenuContent>
          </DropdownMenu>
        </div>
        <CardDescription className="line-clamp-2 text-pretty">
          {course.description && course.description.trim().length > 0
            ? course.description
            : "No description yet."}
        </CardDescription>
      </CardHeader>
      <CardContent className="flex items-center justify-between px-4 text-xs text-muted-foreground">
        <span>Updated {formatDate(course.updatedAt)}</span>
        <Badge variant="outline">{course.status}</Badge>
      </CardContent>
    </Card>
  );
}

function NewCourseDialog({
  open,
  onOpenChange,
  defaultHarness,
  onCreated,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  defaultHarness: string | undefined;
  onCreated: (course: CourseResource) => void;
}) {
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [attachedDir, setAttachedDir] = useState("");
  const [harnessId, setHarnessId] = useState<string | undefined>(defaultHarness);
  const [harnesses, setHarnesses] = useState<HarnessSummary[]>([]);
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    if (!open) {
      return;
    }
    let cancelled = false;
    api
      .listHarnesses({ scope: "profile" })
      .then((list) => {
        if (!cancelled) {
          setHarnesses(list);
        }
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [open]);

  const handleSubmit = async (event: FormEvent) => {
    event.preventDefault();
    const trimmedTitle = title.trim();
    if (trimmedTitle.length === 0 || submitting) {
      return;
    }
    setSubmitting(true);
    try {
      const body: Parameters<typeof api.createCourse>[0] = {
        title: trimmedTitle,
      };
      if (description.trim().length > 0) {
        body.description = description.trim();
      }
      if (attachedDir.trim().length > 0) {
        body.attachedDir = attachedDir.trim();
      }
      if (harnessId !== undefined) {
        body.harnessId = harnessId;
      }
      const course = await api.createCourse(body);
      onCreated(course);
    } catch (error) {
      toast.error(errorMessage(error));
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>New course</DialogTitle>
          <DialogDescription>
            Start a course from scratch. You can attach a project folder for
            context.
          </DialogDescription>
        </DialogHeader>
        <form className="space-y-4" onSubmit={(event) => void handleSubmit(event)}>
          <div className="space-y-1.5">
            <Label htmlFor="new-course-title">Title</Label>
            <Input
              id="new-course-title"
              name="title"
              autoComplete="off"
              required
              value={title}
              onChange={(event) => setTitle(event.target.value)}
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="new-course-description">Description</Label>
            <Textarea
              id="new-course-description"
              name="description"
              rows={3}
              value={description}
              onChange={(event) => setDescription(event.target.value)}
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="new-course-harness">Harness</Label>
            <Select
              value={harnessId ?? "__default__"}
              onValueChange={(value) =>
                setHarnessId(value === "__default__" ? undefined : value)
              }
            >
              <SelectTrigger id="new-course-harness" className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="__default__">Use default agent</SelectItem>
                {harnesses.map((harness) => (
                  <SelectItem key={harness.id} value={harness.id}>
                    {harness.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="new-course-attached-dir">Attached folder</Label>
            <Input
              id="new-course-attached-dir"
              name="attachedDir"
              autoComplete="off"
              placeholder="/path/to/project"
              value={attachedDir}
              onChange={(event) => setAttachedDir(event.target.value)}
            />
          </div>
          <DialogFooter>
            <Button
              type="button"
              variant="secondary"
              size="sm"
              onClick={() => onOpenChange(false)}
            >
              Cancel
            </Button>
            <Button
              type="submit"
              size="sm"
              disabled={submitting || title.trim().length === 0}
            >
              Create course
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function ImportDialog({
  open,
  onOpenChange,
  onImported,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onImported: (courseId: number) => void;
}) {
  const [path, setPath] = useState("");
  const [submitting, setSubmitting] = useState(false);

  const handleSubmit = async (event: FormEvent) => {
    event.preventDefault();
    const trimmed = path.trim();
    if (trimmed.length === 0 || submitting) {
      return;
    }
    setSubmitting(true);
    try {
      const result = await api.importCourse(trimmed);
      if (result.warnings.length > 0) {
        toast.warning(result.warnings.join("\n"));
      }
      onImported(result.courseId);
    } catch (error) {
      toast.error(errorMessage(error));
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Import course</DialogTitle>
          <DialogDescription>
            Import a course previously exported to a folder on disk.
          </DialogDescription>
        </DialogHeader>
        <form className="space-y-4" onSubmit={(event) => void handleSubmit(event)}>
          <div className="space-y-1.5">
            <Label htmlFor="import-course-path">Folder path</Label>
            <Input
              id="import-course-path"
              name="path"
              autoComplete="off"
              required
              placeholder="/home/hal/courses/example"
              value={path}
              onChange={(event) => setPath(event.target.value)}
            />
          </div>
          <DialogFooter>
            <Button
              type="button"
              variant="secondary"
              size="sm"
              onClick={() => onOpenChange(false)}
            >
              Cancel
            </Button>
            <Button
              type="submit"
              size="sm"
              disabled={submitting || path.trim().length === 0}
            >
              Import course
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function BrainstormDialog({
  open,
  onOpenChange,
  onStarted,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onStarted: (courseId: number) => void;
}) {
  const [seed, setSeed] = useState("");
  const [submitting, setSubmitting] = useState(false);

  const handleSubmit = async (event: FormEvent) => {
    event.preventDefault();
    const trimmed = seed.trim();
    if (trimmed.length === 0 || submitting) {
      return;
    }
    setSubmitting(true);
    try {
      const result = await api.createCourseFromSeed(trimmed);
      onStarted(result.course.id);
    } catch (error) {
      toast.error(errorMessage(error));
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Brainstorm with your agent</DialogTitle>
          <DialogDescription>
            Describe what you want to learn and your agent will start teaching
            from that seed.
          </DialogDescription>
        </DialogHeader>
        <form className="space-y-4" onSubmit={(event) => void handleSubmit(event)}>
          <div className="space-y-1.5">
            <Label htmlFor="brainstorm-seed">What do you want to learn?</Label>
            <Textarea
              id="brainstorm-seed"
              name="seed"
              rows={4}
              required
              placeholder="I want to understand how databases work well enough to design one for my app."
              value={seed}
              onChange={(event) => setSeed(event.target.value)}
            />
          </div>
          <DialogFooter>
            <Button
              type="button"
              variant="secondary"
              size="sm"
              onClick={() => onOpenChange(false)}
            >
              Cancel
            </Button>
            <Button
              type="submit"
              size="sm"
              disabled={submitting || seed.trim().length === 0}
            >
              Start course
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function ExportDialog({
  course,
  onOpenChange,
}: {
  course: CourseResource | undefined;
  onOpenChange: (open: boolean) => void;
}) {
  const [includeTranscript, setIncludeTranscript] = useState(false);
  const [exporting, setExporting] = useState(false);

  const handleExport = async () => {
    if (course === undefined || exporting) {
      return;
    }
    setExporting(true);
    try {
      const data = await api.exportCourse(course.id, includeTranscript);
      downloadJson(data, `${slugify(course.title)}.json`);
      onOpenChange(false);
    } catch (error) {
      toast.error(errorMessage(error));
    } finally {
      setExporting(false);
    }
  };

  return (
    <Dialog open={course !== undefined} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Export course</DialogTitle>
          <DialogDescription>
            Downloads a JSON snapshot of “{course?.title ?? ""}”.
          </DialogDescription>
        </DialogHeader>
        <div className="flex items-center gap-2">
          <input
            id="export-include-transcript"
            name="includeTranscript"
            type="checkbox"
            className="size-4 rounded border-input"
            checked={includeTranscript}
            onChange={(event) => setIncludeTranscript(event.target.checked)}
          />
          <Label htmlFor="export-include-transcript">
            Include transcript
          </Label>
        </div>
        <DialogFooter>
          <Button
            type="button"
            variant="secondary"
            size="sm"
            onClick={() => onOpenChange(false)}
          >
            Cancel
          </Button>
          <Button
            type="button"
            size="sm"
            disabled={exporting}
            onClick={() => void handleExport()}
          >
            <Download className="size-4 shrink-0" />
            Export
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export function LibraryScreen() {
  const { navigate } = useRoute();
  const { profile } = useProfile();
  const [courses, setCourses] = useState<CourseResource[] | undefined>(undefined);
  const [tab, setTab] = useState<"active" | "archived">("active");
  const [newCourseOpen, setNewCourseOpen] = useState(false);
  const [importOpen, setImportOpen] = useState(false);
  const [brainstormOpen, setBrainstormOpen] = useState(false);
  const [exportCourseId, setExportCourseId] = useState<number | undefined>(
    undefined,
  );

  const refresh = useCallback(() => {
    api
      .listCourses()
      .then(setCourses)
      .catch((error: unknown) => toast.error(errorMessage(error)));
  }, []);

  useEffect(() => {
    refresh();
    const unsubscribe = subscribeEvents({
      courses: (payload) => setCourses(payload.courses),
    });
    return unsubscribe;
  }, [refresh]);

  const active = useMemo(
    () => (courses ?? []).filter((course) => course.status === "active"),
    [courses],
  );
  const archived = useMemo(
    () => (courses ?? []).filter((course) => course.status === "archived"),
    [courses],
  );

  const exportCourse = courses?.find((course) => course.id === exportCourseId);

  const handleArchive = async (courseId: number) => {
    try {
      await api.deleteCourse(courseId);
      refresh();
    } catch (error) {
      toast.error(errorMessage(error));
    }
  };

  const handleUnarchive = async (courseId: number) => {
    try {
      await api.patchCourse(courseId, { status: "active" });
      refresh();
    } catch (error) {
      toast.error(errorMessage(error));
    }
  };

  const loading = courses === undefined;

  return (
    <>
      <AppHeader title="Library">
        <Button
          type="button"
          variant="secondary"
          size="sm"
          onClick={() => setImportOpen(true)}
        >
          <Upload className="size-4 shrink-0" />
          Import
        </Button>
        <Button
          type="button"
          variant="secondary"
          size="sm"
          onClick={() => setBrainstormOpen(true)}
        >
          <Sparkles className="size-4 shrink-0" />
          Brainstorm
        </Button>
        <Button type="button" size="sm" onClick={() => setNewCourseOpen(true)}>
          <Plus className="size-4 shrink-0" />
          New course
        </Button>
      </AppHeader>

      <div className="min-h-0 flex-1 overflow-y-auto p-6">
        <div className="mx-auto max-w-5xl space-y-8">
          <Tabs value={tab} onValueChange={(value) => setTab(value as "active" | "archived")}>
            <TabsList>
              <TabsTrigger value="active">Active</TabsTrigger>
              <TabsTrigger value="archived">Archived</TabsTrigger>
            </TabsList>
            <TabsContent value="active" className="mt-4">
              {loading ? (
                <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
                  {[0, 1, 2].map((key) => (
                    <Skeleton key={key} className="h-32 rounded-xl" />
                  ))}
                </div>
              ) : active.length === 0 ? (
                <EmptyState
                  message="No active courses yet. Create one to get started."
                  action={{
                    label: "New course",
                    onClick: () => setNewCourseOpen(true),
                  }}
                />
              ) : (
                <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
                  {active.map((course) => (
                    <CourseCard
                      key={course.id}
                      course={course}
                      navigable
                      onNavigate={() =>
                        navigate({ view: "course", courseId: course.id })
                      }
                      menu={
                        <>
                          <DropdownMenuItem
                            onSelect={() => setExportCourseId(course.id)}
                          >
                            <Download className="size-4 shrink-0" />
                            Export
                          </DropdownMenuItem>
                          <DropdownMenuItem
                            onSelect={() => void handleArchive(course.id)}
                          >
                            <ArchiveIcon className="size-4 shrink-0" />
                            Archive
                          </DropdownMenuItem>
                        </>
                      }
                    />
                  ))}
                </div>
              )}
            </TabsContent>
            <TabsContent value="archived" className="mt-4">
              {loading ? (
                <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
                  {[0, 1, 2].map((key) => (
                    <Skeleton key={key} className="h-32 rounded-xl" />
                  ))}
                </div>
              ) : archived.length === 0 ? (
                <EmptyState message="No archived courses." />
              ) : (
                <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
                  {archived.map((course) => (
                    <CourseCard
                      key={course.id}
                      course={course}
                      navigable={false}
                      onNavigate={() => undefined}
                      menu={
                        <DropdownMenuItem
                          onSelect={() => void handleUnarchive(course.id)}
                        >
                          <ArchiveRestore className="size-4 shrink-0" />
                          Unarchive
                        </DropdownMenuItem>
                      }
                    />
                  ))}
                </div>
              )}
            </TabsContent>
          </Tabs>
        </div>
      </div>

      <NewCourseDialog
        open={newCourseOpen}
        onOpenChange={setNewCourseOpen}
        defaultHarness={profile?.preferredHarness ?? undefined}
        onCreated={(course) => {
          setNewCourseOpen(false);
          refresh();
          navigate({ view: "course", courseId: course.id });
        }}
      />
      <ImportDialog
        open={importOpen}
        onOpenChange={setImportOpen}
        onImported={(courseId) => {
          setImportOpen(false);
          refresh();
          navigate({ view: "course", courseId });
        }}
      />
      <BrainstormDialog
        open={brainstormOpen}
        onOpenChange={setBrainstormOpen}
        onStarted={(courseId) => {
          setBrainstormOpen(false);
          refresh();
          navigate({ view: "course", courseId });
        }}
      />
      <ExportDialog
        course={exportCourse}
        onOpenChange={(open) => {
          if (!open) {
            setExportCourseId(undefined);
          }
        }}
      />
    </>
  );
}
