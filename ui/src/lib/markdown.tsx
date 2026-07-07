import { useMemo } from "react";
import { marked } from "marked";
import DOMPurify from "dompurify";
import { cn } from "./utils";

marked.setOptions({ gfm: true, breaks: true });

const PROSE =
  "prose prose-sm dark:prose-invert max-w-none " +
  "prose-headings:font-semibold prose-pre:rounded-lg " +
  "prose-code:before:content-none prose-code:after:content-none";

export function renderMarkdown(text: string): string {
  return DOMPurify.sanitize(marked.parse(text, { async: false }));
}

/** Render agent/learner markdown text. */
export function Markdown({
  text,
  className,
}: {
  text: string;
  className?: string;
}) {
  const html = useMemo(() => renderMarkdown(text), [text]);
  return (
    <div
      className={cn(PROSE, className)}
      dangerouslySetInnerHTML={{ __html: html }}
    />
  );
}

/** Render daemon-prerendered HTML (lessons) with the same prose styling. */
export function ProseHtml({
  html,
  className,
}: {
  html: string;
  className?: string;
}) {
  const safe = useMemo(() => DOMPurify.sanitize(html), [html]);
  return (
    <div
      className={cn(PROSE, className)}
      dangerouslySetInnerHTML={{ __html: safe }}
    />
  );
}
