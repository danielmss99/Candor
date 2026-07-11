import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const repoRoot = resolve(__dirname, "..");
const recordOnly = process.argv.includes("--record-only");
const homeDir = process.env.USERPROFILE || process.env.HOME || "";

function sanitizeText(value) {
  let text = String(value ?? "")
    .replaceAll(repoRoot, "<repo-root>")
    .replaceAll(repoRoot.replaceAll("\\", "\\\\"), "<repo-root>");
  if (homeDir) {
    text = text
      .replaceAll(homeDir, "<home>")
      .replaceAll(homeDir.replaceAll("\\", "\\\\"), "<home>");
  }
  return text.replace(/[A-Za-z]:\\[^"\r\n]+/g, "<abs-path>");
}

function argValue(name, fallback) {
  const index = process.argv.indexOf(name);
  return index >= 0 && process.argv[index + 1] ? process.argv[index + 1] : fallback;
}

function writeJson(path, value) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function run(command, args) {
  const result = spawnSync(command, args, {
    cwd: repoRoot,
    encoding: "utf8",
    shell: false,
    stdio: ["ignore", "pipe", "pipe"],
  });
  return {
    command: [command, ...args],
    exitCode: result.status,
    signal: result.signal,
    ok: result.status === 0,
    stdout: result.stdout?.trim() ?? "",
    stderr: result.stderr?.trim() ?? "",
    error: result.error ? result.error.message : null,
  };
}

function commandVersion(command, args = ["--version"]) {
  const result = run(command, args);
  return {
    command,
    args,
    ok: result.ok,
    exitCode: result.exitCode,
    version: result.ok ? result.stdout.split(/\r?\n/)[0] ?? "" : "",
    error: result.ok ? null : sanitizeText(result.error || result.stderr || result.stdout || ""),
  };
}

const outputPath = resolve(
  repoRoot,
  argValue(
    "--write",
    join("release-v3", "proofs", `m2-local-whisper-preflight-${process.platform}-${process.arch}.json`),
  ),
);

const cmake = commandVersion("cmake");
const cargo = commandVersion("cargo");
const missingTools = [];
if (!cmake.ok) missingTools.push("cmake");
if (!cargo.ok) missingTools.push("cargo");

let featureCheck = {
  attempted: false,
  ok: false,
  skippedReason: missingTools.length > 0 ? `missing tools: ${missingTools.join(", ")}` : null,
};
let unitCheck = {
  attempted: false,
  ok: false,
  skippedReason: missingTools.length > 0 ? `missing tools: ${missingTools.join(", ")}` : null,
};

if (missingTools.length === 0) {
  const result = run(process.execPath, [
    "scripts/cargo-with-local-perl.mjs",
    "check",
    "--manifest-path",
    "crates/candor-core/Cargo.toml",
    "--features",
    "local-whisper",
  ]);
  featureCheck = {
    attempted: true,
    ok: result.ok,
    command: result.command.map(sanitizeText),
    exitCode: result.exitCode,
    signal: result.signal,
    stderrTail: sanitizeText(result.stderr.slice(-4000)),
    stdoutTail: sanitizeText(result.stdout.slice(-4000)),
    error: sanitizeText(result.error),
  };

  if (featureCheck.ok) {
    const unitResult = run(process.execPath, [
      "scripts/cargo-with-local-perl.mjs",
      "test",
      "--manifest-path",
      "crates/candor-core/Cargo.toml",
      "--features",
      "local-whisper",
      "transcription_service::tests",
      "--",
      "--nocapture",
    ]);
    unitCheck = {
      attempted: true,
      ok: unitResult.ok,
      command: unitResult.command.map(sanitizeText),
      exitCode: unitResult.exitCode,
      signal: unitResult.signal,
      stderrTail: sanitizeText(unitResult.stderr.slice(-4000)),
      stdoutTail: sanitizeText(unitResult.stdout.slice(-4000)),
      error: sanitizeText(unitResult.error),
    };
  } else {
    unitCheck = {
      attempted: false,
      ok: false,
      skippedReason: "local-whisper feature check failed",
    };
  }
}

const ready = missingTools.length === 0 && featureCheck.ok === true && unitCheck.ok === true;
const proof = {
  ok: recordOnly || ready,
  proofKind: "m2-local-whisper-preflight",
  generatedAt: new Date().toISOString(),
  platform: process.platform,
  arch: process.arch,
  recordOnly,
  ready,
  localOnly: true,
  cloudAi: false,
  feature: "local-whisper",
  requiredTools: ["cargo", "cmake"],
  missingTools,
  checks: {
    cargo,
    cmake,
    localWhisperFeature: featureCheck,
    localWhisperUnitTests: unitCheck,
  },
  rawPathExposed: false,
  keyMaterialExposedToRenderer: false,
};

writeJson(outputPath, proof);

if (ready) {
  console.log(`M2 local Whisper preflight passed. Proof written to ${outputPath}.`);
} else {
  console.error(`M2 local Whisper preflight is not ready. Proof written to ${outputPath}.`);
  if (missingTools.length > 0) {
    console.error(`Missing tools: ${missingTools.join(", ")}`);
  }
}

if (!proof.ok) {
  process.exit(1);
}
