import { spawn } from "node:child_process";
import { copyFileSync, lstatSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  assertReleaseBinariesDoNotExposeBuildPaths,
  runReleaseBinaryPathAuditSelfTest,
} from "./release-binary-path-audit.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dirname, "..");
const coreName = process.platform === "win32" ? "candor-core.exe" : "candor-core";
const toolNames = process.platform === "win32"
  ? ["candorctl.exe", "candor-mcp.exe"]
  : ["candorctl", "candor-mcp"];
const releaseBinaryNames = [coreName, ...toolNames];
const stableBuildRoot = process.env.CANDOR_CORE_TARGET_DIR || (
  process.platform === "win32"
    ? join(process.env.SystemDrive || "C:", "CandorBuild", "candor-core", `${process.platform}-${process.arch}`)
    : join("/tmp", "CandorBuild", "candor-core", `${process.platform}-${process.arch}`)
);
const stagedCoreDir = resolve(repoRoot, "build", "core-bin");
const env = {
  ...process.env,
  CARGO_TARGET_DIR: stableBuildRoot,
};

runReleaseBinaryPathAuditSelfTest();

const remapFlags = [
  `--remap-path-prefix=${repoRoot}=<workspace>`,
  `--remap-path-prefix=${homedir()}=<home>`,
];
if (env.RUSTFLAGS && !env.CARGO_ENCODED_RUSTFLAGS) {
  throw new Error("Production core builds require CARGO_ENCODED_RUSTFLAGS when custom Rust flags are present.");
}
env.CARGO_ENCODED_RUSTFLAGS = [env.CARGO_ENCODED_RUSTFLAGS, ...remapFlags].filter(Boolean).join("\u001f");
delete env.RUSTFLAGS;

const child = spawn(
  process.execPath,
  [
    "scripts/cargo-with-local-perl.mjs",
    "build",
    "--manifest-path",
    "crates/candor-core/Cargo.toml",
    "--release",
    "--features",
    "sqlcipher-vault,local-whisper,local-parakeet",
  ],
  {
    cwd: repoRoot,
    env,
    shell: false,
    stdio: "inherit",
  },
);

child.once("error", (error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});

child.once("exit", (code, signal) => {
  if (code !== 0) {
    console.error(`Rust release core build failed (${code ?? signal ?? "unknown"}).`);
    process.exitCode = code ?? 1;
    return;
  }
  const tools = spawn(
    process.execPath,
    [
      "scripts/cargo-with-local-perl.mjs",
      "build",
      "--manifest-path",
      "crates/candor-tools/Cargo.toml",
      "--release",
      "--bins",
    ],
    {
      cwd: repoRoot,
      env,
      shell: false,
      stdio: "inherit",
    },
  );
  tools.once("error", (error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
  tools.once("exit", (toolsCode, toolsSignal) => {
    if (toolsCode !== 0) {
      console.error(`Rust release companion build failed (${toolsCode ?? toolsSignal ?? "unknown"}).`);
      process.exitCode = toolsCode ?? 1;
      return;
    }
    const builtBinaries = releaseBinaryNames.map((binaryName) => {
      const sourcePath = join(stableBuildRoot, "release", binaryName);
      const sourceStat = lstatSync(sourcePath);
      if (!sourceStat.isFile() || sourceStat.isSymbolicLink() || sourceStat.size === 0) {
        throw new Error(`Release binary is not a non-empty regular file: ${binaryName}`);
      }
      return { binaryName, sourcePath };
    });
    assertReleaseBinariesDoNotExposeBuildPaths(
      builtBinaries.map(({ sourcePath }) => sourcePath),
      { repoRoot, stage: "release output" },
    );

    mkdirSync(stagedCoreDir, { recursive: true });
    const stagedBinaries = [];
    for (const { binaryName, sourcePath } of builtBinaries) {
      const stagedPath = join(stagedCoreDir, binaryName);
      copyFileSync(sourcePath, stagedPath);
      const stagedStat = lstatSync(stagedPath);
      if (!stagedStat.isFile() || stagedStat.isSymbolicLink() || stagedStat.size === 0) {
        throw new Error(`Staged release binary is not a non-empty regular file: ${binaryName}`);
      }
      stagedBinaries.push(stagedPath);
      console.log(`Staged release binary at build/core-bin/${binaryName}.`);
    }
    assertReleaseBinariesDoNotExposeBuildPaths(stagedBinaries, {
      repoRoot,
      stage: "staged output",
    });
  });
});
