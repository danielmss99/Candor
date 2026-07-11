import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { spawn, spawnSync } from "node:child_process";
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

function runCommand(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: repoRoot,
    encoding: "utf8",
    ...options,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(
      `${command} ${args.join(" ")} failed with exit ${result.status}: ${result.stderr.trim()}`,
    );
  }
  return result;
}

function defaultExecutableCandidates() {
  return [
    join(repoRoot, "release-v3", "mac", "Candor v3 M0.app", "Contents", "MacOS", "Candor v3 M0"),
    join(repoRoot, "release-v3", "mac-arm64", "Candor v3 M0.app", "Contents", "MacOS", "Candor v3 M0"),
  ];
}

function resolveExecutable(explicitPath) {
  const candidates = explicitPath ? [explicitPath] : defaultExecutableCandidates();
  const executable = candidates.find((candidate) => existsSync(candidate));
  if (!executable) {
    throw new Error(`Packaged macOS executable not found. Checked:\n${candidates.join("\n")}`);
  }
  return executable;
}

function defaultInterface() {
  const result = spawnSync("route", ["-n", "get", "default"], { encoding: "utf8" });
  const match = result.stdout.match(/interface:\s*(\S+)/);
  return match?.[1] ?? "en0";
}

function waitForExit(child) {
  return new Promise((resolvePromise, rejectPromise) => {
    child.once("error", rejectPromise);
    child.once("exit", (code, signal) => resolvePromise({ code, signal }));
  });
}

function writeJson(path, value) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(value, null, 2), "utf8");
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
const externalDenyConfirmed = hasArg("--external-deny-confirmed");
const managedPf = hasArg("--managed-pf");
const proofDir = argValue("--proof-dir", join(repoRoot, "release-v3", "proofs"));
const explicitAppPath = process.argv.includes("--app-path")
  ? argValue("--app-path", "")
  : "";
const proofCommands = ["bash", "sudo", "tcpdump", "pfctl", "route", "node"];

if (validateOnly) {
  const candidateAppPaths = explicitAppPath ? [explicitAppPath] : defaultExecutableCandidates();
  const commands = Object.fromEntries(proofCommands.map((command) => [command, commandExists(command)]));
  const root = typeof process.getuid === "function" ? process.getuid() === 0 : false;
  const baseCommandsAvailable = ["bash", "tcpdump", "route", "node"].every((command) => commands[command]);
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
        canRunManagedPfProof: process.platform === "darwin" && root && baseCommandsAvailable && commands.pfctl,
        canRunExternalDenyProof: process.platform === "darwin" && root && baseCommandsAvailable,
      },
      null,
      2,
    ),
  );
  process.exit(0);
}

if (process.platform !== "darwin") {
  throw new Error("M0 macOS network proof can only run on macOS.");
}
if (typeof process.getuid !== "function" || process.getuid() !== 0) {
  throw new Error("Run this proof as root, for example: sudo npm run m0:network-deny:macos -- --managed-pf");
}
if (!externalDenyConfirmed && !managedPf) {
  throw new Error("Refusing to claim macOS network-deny proof without --managed-pf or --external-deny-confirmed.");
}
for (const command of ["bash", "sudo", "tcpdump", "route", "node"]) {
  if (!commandExists(command)) throw new Error(`Required command not found: ${command}`);
}
if (managedPf && !commandExists("pfctl")) {
  throw new Error("Required command not found: pfctl");
}

const invokingUser = process.env.SUDO_USER?.trim();
const invokingUid = Number.parseInt(process.env.SUDO_UID ?? "", 10);
if (!invokingUser || invokingUser === "root" || !Number.isInteger(invokingUid) || invokingUid <= 0) {
  throw new Error("macOS network-deny proof requires sudo from a non-root user so the app runs with desktop-user custody.");
}

const executable = resolveExecutable(explicitAppPath);
const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
const smokeProofPath = join(proofDir, `m0-packaged-runtime-smoke-darwin-${process.arch}.json`);
const networkProofPath = join(proofDir, `m0-network-deny-macos-${timestamp}.json`);
const iface = defaultInterface();
const pfAnchor = `com.apple/candor-v3-m0-network-deny-${process.pid}`;
const pfRules = "block drop out quick proto { tcp udp } from any to any\n";
const pfState = {
  requested: managedPf,
  anchor: managedPf ? pfAnchor : null,
  rules: managedPf ? pfRules.trim() : null,
  enabled: false,
  enableToken: null,
  anchorLoaded: false,
  anchorFlushed: false,
  enableTokenReleased: false,
  cleanupError: null,
};

function enableManagedPfDeny() {
  if (!managedPf) return;

  try {
    const enable = runCommand("pfctl", ["-E"]);
    pfState.enabled = true;
    const tokenMatch = `${enable.stdout}\n${enable.stderr}`.match(/Token\s*:\s*([^\s]+)/i);
    pfState.enableToken = tokenMatch?.[1] ?? null;
    if (!pfState.enableToken) {
      throw new Error("pfctl -E did not return an enable token");
    }

    runCommand("pfctl", ["-a", pfAnchor, "-f", "-"], {
      input: pfRules,
    });
    pfState.anchorLoaded = true;
  } catch (error) {
    cleanupManagedPfDeny();
    throw error;
  }
}

