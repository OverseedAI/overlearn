export type CliExitCode = 0 | 1 | 2;

export type CliResult = Readonly<{
  exitCode: CliExitCode;
  stdout: string;
  stderr?: string;
}>;

export type CliCommand =
  | Readonly<{ kind: "result"; result: CliResult }>
  | Readonly<{ kind: "start"; name?: string }>
  | Readonly<{ kind: "resume"; name: string }>
  | Readonly<{ kind: "wait"; name?: string }>
  | Readonly<{ kind: "instructions"; name?: string; json: boolean }>
  | Readonly<{ kind: "instructions-eject"; toDir?: string; force: boolean }>
  | Readonly<{ kind: "status"; name?: string; json: true }>
  | Readonly<{
      kind: "export";
      name?: string;
      outDir?: string;
      includeTranscript: boolean;
      force: boolean;
      json: boolean;
    }>
  | Readonly<{
      kind: "say";
      name?: string;
      source:
        | Readonly<{ kind: "text"; text: string }>
        | Readonly<{ kind: "file"; path: string }>;
    }>
  | Readonly<{
      kind: "emit";
      name?: string;
      emit:
        | Readonly<{
            kind: "glossary";
            term: string;
            def: string;
            lesson?: string;
            json: boolean;
          }>
        | Readonly<{
            kind: "topic";
            path: string;
            title?: string;
            lesson?: string;
            json: boolean;
          }>
        | Readonly<{
            kind: "demo";
            file: string;
            topic?: string;
            title?: string;
            json: boolean;
          }>;
    }>
  | Readonly<{ kind: "daemon"; courseDir: string }>;

const formatHelp = (version: string): string =>
  [
    `overlearn ${version}`,
    "",
    "Usage:",
    "  learn start [name]",
    "  learn resume <name>",
    "  learn wait [name]",
    "  learn instructions [name] [--json]",
    "  learn instructions --eject [--to <dir>] [--force]",
    "  learn status [name] --json",
    "  learn export [name] [--out <dir>] [--include-transcript] [--force] [--json]",
    "  learn say [name] --text <markdown>",
    "  learn say [name] --file <path>",
    "  learn emit glossary [name] --term <term> --def <definition> [--lesson <lesson-id>] [--json]",
    "  learn emit topic [name] --enter <topic/path> [--title <title>] [--lesson <lesson-id>] [--json]",
    "  learn emit demo [name] --file <file.html> [--topic <topic/path>] [--title <title>] [--json]",
    "  learn --help",
    "  learn --version",
  ].join("\n");

const emitGlossaryUsage =
  "Usage: learn emit glossary [name] --term <term> --def <definition> [--lesson <lesson-id>] [--json]";
const emitTopicUsage =
  "Usage: learn emit topic [name] --enter <topic/path> [--title <title>] [--lesson <lesson-id>] [--json]";
const emitDemoUsage =
  "Usage: learn emit demo [name] --file <file.html> [--topic <topic/path>] [--title <title>] [--json]";

const result = (
  exitCode: CliExitCode,
  stdout: string,
  stderr?: string,
): CliCommand => ({
  kind: "result",
  result:
    stderr === undefined
      ? { exitCode, stdout }
      : {
          exitCode,
          stdout,
          stderr,
        },
});

const optionalNameCommand = (
  kind: "start" | "wait",
  args: readonly string[],
  version: string,
): CliCommand => {
  const [name, extra] = args;

  if (extra !== undefined) {
    return result(1, formatHelp(version), `Too many arguments for ${kind}.`);
  }

  return name === undefined ? { kind } : { kind, name };
};

const requiredNameCommand = (
  kind: "resume",
  args: readonly string[],
  version: string,
): CliCommand => {
  const [name, extra] = args;

  if (name === undefined || extra !== undefined) {
    return result(1, formatHelp(version), `Usage: learn ${kind} <name>`);
  }

  return { kind, name };
};

