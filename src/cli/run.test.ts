import { describe, expect, test } from "bun:test";

import { parseCli, runCli } from "./run";

describe("runCli", () => {
  test("prints the package version", () => {
    expect(runCli(["--version"], "1.2.3")).toEqual({
      exitCode: 0,
      stdout: "1.2.3",
    });
  });

  test("prints help for an empty invocation", () => {
    const result = runCli([], "1.2.3");

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("learn say [name] --text <markdown>");
    expect(result.stdout).toContain("learn instructions [name] [--json]");
    expect(result.stdout).toContain("learn status [name] --json");
    expect(result.stdout).toContain("learn emit glossary [name]");
    expect(result.stdout).toContain("learn --help");
    expect(result.stdout).toContain("learn --version");
  });

  test("parses start, wait, and say commands", () => {
    expect(parseCli(["start", "demo"], "1.2.3")).toEqual({
      kind: "start",
      name: "demo",
    });

    expect(parseCli(["wait"], "1.2.3")).toEqual({
      kind: "wait",
    });

    expect(parseCli(["say", "demo", "--text", "**hello**"], "1.2.3")).toEqual({
      kind: "say",
      name: "demo",
      source: { kind: "text", text: "**hello**" },
    });

    expect(parseCli(["say", "--file", "reply.md"], "1.2.3")).toEqual({
      kind: "say",
      source: { kind: "file", path: "reply.md" },
    });
  });

  test("parses instructions and status commands", () => {
    expect(parseCli(["instructions"], "1.2.3")).toEqual({
      kind: "instructions",
      json: false,
    });

    expect(parseCli(["instructions", "demo", "--json"], "1.2.3")).toEqual({
      kind: "instructions",
      name: "demo",
      json: true,
    });

    expect(parseCli(["status", "--json"], "1.2.3")).toEqual({
      kind: "status",
      json: true,
    });

    expect(parseCli(["status", "demo", "--json"], "1.2.3")).toEqual({
      kind: "status",
      name: "demo",
      json: true,
    });
  });

  test("requires JSON output for status", () => {
    expect(parseCli(["status"], "1.2.3")).toEqual({
      kind: "result",
      result: {
        exitCode: 1,
        stdout: expect.stringContaining("learn status [name] --json"),
        stderr: "Usage: learn status [name] --json",
      },
    });
  });

  test("parses glossary emit commands", () => {
    expect(
      parseCli(
        [
          "emit",
          "glossary",
          "demo",
          "--term",
          "State",
          "--def",
          "A remembered value.",
          "--lesson",
          "01-intro",
          "--json",
        ],
        "1.2.3",
      ),
    ).toEqual({
      kind: "emit",
      name: "demo",
      emit: {
        kind: "glossary",
        term: "State",
        def: "A remembered value.",
        lesson: "01-intro",
        json: true,
      },
    });

    const emptyTerm = parseCli(
      ["emit", "glossary", "--term", " ", "--def", "Definition."],
      "1.2.3",
    );

    expect(emptyTerm).toEqual({
      kind: "result",
      result: {
        exitCode: 1,
        stdout: expect.stringContaining("learn emit glossary"),
        stderr: "Glossary term cannot be empty.",
      },
    });
  });
});
