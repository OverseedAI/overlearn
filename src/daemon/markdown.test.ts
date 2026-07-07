import { describe, expect, test } from "bun:test";

import { parseDemoDirective, renderMarkdown, type GlossaryEntry } from "./markdown";

const glossaryEntry = (term: string): GlossaryEntry => ({
  term,
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
    expect(html).toContain('title="Expand">Expand</button>');
    expect(html).toContain('title="Open in tab">Open in tab</a>');
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

describe("renderMarkdown blockquotes", () => {
  test("renders a single line blockquote", () => {
    expect(renderMarkdown("> quoted text")).toBe(
      "<blockquote>quoted text</blockquote>",
    );
  });

  test("renders consecutive quoted lines as one blockquote", () => {
    expect(renderMarkdown("> first\n>second")).toBe(
      "<blockquote>first<br>second</blockquote>",
    );
  });

  test("renders nested quote markers as text", () => {
    expect(renderMarkdown("> > nested")).toBe(
      "<blockquote>&gt; nested</blockquote>",
    );
  });

  test("renders inline formatting inside blockquotes", () => {
    const html = renderMarkdown(
      "> A **State** with `code` and [docs](https://example.com)",
      {
        glossary: [glossaryEntry("State")],
      },
    );

    expect(html).toContain("<strong>");
    expect(html).toContain("</strong>");
    expect(html).toContain("<code>code</code>");
    expect(html).toContain(
      '<a href="https://example.com/" rel="noreferrer" target="_blank">docs</a>',
    );
    expect(html).toContain('class="term"');
    expect(html).toContain(">State</span>");
  });

  test("keeps blockquotes adjacent to tables and lists as separate blocks", () => {
    const html = renderMarkdown(
      [
        "> table note",
        "| Thing | Value |",
        "| --- | --- |",
        "| A | 1 |",
        "> list note",
        "- alpha",
        "- beta",
      ].join("\n"),
    );

    expect(html).toBe(
      '<blockquote>table note</blockquote><div class="table-wrap"><table><thead><tr><th scope="col">Thing</th><th scope="col">Value</th></tr></thead><tbody><tr><td>A</td><td>1</td></tr></tbody></table></div><blockquote>list note</blockquote><ul><li>alpha</li><li>beta</li></ul>',
    );
  });
});
