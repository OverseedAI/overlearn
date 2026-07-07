export type CliExitCode = 0 | 1 | 2;

export type CliResult = Readonly<{
  exitCode: CliExitCode;
  stdout: string;
  stderr?: string;
}>;

export type CliCommand =
  | Readonly<{ kind: "result"; result: CliResult }>
  | Readonly<{ kind: "daemon"; dataDir?: string; portFile?: string }>
  | Readonly<{ kind: "mcp-proxy"; args: readonly string[] }>;

const formatHelp = (version: string): string =>
  [
    `overlearn internal ${version}`,
    "",
    "Usage:",
    "  overlearn-internal daemon [--data-dir <dir>] [--port-file <path>]",
    "  overlearn-internal mcp-proxy <url> [header=value ...]",
    "  overlearn-internal --help",
    "  overlearn-internal --version",
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

const daemonCommand = (
  args: readonly string[],
  version: string,
): CliCommand => {
  let dataDir: string | undefined;
  let portFile: string | undefined;
  let index = 0;

  while (index < args.length) {
    const arg = args[index];
    index += 1;

    if (arg === "--data-dir") {
      const value = args[index];
      index += 1;
      if (value === undefined || value.trim().length === 0) {
        return result(1, formatHelp(version), "Usage: overlearn-internal daemon [--data-dir <dir>] [--port-file <path>]");
      }

      dataDir = value;
      continue;
    }

    if (arg === "--port-file") {
      const value = args[index];
      index += 1;
      if (value === undefined || value.trim().length === 0) {
        return result(1, formatHelp(version), "Usage: overlearn-internal daemon [--data-dir <dir>] [--port-file <path>]");
      }

      portFile = value;
      continue;
    }

    return result(1, formatHelp(version), `Unknown daemon option: ${String(arg)}`);
  }

  return {
    kind: "daemon",
    ...(dataDir === undefined ? {} : { dataDir }),
    ...(portFile === undefined ? {} : { portFile }),
  };
};

const mcpProxyCommand = (
  args: readonly string[],
  version: string,
): CliCommand => {
  const [url] = args;
  if (url === undefined || url.trim().length === 0) {
    return result(
      1,
      formatHelp(version),
      "Usage: overlearn-internal mcp-proxy <url> [header=value ...]",
    );
  }

  return { kind: "mcp-proxy", args };
};

export const parseCli = (
  args: readonly string[],
  version: string,
): CliCommand => {
  const [arg, ...rest] = args;

  if (arg === undefined || arg === "--help" || arg === "-h") {
    return result(0, formatHelp(version));
  }

  if (arg === "--version" || arg === "-v") {
    return result(0, version);
  }

  if (arg === "daemon") {
    return daemonCommand(rest, version);
  }

  if (arg === "mcp-proxy") {
    return mcpProxyCommand(rest, version);
  }

  return result(1, formatHelp(version), `Unsupported internal command: ${arg}`);
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
