import { watch } from "node:fs";
import type { FSWatcher } from "node:fs";
import { readdir, readFile, stat } from "node:fs/promises";
import { basename, join } from "node:path";

import { renderMarkdown } from "./markdown";

type GlossaryEntry = Readonly<{ term: string }>;

export type RenderedLesson = Readonly<{
  id: string;
  html: string;
  modifiedAtMs: number;
}>;

export type LessonSnapshot = Readonly<{
  lessons: readonly RenderedLesson[];
  selectedLessonId: string | undefined;
}>;

export type LessonEvent =
  | Readonly<{ action: "upsert"; lesson: RenderedLesson }>
  | Readonly<{ action: "delete"; id: string }>
  | Readonly<{ action: "snapshot"; snapshot: LessonSnapshot }>;

type LessonEventEmitterOptions = Readonly<{
  lessonsDir: string;
  debounceMs?: number;
  getGlossary?: () => readonly GlossaryEntry[];
  getDemoFiles?: () => ReadonlySet<string> | readonly string[];
  emit: (event: LessonEvent) => void | Promise<void>;
  onError?: (error: unknown) => void;
}>;

type LessonWatcherOptions = LessonEventEmitterOptions;

type LessonEventEmitter = Readonly<{
  scheduleFile: (fileName: string) => void;
  scheduleSnapshot: () => void;
  close: () => void;
}>;

export type LessonWatcher = Readonly<{
  close: () => void;
}>;

const LESSON_EXTENSION = ".md";

const hasErrorCode = (error: unknown, code: string): boolean =>
  typeof error === "object" &&
  error !== null &&
  "code" in error &&
  error.code === code;

export const isLessonFileName = (fileName: string): boolean =>
  fileName === basename(fileName) &&
  !fileName.includes("\\") &&
  fileName.endsWith(LESSON_EXTENSION) &&
  fileName.length > LESSON_EXTENSION.length;

export const lessonIdFromFileName = (fileName: string): string =>
  fileName.slice(0, -LESSON_EXTENSION.length);

export const readRenderedLessonFile = async (
  lessonsDir: string,
  fileName: string,
  glossary: readonly GlossaryEntry[] = [],
  demoFiles?: ReadonlySet<string> | readonly string[],
): Promise<RenderedLesson | undefined> => {
  if (!isLessonFileName(fileName)) {
    return undefined;
  }

  const filePath = join(lessonsDir, fileName);

  try {
    const fileStat = await stat(filePath);
    if (!fileStat.isFile()) {
      return undefined;
    }

    const markdown = await readFile(filePath, "utf8");
    return {
      id: lessonIdFromFileName(fileName),
      html: renderMarkdown(markdown, {
        glossary,
        ...(demoFiles === undefined ? {} : { demoFiles }),
      }),
      modifiedAtMs: fileStat.mtimeMs,
    };
  } catch (error) {
    if (hasErrorCode(error, "ENOENT")) {
      return undefined;
    }

    throw error;
  }
};

const latestLesson = (
  lessons: readonly RenderedLesson[],
): RenderedLesson | undefined =>
  lessons.reduce<RenderedLesson | undefined>((latest, lesson) => {
    if (latest === undefined) {
      return lesson;
    }

    if (lesson.modifiedAtMs > latest.modifiedAtMs) {
      return lesson;
    }

    if (
      lesson.modifiedAtMs === latest.modifiedAtMs &&
      lesson.id.localeCompare(latest.id) > 0
    ) {
      return lesson;
    }

    return latest;
  }, undefined);

export const readLessonSnapshot = async (
  lessonsDir: string,
  glossary: readonly GlossaryEntry[] = [],
  demoFiles?: ReadonlySet<string> | readonly string[],
): Promise<LessonSnapshot> => {
  const fileNames = (await readdir(lessonsDir))
    .filter(isLessonFileName)
    .sort((left, right) => left.localeCompare(right));
  const renderedLessons = await Promise.all(
    fileNames.map((fileName) =>
      readRenderedLessonFile(lessonsDir, fileName, glossary, demoFiles),
    ),
  );
  const lessons = renderedLessons.flatMap((lesson) =>
    lesson === undefined ? [] : [lesson],
  );

  return {
    lessons,
    selectedLessonId: latestLesson(lessons)?.id,
  };
};

export const readLessonChangeEvent = async (
  lessonsDir: string,
  fileName: string,
  glossary: readonly GlossaryEntry[] = [],
  demoFiles?: ReadonlySet<string> | readonly string[],
): Promise<LessonEvent | undefined> => {
  if (!isLessonFileName(fileName)) {
    return undefined;
  }

  const lesson = await readRenderedLessonFile(
    lessonsDir,
    fileName,
    glossary,
    demoFiles,
  );
  return lesson === undefined
    ? { action: "delete", id: lessonIdFromFileName(fileName) }
    : { action: "upsert", lesson };
};

export const createLessonEventEmitter = (
  options: LessonEventEmitterOptions,
): LessonEventEmitter => {
  const debounceMs = options.debounceMs ?? 100;
  const timers = new Map<string, ReturnType<typeof setTimeout>>();
  let snapshotTimer: ReturnType<typeof setTimeout> | undefined;

  const reportError = (error: unknown): void => {
    if (options.onError !== undefined) {
      options.onError(error);
    }
  };

  const scheduleFile = (fileName: string): void => {
    if (!isLessonFileName(fileName)) {
      return;
    }

    const existingTimer = timers.get(fileName);
    if (existingTimer !== undefined) {
      clearTimeout(existingTimer);
    }

    timers.set(
      fileName,
      setTimeout(() => {
        timers.delete(fileName);
        void (async () => {
          const event = await readLessonChangeEvent(
            options.lessonsDir,
            fileName,
            options.getGlossary?.() ?? [],
            options.getDemoFiles?.(),
          );
          if (event !== undefined) {
            await options.emit(event);
          }
        })().catch(reportError);
      }, debounceMs),
    );
  };

  const scheduleSnapshot = (): void => {
    if (snapshotTimer !== undefined) {
      clearTimeout(snapshotTimer);
    }

    snapshotTimer = setTimeout(() => {
      snapshotTimer = undefined;
      void (async () => {
        const snapshot = await readLessonSnapshot(
          options.lessonsDir,
          options.getGlossary?.() ?? [],
          options.getDemoFiles?.(),
        );
        await options.emit({ action: "snapshot", snapshot });
      })().catch(reportError);
    }, debounceMs);
  };

  const close = (): void => {
    for (const timer of timers.values()) {
      clearTimeout(timer);
    }
    timers.clear();

    if (snapshotTimer !== undefined) {
      clearTimeout(snapshotTimer);
      snapshotTimer = undefined;
    }
  };

  return { close, scheduleFile, scheduleSnapshot };
};

const watchFileNameToString = (
  fileName: string | Buffer | null,
): string | undefined => {
  if (typeof fileName === "string") {
    return fileName;
  }

  if (Buffer.isBuffer(fileName)) {
    return fileName.toString("utf8");
  }

  return undefined;
};

export const watchLessonDirectory = (
  options: LessonWatcherOptions,
): LessonWatcher => {
  const emitter = createLessonEventEmitter(options);
  const watcher: FSWatcher = watch(options.lessonsDir, (_eventType, fileName) => {
    const changedFileName = watchFileNameToString(fileName);
    if (changedFileName === undefined) {
      emitter.scheduleSnapshot();
      return;
    }

    emitter.scheduleFile(changedFileName);
  });

  return {
    close: () => {
      watcher.close();
      emitter.close();
    },
  };
};
