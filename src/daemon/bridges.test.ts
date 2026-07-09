import { afterEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { getHarnessAdapterDefinition } from "../adapter/registry";
import {
  ensureManagedBridge,
  managedBridgeCommand,
  managedBridgeDirectory,
  managedBridgeEntry,
  verifyTarballIntegrity,
} from "./bridges";

const codexDefinition = getHarnessAdapterDefinition("codex");
if (codexDefinition === undefined || codexDefinition.managedBridge === undefined) {
  throw new Error("Missing Codex managed bridge definition.");
}

const tempDirectories: string[] = [];

const tempDirectory = async (prefix: string): Promise<string> => {
  const directory = await mkdtemp(join(tmpdir(), prefix));
  tempDirectories.push(directory);
  return directory;
};

const fixtureTarball = async (): Promise<Uint8Array> => {
  const directory = await tempDirectory("overlearn-bridge-tar-");
  const packageDirectory = join(directory, "package");
  const archive = join(directory, "bridge.tgz");
  await mkdir(join(packageDirectory, "dist"), { recursive: true });
  await writeFile(
    join(packageDirectory, "package.json"),
    JSON.stringify({
      name: codexDefinition.managedBridge?.package,
      version: codexDefinition.managedBridge?.version,
      type: "module",
      bin: { "codex-acp": "dist/index.js" },
    }),
  );
  await writeFile(join(packageDirectory, "dist", "index.js"), "export {};\n");

  const process = Bun.spawn(["tar", "-czf", archive, "-C", directory, "package"], {
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  const [exitCode, stderr] = await Promise.all([
    process.exited,
    new Response(process.stderr).text(),
  ]);
  if (exitCode !== 0) {
    throw new Error(`Could not create tar fixture: ${stderr}`);
  }

  return new Uint8Array(await Bun.file(archive).arrayBuffer());
};

const integrity = (bytes: Uint8Array): string =>
  `sha512-${createHash("sha512").update(bytes).digest("base64")}`;

const packument = (
  bytes: Uint8Array,
  publishedAt = "2020-01-01T00:00:00.000Z",
): Record<string, unknown> => ({
  name: codexDefinition.managedBridge?.package,
  "dist-tags": { latest: codexDefinition.managedBridge?.version },
  time: { [codexDefinition.managedBridge?.version ?? ""]: publishedAt },
  versions: {
    [codexDefinition.managedBridge?.version ?? ""]: {
      name: codexDefinition.managedBridge?.package,
      version: codexDefinition.managedBridge?.version,
      bin: { "codex-acp": "dist/index.js" },
      dependencies: {},
      dist: {
        tarball: "https://fake.registry/bridge.tgz",
        integrity: integrity(bytes),
      },
    },
  },
});

const injectedFetch = (
  metadata: unknown,
  tarball: Uint8Array,
): typeof fetch =>
  (async (input) => {
    const url = String(input);
    if (url === "https://fake.registry/bridge.tgz") {
      return new Response(tarball);
    }
    if (url.startsWith("https://fake.registry/")) {
      return Response.json(metadata);
    }

    return new Response("Not found", { status: 404 });
  }) as typeof fetch;

afterEach(async () => {
  await Promise.all(
    tempDirectories.splice(0).map((directory) =>
      rm(directory, { force: true, recursive: true }),
    ),
  );
});

describe("managed bridge downloads", () => {
  test("uses system Node for managed bridge scripts and reports it unavailable without Node", () => {
    expect(managedBridgeCommand("/tmp/bridge.js", { PATH: "/missing" }))
      .toBeUndefined();
    expect(managedBridgeCommand("/tmp/bridge.js")?.at(-1)).toBe(
      "/tmp/bridge.js",
    );
  });

  test("accepts matching integrity and rejects corrupted tarballs", async () => {
    const bytes = await fixtureTarball();
    expect(() =>
      verifyTarballIntegrity(bytes, { integrity: integrity(bytes) }),
    ).not.toThrow();
    expect(() =>
      verifyTarballIntegrity(bytes, {
        shasum: createHash("sha1").update(bytes).digest("hex"),
      }),
    ).not.toThrow();

    const corrupted = new Uint8Array(bytes);
    corrupted[0] = (corrupted[0] ?? 0) ^ 0xff;
    expect(() =>
      verifyTarballIntegrity(corrupted, { integrity: integrity(bytes) }),
    ).toThrow("integrity verification");

    const dataDir = await tempDirectory("overlearn-bridge-corrupt-");
    await expect(
      ensureManagedBridge(
        codexDefinition,
        dataDir,
        injectedFetch(packument(bytes), corrupted),
        { registryUrl: "https://fake.registry" },
      ),
    ).rejects.toThrow("integrity verification");
    expect(managedBridgeEntry(codexDefinition, dataDir)).toBeUndefined();
  });

  test("refuses a pinned version published less than seven days ago", async () => {
    const bytes = await fixtureTarball();
    const dataDir = await tempDirectory("overlearn-bridge-age-");

    await expect(
      ensureManagedBridge(
        codexDefinition,
        dataDir,
        injectedFetch(packument(bytes, "2026-07-05T00:00:00.000Z"), bytes),
        {
          registryUrl: "https://fake.registry",
          now: () => Date.parse("2026-07-09T00:00:00.000Z"),
        },
      ),
    ).rejects.toThrow("must be at least 7 days old");
    expect(managedBridgeEntry(codexDefinition, dataDir)).toBeUndefined();
  });

  test("rejects malformed packuments with a useful error", async () => {
    const bytes = await fixtureTarball();
    const dataDir = await tempDirectory("overlearn-bridge-packument-");

    await expect(
      ensureManagedBridge(
        codexDefinition,
        dataDir,
        injectedFetch({ name: "missing-versions" }, bytes),
        { registryUrl: "https://fake.registry" },
      ),
    ).rejects.toThrow("missing versions object");

    const secondDataDir = await tempDirectory("overlearn-bridge-json-");
    const malformedFetch = (async () =>
      new Response("not json", {
        headers: { "content-type": "application/json" },
      })) as unknown as typeof fetch;
    await expect(
      ensureManagedBridge(codexDefinition, secondDataDir, malformedFetch, {
        registryUrl: "https://fake.registry",
      }),
    ).rejects.toThrow("malformed JSON");
  });

  test("atomically replaces an incomplete directory and records only complete installs", async () => {
    const bytes = await fixtureTarball();
    const dataDir = await tempDirectory("overlearn-bridge-atomic-");
    const target = managedBridgeDirectory(codexDefinition, dataDir);
    if (target === undefined) {
      throw new Error("Missing managed bridge target.");
    }
    await mkdir(join(target, "dist"), { recursive: true });
    await writeFile(join(target, "dist", "index.js"), "partial\n");
    expect(managedBridgeEntry(codexDefinition, dataDir)).toBeUndefined();

    const entry = await ensureManagedBridge(
      codexDefinition,
      dataDir,
      injectedFetch(packument(bytes), bytes),
      { registryUrl: "https://fake.registry" },
    );
    expect(entry).toBe(join(target, "dist", "index.js"));
    expect(managedBridgeEntry(codexDefinition, dataDir)).toBe(entry);
  });

  test("single-flights concurrent installs of the same bridge", async () => {
    const bytes = await fixtureTarball();
    const dataDir = await tempDirectory("overlearn-bridge-flight-");
    let metadataRequests = 0;
    let tarballRequests = 0;
    const fetchImpl = (async (input) => {
      if (String(input) === "https://fake.registry/bridge.tgz") {
        tarballRequests += 1;
        return new Response(bytes);
      }
      metadataRequests += 1;
      return Response.json(packument(bytes));
    }) as typeof fetch;

    const [first, second] = await Promise.all([
      ensureManagedBridge(codexDefinition, dataDir, fetchImpl, {
        registryUrl: "https://fake.registry",
      }),
      ensureManagedBridge(codexDefinition, dataDir, fetchImpl, {
        registryUrl: "https://fake.registry",
      }),
    ]);
    expect(first).toBe(second);
    expect(metadataRequests).toBe(1);
    expect(tarballRequests).toBe(1);
  });
});