const optionalNameJsonCommand = (
  kind: "instructions" | "status",
  args: readonly string[],
  version: string,
): CliCommand => {
  let name: string | undefined;
  let json = false;

  for (const arg of args) {
    if (arg === "--json") {
      json = true;
      continue;
    }

    if (arg.startsWith("-")) {
      return result(1, formatHelp(version), `Unknown option for ${kind}: ${arg}`);
    }

    if (name !== undefined) {
      return result(1, formatHelp(version), `Too many arguments for ${kind}.`);
    }

    name = arg;
  }

  if (kind === "status") {
    if (!json) {
      return result(1, formatHelp(version), "Usage: learn status [name] --json");
    }

    return name === undefined
      ? { kind, json: true }
      : { kind, name, json: true };
  }

  return name === undefined ? { kind, json } : { kind, name, json };
};

const instructionsUsage =
  "Usage: learn instructions [name] [--json] or learn instructions --eject [--to <dir>] [--force]";

const exportUsage =
  "Usage: learn export [name] [--out <dir>] [--include-transcript] [--force] [--json]";

const instructionsCommand = (
  args: readonly string[],
  version: string,
): CliCommand => {
  let name: string | undefined;
  let json = false;
  let eject = false;
  let toDir: string | undefined;
  let force = false;
  let index = 0;

  while (index < args.length) {
    const arg = args[index];
    index += 1;

    if (arg === "--json") {
      json = true;
      continue;
    }

    if (arg === "--eject") {
      eject = true;
      continue;
    }

    if (arg === "--force") {
      force = true;
      continue;
    }

    if (arg === "--to") {
      const value = args[index];
      index += 1;

      if (value === undefined) {
        return result(1, formatHelp(version), instructionsUsage);
      }

      toDir = value;
      continue;
    }

    if (arg === undefined || arg.startsWith("-")) {
      return result(
        1,
        formatHelp(version),
        `Unknown option for instructions: ${String(arg)}`,
      );
    }

    if (name !== undefined) {
      return result(
        1,
        formatHelp(version),
        "Too many arguments for instructions.",
      );
    }

    name = arg;
  }

  if (eject) {
    if (name !== undefined || json) {
      return result(1, formatHelp(version), instructionsUsage);
    }

    return toDir === undefined
      ? { kind: "instructions-eject", force }
      : { kind: "instructions-eject", toDir, force };
  }

  if (toDir !== undefined || force) {
    return result(1, formatHelp(version), instructionsUsage);
  }

  return name === undefined
    ? { kind: "instructions", json }
    : { kind: "instructions", name, json };
};

const sayCommand = (args: readonly string[], version: string): CliCommand => {
  const [first, second, third, fourth] = args;
  const hasName = first !== undefined && !first.startsWith("-");
  const name = hasName ? first : undefined;
  const flag = hasName ? second : first;
  const value = hasName ? third : second;
  const extra = hasName ? fourth : third;

  if (flag === undefined || value === undefined || extra !== undefined) {
    return result(1, formatHelp(version), "Usage: learn say [name] --text <markdown> or --file <path>");
  }

  if (flag === "--text") {
    return {
      kind: "say",
      ...(name === undefined ? {} : { name }),
      source: { kind: "text", text: value },
    };
  }

  if (flag === "--file") {
    return {
      kind: "say",
      ...(name === undefined ? {} : { name }),
      source: { kind: "file", path: value },
    };
  }

  return result(1, formatHelp(version), "Usage: learn say [name] --text <markdown> or --file <path>");
};

