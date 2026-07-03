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
    expect(result.stdout).toContain("learn resume <name>");
    expect(result.stdout).toContain("learn emit glossary [name]");
    expect(result.stdout).toContain("learn emit demo [name]");
    expect(result.stdout).toContain("learn emit feynman [name]");
    expect(result.stdout).toContain("learn emit mastery [name]");
    expect(result.stdout).toContain("learn --help");
    expect(result.stdout).toContain("learn --version");
  });

  test("parses start, resume, wait, and say commands", () => {
    expect(parseCli(["start", "demo"], "1.2.3")).toEqual({
      kind: "start",
      name: "demo",
    });

    expect(parseCli(["resume", "demo"], "1.2.3")).toEqual({
      kind: "resume",
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

  test("requires a course name for resume", () => {
    expect(parseCli(["resume"], "1.2.3")).toEqual({
      kind: "result",
      result: {
        exitCode: 1,
        stdout: expect.stringContaining("learn resume <name>"),
        stderr: "Usage: learn resume <name>",
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

describe("emit demo CLI parsing", () => {
  test("parses demo emit commands", () => {
    expect(
      parseCli(
        [
          "emit",
          "demo",
          "demo-course",
          "--file",
          "growth.html",
          "--topic",
          "indexes/btree",
          "--title",
          "Growth curve",
          "--json",
        ],
        "1.2.3",
      ),
    ).toEqual({
      kind: "emit",
      name: "demo-course",
      emit: {
        kind: "demo",
        file: "growth.html",
        topic: "indexes/btree",
        title: "Growth curve",
        json: true,
      },
    });

    expect(parseCli(["emit", "demo", "--file", "growth.html"], "1.2.3")).toEqual({
      kind: "emit",
      emit: {
        kind: "demo",
        file: "growth.html",
        json: false,
      },
    });
  });

  test("rejects missing and empty demo fields", () => {
    expect(parseCli(["emit", "demo"], "1.2.3")).toEqual({
      kind: "result",
      result: {
        exitCode: 1,
        stdout: expect.stringContaining("learn emit demo"),
        stderr:
          "Usage: learn emit demo [name] --file <file.html> [--topic <topic/path>] [--title <title>] [--json]",
      },
    });

    expect(parseCli(["emit", "demo", "--file", " "], "1.2.3")).toEqual({
      kind: "result",
      result: {
        exitCode: 1,
        stdout: expect.stringContaining("learn emit demo"),
        stderr: "Demo file cannot be empty.",
      },
    });

    expect(
      parseCli(["emit", "demo", "--file", "growth.html", "--topic", " "], "1.2.3"),
    ).toEqual({
      kind: "result",
      result: {
        exitCode: 1,
        stdout: expect.stringContaining("learn emit demo"),
        stderr: "Demo topic cannot be empty.",
      },
    });
  });
});

describe("instructions CLI parsing", () => {
  test("parses eject options", () => {
    expect(parseCli(["instructions", "--eject"], "1.2.3")).toEqual({
      kind: "instructions-eject",
      force: false,
    });

    expect(
      parseCli(
        ["instructions", "--eject", "--to", "/tmp/overlearn-instructions", "--force"],
        "1.2.3",
      ),
    ).toEqual({
      kind: "instructions-eject",
      toDir: "/tmp/overlearn-instructions",
      force: true,
    });
  });

  test("rejects invalid eject combinations", () => {
    expect(parseCli(["instructions", "course", "--eject"], "1.2.3")).toEqual({
      kind: "result",
      result: {
        exitCode: 1,
        stdout: expect.stringContaining("learn instructions --eject"),
        stderr:
          "Usage: learn instructions [name] [--json] or learn instructions --eject [--to <dir>] [--force]",
      },
    });

    expect(parseCli(["instructions", "--eject", "--json"], "1.2.3")).toEqual({
      kind: "result",
      result: {
        exitCode: 1,
        stdout: expect.stringContaining("learn instructions --eject"),
        stderr:
          "Usage: learn instructions [name] [--json] or learn instructions --eject [--to <dir>] [--force]",
      },
    });
  });
});

describe("emit topic CLI parsing", () => {
  test("parses topic emit commands", () => {
    expect(
      parseCli(
        [
          "emit",
          "topic",
          "demo",
          "--enter",
          "indexes/btree",
          "--title",
          "B-tree",
          "--lesson",
          "02-btree",
          "--json",
        ],
        "1.2.3",
      ),
    ).toEqual({
      kind: "emit",
      name: "demo",
      emit: {
        kind: "topic",
        path: "indexes/btree",
        title: "B-tree",
        lesson: "02-btree",
        json: true,
      },
    });

    expect(
      parseCli(["emit", "topic", "--enter", "indexes"], "1.2.3"),
    ).toEqual({
      kind: "emit",
      emit: {
        kind: "topic",
        path: "indexes",
        json: false,
      },
    });
  });

  test("rejects missing and empty topic fields", () => {
    expect(parseCli(["emit", "topic"], "1.2.3")).toEqual({
      kind: "result",
      result: {
        exitCode: 1,
        stdout: expect.stringContaining("learn emit topic"),
        stderr: "Usage: learn emit topic [name] --enter <topic/path> [--title <title>] [--lesson <lesson-id>] [--json]",
      },
    });

    expect(
      parseCli(["emit", "topic", "--enter", " "], "1.2.3"),
    ).toEqual({
      kind: "result",
      result: {
        exitCode: 1,
        stdout: expect.stringContaining("learn emit topic"),
        stderr: "Topic path cannot be empty.",
      },
    });

    expect(
      parseCli(["emit", "topic", "--enter", "indexes", "--lesson", " "], "1.2.3"),
    ).toEqual({
      kind: "result",
      result: {
        exitCode: 1,
        stdout: expect.stringContaining("learn emit topic"),
        stderr: "Topic lesson cannot be empty.",
      },
    });
  });
});

describe("emit feynman CLI parsing", () => {
  test("parses feynman emit commands", () => {
    expect(
      parseCli(
        [
          "emit",
          "feynman",
          "demo-course",
          "--concept",
          "rule-of-72",
          "--prompt",
          "Explain why the shortcut works.",
          "--key-points",
          "rate, doubling; logarithm approximation",
          "--json",
        ],
        "1.2.3",
      ),
    ).toEqual({
      kind: "emit",
      name: "demo-course",
      emit: {
        kind: "feynman",
        concept: "rule-of-72",
        prompt: "Explain why the shortcut works.",
        keyPoints: ["rate", "doubling", "logarithm approximation"],
        json: true,
      },
    });

    expect(
      parseCli(
        [
          "emit",
          "feynman",
          "--concept",
          "compound-growth",
          "--prompt",
          "Teach it back.",
        ],
        "1.2.3",
      ),
    ).toEqual({
      kind: "emit",
      emit: {
        kind: "feynman",
        concept: "compound-growth",
        prompt: "Teach it back.",
        keyPoints: [],
        json: false,
      },
    });
  });

  test("rejects invalid feynman fields", () => {
    expect(parseCli(["emit", "feynman"], "1.2.3")).toEqual({
      kind: "result",
      result: {
        exitCode: 1,
        stdout: expect.stringContaining("learn emit feynman"),
        stderr:
          "Usage: learn emit feynman [name] --concept <id> --prompt <prompt> [--key-points <points>] [--json]",
      },
    });

    expect(
      parseCli(
        [
          "emit",
          "feynman",
          "--concept",
          "Rule of 72",
          "--prompt",
          "Explain it.",
        ],
        "1.2.3",
      ),
    ).toEqual({
      kind: "result",
      result: {
        exitCode: 1,
        stdout: expect.stringContaining("learn emit feynman"),
        stderr:
          "Invalid concept id: Rule of 72. Use lowercase letters, numbers, and hyphens.",
      },
    });

    expect(
      parseCli(
        [
          "emit",
          "feynman",
          "--concept",
          "rule-of-72",
          "--prompt",
          " ",
        ],
        "1.2.3",
      ),
    ).toEqual({
      kind: "result",
      result: {
        exitCode: 1,
        stdout: expect.stringContaining("learn emit feynman"),
        stderr: "Feynman prompt cannot be empty.",
      },
    });

    expect(
      parseCli(
        [
          "emit",
          "feynman",
          "--concept",
          "rule-of-72",
          "--prompt",
          "Explain it.",
          "--key-points",
          " , ; ",
        ],
        "1.2.3",
      ),
    ).toEqual({
      kind: "result",
      result: {
        exitCode: 1,
        stdout: expect.stringContaining("learn emit feynman"),
        stderr: "Feynman key points cannot be empty.",
      },
    });
  });
});

describe("emit mastery CLI parsing", () => {
  test("parses mastery emit commands", () => {
    expect(
      parseCli(
        [
          "emit",
          "mastery",
          "demo-course",
          "--concept",
          "rule-of-72",
          "--score",
          "82",
          "--gaps",
          "missed the mechanism",
          "--json",
        ],
        "1.2.3",
      ),
    ).toEqual({
      kind: "emit",
      name: "demo-course",
      emit: {
        kind: "mastery",
        concept: "rule-of-72",
        score: 82,
        gaps: "missed the mechanism",
        json: true,
      },
    });
  });

  test("rejects invalid mastery fields", () => {
    expect(parseCli(["emit", "mastery"], "1.2.3")).toEqual({
      kind: "result",
      result: {
        exitCode: 1,
        stdout: expect.stringContaining("learn emit mastery"),
        stderr:
          "Usage: learn emit mastery [name] --concept <id> --score <0-100> [--gaps <gaps>] [--json]",
      },
    });

    expect(
      parseCli(
        [
          "emit",
          "mastery",
          "--concept",
          "rule-of-72",
          "--score",
          "101",
        ],
        "1.2.3",
      ),
    ).toEqual({
      kind: "result",
      result: {
        exitCode: 1,
        stdout: expect.stringContaining("learn emit mastery"),
        stderr: "Mastery score must be an integer from 0 to 100.",
      },
    });

    expect(
      parseCli(
        [
          "emit",
          "mastery",
          "--concept",
          "rule-of-72",
          "--score",
          "82.5",
        ],
        "1.2.3",
      ),
    ).toEqual({
      kind: "result",
      result: {
        exitCode: 1,
        stdout: expect.stringContaining("learn emit mastery"),
        stderr: "Mastery score must be an integer from 0 to 100.",
      },
    });

    expect(
      parseCli(
        [
          "emit",
          "mastery",
          "--concept",
          "rule-of-72",
          "--score",
          "82",
          "--gaps",
          " ",
        ],
        "1.2.3",
      ),
    ).toEqual({
      kind: "result",
      result: {
        exitCode: 1,
        stdout: expect.stringContaining("learn emit mastery"),
        stderr: "Mastery gaps cannot be empty.",
      },
    });
  });
});
