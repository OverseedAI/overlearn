import { createHash, randomUUID, timingSafeEqual } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import {
  mkdir,
  mkdtemp,
  rename,
  rm,
  unlink,
  writeFile,
} from "node:fs/promises";
import { basename, dirname, join, resolve, sep } from "node:path";

import type {
  HarnessAdapterDefinition,
  ManagedBridgeDefinition,
} from "../adapter/registry";

type Fetch = (
  input: string | URL | Request,
  init?: RequestInit,
) => Promise<Response>;

type UnknownRecord = Record<string, unknown>;

type PackageVersion = Readonly<{
  name: string;
  version: string;
  dist: Readonly<{
    tarball: string;
    integrity?: string;
    shasum?: string;
  }>;
  bin?: string | Readonly<Record<string, string>>;
  dependencies: Readonly<Record<string, string>>;
  optionalDependencies: Readonly<Record<string, string>>;
  peerDependencies: Readonly<Record<string, string>>;
  peerDependenciesMeta: Readonly<Record<string, Readonly<{ optional?: boolean }>>>;
  os?: readonly string[];
  cpu?: readonly string[];
}>;

type Packument = Readonly<{
  name: string;
  versions: Readonly<Record<string, PackageVersion>>;
  time: Readonly<Record<string, string>>;
  distTags: Readonly<Record<string, string>>;
}>;

export type ManagedBridgeStatus =
  | Readonly<{ state: "ready" }>
  | Readonly<{ state: "downloading" }>
  | Readonly<{ state: "error"; message: string }>;

type EnsureManagedBridgeOptions = Readonly<{
  registryUrl?: string;
  now?: () => number;
}>;

type ManagedBridgeServiceOptions = Readonly<{
  dataDir: string;
  fetchImpl?: Fetch;
  registryUrl?: string;
  now?: () => number;
  onStatus?: (
    definition: HarnessAdapterDefinition,
    status: ManagedBridgeStatus,
  ) => void;
}>;

export type ManagedBridgeService = Readonly<{
  ensure: (definition: HarnessAdapterDefinition) => Promise<string | undefined>;
  entry: (definition: HarnessAdapterDefinition) => string | undefined;
  status: (
    definition: HarnessAdapterDefinition,
  ) => ManagedBridgeStatus | undefined;
}>;

const defaultRegistryUrl = "https://registry.npmjs.org";
const minimumReleaseAgeMs = 7 * 24 * 60 * 60 * 1_000;
const installMarkerName = ".overlearn-bridge.json";
const singleFlights = new Map<string, Promise<string>>();

const isRecord = (value: unknown): value is UnknownRecord =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const stringRecord = (
  value: unknown,
  field: string,
): Readonly<Record<string, string>> => {
  if (value === undefined) {
    return {};
  }
  if (!isRecord(value)) {
    throw new Error(`Invalid npm packument: ${field} must be an object.`);
  }

  const entries = Object.entries(value);
  if (!entries.every(([, entry]) => typeof entry === "string")) {
    throw new Error(`Invalid npm packument: ${field} values must be strings.`);
  }

  return Object.fromEntries(entries) as Record<string, string>;
};

const optionalPeerRecord = (
  value: unknown,
): Readonly<Record<string, Readonly<{ optional?: boolean }>>> => {
  if (value === undefined) {
    return {};
  }
  if (!isRecord(value)) {
    throw new Error(
      "Invalid npm packument: peerDependenciesMeta must be an object.",
    );
  }

  return Object.fromEntries(
    Object.entries(value).map(([name, metadata]) => {
      if (!isRecord(metadata)) {
        throw new Error(
          `Invalid npm packument: peerDependenciesMeta.${name} must be an object.`,
        );
      }

      return [name, { optional: metadata["optional"] === true }];
    }),
  );
};

const optionalStringArray = (
  value: unknown,
  field: string,
): readonly string[] | undefined => {
  if (value === undefined) {
    return undefined;
  }
  if (!Array.isArray(value) || !value.every((entry) => typeof entry === "string")) {
    throw new Error(`Invalid npm packument: ${field} must be a string array.`);
  }

  return value;
};

