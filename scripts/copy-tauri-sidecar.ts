import { copyFile, mkdir, stat } from "node:fs/promises";
import { dirname, join } from "node:path";
import { $ } from "bun";

const source = join(import.meta.dir, "..", "dist", "learn");
const binDir = join(import.meta.dir, "..", "src-tauri", "bin");

const fail = (message: string): never => {
  console.error(message);
  process.exit(1);
};

try {
  const sourceStat = await stat(source);
  if (!sourceStat.isFile()) {
    fail(`${source} exists but is not a file.`);
  }
} catch {
  fail("Missing dist/learn. Run `bun run build` before copying the Tauri sidecar.");
}

const targetTriple =
  process.env["TAURI_TARGET_TRIPLE"] ??
  (await $`rustc -vV`
    .text()
    .then((output) => {
      const hostLine = output
        .split("\n")
        .find((line) => line.startsWith("host: "));
      return hostLine?.slice("host: ".length).trim();
    }));

if (targetTriple === undefined || targetTriple.length === 0) {
  fail("Unable to determine the Rust target triple for the Tauri sidecar.");
}

const target = join(binDir, `learn-${targetTriple}`);
await mkdir(dirname(target), { recursive: true });
await copyFile(source, target);

console.log(`Copied ${source} -> ${target}`);
