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
  | Readonly<{ kind: "status"; name?: string; json: true }>
  | Readonly<{
      kind: "say";
      name?: string;
      source:
        | Readonly<{ kind: "text"; text: string }>
        | Readonly<{ kind: "file"; path: string }>;
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
    "  learn status [name] --json",
    "  learn say [name] --text <markdown>",
    "  learn say [name] --file <path>",
    "  learn --help",
    "  learn --version",
  ].join("\n");

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
    return optionalNameJsonCommand("instructions", rest, version);
  }

  if (arg === "status") {
    return optionalNameJsonCommand("status", rest, version);
  }

  if (arg === "say") {
    return sayCommand(rest, version);
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