const parsePackageVersion = (
  packageName: string,
  version: string,
  value: unknown,
): PackageVersion => {
  if (!isRecord(value) || !isRecord(value["dist"])) {
    throw new Error(
      `Invalid npm packument for ${packageName}@${version}: missing dist metadata.`,
    );
  }
  const dist = value["dist"];
  const tarball = dist["tarball"];
  if (typeof tarball !== "string" || tarball.length === 0) {
    throw new Error(
      `Invalid npm packument for ${packageName}@${version}: missing dist.tarball.`,
    );
  }
  const integrity = dist["integrity"];
  const shasum = dist["shasum"];
  if (typeof integrity !== "string" && typeof shasum !== "string") {
    throw new Error(
      `Invalid npm packument for ${packageName}@${version}: missing dist.integrity or dist.shasum.`,
    );
  }

  const binValue = value["bin"];
  let bin: PackageVersion["bin"];
  if (typeof binValue === "string") {
    bin = binValue;
  } else if (binValue !== undefined) {
    bin = stringRecord(binValue, "bin");
  }
  const os = optionalStringArray(value["os"], "os");
  const cpu = optionalStringArray(value["cpu"], "cpu");

  return {
    name:
      typeof value["name"] === "string" ? value["name"] : packageName,
    version:
      typeof value["version"] === "string" ? value["version"] : version,
    dist: {
      tarball,
      ...(typeof integrity === "string" ? { integrity } : {}),
      ...(typeof shasum === "string" ? { shasum } : {}),
    },
    ...(bin === undefined ? {} : { bin }),
    dependencies: stringRecord(value["dependencies"], "dependencies"),
    optionalDependencies: stringRecord(
      value["optionalDependencies"],
      "optionalDependencies",
    ),
    peerDependencies: stringRecord(
      value["peerDependencies"],
      "peerDependencies",
    ),
    peerDependenciesMeta: optionalPeerRecord(value["peerDependenciesMeta"]),
    ...(os === undefined ? {} : { os }),
    ...(cpu === undefined ? {} : { cpu }),
  };
};

const parsePackument = (packageName: string, value: unknown): Packument => {
  if (!isRecord(value) || !isRecord(value["versions"])) {
    throw new Error(
      `Invalid npm packument for ${packageName}: missing versions object.`,
    );
  }

  const versions = Object.fromEntries(
    Object.entries(value["versions"]).map(([version, metadata]) => [
      version,
      parsePackageVersion(packageName, version, metadata),
    ]),
  );

  return {
    name: typeof value["name"] === "string" ? value["name"] : packageName,
    versions,
    time: stringRecord(value["time"], "time"),
    distTags: stringRecord(value["dist-tags"], "dist-tags"),
  };
};

const registryPackageUrl = (registryUrl: string, packageName: string): string =>
  `${registryUrl.replace(/\/$/, "")}/${encodeURIComponent(packageName)}`;

const fetchPackument = async (
  packageName: string,
  fetchImpl: Fetch,
  registryUrl: string,
): Promise<Packument> => {
  let response: Response;
  try {
    response = await fetchImpl(registryPackageUrl(registryUrl, packageName));
  } catch (error) {
    throw new Error(
      `Could not reach the npm registry for ${packageName}: ${error instanceof Error ? error.message : String(error)}`,
      { cause: error },
    );
  }
  if (!response.ok) {
    throw new Error(
      `Could not fetch ${packageName} metadata (HTTP ${response.status}).`,
    );
  }

  let value: unknown;
  try {
    value = await response.json();
  } catch {
    throw new Error(`Invalid npm packument for ${packageName}: malformed JSON.`);
  }

  return parsePackument(packageName, value);
};

const resolveAlias = (
  packageName: string,
  range: string,
): Readonly<{ packageName: string; range: string }> => {
  if (!range.startsWith("npm:")) {
    return { packageName, range };
  }

  const alias = range.slice(4);
  const separator = alias.lastIndexOf("@");
  if (separator <= 0) {
    return { packageName: alias, range: "latest" };
  }

  return {
    packageName: alias.slice(0, separator),
    range: alias.slice(separator + 1),
  };
};

