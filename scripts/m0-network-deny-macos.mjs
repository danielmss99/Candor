import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
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
    join(repoRoot, "release-v3", "mac", "Candor.app", "Contents", "MacOS", "Candor"),
    join(repoRoot, "release-v3", "mac-arm64", "Candor.app", "Contents", "MacOS", "Candor"),
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

function waitForExit(child) {
  if (child.exitCode !== null || child.signalCode !== null) {
    return Promise.resolve({ code: child.exitCode, signal: child.signalCode });
  }
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

function parsePktapPacket(line) {
  const metadata = line.match(/\((.*)\)\s+(?:IP|IP6)\b/)?.[1] ?? "";
  const processMatch = metadata.match(/(?:^|,\s*)proc\s+([^,]*?):(\d+)(?:,|$)/);
  const effectiveProcessMatch = metadata.match(/(?:^|,\s*)eproc\s+([^,]*?):(\d+)(?:,|$)/);
  return {
    line,
    processName: processMatch?.[1]?.trim() ?? null,
    pid: processMatch ? Number.parseInt(processMatch[2], 10) : null,
    effectiveProcessName: effectiveProcessMatch?.[1]?.trim() ?? null,
    effectivePid: effectiveProcessMatch
      ? Number.parseInt(effectiveProcessMatch[2], 10)
      : null,
    direction: /(?:^|,\s*)out(?:,|$)/.test(metadata) ? "out" : null,
  };
}

function parsePfRuleStats(text) {
  const packetMatches = [...text.matchAll(/\bPackets:\s*(\d+)/g)];
  const byteMatches = [...text.matchAll(/\bBytes:\s*(\d+)/g)];
  return {
    parsed: packetMatches.length > 0,
    ruleCount: packetMatches.length,
    packets: packetMatches.reduce((total, match) => total + Number.parseInt(match[1], 10), 0),
    bytes: byteMatches.reduce((total, match) => total + Number.parseInt(match[1], 10), 0),
    raw: text.trim(),
  };
}

function parseTcpdumpCaptureStats(text) {
  const captured = text.match(/(\d+)\s+packets? captured/);
  const received = text.match(/(\d+)\s+packets? received by filter/);
  const kernelDropped = text.match(/(\d+)\s+packets? dropped by kernel/);
  const metadataFilterDropped = text.match(/(\d+)\s+drops? by metadata filter/);
  return {
    parsed: Boolean(captured && received && kernelDropped),
    captured: captured ? Number.parseInt(captured[1], 10) : null,
    receivedByFilter: received ? Number.parseInt(received[1], 10) : null,
    kernelDropped: kernelDropped ? Number.parseInt(kernelDropped[1], 10) : null,
    metadataFilterDropped: metadataFilterDropped
      ? Number.parseInt(metadataFilterDropped[1], 10)
      : 0,
  };
}

function processTreeSnapshot(rootPid) {
  if (!Number.isInteger(rootPid) || rootPid <= 0) return [];
  const result = spawnSync("ps", ["-axo", "pid=,ppid=,uid=,gid=,comm="], { encoding: "utf8" });
  if (result.status !== 0) return [];
  const processes = result.stdout
    .split(/\r?\n/)
    .map((line) => line.match(/^\s*(\d+)\s+(\d+)\s+(\d+)\s+(\d+)\s+(.+)$/))
    .filter(Boolean)
    .map((match) => ({
      pid: Number.parseInt(match[1], 10),
      ppid: Number.parseInt(match[2], 10),
      uid: Number.parseInt(match[3], 10),
      gid: Number.parseInt(match[4], 10),
      command: match[5].trim(),
    }));
  const descendants = new Set([rootPid]);
  let changed = true;
  while (changed) {
    changed = false;
    for (const process of processes) {
      if (descendants.has(process.ppid) && !descendants.has(process.pid)) {
        descendants.add(process.pid);
        changed = true;
      }
    }
  }
  return processes.filter((process) => descendants.has(process.pid));
}

function isCandorProcessName(name) {
  const normalized = String(name ?? "").trim().toLowerCase();
  return (
    normalized === "candor" ||
    normalized === "candor-core" ||
    normalized.startsWith("candor helper")
  );
}

function runPacketParserSelfTest() {
  const parsed = parsePktapPacket(
    "00:00:00.000000 (en0, proc Candor Helper (Renderer):77619, out, so) IP 10.0.0.1.1 > 1.1.1.1.443",
  );
  if (
    parsed.processName !== "Candor Helper (Renderer)" ||
    parsed.pid !== 77619 ||
    parsed.direction !== "out"
  ) {
    throw new Error("macOS PKTAP packet parser self-test failed");
  }
  const delegated = parsePktapPacket(
    "00:00:00.000000 (proc mDNSResponder:184, eproc Candor:77620, out) IP 10.0.0.1.1 > 1.1.1.1.53",
  );
  if (
    delegated.processName !== "mDNSResponder" ||
    delegated.pid !== 184 ||
    delegated.effectiveProcessName !== "Candor" ||
    delegated.effectivePid !== 77620
  ) {
    throw new Error("macOS PKTAP effective-process parser self-test failed");
  }
  const ruleStats = parsePfRuleStats(`
@0 block drop out quick proto tcp all user = 501 group = 62000
  [ Evaluations: 42        Packets: 3         Bytes: 180         States: 0     ]
@1 block drop out quick proto udp all user = 501 group = 62000
  [ Evaluations: 21        Packets: 0         Bytes: 0           States: 0     ]
`);
  if (!ruleStats.parsed || ruleStats.ruleCount !== 2 || ruleStats.packets !== 3 || ruleStats.bytes !== 180) {
    throw new Error("macOS PF rule counter parser self-test failed");
  }
  const captureStats = parseTcpdumpCaptureStats(`
0 packets captured
15 packets received by filter
0 packets dropped by kernel
15 drops by metadata filter
`);
  if (
    !captureStats.parsed ||
    captureStats.captured !== 0 ||
    captureStats.receivedByFilter !== 15 ||
    captureStats.kernelDropped !== 0 ||
    captureStats.metadataFilterDropped !== 15
  ) {
    throw new Error("macOS PKTAP capture statistics parser self-test failed");
  }
  const kernelPacket = parsePktapPacket(
    "00:00:00.000000 (proc :0, eproc :0, out) IP 10.0.0.1.1 > 1.1.1.1.443: Flags [R]",
  );
  if (
    kernelPacket.pid !== 0 ||
    kernelPacket.processName !== "" ||
    kernelPacket.effectivePid !== 0 ||
    kernelPacket.effectiveProcessName !== "" ||
    kernelPacket.direction !== "out"
  ) {
    throw new Error("macOS PKTAP kernel-attribution parser self-test failed");
  }
}

runPacketParserSelfTest();

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
    pid: process.pid,
    uid: process.getuid(),
    gid: process.getgid(),
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
const proofCommands = ["bash", "sudo", "tcpdump", "pfctl", "ps", "node"];

if (validateOnly) {
  const candidateAppPaths = explicitAppPath ? [explicitAppPath] : defaultExecutableCandidates();
  const commands = Object.fromEntries(proofCommands.map((command) => [command, commandExists(command)]));
  const root = typeof process.getuid === "function" ? process.getuid() === 0 : false;
  const baseCommandsAvailable = ["bash", "tcpdump", "ps", "node"].every(
    (command) => commands[command],
  );
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
        canRunManagedPfProof:
          process.platform === "darwin" &&
          root &&
          baseCommandsAvailable &&
          commands.pfctl,
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
for (const command of ["bash", "sudo", "tcpdump", "ps", "node"]) {
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

function selectUnusedExecutionGid() {
  const result = spawnSync("ps", ["-axo", "gid="], { encoding: "utf8" });
  if (result.status !== 0) {
    throw new Error(`Unable to enumerate active macOS process groups: ${result.stderr.trim()}`);
  }
  const used = new Set(
    result.stdout
      .split(/\r?\n/)
      .map((value) => Number.parseInt(value.trim(), 10))
      .filter(Number.isInteger),
  );
  for (let offset = 0; offset < 5000; offset += 1) {
    const candidate = 60000 + ((process.pid + offset) % 5000);
    if (!used.has(candidate)) return candidate;
  }
  throw new Error("Unable to reserve an unused execution GID for the macOS proof");
}

const executionGid = selectUnusedExecutionGid();
const invokingHome = runCommand("sudo", ["-u", invokingUser, "-H", "sh", "-c", 'printf "%s" "$HOME"']).stdout.trim();
const executionEnvironment = {
  ...process.env,
  HOME: invokingHome,
  USER: invokingUser,
  LOGNAME: invokingUser,
};
const identityResult = spawnSync(
  process.execPath,
  [
    "-e",
    "console.log(JSON.stringify({ uid: process.getuid(), gid: process.getgid(), groups: process.getgroups() }))",
  ],
  {
    cwd: repoRoot,
    encoding: "utf8",
    env: executionEnvironment,
    uid: invokingUid,
    gid: executionGid,
  },
);
if (identityResult.error || identityResult.status !== 0) {
  throw new Error(
    `Unable to launch the macOS proof identity: ${identityResult.error?.message ?? identityResult.stderr.trim()}`,
  );
}
const executionIdentity = JSON.parse(identityResult.stdout.trim());
if (executionIdentity.uid !== invokingUid || executionIdentity.gid !== executionGid) {
  throw new Error("macOS proof identity did not retain the requested non-root UID and isolated GID");
}

const executable = resolveExecutable(explicitAppPath);
const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
const smokeProofPath = join(proofDir, `m0-packaged-runtime-smoke-darwin-${process.arch}.json`);
const networkProofPath = join(proofDir, `m0-network-deny-macos-${timestamp}.json`);
const captureInterface = "pktap,all";
const captureMetadataFilter = "dir=out";
const captureFilePath = join(tmpdir(), `candor-m0-pktap-${process.pid}-${Date.now()}.pcapng`);
const pfAnchor = `com.apple/candor-v3-m0-network-deny-${process.pid}`;
const pfRules = `block drop out quick proto { tcp udp } all user ${invokingUid} group ${executionGid}\n`;
const pfState = {
  requested: managedPf,
  anchor: managedPf ? pfAnchor : null,
  rules: managedPf ? pfRules.trim() : null,
  enabled: false,
  enableToken: null,
  anchorLoaded: false,
  executionGid: managedPf ? executionGid : null,
  sentinelRuleStats: null,
  applicationBaselineRuleStats: null,
  applicationRuleStats: null,
  countersReset: false,
  anchorFlushed: false,
  enableTokenReleased: false,
  cleanupError: null,
};

function readManagedPfRuleStats() {
  if (!managedPf) return null;
  const result = runCommand("pfctl", ["-a", pfAnchor, "-v", "-v", "-s", "rules"]);
  const stats = parsePfRuleStats(result.stdout);
  if (!stats.parsed || stats.ruleCount !== 2) {
    throw new Error(`Unable to parse the managed PF rule counters: ${result.stdout.trim()}`);
  }
  return stats;
}

function resetManagedPfRuleStats() {
  if (!managedPf) return;
  runCommand("pfctl", ["-a", pfAnchor, "-z"]);
  pfState.countersReset = true;
}

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

const tcpdump = spawn("tcpdump", [
  "-n",
  "-U",
  "-P",
  "-s",
  "256",
  "-i",
  captureInterface,
  "-Q",
  captureMetadataFilter,
  "-w",
  captureFilePath,
  "tcp or udp",
], {
  cwd: repoRoot,
  stdio: ["ignore", "ignore", "pipe"],
});
const packets = [];
const maxCapturedPackets = 50000;
let packetOverflowCount = 0;
let tcpdumpError = "";
let tcpdumpSpawnError = null;
let tcpdumpExitedBeforeCleanup = false;
let captureParseExitCode = null;
let captureParseError = null;
let captureParseStderr = "";
let captureFileRemoved = false;
tcpdump.stderr.on("data", (chunk) => {
  tcpdumpError += chunk.toString("utf8");
});
tcpdump.on("error", (error) => {
  tcpdumpSpawnError = error;
});

let stdout = "";
let stderr = "";
let smokeExit = { code: null, signal: null };
let proofExecutionError = null;
let denyLayerProbe = {
  attempted: false,
  blocked: null,
  skippedReason: "external-deny-confirmed mode is operator-attested",
};
const observedProcesses = new Map();
try {
  await new Promise((resolvePromise) => setTimeout(resolvePromise, 750));

  if (managedPf) {
    let probeStdout = "";
    let probeStderr = "";
    const probe = spawn(process.execPath, ["-e", denyProbeScript()], {
      cwd: repoRoot,
      stdio: ["ignore", "pipe", "pipe"],
      env: executionEnvironment,
      uid: invokingUid,
      gid: executionGid,
    });
    probe.stdout.on("data", (chunk) => {
      probeStdout += chunk.toString("utf8");
    });
    probe.stderr.on("data", (chunk) => {
      probeStderr += chunk.toString("utf8");
    });
    const probeExit = await waitForExit(probe);
    denyLayerProbe = {
      ...parseDenyProbeOutput(probeStdout),
      controllerPid: probe.pid ?? null,
      exitCode: probeExit.code,
      signal: probeExit.signal,
      stderr: probeStderr.trim(),
      error: null,
    };
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 500));
    pfState.sentinelRuleStats = readManagedPfRuleStats();
    resetManagedPfRuleStats();
    pfState.applicationBaselineRuleStats = readManagedPfRuleStats();
  }

  if (
    (!managedPf ||
      (denyLayerProbe.blocked === true &&
        pfState.sentinelRuleStats?.packets > 0 &&
        pfState.countersReset &&
        pfState.applicationBaselineRuleStats?.packets === 0)) &&
    !tcpdumpSpawnError
  ) {
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
    const smokeEnvironment = { ...executionEnvironment };
    for (const [name, value] of Object.entries(forwardedEnvironment)) {
      if (typeof value === "string" && value.length > 0) smokeEnvironment[name] = value;
    }
    const smoke = spawn(process.execPath, ["scripts/m0-packaged-smoke.mjs"], {
      cwd: repoRoot,
      stdio: ["ignore", "pipe", "pipe"],
      env: smokeEnvironment,
      uid: invokingUid,
      gid: executionGid,
    });
    const observeProcessTree = () => {
      for (const process of processTreeSnapshot(smoke.pid)) {
        observedProcesses.set(process.pid, process);
      }
    };
    observeProcessTree();
    const processObserver = setInterval(observeProcessTree, 100);
    smoke.stdout.on("data", (chunk) => {
      stdout += chunk.toString("utf8");
    });
    smoke.stderr.on("data", (chunk) => {
      stderr += chunk.toString("utf8");
    });

    try {
      smokeExit = await waitForExit(smoke);
    } finally {
      clearInterval(processObserver);
    }
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 750));
    if (managedPf) pfState.applicationRuleStats = readManagedPfRuleStats();
  }
} catch (error) {
  proofExecutionError = error instanceof Error ? error.message : String(error);
} finally {
  if (!tcpdumpSpawnError) {
    tcpdumpExitedBeforeCleanup = tcpdump.exitCode !== null || tcpdump.signalCode !== null;
    if (!tcpdumpExitedBeforeCleanup) tcpdump.kill("SIGINT");
    await waitForExit(tcpdump).catch(() => null);
  }
  cleanupManagedPfDeny();
  if (existsSync(captureFilePath)) {
    try {
      const parseResult = spawnSync(
        "tcpdump",
        ["-n", "-k", "NPD", "-r", captureFilePath, "tcp or udp"],
        {
          cwd: repoRoot,
          encoding: "utf8",
          maxBuffer: 64 * 1024 * 1024,
        },
      );
      captureParseExitCode = parseResult.status;
      captureParseError = parseResult.error?.message ?? null;
      captureParseStderr = parseResult.stderr ?? "";
      for (const line of (parseResult.stdout ?? "").split(/\r?\n/)) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        if (packets.length < maxCapturedPackets) packets.push(trimmed);
        else packetOverflowCount += 1;
      }
    } finally {
      try {
        unlinkSync(captureFilePath);
        captureFileRemoved = true;
      } catch (error) {
        captureParseError = [captureParseError, error.message].filter(Boolean).join("; ");
      }
    }
  } else {
    captureParseError = "PKTAP capture file was not created";
  }
}

