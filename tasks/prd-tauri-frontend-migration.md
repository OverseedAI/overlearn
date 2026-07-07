# PRD: Standard Tauri Frontend Architecture

## Introduction

Overlearn currently embeds the React SPA inside the `learn` daemon binary (base64 assets compiled into the sidecar) and points the Tauri webview at the daemon's HTTP server. This gives a slow dev loop (every UI edit requires vite build → base64 embed → ~64 MB `bun compile` → sidecar copy) and a staleness trap: the shell reuses any healthy daemon found via `daemon.json`, so a rebuilt app can silently serve an old UI forever.

This migration moves Overlearn to the standard Tauri shape: the UI ships as Tauri `frontendDist` assets inside the `.app`/`.dmg`, `tauri dev` gets real Vite HMR via `devUrl`, and the daemon becomes an API-only sidecar strictly tied to the window lifecycle. The daemon keeps owning everything else: SQLite store, turn orchestrator, ACP adapters, teaching MCP.

Decisions already made (with rationale, from design discussion):

- **Full migration**, sequenced in three phases that each leave the app shippable.
- **Daemon lifecycle:** kill-don't-reuse. On startup the shell terminates any daemon found in `daemon.json` and spawns fresh. No build-id/version negotiation needed. Orphaned in-flight turns are discarded (persisted writes survive in SQLite).
- **SSE auth:** keep `EventSource`, pass the bearer token as a query param on `/api/events` only. Keeps built-in auto-reconnect; loopback-only exposure is acceptable.
- **Legacy server-rendered UI:** delete entirely (`src/daemon/ui.ts` and friends). The daemon serves no HTML; browser-tab access to Overlearn goes away. Strictly a desktop app.
- **Bearer token stays.** The daemon is a localhost HTTP server fronting an agent with tool permissions; any local process or a webpage doing localhost CSRF can reach the port. Token moves from URL/cookie bootstrap to Tauri IPC + `Authorization` header.

## Goals

- `tauri dev` hot-reloads UI changes with no sidecar rebuild.
- A rebuilt app can never serve a stale UI: daemon lifetime == app lifetime.
- Production still ships as a single `.dmg`; UI edits no longer trigger a 64 MB sidecar compile.
- Daemon becomes API-only: delete the SPA embed pipeline and the legacy HTML renderer.
- No regression in the teaching flow (ACP, teaching MCP, SSE-driven UI updates, notifications).

## User Stories

### Phase A — daemon lifecycle

### US-001: Kill-don't-reuse daemon startup
**Description:** As a developer, I want every app launch to run a daemon from the current sidecar binary so that rebuilds are always visible.

**Acceptance Criteria:**
- [ ] `start_app_daemon` (`src-tauri/src/main.rs`) no longer returns a reused daemon: if `daemon.json` names a live pid, SIGTERM it, wait for exit (bounded, then SIGKILL), then spawn fresh
- [ ] Stale/invalid `daemon.json` (dead pid, unparseable) is handled without error
- [ ] Clean app exit still shuts the daemon down (existing `/api/shutdown` path unchanged)
- [ ] Manual check: launch app, note daemon pid; relaunch app; old pid is gone, new pid in `daemon.json`
- [ ] `cargo build` and existing tests pass

### Phase B — cross-origin auth (daemon still serves the SPA; app keeps working after each story)

### US-002: Daemon accepts cross-origin authenticated clients
**Description:** As the future Tauri-served frontend, I need the daemon API to accept requests from a different origin so the UI no longer has to be same-origin with the API.

**Acceptance Criteria:**
- [ ] Daemon answers CORS preflight and sets `Access-Control-Allow-Origin` for an allowlist: `tauri://localhost`, `http://tauri.localhost`, plus `http://localhost:<vite port>` origins when a dev env flag is set (e.g. `OVERLEARN_DEV_ORIGINS`)
- [ ] Non-allowlisted origins get no CORS headers (same-origin requests unaffected)
- [ ] `GET /api/events` accepts the bearer token via `?token=` query param in addition to header/cookie
- [ ] All other `/api/*` routes continue to require `Authorization: Bearer` (or existing cookie)
- [ ] Contract tests in `test/contract/daemon.test.ts` cover: preflight, allowed-origin request, query-token SSE connect, and 401 for a bad query token
- [ ] Typecheck and `bun run test` pass

### US-003: Frontend gets daemon address and token over Tauri IPC
**Description:** As the React app, I want to discover the daemon and authenticate via IPC instead of relying on being served by the daemon, so I can run from any origin.

**Acceptance Criteria:**
- [ ] New Tauri `invoke` command (e.g. `daemon_info`) returns `{ port, token }`
- [ ] `ui/src/lib/api.ts` resolves a base URL: same-origin relative paths when served by the daemon (transitional), absolute `http://127.0.0.1:<port>` from `daemon_info` when running under Tauri on another origin
- [ ] All `fetch` calls send `Authorization: Bearer <token>` when a token is known
- [ ] SSE connects via `EventSource` with `?token=` when cross-origin
- [ ] App still works end-to-end in the current (daemon-served) mode
- [ ] Typecheck passes; verify the running app in the webview (courses load, SSE updates arrive)

### Phase C — the flip

### US-004: Tauri owns the frontend; dev gets HMR
**Description:** As a developer, I want `tauri dev` to serve the UI from Vite with hot reload, and production builds to bundle `ui/dist` into the app.

