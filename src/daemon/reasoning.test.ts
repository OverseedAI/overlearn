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

  test("extracts screenshot-style planning from anywhere in a short reply", () => {
    const text = [
      "Great — we can turn your French background into a focused course.",
      "",
      "First, I need to run rebuild-course-state and inspect the draft-course payload before responding.",
      "",
      "What would you most like to be able to do in French?",
    ].join("\n");

    expect(splitLeadingLeakedThinking(text)).toEqual({
      thinking:
        "First, I need to run rebuild-course-state and inspect the draft-course payload before responding.",
      text: [
        "Great — we can turn your French background into a focused course.",
        "",
        "What would you most like to be able to do in French?",
      ].join("\n"),
    });
  });

  test("keeps normal course-drafting replies untouched", () => {
    const text = [
      "We'll shape the course around the situations you care about most.",
      "",
      "I need to understand your goal before I draft the first lesson. Is conversation, travel, or reading most important to you?",
    ].join("\n");

    expect(splitLeadingLeakedThinking(text)).toEqual({
      thinking: "",
      text,
    });
  });
});
