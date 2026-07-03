import {
  chmod,
  mkdir,
  readdir,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";

import {
  getCoursesDir,
  readCourseManifest,
  resolveCourseDirForWait,
} from "../course";

export const REGISTRY_BUNDLE_FORMAT_VERSION = 1;
export const MAX_REGISTRY_BUNDLE_BYTES = 5 * 1024 * 1024;

const DEFAULT_REGISTRY_URL = "https://overlearn.org";
const DEFAULT_GITHUB_API_BASE = "https://api.github.com";
const DEFAULT_GITHUB_OAUTH_BASE = "https://github.com";
const DEFAULT_GITHUB_CLIENT_ID = "TODO_CREATE_GITHUB_OAUTH_APP_CLIENT_ID";
const CONFIG_DIR_ENV = "OVERLEARN_CONFIG_DIR";

type Env = Readonly<Record<string, string | undefined>>;

export type RegistryBundle = Readonly<{
  formatVersion: typeof REGISTRY_BUNDLE_FORMAT_VERSION;
  files: Readonly<Record<string, string>>;
}>;

type GitHubDeviceCode = Readonly<{
  deviceCode: string;
  userCode: string;
  verificationUri: string;
  expiresIn: number;
  interval: number;
}>;

type StoredGitHubToken = Readonly<{
  accessToken: string;
  tokenType?: string;
  scope?: string;
  fetchedAt: string;
}>;

type PublishedCourse = Readonly<{
  slug: string;
  registryUrl: string;
  courseDir: string;
  publishedAt: string;
}>;

type PublishedRegistry = Readonly<{
  version: 1;
  courses: Readonly<Record<string, PublishedCourse>>;
}>;

type PublishResponse = Readonly<{
  slug: string;
  url: string;
  course?: unknown;
}>;

type ShareOptions = Readonly<{
  name?: string;
  json: boolean;
  env?: Env;
}>;

type UnpublishOptions = Readonly<{
  name?: string;
  json: boolean;
  env?: Env;
}>;

type FetchOptions = Readonly<{
  input: string;
  force: boolean;
  json: boolean;
  env?: Env;
}>;

const textEncoder = new TextEncoder();

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const hasErrorCode = (error: unknown, code: string): boolean =>
  isRecord(error) && error["code"] === code;

const statIfExists = async (path: string): Promise<Awaited<ReturnType<typeof stat>> | undefined> => {
  try {
    return await stat(path);
  } catch (error) {
    if (hasErrorCode(error, "ENOENT")) {
      return undefined;
    }

    throw error;
  }
};

const pathExists = async (path: string): Promise<boolean> =>
  (await statIfExists(path)) !== undefined;

const directoryExists = async (path: string): Promise<boolean> => {
  const info = await statIfExists(path);
  return info?.isDirectory() ?? false;
};

const normalizeRegistryUrl = (url: string): string => url.replace(/\/+$/, "");

const registryUrlFromEnv = (env: Env): string =>
  normalizeRegistryUrl(env["OVERLEARN_REGISTRY_URL"] ?? DEFAULT_REGISTRY_URL);

const configDirFromEnv = (env: Env): string =>
  resolve(env[CONFIG_DIR_ENV] ?? join(homedir(), ".overlearn"));

const githubApiBaseFromEnv = (env: Env): string =>
  normalizeRegistryUrl(env["GITHUB_API_BASE"] ?? DEFAULT_GITHUB_API_BASE);

const githubOauthBaseFromEnv = (env: Env): string =>
  normalizeRegistryUrl(env["GITHUB_OAUTH_BASE"] ?? DEFAULT_GITHUB_OAUTH_BASE);

const githubClientIdFromEnv = (env: Env): string =>
  env["OVERLEARN_GITHUB_CLIENT_ID"] ??
  env["GITHUB_CLIENT_ID"] ??
  DEFAULT_GITHUB_CLIENT_ID;

const readJsonFile = async (path: string): Promise<unknown> =>
  JSON.parse(await Bun.file(path).text()) as unknown;

const byteLength = (value: string): number => textEncoder.encode(value).byteLength;

const bundleByteLength = (bundle: RegistryBundle): number =>
  byteLength(JSON.stringify(bundle));

const filePathFromBundlePath = (root: string, bundlePath: string): string =>
  join(root, ...bundlePath.split("/"));

const hasSafeSegments = (path: string): boolean =>
  path.length > 0 &&
  !path.startsWith("/") &&
  !path.includes("\\") &&
  path
    .split("/")
    .every((segment) => segment.length > 0 && segment !== "." && segment !== "..");

const isAllowedBundlePath = (path: string): boolean => {
  if (!hasSafeSegments(path) || path.split("/").includes(".overlearn")) {
    return false;
  }

  if (path === "course.json" || path === "glossary.json") {
    return true;
  }

  if (path.startsWith("lessons/")) {
    return path.endsWith(".md");
  }

  if (path.startsWith("demos/")) {
    return path.endsWith(".html");
  }

  if (path.startsWith("instructions/")) {
    return path.endsWith(".md");
  }

  return false;
};

const listFiles = async (
  directory: string,
  bundlePrefix: string,
): Promise<readonly string[]> => {
  if (!(await directoryExists(directory))) {
    return [];
  }

  const entries = (await readdir(directory, { withFileTypes: true })).sort(
    (left, right) => left.name.localeCompare(right.name),
  );
  const files: string[] = [];

  for (const entry of entries) {
    const bundlePath = `${bundlePrefix}/${entry.name}`;
    const absolutePath = join(directory, entry.name);

    if (entry.isDirectory()) {
      files.push(...(await listFiles(absolutePath, bundlePath)));
      continue;
    }

    if (entry.isFile()) {
      files.push(bundlePath);
    }
  }

  return files;
};

const sourceBundlePaths = async (courseDir: string): Promise<readonly string[]> => {
  const paths = [
    "course.json",
    ...((await pathExists(join(courseDir, "glossary.json")))
      ? ["glossary.json"]
      : []),
    ...(await listFiles(join(courseDir, "lessons"), "lessons")),
    ...(await listFiles(join(courseDir, "demos"), "demos")),
    ...(await listFiles(join(courseDir, "instructions"), "instructions")),
  ];

  return paths.filter(isAllowedBundlePath);
};

export const assertRegistryBundle = (value: unknown): RegistryBundle => {
  if (!isRecord(value) || value["formatVersion"] !== REGISTRY_BUNDLE_FORMAT_VERSION) {
    throw new Error(
      `Invalid registry bundle: expected formatVersion ${REGISTRY_BUNDLE_FORMAT_VERSION}.`,
    );
  }

  const filesValue = value["files"];
  if (!isRecord(filesValue)) {
    throw new Error("Invalid registry bundle: expected files object.");
  }

  const entries = Object.entries(filesValue).sort(([left], [right]) =>
    left.localeCompare(right),
  );

  if (!entries.some(([path]) => path === "course.json")) {
    throw new Error("Invalid registry bundle: missing course.json.");
  }

  const files: Record<string, string> = {};
  for (const [path, contents] of entries) {
    if (!isAllowedBundlePath(path)) {
      throw new Error(`Invalid registry bundle path: ${path}`);
    }

    if (typeof contents !== "string") {
      throw new Error(`Invalid registry bundle file contents for ${path}.`);
    }

    files[path] = contents;
  }

  const bundle: RegistryBundle = {
    formatVersion: REGISTRY_BUNDLE_FORMAT_VERSION,
    files,
  };

  if (bundleByteLength(bundle) > MAX_REGISTRY_BUNDLE_BYTES) {
    throw new Error("Invalid registry bundle: bundle exceeds 5 MB.");
  }

  return bundle;
};

export const buildRegistryBundle = async (
  courseDir: string,
): Promise<RegistryBundle> => {
  await readCourseManifest(courseDir);

  const paths = await sourceBundlePaths(courseDir);
  const files: Record<string, string> = {};

  for (const path of paths) {
    files[path] = await Bun.file(filePathFromBundlePath(courseDir, path)).text();
  }

  return assertRegistryBundle({
    formatVersion: REGISTRY_BUNDLE_FORMAT_VERSION,
    files,
  });
};

const parseStoredGitHubToken = (value: unknown): StoredGitHubToken | undefined => {
  if (!isRecord(value) || typeof value["accessToken"] !== "string") {
    return undefined;
  }

  const tokenType = value["tokenType"];
  const scope = value["scope"];
  const fetchedAt = value["fetchedAt"];

  return {
    accessToken: value["accessToken"],
    ...(typeof tokenType === "string" ? { tokenType } : {}),
    ...(typeof scope === "string" ? { scope } : {}),
    fetchedAt: typeof fetchedAt === "string" ? fetchedAt : new Date(0).toISOString(),
  };
};

const tokenPath = (env: Env): string =>
  join(configDirFromEnv(env), "github-token.json");

const loadStoredGitHubToken = async (
  env: Env,
): Promise<StoredGitHubToken | undefined> => {
  const path = tokenPath(env);
  if (!(await pathExists(path))) {
    return undefined;
  }

  return parseStoredGitHubToken(await readJsonFile(path));
};

const writeStoredGitHubToken = async (
  token: StoredGitHubToken,
  env: Env,
): Promise<void> => {
  const path = tokenPath(env);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(token, null, 2)}\n`, {
    encoding: "utf8",
    mode: 0o600,
  });
  await chmod(path, 0o600);
};

const githubHeaders = (token: string): Record<string, string> => ({
  Accept: "application/vnd.github+json",
  Authorization: `Bearer ${token}`,
  "User-Agent": "overlearn-cli",
});

const githubTokenValid = async (token: string, env: Env): Promise<boolean> => {
  try {
    const response = await fetch(`${githubApiBaseFromEnv(env)}/user`, {
      headers: githubHeaders(token),
    });

    return response.ok;
  } catch {
    return false;
  }
};

const parseDeviceCode = (value: unknown): GitHubDeviceCode => {
  if (!isRecord(value)) {
    throw new Error("GitHub device flow returned an invalid response.");
  }

  const deviceCode = value["device_code"];
  const userCode = value["user_code"];
  const verificationUri = value["verification_uri"];
  const expiresIn = value["expires_in"];
  const interval = value["interval"];

  if (
    typeof deviceCode !== "string" ||
    typeof userCode !== "string" ||
    typeof verificationUri !== "string" ||
    typeof expiresIn !== "number"
  ) {
    throw new Error("GitHub device flow returned an invalid response.");
  }

  return {
    deviceCode,
    userCode,
    verificationUri,
    expiresIn,
    interval: typeof interval === "number" ? interval : 5,
  };
};

const requestDeviceCode = async (env: Env): Promise<GitHubDeviceCode> => {
  const clientId = githubClientIdFromEnv(env);
  if (clientId === DEFAULT_GITHUB_CLIENT_ID) {
    throw new Error(
      "Set OVERLEARN_GITHUB_CLIENT_ID to a GitHub OAuth app client id before sharing.",
    );
  }

  const body = new URLSearchParams({
    client_id: clientId,
    scope: "read:user",
  });
  const response = await fetch(`${githubOauthBaseFromEnv(env)}/login/device/code`, {
    method: "POST",
    headers: {
      Accept: "application/json",
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body,
  });

  if (!response.ok) {
    throw new Error(`GitHub device flow failed: ${await response.text()}`);
  }

  return parseDeviceCode(await response.json());
};

const sleep = async (ms: number): Promise<void> =>
  new Promise((resolveSleep) => setTimeout(resolveSleep, ms));

const pollIntervalMs = (deviceCode: GitHubDeviceCode, env: Env): number => {
  const override = env["OVERLEARN_GITHUB_DEVICE_POLL_MS"];
  if (override !== undefined && /^\d+$/.test(override)) {
    return Number.parseInt(override, 10);
  }

  return Math.max(deviceCode.interval, 1) * 1000;
};

const pollDeviceToken = async (
  deviceCode: GitHubDeviceCode,
  env: Env,
): Promise<StoredGitHubToken> => {
  const clientId = githubClientIdFromEnv(env);
  const expiresAt = Date.now() + deviceCode.expiresIn * 1000;
  let intervalMs = pollIntervalMs(deviceCode, env);

  while (Date.now() < expiresAt) {
    if (intervalMs > 0) {
      await sleep(intervalMs);
    }

    const response = await fetch(
      `${githubOauthBaseFromEnv(env)}/login/oauth/access_token`,
      {
        method: "POST",
        headers: {
          Accept: "application/json",
          "Content-Type": "application/x-www-form-urlencoded",
        },
        body: new URLSearchParams({
          client_id: clientId,
          device_code: deviceCode.deviceCode,
          grant_type: "urn:ietf:params:oauth:grant-type:device_code",
        }),
      },
    );
    const body = (await response.json()) as unknown;

    if (!isRecord(body)) {
      throw new Error("GitHub token polling returned an invalid response.");
    }

    const accessToken = body["access_token"];
    if (response.ok && typeof accessToken === "string") {
      const tokenType = body["token_type"];
      const scope = body["scope"];

      return {
        accessToken,
        ...(typeof tokenType === "string" ? { tokenType } : {}),
        ...(typeof scope === "string" ? { scope } : {}),
        fetchedAt: new Date().toISOString(),
      };
    }

    const error = body["error"];
    if (error === "authorization_pending") {
      continue;
    }

    if (error === "slow_down") {
      intervalMs += 5000;
      continue;
    }

    if (typeof error === "string") {
      throw new Error(`GitHub device flow failed: ${error}`);
    }

    throw new Error("GitHub device flow failed.");
  }

  throw new Error("GitHub device flow expired before authorization completed.");
};

const getGitHubToken = async (env: Env): Promise<string> => {
  const stored = await loadStoredGitHubToken(env);
  if (stored !== undefined && (await githubTokenValid(stored.accessToken, env))) {
    return stored.accessToken;
  }

  const deviceCode = await requestDeviceCode(env);
  console.error(
    `Open ${deviceCode.verificationUri} and enter code ${deviceCode.userCode}.`,
  );

  const token = await pollDeviceToken(deviceCode, env);
  await writeStoredGitHubToken(token, env);
  return token.accessToken;
};

const parsePublishResponse = (value: unknown): PublishResponse => {
  if (!isRecord(value)) {
    throw new Error("Registry returned an invalid publish response.");
  }

  const slug = value["slug"];
  const url = value["url"];

  if (typeof slug !== "string" || typeof url !== "string") {
    throw new Error("Registry returned an invalid publish response.");
  }

  return {
    slug,
    url,
    ...(value["course"] === undefined ? {} : { course: value["course"] }),
  };
};

const parseHttpError = async (response: Response): Promise<string> => {
  const body = await response.text();
  if (body.trim().length === 0) {
    return `${response.status} ${response.statusText}`;
  }

  try {
    const parsed = JSON.parse(body) as unknown;
    if (isRecord(parsed) && typeof parsed["error"] === "string") {
      return parsed["error"];
    }
  } catch {
    return body;
  }

  return body;
};

const publishedRegistryPath = (env: Env): string =>
  join(configDirFromEnv(env), "published-courses.json");

const emptyPublishedRegistry = (): PublishedRegistry => ({
  version: 1,
  courses: {},
});

const parsePublishedRegistry = (value: unknown): PublishedRegistry => {
  if (!isRecord(value) || value["version"] !== 1 || !isRecord(value["courses"])) {
    return emptyPublishedRegistry();
  }

  const courses: Record<string, PublishedCourse> = {};
  for (const [key, entry] of Object.entries(value["courses"])) {
    if (!isRecord(entry)) {
      continue;
    }

    const slug = entry["slug"];
    const registryUrl = entry["registryUrl"];
    const courseDir = entry["courseDir"];
    const publishedAt = entry["publishedAt"];

    if (
      typeof slug === "string" &&
      typeof registryUrl === "string" &&
      typeof courseDir === "string" &&
      typeof publishedAt === "string"
    ) {
      courses[key] = { slug, registryUrl, courseDir, publishedAt };
    }
  }

  return { version: 1, courses };
};

const loadPublishedRegistry = async (env: Env): Promise<PublishedRegistry> => {
  const path = publishedRegistryPath(env);
  if (!(await pathExists(path))) {
    return emptyPublishedRegistry();
  }

  return parsePublishedRegistry(await readJsonFile(path));
};

const writePublishedRegistry = async (
  registry: PublishedRegistry,
  env: Env,
): Promise<void> => {
  const path = publishedRegistryPath(env);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(registry, null, 2)}\n`, {
    encoding: "utf8",
    mode: 0o600,
  });
  await chmod(path, 0o600);
};

