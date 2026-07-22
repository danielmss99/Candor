import { createVersionedCoreRequest } from "./core-rpc-envelope.mjs";
import { removeTemporaryDirectory, stopChildProcess } from "./child-process-cleanup.mjs";
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = path.resolve(__dirname, "..");
const exe = process.platform === "win32" ? "candor-core.exe" : "candor-core";
const corePath = process.argv[2]
  ? path.resolve(process.argv[2])
  : path.join(repoRoot, "crates", "candor-core", "target", "debug", exe);

if (!existsSync(corePath)) {
  throw new Error(`candor-core debug binary not found: ${corePath}`);
}

const dataDir = mkdtempSync(path.join(tmpdir(), "candor-v3-vault-"));
const child = spawn(corePath, [], {
  stdio: ["pipe", "pipe", "pipe"],
  windowsHide: true,
  env: {
    ...process.env,
    CANDOR_V3_DATA_DIR: dataDir,
  },
});

const lines = createInterface({ input: child.stdout });
const pending = new Map();

function nonWindowsAvailableOsKeyLabels() {
  return new Set(["keychain-proof-available", "secret-service-proof-available"]);
}

function nonWindowsUnavailableOsKeyLabels() {
  return new Set(["keychain-unavailable", "secret-service-unavailable"]);
}

function nativeOsKeyAvailable(status) {
  return status?.localOpenAvailable === true;
}

child.stderr.on("data", (chunk) => {
  process.stderr.write(`[candor-core stderr] ${chunk}`);
});

lines.on("line", (line) => {
  const response = JSON.parse(line);
  const entry = pending.get(response.id);
  if (!entry) return;
  pending.delete(response.id);
  if (response.ok) {
    entry.resolve(response.result);
  } else {
    const error = new Error(response.error?.message ?? "RPC failed");
    error.code = response.error?.code;
    error.response = response;
    entry.reject(error);
  }
});

function call(method, params = null) {
  const request = createVersionedCoreRequest(method, params);
  const id = request.requestId;
  const payload = JSON.stringify(request);
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      pending.delete(id);
      reject(new Error(`timeout waiting for ${method}`));
    }, 10000);
    pending.set(id, {
      resolve: (value) => {
        clearTimeout(timeout);
        resolve(value);
      },
      reject: (err) => {
        clearTimeout(timeout);
        reject(err);
      },
    });
    child.stdin.write(`${payload}\n`);
  });
}

