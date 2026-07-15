import { describe, expect, test } from "bun:test";

import {
  composerDraftStorageKey,
  readComposerDraft,
  writeComposerDraft,
} from "../../ui/src/lib/composer-draft";

const memoryStorage = () => {
  const values = new Map<string, string>();

  return {
    getItem: (key: string) => values.get(key) ?? null,
    removeItem: (key: string) => {
      values.delete(key);
    },
    setItem: (key: string, value: string) => {
      values.set(key, value);
    },
  };
};

describe("composer draft storage", () => {
  test("keeps drafts isolated by course", () => {
    const storage = memoryStorage();

    writeComposerDraft(12, "Draft for twelve", storage);
    writeComposerDraft(34, "Draft for thirty-four", storage);

    expect(readComposerDraft(12, storage)).toBe("Draft for twelve");
    expect(readComposerDraft(34, storage)).toBe("Draft for thirty-four");
    expect(composerDraftStorageKey(12)).not.toBe(composerDraftStorageKey(34));
  });

  test("removes only the submitted or cleared course draft", () => {
    const storage = memoryStorage();
    writeComposerDraft(12, "First", storage);
    writeComposerDraft(34, "Second", storage);

    writeComposerDraft(12, "", storage);

    expect(readComposerDraft(12, storage)).toBe("");
    expect(readComposerDraft(34, storage)).toBe("Second");
  });

  test("falls back safely when browser storage is unavailable", () => {
    const unavailable = {
      getItem: () => {
        throw new Error("unavailable");
      },
      removeItem: () => {
        throw new Error("unavailable");
      },
      setItem: () => {
        throw new Error("unavailable");
      },
    };

    expect(readComposerDraft(12, unavailable)).toBe("");
    expect(() => writeComposerDraft(12, "Draft", unavailable)).not.toThrow();
    expect(() => writeComposerDraft(12, "", unavailable)).not.toThrow();
  });
});
