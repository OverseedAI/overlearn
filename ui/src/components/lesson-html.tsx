import { useLayoutEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import DOMPurify from "dompurify";
import { DemoCard } from "@/components/demo-card";
import { PROSE } from "@/lib/markdown";
import { cn } from "@/lib/utils";

type DemoMount = {
  node: HTMLElement;
  file: string;
  title: string | undefined;
};

/**
 * Lesson HTML with interactive demo embeds. The daemon renders `:::demo`
 * directives as `<article data-demo-file>` shells; sanitization strips their
 * server-side iframe, and this component mounts a DemoCard into each shell so
 * demos stay behind the one sandboxed embed path.
 */
export function LessonHtml({
  html,
  courseId,
  className,
}: {
  html: string;
  courseId: number;
  className?: string;
}) {
  // Stable object identity: React re-applies dangerouslySetInnerHTML whenever
  // the wrapper object changes, which would wipe the hydrated demo mounts on
  // every re-render.
  const markup = useMemo(() => ({ __html: DOMPurify.sanitize(html) }), [html]);
  const containerRef = useRef<HTMLDivElement>(null);
  const [mounts, setMounts] = useState<DemoMount[]>([]);

  useLayoutEffect(() => {
    const container = containerRef.current;
    if (!container) {
      return;
    }

    const shells = Array.from(
      container.querySelectorAll<HTMLElement>("[data-demo-file]"),
    );
    setMounts(
      shells.flatMap((node) => {
        const file = node.getAttribute("data-demo-file");
        if (file === null || file.length === 0) {
          return [];
        }

        node.replaceChildren();
        node.className = "not-prose my-4";
        return [
          {
            node,
            file,
            title: node.getAttribute("data-demo-title") ?? undefined,
          },
        ];
      }),
    );
  }, [markup]);

  return (
    <>
      <div
        ref={containerRef}
        className={cn(PROSE, className)}
        dangerouslySetInnerHTML={markup}
      />
      {mounts.map((mount, index) =>
        createPortal(
          <DemoCard courseId={courseId} file={mount.file} title={mount.title} />,
          mount.node,
          `${mount.file}-${index}`,
        ),
      )}
    </>
  );
}