const publishedCourseKey = (registryUrl: string, courseDir: string): string =>
  `${normalizeRegistryUrl(registryUrl)}\n${resolve(courseDir)}`;

const savePublishedCourse = async (
  courseDir: string,
  registryUrl: string,
  slug: string,
  env: Env,
): Promise<void> => {
  const registry = await loadPublishedRegistry(env);

  await writePublishedRegistry(
    {
      version: 1,
      courses: {
        ...registry.courses,
        [publishedCourseKey(registryUrl, courseDir)]: {
          slug,
          registryUrl: normalizeRegistryUrl(registryUrl),
          courseDir: resolve(courseDir),
          publishedAt: new Date().toISOString(),
        },
      },
    },
    env,
  );
};

const removePublishedCourse = async (
  courseDir: string | undefined,
  registryUrl: string,
  slug: string,
  env: Env,
): Promise<void> => {
  if (courseDir === undefined) {
    return;
  }

  const registry = await loadPublishedRegistry(env);
  const key = publishedCourseKey(registryUrl, courseDir);
  const nextCourses = { ...registry.courses };

  if (nextCourses[key]?.slug === slug) {
    delete nextCourses[key];
  }

  await writePublishedRegistry({ version: 1, courses: nextCourses }, env);
};

const isValidRegistrySlug = (value: string): boolean =>
  /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(value);

