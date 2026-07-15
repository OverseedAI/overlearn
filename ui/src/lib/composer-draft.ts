const STORAGE_KEY_PREFIX = "overlearn-composer-draft";

type DraftStorage = Pick<Storage, "getItem" | "removeItem" | "setItem">;

export const composerDraftStorageKey = (courseId: number): string =>
  `${STORAGE_KEY_PREFIX}:${courseId}`;

export const readComposerDraft = (
  courseId: number,
  storage: DraftStorage = window.localStorage,
): string => {
  try {
    return storage.getItem(composerDraftStorageKey(courseId)) ?? "";
  } catch {
    return "";
  }
};

export const writeComposerDraft = (
  courseId: number,
  text: string,
  storage: DraftStorage = window.localStorage,
): void => {
  try {
    if (text.length === 0) {
      storage.removeItem(composerDraftStorageKey(courseId));
      return;
    }

    storage.setItem(composerDraftStorageKey(courseId), text);
  } catch {
    // Storage can be unavailable or full. The in-memory composer still works.
  }
};
