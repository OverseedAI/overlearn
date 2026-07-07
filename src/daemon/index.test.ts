import { describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { daemonMetadataPath } from "./index";

describe("app daemon helpers", () => {
  test("uses the store data dir for daemon metadata", async () => {
    const dataDir = await mkdtemp(join(tmpdir(), "overlearn-daemon-meta-"));

    try {
      expect(daemonMetadataPath({ OVERLEARN_DATA_DIR: dataDir })).toBe(
        join(dataDir, "daemon.json"),
      );
    } finally {
      await rm(dataDir, { force: true, recursive: true });
    }
  });
});