const smokeProof = existsSync(smokeProofPath)
  ? JSON.parse(readFileSync(smokeProofPath, "utf8"))
  : null;
const parsedPackets = packets.map(parsePktapPacket);
const captureStats = parseTcpdumpCaptureStats(tcpdumpError);
const observedProcessIds = new Set(observedProcesses.keys());
const observedProcessList = [...observedProcesses.values()].sort((left, right) => left.pid - right.pid);
const escapedApplicationPackets = parsedPackets.filter(
  (packet) =>
    observedProcessIds.has(packet.pid) ||
    observedProcessIds.has(packet.effectivePid) ||
    isCandorProcessName(packet.processName) ||
    isCandorProcessName(packet.effectiveProcessName),
);
const kernelAttributedPackets = parsedPackets.filter(
  (packet) =>
    (packet.pid === 0 && packet.processName === "") ||
    (packet.effectivePid === 0 && packet.effectiveProcessName === ""),
);
const packetsWithoutProcessMetadata = parsedPackets.filter(
  (packet) => {
    const primaryAttributed =
      Number.isInteger(packet.pid) &&
      typeof packet.processName === "string" &&
      (packet.processName.length > 0 || packet.pid === 0);
    const effectiveAttributed =
      Number.isInteger(packet.effectivePid) &&
      typeof packet.effectiveProcessName === "string" &&
      (packet.effectiveProcessName.length > 0 || packet.effectivePid === 0);
    return packet.direction !== "out" || (!primaryAttributed && !effectiveAttributed);
  },
);
const processIdentityMismatches = observedProcessList.filter(
  (process) => process.uid !== invokingUid || process.gid !== executionGid,
);
const denyProbePacketCount = managedPf ? (pfState.sentinelRuleStats?.packets ?? 0) : 0;
const applicationBlockedPacketCount = managedPf ? (pfState.applicationRuleStats?.packets ?? 0) : 0;
const applicationPacketCount = escapedApplicationPackets.length + applicationBlockedPacketCount;
const packetAttribution = {
  captureInterface,
  captureMetadataFilter,
  captureStats,
  captureParse: {
    exitCode: captureParseExitCode,
    error: captureParseError,
    stderr: captureParseStderr.trim(),
    rawCaptureRemoved: captureFileRemoved,
  },
  metadataSource: "macOS PKTAP process name, PID, and direction",
  blockedMetadataSource: managedPf
    ? "PF per-rule packet counters scoped to an isolated execution GID"
    : null,
  observedPacketCount: parsedPackets.length,
  blockedAttemptPacketCount: applicationBlockedPacketCount,
  packetOverflowCount,
  applicationPacketCount,
  applicationEscapedPacketCount: escapedApplicationPackets.length,
  applicationBlockedPacketCount,
  applicationPacketSamples: escapedApplicationPackets
    .map((packet) => ({ capture: "pktap", ...packet }))
    .slice(0, 50),
  hostBackgroundPacketCount: parsedPackets.length - escapedApplicationPackets.length,
  hostBackgroundPacketSamples: parsedPackets
    .filter((packet) => !escapedApplicationPackets.includes(packet))
    .slice(0, 25),
  kernelAttributedPacketCount: kernelAttributedPackets.length,
  kernelAttributedPacketSamples: kernelAttributedPackets.slice(0, 25),
  packetsWithoutProcessMetadata: packetsWithoutProcessMetadata.slice(0, 25),
  observedProcesses: observedProcessList,
  processIdentityMismatches: processIdentityMismatches.slice(0, 25),
  denyProbePacketCount,
  denyProbeCounted: !managedPf || denyProbePacketCount > 0,
  applicationBaselinePacketCount: managedPf
    ? (pfState.applicationBaselineRuleStats?.packets ?? null)
    : null,
  complete:
    !tcpdumpSpawnError &&
    !tcpdumpExitedBeforeCleanup &&
    captureParseExitCode === 0 &&
    !captureParseError &&
    captureFileRemoved &&
    captureStats.parsed &&
    captureStats.kernelDropped === 0 &&
    captureStats.captured === parsedPackets.length &&
    packetOverflowCount === 0 &&
    packetsWithoutProcessMetadata.length === 0 &&
    observedProcessList.length > 0 &&
    processIdentityMismatches.length === 0 &&
    (!managedPf ||
      (pfState.sentinelRuleStats?.parsed === true &&
        pfState.sentinelRuleStats.ruleCount === 2 &&
        pfState.applicationBaselineRuleStats?.parsed === true &&
        pfState.applicationBaselineRuleStats.ruleCount === 2 &&
        pfState.applicationBaselineRuleStats.packets === 0 &&
        pfState.applicationRuleStats?.parsed === true &&
        pfState.applicationRuleStats.ruleCount === 2)),
  tcpdumpExitedBeforeCleanup,
};

