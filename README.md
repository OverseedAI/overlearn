# overlearn

Overlearn is a desktop learning app that turns a coding-agent harness into a
personal teacher. The Tauri app is the user entry point; it starts a local
store-backed daemon, opens the app UI in the webview, and supervises agent turns
through the internal sidecar.

The PRD lives in
[Notion](https://app.notion.com/p/3915b1d7dbd481299068f5d1bc0dfeb6).

## Desktop App

Use the app in development with:

```sh
bun run app:dev
```

The desktop shell builds the internal sidecar, copies it into Tauri's
target-triple binary location, starts one app-level daemon on launch, and loads
the bundled UI directly in the main webview.

In orchestrated mode, changing the header harness picker mid-course takes effect
once the current turn is idle. The daemon ends the old harness session, starts
the next turn on the new harness, and asks it to rebuild from store state;
lessons, transcript, glossary, mastery, and topic state carry over, but the old
agent's in-context memory does not.

Release steps and desktop artifact locations are documented in
[docs/release.md](docs/release.md).

## UI

The interface is a Vite + React + Tailwind v4 + shadcn/ui SPA in [`ui/`](ui/).
Tauri serves the built UI from `ui/dist` in packaged builds and uses the Vite
dev server in development; the daemon is API-only. Design conventions live in
[`ui/DESIGN.md`](ui/DESIGN.md).

For fast UI iteration against a running daemon, read `port`/`token` from the
daemon's `daemon.json` and start the Vite dev server with its proxy:

```sh
OVERLEARN_DAEMON_PORT=<port> OVERLEARN_DAEMON_TOKEN=<token> bun run --cwd ui dev
```

## Testing

Run the main checks:

```sh
bun run typecheck
bun run lint
bun test src
```

Run the contract suite against source:

```sh
bun run test:contract
```

Run the contract suite against the packaged sidecar:

```sh
bun run build
bun run app:copy-sidecar
OVERLEARN_CONTRACT_RUNTIME=sidecar bun run test:contract
```

The supported contract runtimes are `source` and `sidecar`. The adapter
conformance suite is available as:

```sh
bun run test:conformance
```

The opt-in real Claude Code ACP smoke lives in the `Adapter Smoke` GitHub
Actions workflow and requires the `ANTHROPIC_API_KEY` secret.

## Registry Worker

The standalone registry Worker lives in `registry/`:

```sh
cd registry
bun install
bun run dev
```
