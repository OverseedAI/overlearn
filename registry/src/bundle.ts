import type {
  CourseMetadata,
  Publisher,
  RegistryBundle,
  TopicOutline,
  ValidatedBundle,
} from "./types";

export const REGISTRY_BUNDLE_FORMAT_VERSION = 1;
export const MAX_REGISTRY_BUNDLE_BYTES = 5 * 1024 * 1024;

const textEncoder = new TextEncoder();

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const byteLength = (value: string): number => textEncoder.encode(value).byteLength;

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

const parseJson = (text: string, label: string): unknown => {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new Error(`Invalid ${label}: expected JSON.`);
  }
};

const parseTopic = (value: unknown, location: string): TopicOutline => {
  if (!isRecord(value)) {
    throw new Error(`Invalid course.json topic at ${location}.`);
  }

  const path = value["path"];
  const title = value["title"];
  const lesson = value["lesson"];
  const children = value["children"];

  if (
    typeof path !== "string" ||
    path.trim().length === 0 ||
    typeof title !== "string" ||
    title.trim().length === 0 ||
    (lesson !== undefined &&
      (typeof lesson !== "string" || lesson.trim().length === 0)) ||
    !Array.isArray(children)
  ) {
    throw new Error(`Invalid course.json topic at ${location}.`);
  }

  return {
    path: path.trim(),
    title: title.trim(),
    ...(lesson === undefined ? {} : { lesson: lesson.trim() }),
    children: children.map((child, index) =>
      parseTopic(child, `${location}.children[${index}]`),
    ),
  };
};

const countTopics = (topics: readonly TopicOutline[]): number =>
  topics.reduce(
    (total, topic) => total + 1 + countTopics(topic.children),
    0,
  );

const parseCourseManifest = (
  courseJson: string,
): Readonly<{ name: string; topics: readonly TopicOutline[] }> => {
  const value = parseJson(courseJson, "course.json");
  if (!isRecord(value)) {
    throw new Error("Invalid course.json: expected object.");
  }

  const formatVersion = value["formatVersion"];
  const name = value["name"];
  const topics = value["topics"];

  if (
    formatVersion !== 1 ||
    typeof name !== "string" ||
    name.trim().length === 0 ||
    !Array.isArray(topics)
  ) {
    throw new Error("Invalid course.json: expected formatVersion, name, and topics.");
  }

  return {
    name: name.trim(),
    topics: topics.map((topic, index) => parseTopic(topic, `topics[${index}]`)),
  };
};

const glossarySize = (glossaryJson: string | undefined): number => {
  if (glossaryJson === undefined) {
    return 0;
  }

  const value = parseJson(glossaryJson, "glossary.json");
  if (!Array.isArray(value)) {
    throw new Error("Invalid glossary.json: expected array.");
  }

  return value.length;
};

const assertBundleValue = (value: unknown): RegistryBundle => {
  if (!isRecord(value) || value["formatVersion"] !== REGISTRY_BUNDLE_FORMAT_VERSION) {
    throw new Error(
      `Invalid bundle: expected formatVersion ${REGISTRY_BUNDLE_FORMAT_VERSION}.`,
    );
  }

  const filesValue = value["files"];
  if (!isRecord(filesValue)) {
    throw new Error("Invalid bundle: expected files object.");
  }

  const files: Record<string, string> = {};
  for (const [path, contents] of Object.entries(filesValue).sort(([left], [right]) =>
    left.localeCompare(right),
  )) {
    if (!isAllowedBundlePath(path)) {
      throw new Error(`Invalid bundle path: ${path}`);
    }

    if (typeof contents !== "string") {
      throw new Error(`Invalid bundle contents for ${path}.`);
    }

    files[path] = contents;
  }

  if (files["course.json"] === undefined) {
    throw new Error("Invalid bundle: missing course.json.");
  }

  const bundle: RegistryBundle = {
    formatVersion: REGISTRY_BUNDLE_FORMAT_VERSION,
    files,
  };

  if (byteLength(JSON.stringify(bundle)) > MAX_REGISTRY_BUNDLE_BYTES) {
    throw new Error("Invalid bundle: bundle exceeds 5 MB.");
  }

  return bundle;
};

export const validateRegistryBundle = (value: unknown): ValidatedBundle => {
  const bundle = assertBundleValue(value);
  const manifest = parseCourseManifest(bundle.files["course.json"] ?? "");
  const demoCount = Object.keys(bundle.files).filter((path) =>
    path.startsWith("demos/"),
  ).length;

  return {
    bundle,
    courseName: manifest.name,
    topicCount: countTopics(manifest.topics),
    glossarySize: glossarySize(bundle.files["glossary.json"]),
    demoCount,
    fileCount: Object.keys(bundle.files).length,
    bundleBytes: byteLength(JSON.stringify(bundle)),
    topics: manifest.topics,
  };
};

export const courseMetadata = (
  validated: ValidatedBundle,
  publisher: Publisher,
  slug: string,
  now: string,
  previous: CourseMetadata | undefined,
): CourseMetadata => ({
  slug,
  title: validated.courseName,
  courseName: validated.courseName,
  publisher,
  topicCount: validated.topicCount,
  glossarySize: validated.glossarySize,
  demoCount: validated.demoCount,
  fileCount: validated.fileCount,
  bundleBytes: validated.bundleBytes,
  publishedAt: previous?.publishedAt ?? now,
  updatedAt: now,
  topics: validated.topics,
});

export const slugify = (value: string): string => {
  const slug = value
    .trim()
    .toLocaleLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .replace(/-{2,}/g, "-");

  return slug.length === 0 ? "course" : slug;
};

export const isValidSlug = (value: string): boolean =>
  /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(value);