const proof = {
  ok:
    !proofExecutionError &&
    smokeExit.code === 0 &&
    smokeProof?.ok === true &&
    (!managedPf || denyLayerProbe.blocked === true) &&
    packetAttribution.denyProbeCounted &&
    packetAttribution.complete &&
    applicationPacketCount === 0 &&
    (!managedPf ||
      (pfState.anchorLoaded &&
        pfState.countersReset &&
        pfState.anchorFlushed &&
        pfState.enableTokenReleased &&
        !pfState.cleanupError)),
  proofKind: "m0-network-deny-macos",
  generatedAt: new Date().toISOString(),
  denyMechanism: managedPf
    ? "managed-pf isolated-group deny with per-rule blocked-attempt counters and PKTAP escape attribution"
    : "operator-confirmed external deny layer plus PKTAP process attribution",
  applicationUidNonRoot: executionIdentity.uid > 0,
  applicationRunsAsRoot: executionIdentity.uid === 0,
  executionIdentity: {
    user: invokingUser,
    uid: executionIdentity.uid,
    gid: executionIdentity.gid,
    groups: executionIdentity.groups,
    isolatedGid: executionGid,
    processTreeComplete: observedProcessList.length > 0 && processIdentityMismatches.length === 0,
  },
  externalDenyConfirmed,
  managedPf: pfState,
  executable,
  interface: captureInterface,
  captureConfiguration: {
    mode: "temporary-pcapng-file",
    snapshotLengthBytes: 256,
    metadataFilter: captureMetadataFilter,
    rawCaptureRemoved: captureFileRemoved,
  },
  smokeProofPath,
  denyLayerProbe,
  packetCount: applicationPacketCount,
  packetSamples: packetAttribution.applicationPacketSamples.map((packet) => packet.line),
  packetAttribution,
  stdout: stdout.trim(),
  stderr: stderr.trim(),
  proofExecutionError,
  tcpdumpStderr: tcpdumpError.trim(),
  tcpdumpSpawnError: tcpdumpSpawnError?.message ?? null,
  smokeProof,
};
writeJson(networkProofPath, proof);

