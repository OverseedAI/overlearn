export type Env = Readonly<{
  COURSES: R2Bucket;
  META: KVNamespace;
  GITHUB_API_BASE?: string;
  GITHUB_CLIENT_ID?: string;
}>;

export type RegistryBundle = Readonly<{
  formatVersion: 1;
  files: Readonly<Record<string, string>>;
}>;

export type TopicOutline = Readonly<{
  path: string;
  title: string;
  lesson?: string;
  children: readonly TopicOutline[];
}>;

export type Publisher = Readonly<{
  login: string;
  htmlUrl?: string;
}>;

export type CourseMetadata = Readonly<{
  slug: string;
  title: string;
  courseName: string;
  publisher: Publisher;
  topicCount: number;
  glossarySize: number;
  demoCount: number;
  fileCount: number;
  bundleBytes: number;
  publishedAt: string;
  updatedAt: string;
  topics: readonly TopicOutline[];
}>;

export type ValidatedBundle = Readonly<{
  bundle: RegistryBundle;
  courseName: string;
  topicCount: number;
  glossarySize: number;
  demoCount: number;
  fileCount: number;
  bundleBytes: number;
  topics: readonly TopicOutline[];
}>;