const resolveVersion = (
  packument: Packument,
  requestedRange: string,
  now: number,
): PackageVersion => {
  const taggedVersion = packument.distTags[requestedRange];
  const exactVersion = packument.versions[requestedRange];
  const oldEnough = (version: string): boolean => {
    const published = Date.parse(packument.time[version] ?? "");
    return Number.isFinite(published) && now - published >= minimumReleaseAgeMs;
  };
  if (exactVersion !== undefined && !oldEnough(requestedRange)) {
    throw new Error(
      `Refusing to install ${packument.name}@${requestedRange}: npm dependencies must be at least 7 days old.`,
    );
  }
  const selectedVersion =
    (taggedVersion !== undefined && oldEnough(taggedVersion)
      ? taggedVersion
      : undefined) ??
    (exactVersion === undefined
      ? Object.keys(packument.versions)
          .filter((version) => {
            if (!oldEnough(version)) {
              return false;
            }
            if (taggedVersion !== undefined) {
              return !version.includes("-");
            }
            try {
              return Bun.semver.satisfies(version, requestedRange);
            } catch {
              return false;
            }
          })
          .sort((left, right) => Bun.semver.order(right, left))[0]
      : requestedRange);
  const selected =
    selectedVersion === undefined
      ? undefined
      : packument.versions[selectedVersion];

  if (selected === undefined) {
    throw new Error(
      `No npm version of ${packument.name} satisfies ${requestedRange}.`,
    );
  }

  return selected;
};

const listAllows = (values: readonly string[] | undefined, actual: string): boolean => {
  if (values === undefined || values.length === 0) {
    return true;
  }
  if (values.includes(`!${actual}`)) {
    return false;
  }

  const positive = values.filter((value) => !value.startsWith("!"));
  return positive.length === 0 || positive.includes(actual);
};

const packageSupportsHost = (metadata: PackageVersion): boolean =>
  listAllows(metadata.os, process.platform) &&
  listAllows(metadata.cpu, process.arch);

const expectedDigest = (
  dist: PackageVersion["dist"],
): Readonly<{ algorithm: "sha512" | "sha1"; digest: Buffer }> => {
  const integrityTokens = dist.integrity?.split(/\s+/) ?? [];
  const sha512 = integrityTokens.find((token) => token.startsWith("sha512-"));
  if (sha512 !== undefined) {
    return {
      algorithm: "sha512",
      digest: Buffer.from(sha512.slice("sha512-".length), "base64"),
    };
  }
  if (dist.shasum !== undefined) {
    return { algorithm: "sha1", digest: Buffer.from(dist.shasum, "hex") };
  }

  throw new Error("Unsupported npm tarball integrity algorithm.");
};

export const verifyTarballIntegrity = (
  bytes: Uint8Array,
  dist: Readonly<{ integrity?: string; shasum?: string }>,
): void => {
  const expected = expectedDigest({ tarball: "", ...dist });
  const actual = createHash(expected.algorithm).update(bytes).digest();
  if (
    actual.length !== expected.digest.length ||
    !timingSafeEqual(actual, expected.digest)
  ) {
    throw new Error(`Downloaded tarball failed ${expected.algorithm} integrity verification.`);
  }
};

const downloadTarball = async (
  metadata: PackageVersion,
  fetchImpl: Fetch,
): Promise<Uint8Array> => {
  let response: Response;
  try {
    response = await fetchImpl(metadata.dist.tarball);
  } catch (error) {
    throw new Error(
      `Could not download ${metadata.name}@${metadata.version}: ${error instanceof Error ? error.message : String(error)}`,
      { cause: error },
    );
  }
  if (!response.ok) {
    throw new Error(
      `Could not download ${metadata.name}@${metadata.version} (HTTP ${response.status}).`,
    );
  }

  const bytes = new Uint8Array(await response.arrayBuffer());
  verifyTarballIntegrity(bytes, metadata.dist);
  return bytes;
};

