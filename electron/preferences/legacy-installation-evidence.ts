import { lstat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

export interface LegacyInstallationEvidenceOptions {
  userDataPath: () => string;
  coreDataPath?: () => string;
  coreRootExistenceIsEvidence?: boolean;
}

const KNOWN_CORE_FOOTPRINTS = Object.freeze([
  "recordings",
  "settings",
  "consent",
  "models",
  "keys",
  "recovery",
  "search",
  "deletions",
  "candor-v3.sqlcipher",
  "microphone-preference.json",
]);

const KNOWN_USER_DATA_FOOTPRINTS = Object.freeze([
  "license-state.bin",
  path.join("recovery", "capture-connection.json"),
]);

async function isOwnedFilesystemObject(candidate: string): Promise<boolean> {
  try {
    const metadata = await lstat(candidate);
    return !metadata.isSymbolicLink() && (metadata.isDirectory() || metadata.isFile());
  } catch {
    return false;
  }
}

async function isOwnedDirectory(candidate: string): Promise<boolean> {
  try {
    const metadata = await lstat(candidate);
    return !metadata.isSymbolicLink() && metadata.isDirectory();
  } catch {
    return false;
  }
}

export function defaultCandorCoreDataPath(
  platform: NodeJS.Platform = process.platform,
  environment: NodeJS.ProcessEnv = process.env,
): string {
  const override = environment.CANDOR_V3_DATA_DIR?.trim();
  if (override) return path.resolve(override);
  if (platform === "win32") {
    return path.join(environment.LOCALAPPDATA || os.tmpdir(), "Candor", "v3");
  }
  if (platform === "darwin") {
    return path.join(environment.HOME || os.tmpdir(), "Library", "Application Support", "Candor", "v3");
  }
  const dataHome = environment.XDG_DATA_HOME
    || (environment.HOME ? path.join(environment.HOME, ".local", "share") : os.tmpdir());
  return path.join(dataHome, "candor", "v3");
}

/**
 * Detects an upgrade only before desktop setup preferences exist. The caller
 * must snapshot and persist this result before starting candor-core because a
 * first-run core handshake may create the same Candor-owned data root.
 *
 * Evidence is deliberately narrow: the exact pre-existing Candor v3 core root,
 * known children of that root, the encrypted license state, or a capture
 * recovery record. Generic Electron userData existence and Chromium files do
 * not count. Symlinks do not count.
 */
export function createLegacyInstallationEvidenceDetector(
  options: LegacyInstallationEvidenceOptions,
): () => Promise<boolean> {
  return async () => {
    const coreRoot = path.resolve((options.coreDataPath ?? defaultCandorCoreDataPath)());
    if (options.coreRootExistenceIsEvidence !== false && await isOwnedDirectory(coreRoot)) {
      return true;
    }
    if (await isOwnedDirectory(coreRoot)) {
      for (const footprint of KNOWN_CORE_FOOTPRINTS) {
        if (await isOwnedFilesystemObject(path.join(coreRoot, footprint))) return true;
      }
    }

    const userDataRoot = path.resolve(options.userDataPath());
    for (const footprint of KNOWN_USER_DATA_FOOTPRINTS) {
      if (await isOwnedFilesystemObject(path.join(userDataRoot, footprint))) return true;
    }
    return false;
  };
}
