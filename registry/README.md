# Overlearn Registry Worker

Local first:

```sh
bun install
bun run dev
```

`wrangler dev --local` uses Miniflare for R2 and KV, so the registry is testable before R2 is enabled on the Cloudflare account.

Config:

- `GITHUB_CLIENT_ID` in `wrangler.toml` is a placeholder until a GitHub OAuth app exists.
- `GITHUB_API_BASE` can point at a local stub in tests.
- The CLI reads `OVERLEARN_REGISTRY_URL` and defaults to `https://overlearn.org`.
- The CLI reads `OVERLEARN_GITHUB_CLIENT_ID` for device flow until a baked default exists.

Deployment is wired in CI but gated on `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID`.