export const parseCourseSlug = (input: string): string => {
  const trimmed = input.trim();
  if (trimmed.length === 0) {
    throw new Error("Course slug cannot be empty.");
  }

  try {
    const url = new URL(trimmed);
    const segments = url.pathname.split("/").filter((segment) => segment.length > 0);

    if (segments[0] === "c" && segments[1] !== undefined) {
      return parseCourseSlug(segments[1]);
    }

    if (
      segments[0] === "api" &&
      segments[1] === "courses" &&
      segments[2] !== undefined
    ) {
      return parseCourseSlug(segments[2]);
    }
  } catch {
    // Not a URL; validate below as a direct slug.
  }

  const slug = basename(trimmed);
  if (slug !== trimmed || !isValidRegistrySlug(slug)) {
    throw new Error(
      `Invalid course slug: ${input}. Use lowercase letters, numbers, and hyphens.`,
    );
  }

  return slug;
};

const resolvePublishedSlug = async (
  name: string | undefined,
  registryUrl: string,
  env: Env,
): Promise<Readonly<{ slug: string; courseDir?: string }>> => {
  if (name === undefined) {
    const courseDir = await resolveCourseDirForWait(undefined, env);
    const registry = await loadPublishedRegistry(env);
    const entry = registry.courses[publishedCourseKey(registryUrl, courseDir)];

    if (entry === undefined) {
      throw new Error(`No published registry slug recorded for ${courseDir}.`);
    }

    return { slug: entry.slug, courseDir };
  }

  try {
    const courseDir = await resolveCourseDirForWait(name, env);
    const registry = await loadPublishedRegistry(env);
    const entry = registry.courses[publishedCourseKey(registryUrl, courseDir)];

    if (entry !== undefined) {
      return { slug: entry.slug, courseDir };
    }
  } catch {
    // Fall through and treat the argument as a slug or URL.
  }

  return { slug: parseCourseSlug(name) };
};

