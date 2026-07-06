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

  test("uses a teaching stream with a collapsed Lesson/Glossary rail", () => {
    const html = renderEmptyPage();

    expect(html).toContain('class="stream-pane"');
    expect(html).toContain('id="study-rail" class="study-rail collapsed"');
    expect(html).toContain('data-rail-tab="lesson"');
    expect(html).toContain('data-rail-tab="glossary"');
    expect(html).not.toContain("view-tabs");
    expect(html).not.toContain("study-pane");
    expect(html).not.toContain("chat-pane");
  });

  test("renders lesson timeline cards with only the most recent expanded", () => {
    const lessons: LessonSnapshot = {
      selectedLessonId: "02-next",
      lessons: [
        {
          id: "01-intro",
          html: "<h1>Intro</h1><p>Intro body.</p>",
          modifiedAtMs: 1,
        },
        {
          id: "02-next",
          html: "<h2>Next step</h2><p>Next body.</p>",
          modifiedAtMs: 2,
        },
      ],
    };
    const html = renderPage(
      "Display Title",
      [
        {
          role: "agent",
          kind: "lesson",
          lesson: "01-intro",
          at: "2026-01-01T00:00:00.000Z",
        },
        {
          role: "agent",
          kind: "lesson",
          lesson: "02-next",
          at: "2026-01-01T00:01:00.000Z",
        },
      ],
      lessons,
      [],
      [],
      [],
      [],
      new Set(),
      undefined,
    );

    expect(html).toContain('class="entry lesson-card collapsed"');
    expect(html).toContain('class="entry lesson-card expanded"');
    expect(html).toContain('<span class="lesson-card-title">Intro</span>');
    expect(html).toContain('<span class="lesson-card-title">Next step</span>');
    expect(html).toContain(
      '<h1 class="lesson-card-derived-title" aria-hidden="true">Intro</h1><p>Intro body.</p>',
    );
    expect(html).toContain(
      '<h2 class="lesson-card-derived-title" aria-hidden="true">Next step</h2><p>Next body.</p>',
    );
    expect(html).toContain("<p>Intro body.</p>");
    expect(html).toContain("<p>Next body.</p>");
    expect(html).toContain('id="rail-lesson-01-intro"');
    expect(html).toContain('id="rail-lesson-02-next"');
    expect(html).toContain(
      '<div class="lesson-content rail-lesson-content prose"><h1>Intro</h1><p>Intro body.</p></div>',
    );
    expect(html).toContain(
      '<div class="lesson-content rail-lesson-content prose"><h2>Next step</h2><p>Next body.</p></div>',
    );
    expect(html.match(/<h1>Intro<\/h1>/g)).toHaveLength(1);
    expect(html.match(/<h2>Next step<\/h2>/g)).toHaveLength(1);
  });

  test("renders removed lesson timeline stubs", () => {
    const html = renderPage(
      "Display Title",
      [
        {
          role: "agent",
          kind: "lesson",
          lesson: "01-missing",
          at: "2026-01-01T00:00:00.000Z",
        },
      ],
      emptyLessons,
      [],
      [],
      [],
      [],
      new Set(),
      undefined,
    );

    expect(html).toContain("Lesson section removed");
    expect(html).toContain("Section removed. 01-missing is no longer available.");
  });

  test("renders Feynman check markers and learner check answers", () => {
    const html = renderPage(
      "Display Title",
      [
        {
          role: "agent",
          kind: "feynman-check",
          concept: "rule-of-72",
          prompt: "Explain **why** 72 works.",
          at: "2026-01-01T00:00:00.000Z",
        },
        {
          role: "learner",
          kind: "feynman-answer",
          concept: "rule-of-72",
          text: "It estimates doubling time.",
          at: "2026-01-01T00:01:00.000Z",
        },
      ],
      emptyLessons,
      [],
      [],
      [],
      [],
      new Set(),
      undefined,
    );

    expect(html).toContain('class="entry feynman-check-entry"');
    expect(html).toContain('<span class="concept-chip">rule-of-72</span>');
    expect(html).toContain("Explain <strong>why</strong> 72 works.");
    expect(html).toContain('class="entry learner feynman-answer-entry"');
    expect(html).toContain("You · Check answer");
    expect(html).toContain("It estimates doubling time.");
  });
});
