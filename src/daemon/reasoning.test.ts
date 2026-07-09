import { describe, expect, test } from "bun:test";

import { splitLeadingLeakedThinking } from "./reasoning";

describe("agent reasoning text cleanup", () => {
  test("splits obvious leading self-talk from the learner-facing reply", () => {
    const result = splitLeadingLeakedThinking(
      [
        "Fresh course, no topics yet, and the learner just told me they have some school French. This is orientation - I need to calibrate and find an entry point before creating the first topic.",
        "",
        "Bienvenue ! Great that you have some background already.",
      ].join("\n"),
    );

    expect(result.thinking).toContain("Fresh course");
    expect(result.thinking).toContain("I need to calibrate");
    expect(result.text).toBe(
      "Bienvenue ! Great that you have some background already.",
    );
  });

  test("keeps ordinary mentor phrasing visible", () => {
    const text =
      "I need a little more context before we choose exercises. Where are you headed?";

    expect(splitLeadingLeakedThinking(text)).toEqual({
      thinking: "",
      text,
    });
  });

  test("only splits leading internal paragraphs", () => {
    const text = [
      "Let's start with one tiny example.",
      "",
      "The learner state is visible here, but this is not a leading scratchpad.",
    ].join("\n");

    expect(splitLeadingLeakedThinking(text)).toEqual({
      thinking: "",
      text,
    });
  });
});
