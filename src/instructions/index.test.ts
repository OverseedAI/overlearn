import { describe, expect, test } from "bun:test";

import {
  assembleInstructionModules,
  formatInstructions,
  formatInstructionsJson,
  resolveModule,
} from "./index";

describe("instructions", () => {
  test("resolves built-in modules", () => {
    expect(resolveModule("pedagogy")).toEqual({
      source: "builtin",
      content: expect.stringContaining("Ask ONE question at a time."),
    });
  });

  test("assembles modules with stable separators", () => {
    const text = formatInstructions();

    expect(text).toContain("## module: pedagogy");
    expect(text).toContain("## module: protocol");
    expect(text).toContain("## module: demos");
    expect(text).toContain("## module: grading");
    expect(text).toContain("learn wait <course>");
  });

  test("formats JSON with module metadata and assembled text", () => {
    const parsed = JSON.parse(formatInstructionsJson()) as {
      modules: readonly unknown[];
      text: string;
    };

    expect(parsed.modules).toHaveLength(assembleInstructionModules().length);
    expect(parsed.text).toContain("## module: pedagogy");
  });
});
