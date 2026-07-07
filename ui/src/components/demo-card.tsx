import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
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

  return (
    <Card className="overflow-hidden py-0 gap-0">
      <CardHeader className="flex-row items-center gap-2 border-b px-4 py-3 [.border-b]:pb-3">
        <CardTitle className="flex-1 truncate text-sm font-medium">
          {title ?? file}
        </CardTitle>
        <Button
          type="button"
          variant="secondary"
          size="sm"
          onClick={() => setOpen((current) => !current)}
        >
          {open ? "Hide demo" : "Open demo"}
        </Button>
      </CardHeader>
      {open ? (
        <CardContent className="p-0">
          <iframe
            src={api.demoUrl(courseId, file)}
            title={title ?? file}
            sandbox="allow-scripts"
            className="h-96 w-full border-0 bg-card"
          />
        </CardContent>
      ) : null}
    </Card>
  );
}
