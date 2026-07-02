export type CliExitCode = 0 | 1;

export type CliResult = Readonly<{
  exitCode: CliExitCode;
  stdout: string;
  stderr?: string;
}>;

const formatHelp = (version: string): string =>
  [
    `overlearn ${version}`,
    "",
    "Usage:",
    "  learn --help",
    "  learn --version",
  ].join("\n");

export const runCli = (args: readonly string[], version: string): CliResult => {
  const [arg] = args;

  if (arg === "--version" || arg === "-v") {
    return {
      exitCode: 0,
      stdout: version,
    };
  }

  if (arg === undefined || arg === "--help" || arg === "-h") {
    return {
      exitCode: 0,
      stdout: formatHelp(version),
    };
  }

  return {
    exitCode: 1,
    stdout: formatHelp(version),
    stderr: `Unknown option: ${arg}`,
  };
};