try {
  const before = await call("vault.status");
  if (before?.backend !== "sqlcipher" || before?.keyMaterialExposedToRenderer !== false) {
    throw new Error("vault status did not report SQLCipher with hidden key material");
  }
  if (process.platform === "win32" && before?.osKeyStorage !== "dpapi-proof-available") {
    throw new Error(`Windows vault status did not report DPAPI proof availability: ${before?.osKeyStorage}`);
  }
  if (
    process.platform !== "win32" &&
    nativeOsKeyAvailable(before) &&
    !nonWindowsAvailableOsKeyLabels().has(before?.osKeyStorage)
  ) {
    throw new Error(`Non-Windows vault status did not report available native key storage: ${before?.osKeyStorage}`);
  }
  if (
    process.platform !== "win32" &&
    !nativeOsKeyAvailable(before) &&
    !nonWindowsUnavailableOsKeyLabels().has(before?.osKeyStorage)
  ) {
    throw new Error(`Non-Windows vault status did not report unavailable native key storage: ${before?.osKeyStorage}`);
  }

  const osKeyProof = await call("vault.proofOsKeyStorage");
  if (process.platform === "win32") {
    if (
      osKeyProof?.backend !== "dpapi" ||
      osKeyProof?.available !== true ||
      osKeyProof?.roundTrip !== true ||
      osKeyProof?.stableAfterReopen !== true ||
      osKeyProof?.persisted !== true
    ) {
      throw new Error("DPAPI key-storage proof did not persist and reopen a local key");
    }
  } else if (nativeOsKeyAvailable(before)) {
    if (
      !["keychain", "secret-service"].includes(osKeyProof?.backend) ||
      osKeyProof?.available !== true ||
      osKeyProof?.stableAfterReopen !== true ||
      osKeyProof?.persisted !== true
    ) {
      throw new Error("native key-storage proof did not persist and reopen a local key");
    }
  } else if (
    osKeyProof?.available !== false ||
    osKeyProof?.state !== "unavailable" ||
    osKeyProof?.passphraseRequired !== true
  ) {
    throw new Error("non-Windows key-storage proof did not report explicit unavailable fallback state");
  }
  if (osKeyProof?.keyMaterialExposedToRenderer !== false || osKeyProof?.rawPathExposed !== false) {
    throw new Error("OS key-storage proof exposed key material or raw paths");
  }

  const shouldOpenOsKeyVault = process.platform === "win32" || nativeOsKeyAvailable(before);
  if (shouldOpenOsKeyVault) {
    const localVault = await call("vault.openLocal");
    if (
      localVault?.backend !== "sqlcipher" ||
      localVault?.encrypted !== true ||
      localVault?.openMode !== "os-key" ||
      localVault?.passphraseRequired !== false ||
      localVault?.proofHarness !== false
    ) {
      throw new Error("production local vault open did not use the OS-key SQLCipher path");
    }
    if (
      localVault?.keyMaterialExposedToRenderer !== false ||
      localVault?.rawPathExposed !== false
    ) {
      throw new Error("production local vault open exposed key material or raw paths");
    }

    const osKeyVault = await call("vault.openWithOsKeyProof");
    if (
      osKeyVault?.backend !== "sqlcipher" ||
      osKeyVault?.encrypted !== true ||
      osKeyVault?.openMode !== "os-key" ||
      osKeyVault?.passphraseRequired !== false ||
      osKeyVault?.proofHarness !== true ||
      osKeyVault?.reopenVerified !== true ||
      osKeyVault?.stableAfterReopen !== true
    ) {
      throw new Error("OS-key-backed SQLCipher vault proof did not open and reopen locally");
    }
    if (
      osKeyVault?.keyMaterialExposedToRenderer !== false ||
      osKeyVault?.rawPathExposed !== false
    ) {
      throw new Error("OS-key-backed vault proof exposed key material or raw paths");
    }

    const indexedStart = await call("recording.durable.start", { label: "indexed vault smoke" });
    await call("recording.durable.writeTextChunk", {
      recordingId: indexedStart.recordingId,
      channel: "mic",
      dataUtf8: "metadata lands in encrypted vault",
    });
    const indexedFinished = await call("recording.durable.finish", {
      recordingId: indexedStart.recordingId,
    });
    if (
      indexedFinished?.vaultIndex?.available !== true ||
      indexedFinished?.vaultIndex?.indexed !== true ||
      indexedFinished?.vaultIndex?.backend !== "sqlcipher" ||
      indexedFinished?.vaultIndex?.recordingCount < 1
    ) {
      throw new Error("durable recording metadata was not indexed into the encrypted SQLCipher vault");
    }
    if (
      indexedFinished?.vaultIndex?.keyMaterialExposedToRenderer !== false ||
      indexedFinished?.vaultIndex?.rawPathExposed !== false
    ) {
      throw new Error("encrypted recording index exposed key material or raw paths");
    }
  }

  const proof = await call("vault.proofWrongKeyFails", {
    correctPassphrase: "correct horse battery staple",
    wrongPassphrase: "wrong horse battery staple",
  });
  if (proof?.open?.backend !== "sqlcipher" || proof?.open?.encrypted !== true) {
    throw new Error("vault proof did not open an encrypted SQLCipher vault");
  }
  if (proof?.wrongKeyFailed !== true) {
    throw new Error("SQLCipher vault accepted or read with the wrong key");
  }
  if (proof?.keyMaterialExposedToRenderer !== false || proof?.rawPathExposed !== false) {
    throw new Error("vault proof exposed key material or raw paths");
  }

  const fallbackProof = await call("vault.proofPassphraseFallback");
  if (
    fallbackProof?.backend !== "sqlcipher" ||
    fallbackProof?.encrypted !== true ||
    fallbackProof?.openMode !== "passphrase-fallback" ||
    fallbackProof?.proofHarness !== true ||
    fallbackProof?.passphraseRequired !== true ||
    fallbackProof?.reopenVerified !== true ||
    fallbackProof?.wrongKeyFailed !== true ||
    fallbackProof?.rendererPassphraseExposed !== false
  ) {
    throw new Error("passphrase fallback proof did not reopen and reject the wrong key locally");
  }
  if (
    fallbackProof?.keyMaterialExposedToRenderer !== false ||
    fallbackProof?.rawPathExposed !== false
  ) {
    throw new Error("passphrase fallback proof exposed key material or raw paths");
  }

  const after = await call("vault.status");
  if (after?.rawPathExposed !== false || after?.keyMaterialExposedToRenderer !== false) {
    throw new Error("vault status after proof exposed key material or raw paths");
  }
  if (shouldOpenOsKeyVault && (after?.state !== "closed" || after?.encrypted !== true)) {
    throw new Error("vault status after proof did not report a closed encrypted production vault");
  }
  if (!shouldOpenOsKeyVault && after?.localOpenAvailable !== false) {
    throw new Error("vault status after unavailable key-storage proof did not preserve fallback state");
  }

  await call("core.shutdown");
  console.log("M1 SQLCipher vault smoke passed.");
} finally {
  lines.close();
  if (!child.stdin.destroyed && !child.stdin.writableEnded) child.stdin.end();
  await stopChildProcess(child);
  removeTemporaryDirectory(dataDir);
}
