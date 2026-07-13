import { spawn } from "node:child_process";
import { copyFileSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dirname, "..");
const coreName = process.platform === "win32" ? "candor-core.exe" : "candor-core";
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

const remapFlags = [
  `--remap-path-prefix=${repoRoot}=<workspace>`,
  `--remap-path-prefix=${homedir()}=<home>`,
];
if (env.CARGO_ENCODED_RUSTFLAGS) {
  env.CARGO_ENCODED_RUSTFLAGS = `${env.CARGO_ENCODED_RUSTFLAGS}\u001f${remapFlags.join("\u001f")}`;
} else {
  const quoted = remapFlags.map((flag) => (flag.includes(" ") ? `"${flag}"` : flag));
  env.RUSTFLAGS = [env.RUSTFLAGS, ...quoted].filter(Boolean).join(" ");
}

const child = spawn(
  process.execPath,
  [
    "scripts/cargo-with-local-perl.mjs",
    "build",
    "--manifest-path",
    "crates/candor-core/Cargo.toml",
    "--release",
    "--features",
    "sqlcipher-vault,local-whisper",
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
  mkdirSync(stagedCoreDir, { recursive: true });
  copyFileSync(join(stableBuildRoot, "release", coreName), join(stagedCoreDir, coreName));
  console.log(`Staged release core at build/core-bin/${coreName}.`);
});
