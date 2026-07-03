import { isValidSlug, slugify } from "./bundle";
import type { CourseMetadata, Env } from "./types";

const metadataKey = (slug: string): string => `courses/${slug}`;
export const bundleKey = (slug: string): string => `courses/${slug}.json`;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const parseMetadata = (value: unknown): CourseMetadata | undefined => {
  if (!isRecord(value)) {
    return undefined;
  }

  const slug = value["slug"];
  const title = value["title"];
  const courseName = value["courseName"];
  const publisher = value["publisher"];
  const topicCount = value["topicCount"];
  const glossarySize = value["glossarySize"];
  const demoCount = value["demoCount"];
  const fileCount = value["fileCount"];
  const bundleBytes = value["bundleBytes"];
  const publishedAt = value["publishedAt"];
  const updatedAt = value["updatedAt"];
  const topics = value["topics"];

  if (
    typeof slug !== "string" ||
    typeof title !== "string" ||
    typeof courseName !== "string" ||
    !isRecord(publisher) ||
    typeof publisher["login"] !== "string" ||
    typeof topicCount !== "number" ||
    typeof glossarySize !== "number" ||
    typeof demoCount !== "number" ||
    typeof fileCount !== "number" ||
    typeof bundleBytes !== "number" ||
    typeof publishedAt !== "string" ||
    typeof updatedAt !== "string" ||
    !Array.isArray(topics)
  ) {
    return undefined;
  }

  const htmlUrl = publisher["htmlUrl"];

  return {
    slug,
    title,
    courseName,
    publisher: {
      login: publisher["login"],
      ...(typeof htmlUrl === "string" ? { htmlUrl } : {}),
    },
    topicCount,
    glossarySize,
    demoCount,
    fileCount,
    bundleBytes,
    publishedAt,
    updatedAt,
    topics: topics as CourseMetadata["topics"],
  };
};

export const getMetadata = async (
  env: Env,
  slug: string,
): Promise<CourseMetadata | undefined> => {
  const text = await env.META.get(metadataKey(slug));
  if (text === null) {
    return undefined;
  }

  return parseMetadata(JSON.parse(text) as unknown);
};

export const putMetadata = async (
  env: Env,
  metadata: CourseMetadata,
): Promise<void> => {
  await env.META.put(metadataKey(metadata.slug), JSON.stringify(metadata));
};

export const deleteMetadata = async (env: Env, slug: string): Promise<void> => {
  await env.META.delete(metadataKey(slug));
};

export const listMetadata = async (env: Env): Promise<readonly CourseMetadata[]> => {
  const listed = await env.META.list({ prefix: "courses/" });
  const courses = await Promise.all(
    listed.keys.map(async (key) => {
      const text = await env.META.get(key.name);
      return text === null ? undefined : parseMetadata(JSON.parse(text) as unknown);
    }),
  );

  return courses
    .filter((course): course is CourseMetadata => course !== undefined)
    .sort((left, right) => right.publishedAt.localeCompare(left.publishedAt));
};

export const chooseSlug = async (
  env: Env,
  courseName: string,
  login: string,
): Promise<Readonly<{ slug: string; previous?: CourseMetadata }>> => {
  const base = slugify(courseName);
  const baseMetadata = await getMetadata(env, base);

  if (baseMetadata === undefined || baseMetadata.publisher.login === login) {
    return baseMetadata === undefined
      ? { slug: base }
      : { slug: base, previous: baseMetadata };
  }

  const loginSlug = slugify(login);
  const candidate = `${base}-${loginSlug}`;
  const candidateMetadata = await getMetadata(env, candidate);

  if (
    candidateMetadata === undefined ||
    candidateMetadata.publisher.login === login
  ) {
    return candidateMetadata === undefined
      ? { slug: candidate }
      : { slug: candidate, previous: candidateMetadata };
  }

  for (let index = 2; index < 100; index += 1) {
    const fallback = `${candidate}-${index}`;
    const fallbackMetadata = await getMetadata(env, fallback);
    if (
      fallbackMetadata === undefined ||
      fallbackMetadata.publisher.login === login
    ) {
      return fallbackMetadata === undefined
        ? { slug: fallback }
        : { slug: fallback, previous: fallbackMetadata };
    }
  }

  throw new Error("Unable to allocate a course slug.");
};

export const requireSlug = (slug: string | undefined): string => {
  if (slug === undefined || !isValidSlug(slug)) {
    throw new Error("Invalid course slug.");
  }

  return slug;
};
