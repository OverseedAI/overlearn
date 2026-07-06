# overlearn

overlearn turns a coding harness into a personal teacher: a local `learn` CLI will coordinate a daemon, file-backed course state, and a browser UI so agents can teach interactively while learners respond in the browser. The PRD lives in [Notion](https://app.notion.com/p/3915b1d7dbd481299068f5d1bc0dfeb6).

## Install

```sh
curl -fsSL https://overlearn.org/install.sh | bash
```

Pin a release version:

```sh
curl -fsSL https://overlearn.org/install.sh | OVERLEARN_VERSION=v0.1.0 bash
```

Manual binary install fallback:

```sh
mkdir -p ~/.local/bin
curl -fL -o ~/.local/bin/learn https://github.com/OverseedAI/overlearn/releases/latest/download/learn-linux-x64
chmod 0755 ~/.local/bin/learn
```

Use `learn-linux-arm64`, `learn-darwin-x64`, or `learn-darwin-arm64` for other platforms.

Install the harness files for your agent (Claude Code and Codex today):

```sh
learn install claude-code
# or
learn install codex
```

Both installs write a harness-specific `learn` skill and a Stop-hook backstop
that keeps the agent in the teaching loop. Claude Code gets the hook in
`.claude/settings.json`; Codex gets it in `~/.codex/hooks.json`, and the
install also enables `features.hooks` in `~/.codex/config.toml` if needed.

Re-running `learn install` after upgrading the CLI refreshes the installed
files, as long as you haven't edited them yourself (use `--force` to overwrite
your edits too).

Claude Code plugin marketplace alternative:

```sh
claude plugin marketplace add OverseedAI/overlearn
claude plugin install overlearn@overlearn
```

Quickstart:

```sh
learn install claude-code   # or: learn install codex
learn start my-course
```

In your agent, run `/learn`.

## Desktop App

The Tauri desktop shell packages the same compiled `dist/learn` daemon used by
the CLI release. Build the sidecar first, copy it into Tauri's target-triple
binary name, then run the debug bundle:

```sh
bun run app:build
```

The launcher stores selected course directories and optional per-course working
directories in the Tauri app config file (`app.json` under the platform app
config directory). The working directory is persisted for future orchestration;
the current daemon still runs through the existing `learn resume <course>`
command.

In orchestrated mode, changing the header harness picker mid-course takes effect
immediately once the current turn is idle. The daemon ends the old harness
session, starts the next turn on the new harness, and asks it to rebuild from
the on-disk course state; lessons, transcript, glossary, mastery, and topic
state carry over, but the old agent's in-context memory does not.

## Registry

The course registry Worker lives in `registry/` and is local-first while R2 enablement is pending:

```sh
cd registry
bun install
bun run dev
```

Point the CLI at a local Worker with `OVERLEARN_REGISTRY_URL=http://127.0.0.1:8787`. GitHub device flow uses `OVERLEARN_GITHUB_CLIENT_ID` until the OAuth app client id exists.