if (proofExecutionError) {
  throw new Error(`macOS network proof execution failed: ${proofExecutionError}. Proof written to ${networkProofPath}`);
}
if (managedPf && denyLayerProbe.blocked !== true) {
  throw new Error(`macOS deny-layer sentinel connected or did not prove blocked. Proof written to ${networkProofPath}`);
}
if (!packetAttribution.denyProbeCounted) {
  throw new Error(`macOS PF counters did not record the isolated-group sentinel. Proof written to ${networkProofPath}`);
}
if (managedPf && packetAttribution.applicationBaselinePacketCount !== 0) {
  throw new Error(`macOS PF application counters did not reset to zero. Proof written to ${networkProofPath}`);
}
if (!packetAttribution.complete) {
  throw new Error(`macOS PKTAP process attribution was incomplete. Proof written to ${networkProofPath}`);
}
if (smokeExit.code !== 0) {
  throw new Error(`macOS packaged smoke failed under confirmed deny layer. Proof written to ${networkProofPath}`);
}
if (applicationPacketCount > 0) {
  throw new Error(
    `macOS PF counters or PKTAP observed Candor-attributed outbound packets. Proof written to ${networkProofPath}`,
  );
}
if (!smokeProof?.ok) {
  throw new Error(`macOS smoke proof missing or failed: ${smokeProofPath}`);
}

console.log(`M0 macOS network proof written to ${networkProofPath}.`);