const extractTarball = async (
  bytes: Uint8Array,
  directory: string,
): Promise<void> => {
  await mkdir(directory, { recursive: true });
  const archivePath = join(directory, `.package-${randomUUID()}.tgz`);
  await writeFile(archivePath, bytes);

  try {
    const process = Bun.spawn(
      ["tar", "-xzf", archivePath, "-C", directory, "--strip-components=1"],
      {
        stdin: "ignore",
        stdout: "pipe",
        stderr: "pipe",
      },
    );
    const [exitCode, stderr] = await Promise.all([
      process.exited,
      new Response(process.stderr).text(),
    ]);
    if (exitCode !== 0) {
      throw new Error(
        `Could not extract npm tarball with system tar: ${stderr.trim() || `exit ${exitCode}`}`,
      );
    }
  } finally {
    await unlink(archivePath).catch(() => undefined);
  }
};

const packageDirectory = (parent: string, dependencyName: string): string =>
  join(parent, "node_modules", ...dependencyName.split("/"));

type InstallContext = Readonly<{
  fetchImpl: Fetch;
  registryUrl: string;
  now: number;
  packuments: Map<string, Promise<Packument>>;
  installed: Map<string, PackageVersion>;
}>;

type InstalledAncestor = Readonly<{
  installName: string;
  metadata: PackageVersion;
  directory: string;
}>;

const cachedPackument = (
  context: InstallContext,
  packageName: string,
): Promise<Packument> => {
  const existing = context.packuments.get(packageName);
  if (existing !== undefined) {
    return existing;
  }

  const pending = fetchPackument(
    packageName,
    context.fetchImpl,
    context.registryUrl,
  );
  context.packuments.set(packageName, pending);
  return pending;
};

const versionSatisfies = (version: string, range: string): boolean => {
  try {
    return Bun.semver.satisfies(version, range);
  } catch {
    return version === range;
  }
};

const installPackage = async (
  installName: string,
  requestedRange: string,
  directory: string,
  context: InstallContext,
  ancestors: readonly InstalledAncestor[],
  optional: boolean,
): Promise<PackageVersion | undefined> => {
  const alias = resolveAlias(installName, requestedRange);
  const ancestor = ancestors.find(
    (candidate) =>
      candidate.installName === installName &&
      versionSatisfies(candidate.metadata.version, alias.range),
  );
  if (ancestor !== undefined) {
    return ancestor.metadata;
  }

  const existing = context.installed.get(directory);
  if (existing !== undefined) {
    if (versionSatisfies(existing.version, alias.range)) {
      return existing;
    }
    if (optional) {
      return undefined;
    }
    throw new Error(
      `Managed bridge dependencies require conflicting ${installName} versions (${existing.version} and ${alias.range}).`,
    );
  }
  if (ancestors.length > 64) {
    throw new Error(`npm dependency tree exceeded 64 levels at ${installName}.`);
  }

  try {
    const packument = await cachedPackument(context, alias.packageName);
    const metadata = resolveVersion(packument, alias.range, context.now);
    if (!packageSupportsHost(metadata)) {
      if (optional) {
        return undefined;
      }
      throw new Error(
        `${metadata.name}@${metadata.version} does not support ${process.platform}-${process.arch}.`,
      );
    }

    await extractTarball(
      await downloadTarball(metadata, context.fetchImpl),
      directory,
    );
    context.installed.set(directory, metadata);

    const nextAncestors = [
      ...ancestors,
      { installName, metadata, directory },
    ];
    const dependencyRoot = nextAncestors[0]?.directory ?? directory;
    const dependencyDirectory = (name: string, range: string): string => {
      const rootDirectory = packageDirectory(dependencyRoot, name);
      const rootPackage = context.installed.get(rootDirectory);
      const aliasRange = resolveAlias(name, range).range;

      return rootPackage === undefined ||
        versionSatisfies(rootPackage.version, aliasRange)
        ? rootDirectory
        : packageDirectory(directory, name);
    };
    const requiredPeers = Object.fromEntries(
      Object.entries(metadata.peerDependencies).filter(
        ([name]) => metadata.peerDependenciesMeta[name]?.optional !== true,
      ),
    );
    const required = {
      ...requiredPeers,
      ...metadata.dependencies,
    };
    for (const [name, range] of Object.entries(required)) {
      await installPackage(
        name,
        range,
        dependencyDirectory(name, range),
        context,
        nextAncestors,
        false,
      );
    }
    for (const [name, range] of Object.entries(metadata.optionalDependencies)) {
      await installPackage(
        name,
        range,
        dependencyDirectory(name, range),
        context,
        nextAncestors,
        true,
      );
    }

    return metadata;
  } catch (error) {
    context.installed.delete(directory);
    await rm(directory, { force: true, recursive: true });
    if (optional) {
      return undefined;
    }
    throw error;
  }
};