const emitGlossaryCommand = (
  args: readonly string[],
  version: string,
): CliCommand => {
  let index = 0;
  const first = args[index];
  const name = first !== undefined && !first.startsWith("-") ? first : undefined;

  if (name !== undefined) {
    index += 1;
  }

  let term: string | undefined;
  let def: string | undefined;
  let lesson: string | undefined;
  let json = false;

  while (index < args.length) {
    const flag = args[index];
    index += 1;

    if (flag === "--json") {
      json = true;
      continue;
    }

    if (flag !== "--term" && flag !== "--def" && flag !== "--lesson") {
      return result(1, formatHelp(version), emitGlossaryUsage);
    }

    const value = args[index];
    index += 1;

    if (value === undefined) {
      return result(1, formatHelp(version), emitGlossaryUsage);
    }

    if (flag === "--term") {
      term = value;
    } else if (flag === "--def") {
      def = value;
    } else {
      lesson = value;
    }
  }

  if (term === undefined || def === undefined) {
    return result(1, formatHelp(version), emitGlossaryUsage);
  }

  if (term.trim().length === 0) {
    return result(1, formatHelp(version), "Glossary term cannot be empty.");
  }

  if (def.trim().length === 0) {
    return result(1, formatHelp(version), "Glossary definition cannot be empty.");
  }

  if (lesson !== undefined && lesson.trim().length === 0) {
    return result(1, formatHelp(version), "Glossary lesson cannot be empty.");
  }

  return {
    kind: "emit",
    ...(name === undefined ? {} : { name }),
    emit:
      lesson === undefined
        ? {
            kind: "glossary",
            term,
            def,
            json,
          }
        : {
            kind: "glossary",
            term,
            def,
            lesson,
            json,
          },
  };
};

const emitTopicCommand = (
  args: readonly string[],
  version: string,
): CliCommand => {
  let index = 0;
  const first = args[index];
  const name = first !== undefined && !first.startsWith("-") ? first : undefined;

  if (name !== undefined) {
    index += 1;
  }

  let path: string | undefined;
  let title: string | undefined;
  let lesson: string | undefined;
  let json = false;

  while (index < args.length) {
    const flag = args[index];
    index += 1;

    if (flag === "--json") {
      json = true;
      continue;
    }

    if (flag !== "--enter" && flag !== "--title" && flag !== "--lesson") {
      return result(1, formatHelp(version), emitTopicUsage);
    }

    const value = args[index];
    index += 1;

    if (value === undefined) {
      return result(1, formatHelp(version), emitTopicUsage);
    }

    if (flag === "--enter") {
      path = value;
    } else if (flag === "--title") {
      title = value;
    } else {
      lesson = value;
    }
  }

  if (path === undefined) {
    return result(1, formatHelp(version), emitTopicUsage);
  }

  if (path.trim().length === 0) {
    return result(1, formatHelp(version), "Topic path cannot be empty.");
  }

  if (title !== undefined && title.trim().length === 0) {
    return result(1, formatHelp(version), "Topic title cannot be empty.");
  }

  if (lesson !== undefined && lesson.trim().length === 0) {
    return result(1, formatHelp(version), "Topic lesson cannot be empty.");
  }

  return {
    kind: "emit",
    ...(name === undefined ? {} : { name }),
    emit: {
      kind: "topic",
      path,
      ...(title === undefined ? {} : { title }),
      ...(lesson === undefined ? {} : { lesson }),
      json,
    },
  };
};

const emitDemoCommand = (
  args: readonly string[],
  version: string,
): CliCommand => {
  let index = 0;
  const first = args[index];
  const name = first !== undefined && !first.startsWith("-") ? first : undefined;

  if (name !== undefined) {
    index += 1;
  }

  let file: string | undefined;
  let topic: string | undefined;
  let title: string | undefined;
  let json = false;

  while (index < args.length) {
    const flag = args[index];
    index += 1;

    if (flag === "--json") {
      json = true;
      continue;
    }

    if (flag !== "--file" && flag !== "--topic" && flag !== "--title") {
      return result(1, formatHelp(version), emitDemoUsage);
    }

    const value = args[index];
    index += 1;

    if (value === undefined) {
      return result(1, formatHelp(version), emitDemoUsage);
    }

    if (flag === "--file") {
      file = value;
    } else if (flag === "--topic") {
      topic = value;
    } else {
      title = value;
    }
  }

  if (file === undefined) {
    return result(1, formatHelp(version), emitDemoUsage);
  }

  if (file.trim().length === 0) {
    return result(1, formatHelp(version), "Demo file cannot be empty.");
  }

  if (topic !== undefined && topic.trim().length === 0) {
    return result(1, formatHelp(version), "Demo topic cannot be empty.");
  }

  if (title !== undefined && title.trim().length === 0) {
    return result(1, formatHelp(version), "Demo title cannot be empty.");
  }

  return {
    kind: "emit",
    ...(name === undefined ? {} : { name }),
    emit: {
      kind: "demo",
      file,
      ...(topic === undefined ? {} : { topic }),
      ...(title === undefined ? {} : { title }),
      json,
    },
  };
};

