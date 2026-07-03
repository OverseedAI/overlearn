import { watch, type FSWatcher } from "node:fs";
import { basename, dirname } from "node:path";

type TopicEventEmitterOptions = Readonly<{
  courseJson: string;
  debounceMs?: number;
  emit: () => void | Promise<void>;
  onError?: (error: unknown) => void;
}>;

type TopicEventEmitter = Readonly<{
  schedule: () => void;
  close: () => void;
}>;

export type TopicWatcher = Readonly<{
  close: () => void;
}>;

export const createTopicEventEmitter = (
  options: TopicEventEmitterOptions,
): TopicEventEmitter => {
  const debounceMs = options.debounceMs ?? 100;
  let timer: ReturnType<typeof setTimeout> | undefined;

  const reportError = (error: unknown): void => {
    if (options.onError !== undefined) {
      options.onError(error);
    }
  };

  const schedule = (): void => {
    if (timer !== undefined) {
      clearTimeout(timer);
    }

    timer = setTimeout(() => {
      timer = undefined;
      void Promise.resolve(options.emit()).catch(reportError);
    }, debounceMs);
  };

  const close = (): void => {
    if (timer !== undefined) {
      clearTimeout(timer);
      timer = undefined;
    }
  };

  return { close, schedule };
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

export const watchTopicFile = (
  options: TopicEventEmitterOptions,
): TopicWatcher => {
  const emitter = createTopicEventEmitter(options);
  const courseFileName = basename(options.courseJson);
  const watcher: FSWatcher = watch(
    dirname(options.courseJson),
    (_eventType, fileName) => {
      const changedFileName = watchFileNameToString(fileName);
      // Atomic writes land via a `.course.json.*.tmp` rename; Bun's fs.watch
      // only reports the temp name, so match it too.
      if (
        changedFileName === undefined ||
        changedFileName === courseFileName ||
        changedFileName.startsWith(`.${courseFileName}.`)
      ) {
        emitter.schedule();
      }
    },
  );

  return {
    close: () => {
      watcher.close();
      emitter.close();
    },
  };
};
