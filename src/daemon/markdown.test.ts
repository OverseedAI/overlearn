import { describe, expect, test } from "bun:test";

import type { GlossaryEntry } from "../course";
import { parseDemoDirective, renderMarkdown } from "./markdown";

const glossaryEntry = (term: string): GlossaryEntry => ({
  term,
  def: `${term} definition.`,
  addedAt: "2026-01-01T00:00:00.000Z",
});

describe("renderMarkdown glossary linking", () => {
  test("links whole-word terms case-insensitively once per block", () => {
    const html = renderMarkdown(
      "State changes state, not stateful text.\n\nA STATE appears again.",
      {
        glossary: [glossaryEntry("state")],
      },
    );

    expect(html).toContain(
      '<span class="term" data-term="state" tabindex="0">State</span>',
    );
    expect(html).toContain(
      '<span class="term" data-term="state" tabindex="0">STATE</span>',
    );
    expect(html).toContain("stateful");
    expect(html.match(/class="term"/g)).toHaveLength(2);
  });

  test("does not link terms inside code blocks, inline code, or links", () => {
    const html = renderMarkdown(
      [
        "State outside.",
        "",
        "`State` and [State](https://example.com)",
        "",
        "```",
        "State",
        "```",
      ].join("\n"),
      {
        glossary: [glossaryEntry("State")],
      },
    );

    expect(html).toContain(
      '<span class="term" data-term="State" tabindex="0">State</span> outside.',
    );
    expect(html).toContain("<code>State</code>");
    expect(html).toContain(">State</a>");
    expect(html).toContain("<pre><code>State</code></pre>");
    expect(html.match(/class="term"/g)).toHaveLength(1);
  });
});

describe("renderMarkdown demo directives", () => {
  test("parses demo directives with optional quoted titles", () => {
    expect(parseDemoDirective(":::demo growth.html")).toEqual({
      ok: true,
      file: "growth.html",
    });

    expect(parseDemoDirective(':::demo growth.html "Growth curve"')).toEqual({
      ok: true,
      file: "growth.html",
      title: "Growth curve",
    });

    expect(parseDemoDirective("ordinary text")).toBeUndefined();
  });

  test("renders sandboxed demo iframes", () => {
    const html = renderMarkdown('Before\n\n:::demo growth.html "Growth curve"', {
      demoFiles: new Set(["growth.html"]),
    });

    expect(html).toContain("<p>Before</p>");
    expect(html).toContain('class="demo-card"');
    expect(html).toContain("Growth curve");
    expect(html).toContain('src="/demos/growth.html"');
    expect(html).toContain('sandbox="allow-scripts"');
    expect(html).not.toContain("allow-same-origin");
    expect(html).toContain('loading="lazy"');
  });

  test("renders visible warnings for missing or invalid demo files", () => {
    const missing = renderMarkdown(":::demo missing.html", {
      demoFiles: new Set(["growth.html"]),
    });
    expect(missing).toContain("Demo unavailable");
    expect(missing).toContain("Missing demo file: demos/missing.html");
    expect(missing).not.toContain("<iframe");

    const invalid = renderMarkdown(":::demo ../secret.html", {
      demoFiles: new Set(["growth.html"]),
    });
    expect(invalid).toContain("Invalid demo file");
    expect(invalid).not.toContain("<iframe");
  });
});
