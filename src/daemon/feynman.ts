import { watch, type FSWatcher } from "node:fs";
import { basename, dirname } from "node:path";

type FeynmanEventEmitterOptions = Readonly<{
  activeFeynmanJson: string;
  debounceMs?: number;
  emit: () => void | Promise<void>;
  onError?: (error: unknown) => void;
}>;

type FeynmanEventEmitter = Readonly<{
  schedule: () => void;
  close: () => void;
}>;

export type FeynmanWatcher = Readonly<{
  close: () => void;
}>;

export const createFeynmanEventEmitter = (
  options: FeynmanEventEmitterOptions,
): FeynmanEventEmitter => {
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

export const watchFeynmanFile = (
  options: FeynmanEventEmitterOptions,
): FeynmanWatcher => {
  const emitter = createFeynmanEventEmitter(options);
  const activeFileName = basename(options.activeFeynmanJson);
  const watcher: FSWatcher = watch(
    dirname(options.activeFeynmanJson),
    (_eventType, fileName) => {
      const changedFileName = watchFileNameToString(fileName);
      if (
        changedFileName === undefined ||
        changedFileName === activeFileName ||
        changedFileName.startsWith(`.${activeFileName}.`)
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