**Acceptance Criteria:**
- [ ] `tauri.conf.json`: `frontendDist` points at `../ui/dist`, `devUrl` at the Vite dev server; `beforeDevCommand` runs Vite, `beforeBuildCommand` runs the UI build
- [ ] `navigate_to_daemon` and the `/?token=` cookie bootstrap are removed; the window loads the bundled UI, which uses IPC + header auth (US-003)
- [ ] `tauri dev`: editing a component in `ui/src` hot-reloads in the app window without any rebuild
- [ ] `tauri build --debug` produces an app where the packaged UI works against the spawned daemon
- [ ] Rust + TS typechecks pass; verify the flow in the dev webview (onboarding or settings loads, agent list renders)

### US-005: Delete the embed pipeline and legacy UI
**Description:** As a maintainer, I want the daemon to be API-only so there is one UI path and no dead code.

**Acceptance Criteria:**
- [ ] Deleted: `scripts/embed-ui-assets.ts`, `src/daemon/spa-assets.gen.ts` (and gitignore entry), `src/daemon/spa.ts`
- [ ] Deleted: `src/daemon/ui.ts` and its test, plus `markdown.ts` / `lessons.ts` / `glossary.ts` renderers if nothing else imports them (verify imports first)
- [ ] Daemon returns a JSON 404 for non-`/api` routes; `OVERLEARN_LEGACY_UI` env flag removed
- [ ] `package.json` scripts (`build`, `typecheck`, `test`, `ui:build`, `app:*`) updated to drop `--ensure`/`--build` embed steps; full `bun run build && bun run app:copy-sidecar` still succeeds
- [ ] Repo-wide grep finds no references to removed modules; typecheck and all test suites pass

### US-006: End-to-end verification of the packaged app
**Description:** As a user, I want the packaged app to behave exactly as before the migration.

**Acceptance Criteria:**
- [ ] `bun run app:build` (or `tauri build --debug`) produces an installable artifact
- [ ] Fresh data dir: onboarding → agent selection → tutorial course creation works
- [ ] A teaching turn round-trips: submit → agent streams → MCP writes → SSE updates UI; native notification fires when unfocused
- [ ] Relaunch replaces the daemon (US-001 behavior observed in packaged app)
- [ ] `check:version` passes; README/docs updated where they describe the embed pipeline

## Functional Requirements

- FR-1: On startup the shell must terminate any daemon referenced by `daemon.json` before spawning a new one; it must never attach to an existing daemon.
- FR-2: The daemon must expose CORS for an explicit origin allowlist (`tauri://localhost`, `http://tauri.localhost`, dev origins via `OVERLEARN_DEV_ORIGINS`) and reject others by omission of CORS headers.
- FR-3: `/api/events` must accept `?token=<bearer>` as an authentication method; all other routes keep header/cookie auth.
- FR-4: The shell must expose a `daemon_info` IPC command returning the daemon's port and token to the frontend.
- FR-5: The frontend must send `Authorization: Bearer` on all API fetches and use the query token for `EventSource`.
- FR-6: `tauri.conf.json` must use `frontendDist: ../ui/dist` and `devUrl` for dev; the webview must never navigate to the daemon origin.
- FR-7: The daemon must serve only `/api/*` and `/mcp/*`; all other paths return a JSON 404.
- FR-8: The SPA embed pipeline and legacy HTML renderer must be fully removed, including build-script references.
- FR-9: The `.dmg` must remain the single distributable, containing the Tauri app (with bundled UI) and the `learn` sidecar.

## Non-Goals

- No browser-tab access to Overlearn (daemon serves no HTML; deliberate loss).
- No graceful drain of in-flight turns from orphaned daemons — they are killed immediately.
- No changes to the teaching flow: ACP adapters, orchestrator, teaching MCP tools, store schema all untouched.
- No multi-window or multi-daemon support.
- No remote/non-loopback access; the daemon stays bound to `127.0.0.1`.
- No change to `learn mcp-proxy` or the data-dir layout.

## Technical Considerations

- **Windows origin:** Tauri serves from `http://tauri.localhost` on Windows and `tauri://localhost` on macOS/Linux — allowlist both even though Windows isn't shipped yet.
- **Vite proxy:** `ui/vite.config.ts`'s `/api` proxy becomes unnecessary once CORS + header auth land (dev frontend talks to the daemon directly). Remove it in US-005 or keep briefly for browserless UI work.
- **Dev daemon source:** `tauri dev` still spawns the compiled sidecar. Daemon-code changes keep requiring `bun run build && app:copy-sidecar`; only UI changes become free. A debug-only path that spawns `bun src/cli/index.ts daemon` from the repo could remove that too — see Open Questions.
- **Token exposure:** query-param token appears only on the SSE URL over loopback; equivalent exposure class to `daemon.json` itself (local file with the token).
- **Sequencing safety:** Phases A and B are shippable independently and keep the daemon-served SPA working; only US-004 changes what users load.
- **Old installed binary:** `~/.local/bin/learn` predates the current architecture; unrelated to this migration but should be reinstalled to avoid confusion from `learn __daemon` processes.

## Success Metrics

- UI change → visible in running dev app in under 5 seconds (today: minutes, full rebuild).
- Zero occurrences of "rebuilt but seeing old UI" — verified by relaunch always rotating the daemon pid.
- Sidecar binary shrinks (UI assets no longer embedded).
- Net code deletion: embed pipeline + legacy UI (~thousands of lines) removed.

## Open Questions

- Should debug builds of the shell spawn the daemon from source (`bun src/cli/index.ts daemon`) so daemon changes also skip the compile step?
- Does anything besides `ui.ts` import the `markdown.ts`/`lessons.ts`/`glossary.ts` renderers (e.g. demo rendering in API responses)? Verify before deleting.
- Should `daemon_info` also carry the daemon version for a sanity assert in the frontend?
