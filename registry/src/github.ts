import type { Env, Publisher } from "./types";

const DEFAULT_GITHUB_API_BASE = "https://api.github.com";

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const githubApiBase = (env: Env): string =>
  (env.GITHUB_API_BASE ?? DEFAULT_GITHUB_API_BASE).replace(/\/+$/, "");

const bearerToken = (request: Request): string | undefined => {
  const header = request.headers.get("Authorization");
  if (header === null) {
    return undefined;
  }

  const match = /^Bearer\s+(.+)$/i.exec(header);
  return match?.[1];
};

export const verifyGitHubPublisher = async (
  request: Request,
  env: Env,
): Promise<Publisher> => {
  const token = bearerToken(request);
  if (token === undefined || token.trim().length === 0) {
    throw new Response("Missing bearer token.", { status: 401 });
  }

  const response = await fetch(`${githubApiBase(env)}/user`, {
    headers: {
      Accept: "application/vnd.github+json",
      Authorization: `Bearer ${token}`,
      "User-Agent": "overlearn-registry-worker",
    },
  });

  if (!response.ok) {
    throw new Response("Invalid GitHub token.", { status: 401 });
  }

  const body = (await response.json()) as unknown;
  if (!isRecord(body) || typeof body["login"] !== "string") {
    throw new Response("GitHub returned an invalid user response.", {
      status: 502,
    });
  }

  const htmlUrl = body["html_url"];

  return {
    login: body["login"],
    ...(typeof htmlUrl === "string" ? { htmlUrl } : {}),
  };
};
