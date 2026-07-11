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
  const processMatch = metadata.match(/(?:^|,\s*)proc\s+([^,]+):(\d+)(?:,|$)/);
  const effectiveProcessMatch = metadata.match(/(?:^|,\s*)eproc\s+([^,]+):(\d+)(?:,|$)/);
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

function parsePflogPacket(line) {
  const identity = line.match(/\[\s*uid\s+(\d+),\s*pid\s+(\d+)\s*\]/);
  return {
    line,
    uid: identity ? Number.parseInt(identity[1], 10) : null,
    pid: identity ? Number.parseInt(identity[2], 10) : null,
    direction: /\bblock\s+out\b/.test(line) ? "out" : null,
  };
}

function processTreeSnapshot(rootPid) {
  if (!Number.isInteger(rootPid) || rootPid <= 0) return [];
  const result = spawnSync("ps", ["-axo", "pid=,ppid=,comm="], { encoding: "utf8" });
  if (result.status !== 0) return [];
  const processes = result.stdout
    .split(/\r?\n/)
    .map((line) => line.match(/^\s*(\d+)\s+(\d+)\s+(.+)$/))
    .filter(Boolean)
    .map((match) => ({
      pid: Number.parseInt(match[1], 10),
      ppid: Number.parseInt(match[2], 10),
      command: match[3].trim(),
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
  return normalized === "candor-core" || normalized.startsWith("candor v3 m0");
}

function runPacketParserSelfTest() {
  const parsed = parsePktapPacket(
    "00:00:00.000000 (en0, proc Candor v3 M0 Helper (Renderer):77619, out, so) IP 10.0.0.1.1 > 1.1.1.1.443",
  );
  if (
    parsed.processName !== "Candor v3 M0 Helper (Renderer)" ||
    parsed.pid !== 77619 ||
    parsed.direction !== "out"
  ) {
    throw new Error("macOS PKTAP packet parser self-test failed");
  }
  const delegated = parsePktapPacket(
    "00:00:00.000000 (proc mDNSResponder:184, eproc Candor v3 M0:77620, out) IP 10.0.0.1.1 > 1.1.1.1.53",
  );
  if (
    delegated.processName !== "mDNSResponder" ||
    delegated.pid !== 184 ||
    delegated.effectiveProcessName !== "Candor v3 M0" ||
    delegated.effectivePid !== 77620
  ) {
    throw new Error("macOS PKTAP effective-process parser self-test failed");
  }
  const blocked = parsePflogPacket(
    "00:00:00.000000 rule 0/(match) [uid 501, pid 83664] block out on en0: 10.0.0.1.1 > 1.1.1.1.443",
  );
  if (blocked.uid !== 501 || blocked.pid !== 83664 || blocked.direction !== "out") {
    throw new Error("macOS PFLOG packet parser self-test failed");
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
const proofCommands = ["bash", "sudo", "tcpdump", "pfctl", "ifconfig", "ps", "node"];

if (validateOnly) {
  const candidateAppPaths = explicitAppPath ? [explicitAppPath] : defaultExecutableCandidates();
  const commands = Object.fromEntries(proofCommands.map((command) => [command, commandExists(command)]));
  const root = typeof process.getuid === "function" ? process.getuid() === 0 : false;
  const baseCommandsAvailable = ["bash", "tcpdump", "ps", "node"].every((command) => commands[command]);
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
          commands.pfctl &&
          commands.ifconfig,
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
if (managedPf && !commandExists("ifconfig")) {
  throw new Error("Required command not found: ifconfig");
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
const captureInterface = "pktap,all";
const pfAnchor = `com.apple/candor-v3-m0-network-deny-${process.pid}`;
const pfRules = `block drop out log (user) quick proto { tcp udp } all user ${invokingUid}\n`;
const pfState = {
  requested: managedPf,
  anchor: managedPf ? pfAnchor : null,
  rules: managedPf ? pfRules.trim() : null,
  enabled: false,
  enableToken: null,
  anchorLoaded: false,
  pflogInterface: managedPf ? "pflog0" : null,
  pflogInterfaceInitiallyPresent: null,
  pflogInterfaceCreated: false,
  pflogInterfaceReady: false,
  pflogInterfaceDestroyed: false,
  anchorFlushed: false,
  enableTokenReleased: false,
  cleanupError: null,
};

function interfaceExists(name) {
  const result = spawnSync("ifconfig", [name], {
    cwd: repoRoot,
    encoding: "utf8",
  });
  return result.status === 0;
}

function ensureManagedPflogInterface() {
  if (!managedPf) return;
  pfState.pflogInterfaceInitiallyPresent = interfaceExists("pflog0");
  if (!pfState.pflogInterfaceInitiallyPresent) {
    runCommand("ifconfig", ["pflog0", "create"]);
    pfState.pflogInterfaceCreated = true;
  }
  runCommand("ifconfig", ["pflog0", "up"]);
  pfState.pflogInterfaceReady = interfaceExists("pflog0");
  if (!pfState.pflogInterfaceReady) {
    throw new Error("pflog0 was not available after setup");
  }
}

function enableManagedPfDeny() {
  if (!managedPf) return;

  try {
    ensureManagedPflogInterface();
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

  if (pfState.pflogInterfaceCreated) {
    try {
      runCommand("ifconfig", ["pflog0", "destroy"]);
      pfState.pflogInterfaceDestroyed = true;
    } catch (error) {
      pfState.cleanupError = [pfState.cleanupError, error.message].filter(Boolean).join("; ");
    }
  }
}

mkdirSync(proofDir, { recursive: true });

enableManagedPfDeny();

const tcpdump = spawn("tcpdump", [
  "-n",
  "-l",
  "-k",
  "NPD",
  "-i",
  captureInterface,
  "-Q",
  "dir=out",
  "tcp or udp",
], {
  cwd: repoRoot,
  stdio: ["ignore", "pipe", "pipe"],
});
const packets = [];
const maxCapturedPackets = 5000;
let packetOverflowCount = 0;
let packetBuffer = "";
let tcpdumpError = "";
let tcpdumpSpawnError = null;
let tcpdumpExitedBeforeCleanup = false;
tcpdump.stdout.on("data", (chunk) => {
  packetBuffer += chunk.toString("utf8");
  let newlineIndex = packetBuffer.indexOf("\n");
  while (newlineIndex >= 0) {
    const line = packetBuffer.slice(0, newlineIndex).trim();
    packetBuffer = packetBuffer.slice(newlineIndex + 1);
    if (line) {
      if (packets.length < maxCapturedPackets) packets.push(line);
      else packetOverflowCount += 1;
    }
    newlineIndex = packetBuffer.indexOf("\n");
  }
});
tcpdump.stderr.on("data", (chunk) => {
  tcpdumpError += chunk.toString("utf8");
});
tcpdump.on("error", (error) => {
  tcpdumpSpawnError = error;
});

const pflogDump = managedPf
  ? spawn("tcpdump", ["-n", "-l", "-e", "-vv", "-ttt", "-i", "pflog0"], {
      cwd: repoRoot,
      stdio: ["ignore", "pipe", "pipe"],
    })
  : null;
const blockedPackets = [];
let blockedPacketOverflowCount = 0;
let pflogBuffer = "";
let pflogError = "";
let pflogSpawnError = null;
let pflogExitedBeforeCleanup = false;
if (pflogDump) {
  pflogDump.stdout.on("data", (chunk) => {
    pflogBuffer += chunk.toString("utf8");
    let newlineIndex = pflogBuffer.indexOf("\n");
    while (newlineIndex >= 0) {
      const line = pflogBuffer.slice(0, newlineIndex).trim();
      pflogBuffer = pflogBuffer.slice(newlineIndex + 1);
      if (line) {
        if (blockedPackets.length < maxCapturedPackets) blockedPackets.push(line);
        else blockedPacketOverflowCount += 1;
      }
      newlineIndex = pflogBuffer.indexOf("\n");
    }
  });
  pflogDump.stderr.on("data", (chunk) => {
    pflogError += chunk.toString("utf8");
  });
  pflogDump.on("error", (error) => {
    pflogSpawnError = error;
  });
}

let stdout = "";
let stderr = "";
let smokeExit = { code: null, signal: null };
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
    const probe = spawn("sudo", [
      "-u",
      invokingUser,
      "-H",
      "env",
      process.execPath,
      "-e",
      denyProbeScript(),
    ], {
      cwd: repoRoot,
      stdio: ["ignore", "pipe", "pipe"],
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
  }

  if (
    (!managedPf || denyLayerProbe.blocked === true) &&
    !tcpdumpSpawnError &&
    (!managedPf || !pflogSpawnError)
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
  }
} finally {
  if (!tcpdumpSpawnError) {
    tcpdumpExitedBeforeCleanup = tcpdump.exitCode !== null || tcpdump.signalCode !== null;
    if (!tcpdumpExitedBeforeCleanup) tcpdump.kill("SIGINT");
    await waitForExit(tcpdump).catch(() => null);
  }
  if (pflogDump && !pflogSpawnError) {
    pflogExitedBeforeCleanup = pflogDump.exitCode !== null || pflogDump.signalCode !== null;
    if (!pflogExitedBeforeCleanup) pflogDump.kill("SIGINT");
    await waitForExit(pflogDump).catch(() => null);
  }
  const trailingPacket = packetBuffer.trim();
  if (trailingPacket) {
    if (packets.length < maxCapturedPackets) packets.push(trailingPacket);
    else packetOverflowCount += 1;
  }
  const trailingBlockedPacket = pflogBuffer.trim();
  if (trailingBlockedPacket) {
    if (blockedPackets.length < maxCapturedPackets) blockedPackets.push(trailingBlockedPacket);
    else blockedPacketOverflowCount += 1;
  }
  cleanupManagedPfDeny();
}

const smokeProof = existsSync(smokeProofPath)
  ? JSON.parse(readFileSync(smokeProofPath, "utf8"))
  : null;
const parsedPackets = packets.map(parsePktapPacket);
const parsedBlockedPackets = blockedPackets.map(parsePflogPacket);
const observedProcessIds = new Set(observedProcesses.keys());
const escapedApplicationPackets = parsedPackets.filter(
  (packet) =>
    observedProcessIds.has(packet.pid) ||
    observedProcessIds.has(packet.effectivePid) ||
    isCandorProcessName(packet.processName) ||
    isCandorProcessName(packet.effectiveProcessName),
);
const blockedApplicationPackets = parsedBlockedPackets.filter(
  (packet) => packet.uid === invokingUid && observedProcessIds.has(packet.pid),
);
const denyProbePackets = parsedBlockedPackets.filter(
  (packet) => Number.isInteger(denyLayerProbe.pid) && packet.pid === denyLayerProbe.pid,
);
const packetsWithoutProcessMetadata = parsedPackets.filter(
  (packet) =>
    packet.direction !== "out" ||
    ((!Number.isInteger(packet.pid) ||
      typeof packet.processName !== "string" ||
      packet.processName.length === 0) &&
      (!Number.isInteger(packet.effectivePid) ||
        typeof packet.effectiveProcessName !== "string" ||
        packet.effectiveProcessName.length === 0)),
);
const blockedPacketsWithoutProcessMetadata = parsedBlockedPackets.filter(
  (packet) =>
    packet.direction !== "out" ||
    !Number.isInteger(packet.uid) ||
    !Number.isInteger(packet.pid),
);
const applicationPacketCount =
  escapedApplicationPackets.length + blockedApplicationPackets.length;
const packetAttribution = {
  captureInterface,
  blockedCaptureInterface: managedPf ? "pflog0" : null,
  metadataSource: "macOS PKTAP process name, PID, and direction",
  blockedMetadataSource: managedPf ? "PF log(user) UID and PID" : null,
  observedPacketCount: parsedPackets.length,
  blockedAttemptPacketCount: parsedBlockedPackets.length,
  packetOverflowCount,
  blockedPacketOverflowCount,
  applicationPacketCount,
  applicationEscapedPacketCount: escapedApplicationPackets.length,
  applicationBlockedPacketCount: blockedApplicationPackets.length,
  applicationPacketSamples: [
    ...escapedApplicationPackets.map((packet) => ({ capture: "pktap", ...packet })),
    ...blockedApplicationPackets.map((packet) => ({ capture: "pflog0", ...packet })),
  ].slice(0, 50),
  hostBackgroundPacketCount: parsedPackets.length - escapedApplicationPackets.length,
  hostBackgroundPacketSamples: parsedPackets
    .filter((packet) => !escapedApplicationPackets.includes(packet))
    .slice(0, 25),
  blockedHostBackgroundPacketCount:
    parsedBlockedPackets.length - blockedApplicationPackets.length - denyProbePackets.length,
  blockedHostBackgroundPacketSamples: parsedBlockedPackets
    .filter((packet) => !blockedApplicationPackets.includes(packet) && !denyProbePackets.includes(packet))
    .slice(0, 25),
  packetsWithoutProcessMetadata: packetsWithoutProcessMetadata.slice(0, 25),
  blockedPacketsWithoutProcessMetadata: blockedPacketsWithoutProcessMetadata.slice(0, 25),
  observedProcesses: [...observedProcesses.values()].sort((left, right) => left.pid - right.pid),
  denyProbePacketCount: denyProbePackets.length,
  denyProbeCaptured: !managedPf || denyProbePackets.length > 0,
  complete:
    !tcpdumpSpawnError &&
    !tcpdumpExitedBeforeCleanup &&
    packetOverflowCount === 0 &&
    packetsWithoutProcessMetadata.length === 0 &&
    (!managedPf ||
      (!pflogSpawnError &&
        !pflogExitedBeforeCleanup &&
        blockedPacketOverflowCount === 0 &&
        blockedPacketsWithoutProcessMetadata.length === 0)),
  tcpdumpExitedBeforeCleanup,
  pflogExitedBeforeCleanup,
};

const proof = {
  ok:
    smokeExit.code === 0 &&
    smokeProof?.ok === true &&
    (!managedPf || denyLayerProbe.blocked === true) &&
    packetAttribution.denyProbeCaptured &&
    packetAttribution.complete &&
    applicationPacketCount === 0 &&
    (!managedPf ||
      (pfState.anchorLoaded &&
        pfState.pflogInterfaceReady &&
        (!pfState.pflogInterfaceCreated || pfState.pflogInterfaceDestroyed) &&
        pfState.anchorFlushed &&
        pfState.enableTokenReleased &&
        !pfState.cleanupError)),
  proofKind: "m0-network-deny-macos",
  generatedAt: new Date().toISOString(),
  denyMechanism: managedPf
    ? "managed-pf user-scoped deny with PFLOG blocked-attempt and PKTAP escape attribution"
    : "operator-confirmed external deny layer plus PKTAP process attribution",
  applicationUidNonRoot: invokingUid > 0,
  applicationRunsAsRoot: false,
  externalDenyConfirmed,
  managedPf: pfState,
  executable,
  interface: captureInterface,
  smokeProofPath,
  denyLayerProbe,
  packetCount: applicationPacketCount,
  packetSamples: packetAttribution.applicationPacketSamples.map((packet) => packet.line),
  packetAttribution,
  stdout: stdout.trim(),
  stderr: stderr.trim(),
  tcpdumpStderr: tcpdumpError.trim(),
  tcpdumpSpawnError: tcpdumpSpawnError?.message ?? null,
  pflogStderr: pflogError.trim(),
  pflogSpawnError: pflogSpawnError?.message ?? null,
  smokeProof,
};
writeJson(networkProofPath, proof);

if (managedPf && denyLayerProbe.blocked !== true) {
  throw new Error(`macOS deny-layer sentinel connected or did not prove blocked. Proof written to ${networkProofPath}`);
}
if (!packetAttribution.denyProbeCaptured) {
  throw new Error(`macOS PFLOG did not capture the blocked sentinel with its process PID. Proof written to ${networkProofPath}`);
}
if (!packetAttribution.complete) {
  throw new Error(`macOS PKTAP process attribution was incomplete. Proof written to ${networkProofPath}`);
}
if (smokeExit.code !== 0) {
  throw new Error(`macOS packaged smoke failed under confirmed deny layer. Proof written to ${networkProofPath}`);
}
if (applicationPacketCount > 0) {
  throw new Error(`macOS PFLOG or PKTAP observed Candor-attributed outbound packets. Proof written to ${networkProofPath}`);
}
if (!smokeProof?.ok) {
  throw new Error(`macOS smoke proof missing or failed: ${smokeProofPath}`);
}

console.log(`M0 macOS network proof written to ${networkProofPath}.`);
