import { readFileSync, rmSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const repoRoot = resolve(__dirname, "..");
const outputDir = resolve(repoRoot, "dist-v3", "electron");

rmSync(outputDir, { recursive: true, force: true });

function runTool(name, args, label) {
  const executable = resolve(
    repoRoot,
    "node_modules",
    ".bin",
    process.platform === "win32" ? `${name}.cmd` : name,
  );
  const command = process.platform === "win32" ? process.env.ComSpec ?? "cmd.exe" : executable;
  const commandArgs = process.platform === "win32"
    ? ["/d", "/c", [executable, ...args].join(" ")]
    : args;
  const result = spawnSync(command, commandArgs, {
    cwd: repoRoot,
    stdio: "inherit",
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`${label} failed with exit code ${result.status}.`);
  }
}

runTool("tsc", ["-p", "electron/tsconfig.json"], "Electron TypeScript build");
runTool("vite", ["build", "-c", "vite.preload.config.ts"], "Sandboxed preload bundle");

const preloadPath = resolve(outputDir, "preload.cjs");
const preloadBundle = readFileSync(preloadPath, "utf8");
const requiredModules = [...preloadBundle.matchAll(/\brequire\((['"])([^'"]+)\1\)/g)]
  .map((match) => match[2]);
const forbiddenModules = requiredModules.filter((specifier) => specifier !== "electron");
if (forbiddenModules.length > 0) {
  throw new Error(
    `Sandboxed preload bundle retained unsupported module imports: ${forbiddenModules.join(", ")}`,
  );
}
