type VersionedJson = {
  version?: unknown;
};

const readVersion = async (path: string): Promise<string> => {
  const value = JSON.parse(await Bun.file(path).text()) as VersionedJson;

  if (typeof value.version !== "string" || value.version.length === 0) {
    throw new Error(`${path} must contain a non-empty string version.`);
  }

  return value.version;
};

const packageVersion = await readVersion("package.json");
const tauriVersion = await readVersion("src-tauri/tauri.conf.json");

if (packageVersion !== tauriVersion) {
  console.error(
    `Version mismatch: package.json has ${packageVersion}, src-tauri/tauri.conf.json has ${tauriVersion}.`,
  );
  process.exit(1);
}

console.log(`Version sync OK: ${packageVersion}`);