const safeBridgeName = (definition: ManagedBridgeDefinition): string => {
  const name = definition.package.split("/").at(-1) ?? definition.bin;
  return name.replace(/[^a-zA-Z0-9._-]/g, "-");
};

export const managedBridgeDirectory = (
  definition: HarnessAdapterDefinition,
  dataDir: string,
): string | undefined =>
  definition.managedBridge === undefined
    ? undefined
    : join(
        dataDir,
        "bridges",
        safeBridgeName(definition.managedBridge),
        definition.managedBridge.version,
      );

const markerPath = (directory: string): string =>
  join(directory, installMarkerName);

const validatedEntry = (directory: string, entry: unknown): string | undefined => {
  if (typeof entry !== "string" || entry.length === 0) {
    return undefined;
  }

  const path = resolve(directory, entry);
  if (!path.startsWith(`${resolve(directory)}${sep}`) || !existsSync(path)) {
    return undefined;
  }

  return path;
};

export const managedBridgeEntry = (
  definition: HarnessAdapterDefinition,
  dataDir: string,
): string | undefined => {
  const directory = managedBridgeDirectory(definition, dataDir);
  const bridge = definition.managedBridge;
  if (directory === undefined || bridge === undefined) {
    return undefined;
  }

  try {
    const marker = JSON.parse(readFileSync(markerPath(directory), "utf8")) as unknown;
    if (
      !isRecord(marker) ||
      marker["package"] !== bridge.package ||
      marker["version"] !== bridge.version
    ) {
      return undefined;
    }

    return validatedEntry(directory, marker["entry"]);
  } catch {
    return undefined;
  }
};

const bridgeBinPath = (
  definition: ManagedBridgeDefinition,
  metadata: PackageVersion,
): string => {
  const value =
    typeof metadata.bin === "string"
      ? metadata.bin
      : metadata.bin?.[definition.bin];
  if (value === undefined) {
    throw new Error(
      `${definition.package}@${definition.version} does not declare the ${definition.bin} bin.`,
    );
  }

  return value;
};

const assertReleaseAge = (
  definition: ManagedBridgeDefinition,
  packument: Packument,
  now: number,
): void => {
  const publishedAt = packument.time[definition.version];
  const publishedMs =
    publishedAt === undefined ? Number.NaN : Date.parse(publishedAt);
  if (!Number.isFinite(publishedMs)) {
    throw new Error(
      `Invalid npm packument for ${definition.package}: missing publish time for ${definition.version}.`,
    );
  }
  const age = now - publishedMs;
  if (age < minimumReleaseAgeMs) {
    const ageDays = Math.max(0, age / (24 * 60 * 60 * 1_000));
    throw new Error(
      `Refusing to install ${definition.package}@${definition.version}: published ${ageDays.toFixed(1)} days ago; managed bridges must be at least 7 days old.`,
    );
  }
};