const emitCommand = (args: readonly string[], version: string): CliCommand => {
  const [kind, ...rest] = args;

  if (kind === "glossary") {
    return emitGlossaryCommand(rest, version);
  }

  if (kind === "topic") {
    return emitTopicCommand(rest, version);
  }

  if (kind === "demo") {
    return emitDemoCommand(rest, version);
  }

  if (kind === undefined) {
    return result(1, formatHelp(version), "Usage: learn emit <kind> ...");
  }

  return result(1, formatHelp(version), `Unknown emit kind: ${kind}`);
};

const exportCommand = (
  args: readonly string[],
  version: string,
): CliCommand => {
  let name: string | undefined;
  let outDir: string | undefined;
  let includeTranscript = false;
  let force = false;
  let json = false;
  let index = 0;

  while (index < args.length) {
    const arg = args[index];
    index += 1;

    if (arg === "--include-transcript") {
      includeTranscript = true;
      continue;
    }

    if (arg === "--force") {
      force = true;
      continue;
    }

    if (arg === "--json") {
      json = true;
      continue;
    }

    if (arg === "--out") {
      const value = args[index];
      index += 1;

      if (value === undefined) {
        return result(1, formatHelp(version), exportUsage);
      }

      if (value.trim().length === 0) {
        return result(1, formatHelp(version), "Export output dir cannot be empty.");
      }

      outDir = value;
      continue;
    }

    if (arg === undefined || arg.startsWith("-")) {
      return result(1, formatHelp(version), `Unknown option for export: ${String(arg)}`);
    }

    if (name !== undefined) {
      return result(1, formatHelp(version), "Too many arguments for export.");
    }

    name = arg;
  }

  return {
    kind: "export",
    ...(name === undefined ? {} : { name }),
    ...(outDir === undefined ? {} : { outDir }),
    includeTranscript,
    force,
    json,
  };
};

export const parseCli = (
  args: readonly string[],
  version: string,
): CliCommand => {
  const [arg, ...rest] = args;

  if (arg === "--version" || arg === "-v") {
    return result(0, version);
  }

  if (arg === undefined || arg === "--help" || arg === "-h") {
    return result(0, formatHelp(version));
  }

  if (arg === "start") {
    return optionalNameCommand("start", rest, version);
  }

  if (arg === "resume") {
    return requiredNameCommand("resume", rest, version);
  }

  if (arg === "wait") {
    return optionalNameCommand("wait", rest, version);
  }

  if (arg === "instructions") {
    return instructionsCommand(rest, version);
  }

  if (arg === "status") {
    return optionalNameJsonCommand("status", rest, version);
  }

  if (arg === "export") {
    return exportCommand(rest, version);
  }

  if (arg === "say") {
    return sayCommand(rest, version);
  }

  if (arg === "emit") {
    return emitCommand(rest, version);
  }

  if (arg === "__daemon") {
    const [courseDir, extra] = rest;
    if (courseDir === undefined || extra !== undefined) {
      return result(1, "", "Usage: learn __daemon <course-dir>");
    }

    return { kind: "daemon", courseDir };
  }

  return result(1, formatHelp(version), `Unknown option: ${arg}`);
};

export const runCli = (args: readonly string[], version: string): CliResult => {
  const command = parseCli(args, version);

  if (command.kind === "result") {
    return command.result;
  }

  return {
    exitCode: 1,
    stdout: formatHelp(version),
    stderr: `Command requires the executable entrypoint: ${command.kind}`,
  };
};
