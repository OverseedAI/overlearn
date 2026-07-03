import { describe, expect, test } from "bun:test";

import type { TopicNode } from "../course";
import type { LessonSnapshot } from "./lessons";
import { renderPage } from "./ui";

const emptyLessons: LessonSnapshot = {
  lessons: [],
  selectedLessonId: undefined,
};

const renderEmptyPage = (
  status: "waiting-for-agent" | "agent-working" = "agent-working",
  hasSeenWait = false,
): string =>
  renderPage(
    "Display Title",
    [],
    emptyLessons,
    [],
    [],
    [],
    [],
    new Set(),
    undefined,
    status,
    hasSeenWait,
  );

describe("renderPage", () => {
  test("uses the display title in the document title and header", () => {
    const html = renderEmptyPage();

    expect(html).toContain("<title>Display Title - overlearn</title>");
    expect(html).toContain("<h1>Display Title</h1>");
  });

  test("renders initial status and composer affordance before any wait", () => {
    const html = renderEmptyPage("agent-working", false);

    expect(html).toContain("Waiting for the agent to start teaching");
    expect(html).toContain(
      'aria-label="The agent is teaching — you can reply when it pauses"',
    );
    expect(html).toContain(
      'placeholder="The agent is teaching — you can reply when it pauses"',
    );
  });

  test("renders learner turn status and enabled composer copy", () => {
    const html = renderEmptyPage("waiting-for-agent", true);

    expect(html).toContain("Your turn — the agent is waiting");
    expect(html).toContain('aria-label="Message the agent…"');
    expect(html).toContain('placeholder="Message the agent…"');
  });

  test("renders ungraded mastery chips as muted em dashes", () => {
    const topic: TopicNode = {
      path: "intro",
      title: "Intro",
      current: false,
      children: [],
    };
    const html = renderPage(
      "Display Title",
      [],
      emptyLessons,
      [],
      [topic],
      [],
      [],
      new Set(),
      undefined,
    );

    expect(html).toContain(
      '<span class="mastery-chip" aria-label="not graded yet">—</span>',
    );
    expect(html).not.toContain(">--</span>");
  });

  test("includes a compact inline SVG favicon", () => {
    const html = renderEmptyPage();

    expect(html).toContain('rel="icon"');
    expect(html).toContain("data:image/svg+xml,");
  });
});