const installManagedBridge = async (
  definition: HarnessAdapterDefinition,
  dataDir: string,
  fetchImpl: Fetch,
  options: EnsureManagedBridgeOptions,
): Promise<string> => {
  const bridge = definition.managedBridge;
  const target = managedBridgeDirectory(definition, dataDir);
  if (bridge === undefined || target === undefined) {
    throw new Error(`${definition.name} has no managed bridge.`);
  }

  const registryUrl = options.registryUrl ?? defaultRegistryUrl;
  const now = (options.now ?? Date.now)();
  const context: InstallContext = {
    fetchImpl,
    registryUrl,
    now,
    packuments: new Map(),
    installed: new Map(),
  };
  const packument = await cachedPackument(context, bridge.package);
  const rootMetadata = packument.versions[bridge.version];
  if (rootMetadata === undefined) {
    throw new Error(
      `Pinned managed bridge ${bridge.package}@${bridge.version} is missing from the npm registry.`,
    );
  }
  assertReleaseAge(bridge, packument, now);

  await mkdir(dirname(target), { recursive: true });
  const temporary = await mkdtemp(
    join(dirname(target), `.${basename(target)}-install-`),
  );
  try {
    const metadata = await installPackage(
      bridge.package,
      bridge.version,
      temporary,
      context,
      [],
      false,
    );
    if (metadata === undefined) {
      throw new Error(`Could not install ${bridge.package}@${bridge.version}.`);
    }
    const entry = bridgeBinPath(bridge, metadata);
    if (validatedEntry(temporary, entry) === undefined) {
      throw new Error(
        `${bridge.package}@${bridge.version} is missing its ${bridge.bin} entry file.`,
      );
    }
    await writeFile(
      markerPath(temporary),
      `${JSON.stringify({ package: bridge.package, version: bridge.version, entry })}\n`,
      "utf8",
    );

    const concurrentlyInstalled = managedBridgeEntry(definition, dataDir);
    if (concurrentlyInstalled !== undefined) {
      return concurrentlyInstalled;
    }
    await rm(target, { force: true, recursive: true });
    await rename(temporary, target);
    const installed = managedBridgeEntry(definition, dataDir);
    if (installed === undefined) {
      throw new Error(`Managed bridge install did not produce a valid entry file.`);
    }

    return installed;
  } finally {
    await rm(temporary, { force: true, recursive: true });
  }
};

export const ensureManagedBridge = async (
  definition: HarnessAdapterDefinition,
  dataDir: string,
  fetchImpl: Fetch = fetch,
  options: EnsureManagedBridgeOptions = {},
): Promise<string | undefined> => {
  if (definition.managedBridge === undefined) {
    return undefined;
  }
  const installed = managedBridgeEntry(definition, dataDir);
  if (installed !== undefined) {
    return installed;
  }
  const target = managedBridgeDirectory(definition, dataDir);
  if (target === undefined) {
    return undefined;
  }

  const existing = singleFlights.get(target);
  if (existing !== undefined) {
    return await existing;
  }

  const pending = installManagedBridge(
    definition,
    dataDir,
    fetchImpl,
    options,
  );
  singleFlights.set(target, pending);
  try {
    return await pending;
  } finally {
    singleFlights.delete(target);
  }
};

export const managedBridgeCommand = (
  entry: string,
  env: Readonly<Record<string, string | undefined>> = process.env,
): readonly string[] | undefined => {
  const path = env["PATH"];
  const node =
    path === undefined ? Bun.which("node") : Bun.which("node", { PATH: path });

  return node === null ? undefined : [node, entry];
};

export const createManagedBridgeService = (
  options: ManagedBridgeServiceOptions,
): ManagedBridgeService => {
  const statuses = new Map<string, ManagedBridgeStatus>();
  const key = (definition: HarnessAdapterDefinition): string => definition.id;
  const update = (
    definition: HarnessAdapterDefinition,
    status: ManagedBridgeStatus,
  ): void => {
    statuses.set(key(definition), status);
    options.onStatus?.(definition, status);
  };

  return {
    ensure: async (definition) => {
      if (definition.managedBridge === undefined) {
        return undefined;
      }
      const installed = managedBridgeEntry(definition, options.dataDir);
      if (installed !== undefined) {
        update(definition, { state: "ready" });
        return installed;
      }

      update(definition, { state: "downloading" });
      try {
        const entry = await ensureManagedBridge(
          definition,
          options.dataDir,
          options.fetchImpl ?? fetch,
          {
            ...(options.registryUrl === undefined
              ? {}
              : { registryUrl: options.registryUrl }),
            ...(options.now === undefined ? {} : { now: options.now }),
          },
        );
        update(definition, { state: "ready" });
        return entry;
      } catch (error) {
        const message =
          error instanceof Error ? error.message : "Managed bridge download failed.";
        update(definition, { state: "error", message });
        throw error;
      }
    },
    entry: (definition) => managedBridgeEntry(definition, options.dataDir),
    status: (definition) => {
      const installed = managedBridgeEntry(definition, options.dataDir);
      return installed === undefined
        ? statuses.get(key(definition))
        : { state: "ready" };
    },
  };
};
