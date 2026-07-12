import { rmSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const repoRoot = resolve(__dirname, "..");
const outputDir = resolve(repoRoot, "dist-v3", "electron");

rmSync(outputDir, { recursive: true, force: true });

const tscBin = resolve(
  repoRoot,
  "node_modules",
  ".bin",
  process.platform === "win32" ? "tsc.cmd" : "tsc",
);
const command = process.platform === "win32" ? process.env.ComSpec ?? "cmd.exe" : tscBin;
const args =
  process.platform === "win32"
    ? ["/d", "/c", `${tscBin} -p electron/tsconfig.json`]
    : ["-p", "electron/tsconfig.json"];

const result = spawnSync(command, args, {
  cwd: repoRoot,
  stdio: "inherit",
});

if (result.error) throw result.error;
if (result.status !== 0) {
  throw new Error(`Electron TypeScript build failed with exit code ${result.status}.`);
}
