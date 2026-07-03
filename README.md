# overlearn

overlearn turns a coding harness into a personal teacher: a local `learn` CLI will coordinate a daemon, file-backed course state, and a browser UI so agents can teach interactively while learners respond in the browser. The PRD lives in [Notion](https://app.notion.com/p/3915b1d7dbd481299068f5d1bc0dfeb6).

## Dev Quickstart

```sh
bun install
bun test
bun run build
./dist/learn --version
```

## Registry

The course registry Worker lives in `registry/` and is local-first while R2 enablement is pending:

```sh
cd registry
bun install
bun run dev
```

Point the CLI at a local Worker with `OVERLEARN_REGISTRY_URL=http://127.0.0.1:8787`. GitHub device flow uses `OVERLEARN_GITHUB_CLIENT_ID` until the OAuth app client id exists.