export const shareCourse = async ({
  name,
  json,
  env = process.env,
}: ShareOptions): Promise<string> => {
  const courseDir = await resolveCourseDirForWait(name, env);
  const bundle = await buildRegistryBundle(courseDir);
  const token = await getGitHubToken(env);
  const registryUrl = registryUrlFromEnv(env);

  const response = await fetch(`${registryUrl}/api/courses`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(bundle),
  });

  if (!response.ok) {
    throw new Error(`Registry publish failed: ${await parseHttpError(response)}`);
  }

  const published = parsePublishResponse(await response.json());
  await savePublishedCourse(courseDir, registryUrl, published.slug, env);

  return json
    ? JSON.stringify({
        ok: true,
        courseDir,
        registryUrl,
        slug: published.slug,
        url: published.url,
        ...(published.course === undefined ? {} : { course: published.course }),
      })
    : published.url;
};

export const unpublishCourse = async ({
  name,
  json,
  env = process.env,
}: UnpublishOptions): Promise<string> => {
  const registryUrl = registryUrlFromEnv(env);
  const target = await resolvePublishedSlug(name, registryUrl, env);
  const token = await getGitHubToken(env);

  const response = await fetch(`${registryUrl}/api/courses/${target.slug}`, {
    method: "DELETE",
    headers: {
      Authorization: `Bearer ${token}`,
    },
  });

  if (!response.ok) {
    throw new Error(`Registry unpublish failed: ${await parseHttpError(response)}`);
  }

  await removePublishedCourse(target.courseDir, registryUrl, target.slug, env);

  return json
    ? JSON.stringify({ ok: true, slug: target.slug })
    : `Unpublished ${target.slug}`;
};

