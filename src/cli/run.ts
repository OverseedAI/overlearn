export type CliExitCode = 0 | 1 | 2;

export type CliResult = Readonly<{
  exitCode: CliExitCode;
  stdout: string;
  stderr?: string;
}>;

export type CliCommand =
  | Readonly<{ kind: "result"; result: CliResult }>
  | Readonly<{ kind: "start"; name?: string }>
  | Readonly<{ kind: "wait"; name?: string }>
  | Readonly<{ kind: "daemon"; courseDir: string }>;

const formatHelp = (version: string): string =>
  [
    `overlearn ${version}`,
    "",
    "Usage:",
    "  learn start [name]",
    "  learn wait [name]",
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

  if (arg === "wait") {
    return optionalNameCommand("wait", rest, version);
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
