import { useState } from "react";
import { Maximize2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { api } from "@/lib/api";

/**
 * Interactive demo embed. The only place demo iframes are created — keeps the
 * sandbox policy and the course-scoped demo URL in one spot.
 */
export function DemoCard({
  courseId,
  file,
  title,
}: {
  courseId: number;
  file: string;
  title?: string | undefined;
}) {
  const [open, setOpen] = useState(false);
  const demoTitle = title ?? file;
  const demoUrl = api.demoUrl(courseId, file);

  return (
    <>
      <Card className="gap-0 overflow-hidden py-0">
        <CardHeader className="flex-row items-center gap-2 border-b px-4 py-3 [.border-b]:pb-3">
          <CardTitle className="flex-1 truncate text-sm font-medium">
            {demoTitle}
          </CardTitle>
          <Button
            type="button"
            variant="secondary"
            size="sm"
            onClick={() => setOpen(true)}
            className="shrink-0"
          >
            <Maximize2 className="size-4" />
            Open demo
          </Button>
        </CardHeader>
        <CardContent className="bg-muted/30 px-4 py-3">
          <p className="truncate text-xs text-muted-foreground">{file}</p>
        </CardContent>
      </Card>

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="grid h-[calc(100dvh-2rem)] max-h-[900px] w-[calc(100vw-2rem)] max-w-[1180px] grid-rows-[auto_minmax(0,1fr)] gap-0 overflow-hidden p-0 sm:max-w-[calc(100vw-2rem)]">
          <DialogHeader className="border-b px-5 py-4 pr-12">
            <DialogTitle className="truncate text-base">
              {demoTitle}
            </DialogTitle>
            <DialogDescription className="truncate">{file}</DialogDescription>
          </DialogHeader>
          <div className="min-h-0 bg-card">
            <iframe
              src={demoUrl}
              title={demoTitle}
              sandbox="allow-scripts"
              className="h-full w-full border-0 bg-card"
            />
          </div>
        </DialogContent>
      </Dialog>
    </>
  );
}