function cleanupManagedPfDeny() {
  if (!managedPf) return;
  try {
    runCommand("pfctl", ["-a", pfAnchor, "-F", "all"]);
    pfState.anchorFlushed = true;
  } catch (error) {
    pfState.cleanupError = error.message;
  }

  if (pfState.enableToken) {
    try {
      runCommand("pfctl", ["-X", pfState.enableToken]);
      pfState.enableTokenReleased = true;
    } catch (error) {
      pfState.cleanupError = [pfState.cleanupError, error.message].filter(Boolean).join("; ");
    }
  } else if (pfState.enabled) {
    pfState.cleanupError = [pfState.cleanupError, "PF was enabled but no enable token was recorded"]
      .filter(Boolean)
      .join("; ");
  } else {
    pfState.enableTokenReleased = true;
  }
}

mkdirSync(proofDir, { recursive: true });

enableManagedPfDeny();

const denyProbeResult = managedPf
  ? spawnSync(process.execPath, ["-e", denyProbeScript()], {
      cwd: repoRoot,
      encoding: "utf8",
    })
  : null;
const denyLayerProbe = denyProbeResult
  ? {
      ...parseDenyProbeOutput(denyProbeResult.stdout),
      exitCode: denyProbeResult.status,
      signal: denyProbeResult.signal,
      stderr: denyProbeResult.stderr.trim(),
      error: denyProbeResult.error ? denyProbeResult.error.message : null,
    }
  : {
      attempted: false,
      blocked: null,
      skippedReason: "external-deny-confirmed mode is operator-attested",
    };

const tcpdump = spawn("tcpdump", ["-n", "-l", "-i", iface, "tcp or udp"], {
  cwd: repoRoot,
  stdio: ["ignore", "pipe", "pipe"],
});
const packets = [];
let tcpdumpError = "";
tcpdump.stdout.on("data", (chunk) => {
  const lines = chunk.toString("utf8").split(/\r?\n/).filter(Boolean);
  for (const line of lines) {
    if (packets.length < 200) packets.push(line);
  }
});
tcpdump.stderr.on("data", (chunk) => {
  tcpdumpError += chunk.toString("utf8");
});

await new Promise((resolvePromise) => setTimeout(resolvePromise, 750));

let stdout = "";
let stderr = "";
let smokeExit = { code: null, signal: null };
try {
  const forwardedEnvironment = {
    CANDOR_M0_PACKAGED_SMOKE_PROOF: smokeProofPath,
    GITHUB_ACTIONS: process.env.GITHUB_ACTIONS,
    GITHUB_WORKFLOW: process.env.GITHUB_WORKFLOW,
    GITHUB_RUN_ID: process.env.GITHUB_RUN_ID,
    GITHUB_RUN_ATTEMPT: process.env.GITHUB_RUN_ATTEMPT,
    GITHUB_JOB: process.env.GITHUB_JOB,
    GITHUB_SHA: process.env.GITHUB_SHA,
    GITHUB_REF: process.env.GITHUB_REF,
    RUNNER_OS: process.env.RUNNER_OS,
  };
  const environmentArguments = Object.entries(forwardedEnvironment)
    .filter(([, value]) => typeof value === "string" && value.length > 0)
    .map(([name, value]) => `${name}=${value}`);
  const smoke = spawn("sudo", [
    "-u",
    invokingUser,
    "-H",
    "env",
    ...environmentArguments,
    process.execPath,
    "scripts/m0-packaged-smoke.mjs",
  ], {
    cwd: repoRoot,
    stdio: ["ignore", "pipe", "pipe"],
  });
  smoke.stdout.on("data", (chunk) => {
    stdout += chunk.toString("utf8");
  });
  smoke.stderr.on("data", (chunk) => {
    stderr += chunk.toString("utf8");
  });

  smokeExit = await waitForExit(smoke);
  await new Promise((resolvePromise) => setTimeout(resolvePromise, 750));
} finally {
  tcpdump.kill("SIGINT");
  await waitForExit(tcpdump).catch(() => null);
  cleanupManagedPfDeny();
}

const smokeProof = existsSync(smokeProofPath)
  ? JSON.parse(readFileSync(smokeProofPath, "utf8"))
  : null;

const proof = {
  ok:
    smokeExit.code === 0 &&
    (!managedPf || denyLayerProbe.blocked === true) &&
    packets.length === 0 &&
    (!managedPf ||
      (pfState.anchorLoaded &&
        pfState.anchorFlushed &&
        pfState.enableTokenReleased &&
        !pfState.cleanupError)),
  proofKind: "m0-network-deny-macos",
  generatedAt: new Date().toISOString(),
  denyMechanism: managedPf
    ? "managed-pf-anchor plus tcpdump capture"
    : "operator-confirmed external deny layer plus tcpdump capture",
  applicationUidNonRoot: invokingUid > 0,
  applicationRunsAsRoot: false,
  externalDenyConfirmed,
  managedPf: pfState,
  executable,
  interface: iface,
  smokeProofPath,
  denyLayerProbe,
  packetCount: packets.length,
  packetSamples: packets,
  stdout: stdout.trim(),
  stderr: stderr.trim(),
  tcpdumpStderr: tcpdumpError.trim(),
  smokeProof,
};
writeJson(networkProofPath, proof);

if (denyProbeResult?.error) throw denyProbeResult.error;
if (managedPf && denyLayerProbe.blocked !== true) {
  throw new Error(`macOS deny-layer sentinel connected or did not prove blocked. Proof written to ${networkProofPath}`);
}
if (smokeExit.code !== 0) {
  throw new Error(`macOS packaged smoke failed under confirmed deny layer. Proof written to ${networkProofPath}`);
}
if (packets.length > 0) {
  throw new Error(`macOS tcpdump observed outbound packets. Proof written to ${networkProofPath}`);
}
if (!smokeProof?.ok) {
  throw new Error(`macOS smoke proof missing or failed: ${smokeProofPath}`);
}

console.log(`M0 macOS network proof written to ${networkProofPath}.`);
