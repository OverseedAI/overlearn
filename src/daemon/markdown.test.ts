import { describe, expect, test } from "bun:test";

import type { GlossaryEntry } from "../course";
import { renderMarkdown } from "./markdown";

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