const writeBundleToCourseDir = async (
  bundle: RegistryBundle,
  courseDir: string,
  force: boolean,
): Promise<void> => {
  if ((await statIfExists(courseDir)) !== undefined) {
    if (!force) {
      throw new Error(`Refusing to overwrite existing course directory: ${courseDir}`);
    }

    await rm(courseDir, { recursive: true, force: true });
  }

  for (const [path, contents] of Object.entries(bundle.files)) {
    const targetPath = filePathFromBundlePath(courseDir, path);
    await mkdir(dirname(targetPath), { recursive: true });
    await writeFile(targetPath, contents, "utf8");
  }

  await readCourseManifest(courseDir);
};

export const fetchCourse = async ({
  input,
  force,
  json,
  env = process.env,
}: FetchOptions): Promise<string> => {
  const slug = parseCourseSlug(input);
  const registryUrl = registryUrlFromEnv(env);
  const response = await fetch(`${registryUrl}/api/courses/${slug}/bundle`);

  if (!response.ok) {
    throw new Error(`Registry fetch failed: ${await parseHttpError(response)}`);
  }

  const bundle = assertRegistryBundle(await response.json());
  const courseDir = join(getCoursesDir(env), slug);

  await writeBundleToCourseDir(bundle, courseDir, force);

  return json
    ? JSON.stringify({ ok: true, slug, courseDir, registryUrl })
    : courseDir;
};
