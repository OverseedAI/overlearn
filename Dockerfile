# syntax=docker/dockerfile:1

FROM oven/bun:1.3.14-debian AS build

WORKDIR /app

COPY package.json bun.lock bunfig.toml tsconfig.json ./
COPY src ./src

RUN bun install --frozen-lockfile
RUN bun run build

FROM debian:bookworm-slim AS runtime

COPY --from=build /app/dist/learn /usr/local/bin/learn

ENTRYPOINT ["/usr/local/bin/learn"]
CMD ["--help"]
