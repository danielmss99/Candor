import { lstat, mkdtemp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  AtomicJsonFile,
  AtomicJsonFileError,
  createUserOnlyFilePermissionEnforcer,
  type UserOnlyFilePermissionEnforcer,
} from "./atomic-json-file.js";

describe("atomic JSON file permissions", () => {
  it("uses the fixed Windows ACL tool without putting the preferences path in command arguments", async () => {
    const calls: Array<{
      executable: string;
      arguments_: readonly string[];
      environment: NodeJS.ProcessEnv;
      timeout: number;
      windowsHide: boolean;
    }> = [];
    const target = "C:\\Users\\Example User\\AppData\\Roaming\\Candor\\preferences\\desktop-preferences.json";
    const enforce = createUserOnlyFilePermissionEnforcer({
      platform: "win32",
      environment: { SystemRoot: "C:\\Windows" },
      executeWindowsAclCommand: async (executable, arguments_, options) => {
        calls.push({
          executable,
          arguments_,
          environment: options.env,
          timeout: options.timeout,
          windowsHide: options.windowsHide,
        });
      },
    });

    await enforce(target);

    expect(calls).toHaveLength(1);
    expect(calls[0]?.executable).toBe(
      "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe",
    );
    expect(calls[0]?.arguments_.slice(0, 4)).toEqual([
      "-NoLogo",
      "-NoProfile",
      "-NonInteractive",
      "-Command",
    ]);
    expect(calls[0]?.arguments_).not.toContain(target);
    expect(calls[0]?.arguments_.at(-1)).toContain("SetAccessControl");
    expect(calls[0]?.arguments_.at(-1)).toContain("AreAccessRulesProtected");
    expect(calls[0]?.environment.CANDOR_ATOMIC_JSON_ACL_TARGET).toBe(target);
    expect(calls[0]?.timeout).toBe(10_000);
    expect(calls[0]?.windowsHide).toBe(true);
  });

  it("rejects an untrusted Windows system-root location before executing a command", async () => {
    const executeWindowsAclCommand = vi.fn(async () => undefined);
    const enforce = createUserOnlyFilePermissionEnforcer({
      platform: "win32",
      environment: { SystemRoot: "relative\\windows" },
      executeWindowsAclCommand,
    });

    await expect(enforce("C:\\preferences.json")).rejects.toThrow("system root");
    expect(executeWindowsAclCommand).not.toHaveBeenCalled();
  });

  it("uses mode 0600 on non-Windows systems through the same enforcement boundary", async () => {
    const chmodFile = vi.fn(async () => undefined);
    const enforce = createUserOnlyFilePermissionEnforcer({ platform: "linux", chmodFile });

    await enforce("/private/preferences.json");

    expect(chmodFile).toHaveBeenCalledWith("/private/preferences.json", 0o600);
  });

  it("protects an empty temporary file before writing and preserves the old file on ACL failure", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "candor-atomic-json-acl-"));
    const destination = path.join(root, "preferences", "desktop-preferences.json");
    await mkdir(path.dirname(destination), { recursive: true });
    await writeFile(destination, JSON.stringify({ previous: true }), "utf8");
    const protectedFiles: string[] = [];
    const permissionEnforcer: UserOnlyFilePermissionEnforcer = async (filePath) => {
      protectedFiles.push(filePath);
      if (filePath === destination) return;
      expect((await lstat(filePath)).isFile()).toBe(true);
      expect(await readFile(filePath, "utf8")).toBe("");
      throw new Error(`simulated ACL failure for ${filePath}`);
    };
    const file = new AtomicJsonFile({
      filePath: destination,
      maximumBytes: 4 * 1024,
      permissionEnforcer,
    });

    try {
      const error = await file.writeObject({ replacement: true }).catch((caught: unknown) => caught);
      expect(error).toBeInstanceOf(AtomicJsonFileError);
      expect((error as AtomicJsonFileError).code).toBe("ATOMIC_JSON_WRITE_FAILED");
      expect((error as Error).message).toBe("settings file could not be saved");
      expect((error as Error).message).not.toContain(root);
      expect(await readFile(destination, "utf8")).toBe(JSON.stringify({ previous: true }));
      expect(protectedFiles[0]).toBe(destination);
      expect(protectedFiles[1]).toMatch(/\.tmp$/);
      expect(await readdir(path.dirname(destination))).toEqual(["desktop-preferences.json"]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("fails closed with a generic error when an existing file cannot be protected before read", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "candor-atomic-json-acl-read-"));
    const destination = path.join(root, "preferences.json");
    await writeFile(destination, JSON.stringify({ enabled: true }), "utf8");
    const file = new AtomicJsonFile({
      filePath: destination,
      maximumBytes: 4 * 1024,
      permissionEnforcer: async () => {
        throw new Error(`sensitive path: ${destination}`);
      },
    });

    try {
      const error = await file.readObject().catch((caught: unknown) => caught);
      expect(error).toBeInstanceOf(AtomicJsonFileError);
      expect((error as AtomicJsonFileError).code).toBe("ATOMIC_JSON_READ_FAILED");
      expect((error as Error).message).toBe("settings file could not be read");
      expect((error as Error).message).not.toContain(root);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
