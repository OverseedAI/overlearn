import { describe, expect, test } from "bun:test";

import type { LessonSnapshot } from "./lessons";
import { renderPage, type TopicNode } from "./ui";

const emptyLessons: LessonSnapshot = {
  lessons: [],
  selectedLessonId: undefined,
};

const renderEmptyPage = (
  status:
    | "waiting-for-agent"
    | "agent-working"
    | "agent-failed"
    | "wrapping-up"
    | "session-ended" = "agent-working",
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
    expect(html).toContain(
      '<a class="wordmark" href="/" aria-label="Homepage"><strong>overlearn</strong></a>',
    );
    expect(html).toContain('<h1 class="course-title">Display Title</h1>');
    expect(html).toContain(
      '<span id="topic-title" class="topic-title-text">Display Title</span>',
    );
  });

  test("renders the library shell, CRUD controls, and archived view entry", () => {
    const html = renderEmptyPage();

    expect(html).toContain('id="library-screen" class="library-screen"');
    expect(html).toContain('<h1 id="library-title">Course library</h1>');
    expect(html).toContain('id="course-library-list" class="course-card-grid"');
    expect(html).toContain('id="new-course"');
    expect(html).toContain('id="import-course"');
    expect(html).toContain('id="import-notice"');
    expect(html).toContain('id="library-course-form"');
    expect(html).toContain('name="title" type="text"');
    expect(html).toContain('name="description"');
    expect(html).toContain('name="harnessId"');
    expect(html).toContain('name="attachedDir"');
    expect(html).toContain('data-library-status="archived"');
    expect(html).toContain('id="back-to-library"');
  });

  test("wires library endpoints, history, and live SSE refreshes", () => {
    const html = renderEmptyPage();

    expect(html).toContain('requestJson("/api/harnesses")');
    expect(html).toContain('"/api/courses?status=" + encodeURIComponent(status)');
    expect(html).toContain('requestJson("/api/courses", {');
    expect(html).toContain('method: "POST"');
    expect(html).toContain('method: "PATCH"');
    expect(html).toContain('method: "DELETE"');
    expect(html).toContain('body: JSON.stringify({ status: "active" })');
    expect(html).toContain('history.pushState({ screen: "library" }');
    expect(html).toContain('location.href = "/?course="');
    expect(html).toContain('const libraryEvents = new EventSource("/api/events")');
    expect(html).toContain('libraryEvents.addEventListener("courses"');
    expect(html).toContain('libraryEvents.addEventListener("tool-write"');
    expect(html).toContain('libraryEvents.addEventListener("message"');
  });

  test("renders topic navigation in the header dropdown with mastery progress", () => {
    const topics: TopicNode[] = [
      {
        path: "intro",
        title: "Intro",
        current: true,
        children: [
          {
            path: "intro/details",
            title: "Details",
            current: false,
            children: [],
          },
        ],
      },
    ];
    const html = renderPage(
      "Display Title",
      [],
      emptyLessons,
      [],
      topics,
      [],
      [{ concept: "intro", score: 72, at: "2026-01-01T00:00:00.000Z" }],
      new Set(),
      undefined,
    );

    expect(html).toContain('id="topic-menu-button"');
    expect(html).toContain('aria-expanded="false"');
    expect(html).toContain(
      '<span id="topic-title" class="topic-title-text">Intro</span>',
    );
    expect(html).toContain(
      '<span id="topic-progress" class="topic-progress" aria-label="Mastery progress 1/2 · 72">1/2 · 72</span>',
    );
    expect(html).toContain('id="topic-menu" class="topic-menu"');
    expect(html).toContain('id="mastery-summary" class="mastery-summary"');
    expect(html).toContain("1/2 graded");
    expect(html).toContain("Weakest: intro (72)");
    expect(html).toContain('id="lesson-list" class="lesson-list"');
    expect(html).toContain('data-topic-path="intro"');
    expect(html).not.toContain("lesson-nav");
  });

  test("hides the harness picker outside orchestrated mode", () => {
    const html = renderEmptyPage();

    expect(html).toContain('id="harness-selector" class="harness-selector" hidden');
    expect(html).not.toContain('id="agent-activity"');
  });

  test("renders orchestrated harness picker states and activity skeleton", () => {
    const html = renderPage(
      "Display Title",
      [],
      emptyLessons,
      [],
      [],
      [],
      [],
      new Set(),
      undefined,
      "waiting-for-agent",
      true,
      {
        orchestrated: true,
        harnesses: [
          {
            id: "claude-code",
            name: "Claude Code",
            installed: true,
            authenticated: true,
            version: "1.2.3",
            selected: true,
          },
          {
            id: "codex",
            name: "Codex",
            installed: true,
            authenticated: false,
            selected: false,
          },
          {
            id: "gemini",
            name: "Gemini",
            installed: false,
            authenticated: false,
            selected: false,
          },
        ],
      },
    );

    expect(html).toContain('id="harness-selector" class="harness-selector"');
    expect(html).not.toContain('id="harness-selector" class="harness-selector" hidden');
    expect(html).toContain(
      '<span id="harness-selected-name" class="harness-selected-name">Claude Code</span>',
    );
    expect(html).toContain("Claude Code ✓");
    expect(html).toContain("Codex — not logged in");
    expect(html).toContain("Gemini — not installed");
    expect(html).toContain('data-harness-id="codex"');
    expect(html).toContain('title="Log in to Codex from your terminal." disabled');
    expect(html).toContain('id="agent-activity" class="entry agent-activity" hidden');
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

  test("renders the done learning control before the theme toggle", () => {
    const html = renderEmptyPage("waiting-for-agent", true);

    expect(html.indexOf('id="done-learning"')).toBeLessThan(
      html.indexOf('id="theme-toggle"'),
    );
    expect(html).toContain(">Done Learning</button>");
    expect(html).toContain('id="done-confirm"');
    expect(html).toContain("End session?");
  });

  test("renders wrapping-up status with disabled composer", () => {
    const html = renderEmptyPage("wrapping-up", true);

    expect(html).toContain("Agent is writing your wrap-up");
    expect(html).toContain(">Wrapping up…</button>");
    expect(html).toContain(
      'placeholder="Session is wrapping up — the agent is writing the summary"',
    );
  });

  test("renders agent failure status with retry-ready composer", () => {
    const html = renderEmptyPage("agent-failed", true);

    expect(html).toContain("Agent failed — you can submit again");
    expect(html).toContain('class="status-line failed"');
    expect(html).toContain('aria-label="Message the agent…"');
    expect(html).toContain('placeholder="Message the agent…"');
  });

  test("renders session-ended state without hiding transcript content", () => {
    const html = renderPage(
      "Display Title",
      [
        {
          role: "agent",
          text: "Final wrap-up is visible.",
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
      "session-ended",
      true,
    );

    expect(html).toContain("Session ended — the daemon has stopped");
    expect(html).toContain('id="session-ended" class="session-ended"');
    expect(html).toContain("Final wrap-up is visible.");
    expect(html).toContain(">Session ended</button>");
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
