import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const repoRoot = resolve(__dirname, "..");

function hasArg(name) {
  return process.argv.includes(name);
}

function argValue(name, fallback) {
  const index = process.argv.indexOf(name);
  return index >= 0 && process.argv[index + 1] ? resolve(process.argv[index + 1]) : fallback;
}

function commandExists(command) {
  const result = spawnSync("bash", ["-lc", `command -v ${command}`], {
    encoding: "utf8",
  });
  return result.status === 0;
}

function defaultExecutableCandidates() {
  return [
    join(repoRoot, "release-v3", "linux-unpacked", "candor"),
    join(repoRoot, "release-v3", "linux-unpacked", "Candor v3 M0"),
  ];
}

function resolveExecutable(explicitPath) {
  const candidates = explicitPath ? [explicitPath] : defaultExecutableCandidates();
  const executable = candidates.find((candidate) => existsSync(candidate));
  if (!executable) {
    throw new Error(`Packaged Linux executable not found. Checked:\n${candidates.join("\n")}`);
  }
  return executable;
}

function writeJson(path, value) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(value, null, 2), "utf8");
}

function shellQuote(value) {
  return `'${String(value).replaceAll("'", `'"'"'`)}'`;
}

function parseDenyProbeOutput(text) {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start < 0 || end <= start) {
    return {
      attempted: true,
      blocked: false,
      parseError: "deny probe did not emit JSON",
      stdout: text.trim(),
    };
  }
  return JSON.parse(text.slice(start, end + 1));
}

function denyProbeScript() {
  return `
const net = require("node:net");
const started = Date.now();
const socket = net.connect({ host: "1.1.1.1", port: 443 });
let settled = false;
function finish(blocked, reason) {
  if (settled) return;
  settled = true;
  socket.destroy();
  console.log(JSON.stringify({
    attempted: true,
    target: "1.1.1.1:443",
    blocked,
    reason: String(reason ?? ""),
    durationMs: Date.now() - started
  }));
  process.exit(blocked ? 0 : 2);
}
socket.setTimeout(1500, () => finish(true, "timeout"));
socket.on("error", (error) => finish(true, error.code || error.message));
socket.on("connect", () => finish(false, "connected"));
`;
}

const validateOnly = hasArg("--validate-only");
const proofDir = argValue("--proof-dir", join(repoRoot, "release-v3", "proofs"));
const explicitAppPath = process.argv.includes("--app-path")
  ? argValue("--app-path", "")
  : "";
const proofCommands = ["bash", "unshare", "runuser", "xvfb-run", "node", "ip"];

if (validateOnly) {
  const candidateAppPaths = explicitAppPath ? [explicitAppPath] : defaultExecutableCandidates();
  const commands = Object.fromEntries(proofCommands.map((command) => [command, commandExists(command)]));
  const root = typeof process.getuid === "function" ? process.getuid() === 0 : false;
  console.log(
    JSON.stringify(
      {
        ok: true,
        mode: "validate-only",
        validateOnlyIsNotNetworkProof: true,
        platform: process.platform,
        proofDir,
        candidateAppPaths,
        packagedExecutableAvailable: candidateAppPaths.some((candidate) => existsSync(candidate)),
        root,
        commands,
        canRunProof: process.platform === "linux" && root && Object.values(commands).every(Boolean),
      },
      null,
      2,
    ),
  );
  process.exit(0);
}

if (process.platform !== "linux") {
  throw new Error("M0 Linux network-deny proof can only run on Linux.");
}
if (typeof process.getuid !== "function" || process.getuid() !== 0) {
  throw new Error("Run this proof as root, for example: sudo npm run m0:network-deny:linux");
}
for (const command of proofCommands) {
  if (!commandExists(command)) throw new Error(`Required command not found: ${command}`);
}

const invokingUser = process.env.SUDO_USER?.trim();
const invokingUid = Number.parseInt(process.env.SUDO_UID ?? "", 10);
if (!invokingUser || invokingUser === "root" || !Number.isInteger(invokingUid) || invokingUid <= 0) {
  throw new Error("Linux network-deny proof requires sudo from a non-root user so Electron can retain its sandbox.");
}

const executable = resolveExecutable(explicitAppPath);
const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
const smokeProofPath = join(proofDir, `m0-packaged-runtime-smoke-linux-${process.arch}.json`);
const networkProofPath = join(proofDir, `m0-network-deny-linux-${timestamp}.json`);

mkdirSync(proofDir, { recursive: true });

const denyProbeResult = spawnSync(
  "unshare",
  ["--net", "--fork", "--mount-proc", process.execPath, "-e", denyProbeScript()],
  {
    cwd: repoRoot,
    encoding: "utf8",
  },
);
const denyLayerProbe = {
  ...parseDenyProbeOutput(denyProbeResult.stdout),
  exitCode: denyProbeResult.status,
  signal: denyProbeResult.signal,
  stderr: denyProbeResult.stderr.trim(),
  error: denyProbeResult.error ? denyProbeResult.error.message : null,
};

const command = [
  "ip link set lo up >/dev/null 2>&1 || true",
  [
    "runuser",
    "-u",
    shellQuote(invokingUser),
    "--",
    "env",
    ...Object.entries({
      CANDOR_M0_PACKAGED_SMOKE_PROOF: smokeProofPath,
      GITHUB_ACTIONS: process.env.GITHUB_ACTIONS,
      GITHUB_WORKFLOW: process.env.GITHUB_WORKFLOW,
      GITHUB_RUN_ID: process.env.GITHUB_RUN_ID,
      GITHUB_RUN_ATTEMPT: process.env.GITHUB_RUN_ATTEMPT,
      GITHUB_JOB: process.env.GITHUB_JOB,
      GITHUB_SHA: process.env.GITHUB_SHA,
      GITHUB_REF: process.env.GITHUB_REF,
      RUNNER_OS: process.env.RUNNER_OS,
    })
      .filter(([, value]) => typeof value === "string" && value.length > 0)
      .map(([name, value]) => `${name}=${shellQuote(value)}`),
    "xvfb-run",
    "-a",
    shellQuote(process.execPath),
    "scripts/m0-packaged-smoke.mjs",
  ].join(" "),
].join("; ");

const result = spawnSync("unshare", ["--net", "--fork", "--mount-proc", "bash", "-lc", command], {
  cwd: repoRoot,
  encoding: "utf8",
  env: {
    ...process.env,
    CANDOR_M0_PACKAGED_SMOKE_PROOF: smokeProofPath,
  },
});

const smokeProof = existsSync(smokeProofPath)
  ? JSON.parse(readFileSync(smokeProofPath, "utf8"))
  : null;

const proof = {
  ok: denyLayerProbe.blocked === true && result.status === 0,
  proofKind: "m0-network-deny-linux",
  generatedAt: new Date().toISOString(),
  denyMechanism: "unshare --net",
  executable,
  smokeProofPath,
  denyLayerProbe,
  command: "unshare --net --fork --mount-proc bash -lc '<lo up>; runuser <invoking-user> -- xvfb-run -a node scripts/m0-packaged-smoke.mjs'",
  applicationUidNonRoot: invokingUid > 0,
  applicationRunsAsRoot: false,
  stdout: result.stdout.trim(),
  stderr: result.stderr.trim(),
  smokeProof,
};
writeJson(networkProofPath, proof);

if (result.error) throw result.error;
if (denyProbeResult.error) throw denyProbeResult.error;
if (denyLayerProbe.blocked !== true) {
  throw new Error(`Linux deny-layer sentinel connected or did not prove blocked. Proof written to ${networkProofPath}`);
}
if (result.status !== 0) {
  throw new Error(`Linux network-deny proof failed. Proof written to ${networkProofPath}`);
}
if (!smokeProof?.ok) {
  throw new Error(`Linux network-deny smoke proof missing or failed: ${smokeProofPath}`);
}

console.log(`M0 Linux network-deny proof written to ${networkProofPath}.`);
