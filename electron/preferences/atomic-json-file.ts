import { randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import type { BigIntStats } from "node:fs";
import { chmod, lstat, mkdir, open, readFile, rename, rm } from "node:fs/promises";
import path from "node:path";

export type JsonObject = Record<string, unknown>;

export interface AtomicJsonFileOptions {
  filePath: string;
  maximumBytes: number;
  permissionEnforcer?: UserOnlyFilePermissionEnforcer;
}

export type UserOnlyFilePermissionEnforcer = (filePath: string) => Promise<void>;

interface WindowsAclCommandOptions {
  encoding: "utf8";
  env: NodeJS.ProcessEnv;
  maxBuffer: number;
  timeout: number;
  windowsHide: true;
}

type ExecuteWindowsAclCommand = (
  executable: string,
  arguments_: readonly string[],
  options: WindowsAclCommandOptions,
) => Promise<void>;

export interface UserOnlyFilePermissionDependencies {
  platform?: NodeJS.Platform;
  environment?: NodeJS.ProcessEnv;
  chmodFile?: (filePath: string, mode: number) => Promise<void>;
  executeWindowsAclCommand?: ExecuteWindowsAclCommand;
}

export class AtomicJsonFileError extends Error {
  constructor(
    readonly code:
      | "ATOMIC_JSON_INVALID"
      | "ATOMIC_JSON_TOO_LARGE"
      | "ATOMIC_JSON_UNSAFE_PATH"
      | "ATOMIC_JSON_READ_FAILED"
      | "ATOMIC_JSON_WRITE_FAILED",
    message: string,
  ) {
    super(message);
    this.name = "AtomicJsonFileError";
  }
}

function isObject(value: unknown): value is JsonObject {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function isMissingFile(error: unknown): boolean {
  return error !== null
    && typeof error === "object"
    && "code" in error
    && (error as { code?: unknown }).code === "ENOENT";
}

function fileIdentity(metadata: BigIntStats): string {
  return `${metadata.dev}:${metadata.ino}:${metadata.birthtimeNs}:${metadata.ctimeNs}`;
}

function isSameFile(left: BigIntStats, right: BigIntStats): boolean {
  return left.dev === right.dev && left.ino === right.ino;
}

const WINDOWS_ACL_TARGET_ENVIRONMENT_KEY = "CANDOR_ATOMIC_JSON_ACL_TARGET";
const WINDOWS_ACL_TIMEOUT_MS = 10_000;
const WINDOWS_ACL_MAXIMUM_OUTPUT_BYTES = 16 * 1024;

// The target is passed only through the child environment. The command text is fixed,
// so a preferences path can never become executable PowerShell input or a process argument.
const WINDOWS_USER_ONLY_ACL_SCRIPT = String.raw`
$ErrorActionPreference = 'Stop'
$target = [System.Environment]::GetEnvironmentVariable('CANDOR_ATOMIC_JSON_ACL_TARGET', 'Process')
if ([System.String]::IsNullOrWhiteSpace($target)) { throw 'ACL target is missing.' }
$attributes = [System.IO.File]::GetAttributes($target)
if (($attributes -band [System.IO.FileAttributes]::Directory) -ne 0 -or ($attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0) {
  throw 'ACL target must be a regular file.'
}
$identity = [System.Security.Principal.WindowsIdentity]::GetCurrent()
$sid = $identity.User
if ($null -eq $sid) { throw 'Current user SID is unavailable.' }
$acl = New-Object System.Security.AccessControl.FileSecurity
$acl.SetOwner($sid)
$acl.SetAccessRuleProtection($true, $false)
$rule = New-Object System.Security.AccessControl.FileSystemAccessRule(
  $sid,
  [System.Security.AccessControl.FileSystemRights]::FullControl,
  [System.Security.AccessControl.AccessControlType]::Allow
)
[void] $acl.AddAccessRule($rule)
[System.IO.File]::SetAccessControl($target, $acl)
$sections = [System.Security.AccessControl.AccessControlSections]::Access -bor [System.Security.AccessControl.AccessControlSections]::Owner
$verified = [System.IO.File]::GetAccessControl($target, $sections)
$owner = $verified.GetOwner([System.Security.Principal.SecurityIdentifier])
$rules = @($verified.GetAccessRules($true, $true, [System.Security.Principal.SecurityIdentifier]))
if (-not $verified.AreAccessRulesProtected -or $owner.Value -ne $sid.Value -or $rules.Count -ne 1) {
  throw 'ACL verification failed.'
}
$onlyRule = $rules[0]
$requiredRights = [System.Security.AccessControl.FileSystemRights]::FullControl
if (
  $onlyRule.IsInherited -or
  $onlyRule.IdentityReference.Value -ne $sid.Value -or
  $onlyRule.AccessControlType -ne [System.Security.AccessControl.AccessControlType]::Allow -or
  (($onlyRule.FileSystemRights -band $requiredRights) -ne $requiredRights)
) {
  throw 'ACL verification failed.'
}
`;

function defaultExecuteWindowsAclCommand(
  executable: string,
  arguments_: readonly string[],
  options: WindowsAclCommandOptions,
): Promise<void> {
  return new Promise((resolve, reject) => {
    execFile(executable, [...arguments_], options, (error) => {
      if (error) reject(error);
      else resolve();
    });
  });
}

function resolveWindowsPowerShell(environment: NodeJS.ProcessEnv): string {
  const systemRoot = environment.SystemRoot ?? environment.SYSTEMROOT;
  if (!systemRoot || !path.win32.isAbsolute(systemRoot)) {
    throw new Error("Windows system root is unavailable");
  }
  const normalizedRoot = path.win32.resolve(systemRoot);
  const executable = path.win32.resolve(
    normalizedRoot,
    "System32",
    "WindowsPowerShell",
    "v1.0",
    "powershell.exe",
  );
  const rootPrefix = normalizedRoot.endsWith(path.win32.sep)
    ? normalizedRoot.toLowerCase()
    : `${normalizedRoot.toLowerCase()}${path.win32.sep}`;
  if (!executable.toLowerCase().startsWith(rootPrefix)) {
    throw new Error("Windows ACL tool path is invalid");
  }
  return executable;
}

export function createUserOnlyFilePermissionEnforcer(
  dependencies: UserOnlyFilePermissionDependencies = {},
): UserOnlyFilePermissionEnforcer {
  const platform = dependencies.platform ?? process.platform;
  const environment = dependencies.environment ?? process.env;
  const chmodFile = dependencies.chmodFile ?? chmod;
  const executeWindowsAclCommand = dependencies.executeWindowsAclCommand
    ?? defaultExecuteWindowsAclCommand;

  if (platform !== "win32") {
    return async (filePath) => chmodFile(filePath, 0o600);
  }

  return async (filePath) => {
    const executable = resolveWindowsPowerShell(environment);
    await executeWindowsAclCommand(
      executable,
      ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", WINDOWS_USER_ONLY_ACL_SCRIPT],
      {
        encoding: "utf8",
        env: {
          ...environment,
          [WINDOWS_ACL_TARGET_ENVIRONMENT_KEY]: filePath,
        },
        maxBuffer: WINDOWS_ACL_MAXIMUM_OUTPUT_BYTES,
        timeout: WINDOWS_ACL_TIMEOUT_MS,
        windowsHide: true,
      },
    );
  };
}

export class AtomicJsonFile {
  private readonly filePath: string;
  private readonly maximumBytes: number;
  private readonly enforceUserOnlyPermissions: UserOnlyFilePermissionEnforcer;
  private protectedDestinationIdentity: string | null = null;

  constructor(options: AtomicJsonFileOptions) {
    if (!path.isAbsolute(options.filePath)) {
      throw new AtomicJsonFileError("ATOMIC_JSON_UNSAFE_PATH", "settings path must be absolute");
    }
    if (!Number.isSafeInteger(options.maximumBytes) || options.maximumBytes < 128) {
      throw new AtomicJsonFileError("ATOMIC_JSON_INVALID", "settings size limit is invalid");
    }
    this.filePath = options.filePath;
    this.maximumBytes = options.maximumBytes;
    this.enforceUserOnlyPermissions = options.permissionEnforcer
      ?? createUserOnlyFilePermissionEnforcer();
  }

  async readObject(): Promise<JsonObject | null> {
    try {
      const metadata = await lstat(this.filePath, { bigint: true });
      if (!metadata.isFile() || metadata.isSymbolicLink()) {
        throw new AtomicJsonFileError(
          "ATOMIC_JSON_UNSAFE_PATH",
          "settings file must be a regular local file",
        );
      }
      if (metadata.size <= 0n || metadata.size > BigInt(this.maximumBytes)) {
        throw new AtomicJsonFileError(
          "ATOMIC_JSON_TOO_LARGE",
          "settings file exceeds its local size limit",
        );
      }
      await this.ensureDestinationPermissions(metadata);
      const serialized = await readFile(this.filePath, "utf8");
      const value: unknown = JSON.parse(serialized);
      if (!isObject(value)) {
        throw new AtomicJsonFileError("ATOMIC_JSON_INVALID", "settings file must contain an object");
      }
      return value;
    } catch (error) {
      if (isMissingFile(error)) return null;
      if (error instanceof AtomicJsonFileError) throw error;
      if (error instanceof SyntaxError) {
        throw new AtomicJsonFileError("ATOMIC_JSON_INVALID", "settings file is not valid JSON");
      }
      throw new AtomicJsonFileError("ATOMIC_JSON_READ_FAILED", "settings file could not be read");
    }
  }

  async writeObject(value: JsonObject): Promise<void> {
    let serialized: string;
    try {
      serialized = JSON.stringify(value);
    } catch {
      throw new AtomicJsonFileError("ATOMIC_JSON_INVALID", "settings value is not JSON serializable");
    }
    const bytes = Buffer.byteLength(serialized, "utf8");
    if (bytes <= 0 || bytes > this.maximumBytes) {
      throw new AtomicJsonFileError("ATOMIC_JSON_TOO_LARGE", "settings value exceeds its local size limit");
    }

    const directory = path.dirname(this.filePath);
    const temporary = path.join(directory, `.${path.basename(this.filePath)}.${process.pid}.${randomUUID()}.tmp`);
    let temporaryCreated = false;
    try {
      await mkdir(directory, { recursive: true, mode: 0o700 });
      try {
        const existing = await lstat(this.filePath, { bigint: true });
        if (!existing.isFile() || existing.isSymbolicLink()) {
          throw new AtomicJsonFileError(
            "ATOMIC_JSON_UNSAFE_PATH",
            "settings destination must be a regular local file",
          );
        }
        await this.ensureDestinationPermissions(existing);
      } catch (error) {
        if (!isMissingFile(error)) throw error;
      }

      const handle = await open(temporary, "wx", 0o600);
      temporaryCreated = true;
      const openedTemporary = await handle.stat({ bigint: true });
      try {
        await this.enforceUserOnlyPermissions(temporary);
        const protectedTemporary = await lstat(temporary, { bigint: true });
        if (
          !protectedTemporary.isFile()
          || protectedTemporary.isSymbolicLink()
          || !isSameFile(openedTemporary, protectedTemporary)
        ) {
          throw new AtomicJsonFileError(
            "ATOMIC_JSON_UNSAFE_PATH",
            "settings temporary file changed while permissions were applied",
          );
        }
        await handle.writeFile(serialized, "utf8");
        await handle.sync();
      } finally {
        await handle.close();
      }
      const prepared = await lstat(temporary, { bigint: true });
      if (
        !prepared.isFile()
        || prepared.isSymbolicLink()
        || !isSameFile(openedTemporary, prepared)
      ) {
        throw new AtomicJsonFileError(
          "ATOMIC_JSON_UNSAFE_PATH",
          "settings temporary file must remain a regular local file",
        );
      }
      await rename(temporary, this.filePath);
      temporaryCreated = false;
      // Publication is the commit point. Metadata refresh is best effort so a post-rename
      // inspection failure cannot report rollback after the durable file was replaced.
      const published = await lstat(this.filePath, { bigint: true }).catch(() => null);
      this.protectedDestinationIdentity = published
        && published.isFile()
        && !published.isSymbolicLink()
        && isSameFile(prepared, published)
        ? fileIdentity(published)
        : null;
    } catch (error) {
      if (error instanceof AtomicJsonFileError) throw error;
      throw new AtomicJsonFileError("ATOMIC_JSON_WRITE_FAILED", "settings file could not be saved");
    } finally {
      if (temporaryCreated) await rm(temporary, { force: true }).catch(() => undefined);
    }
  }

  private async ensureDestinationPermissions(metadata: BigIntStats): Promise<void> {
    if (this.protectedDestinationIdentity === fileIdentity(metadata)) return;
    await this.enforceUserOnlyPermissions(this.filePath);
    const protectedMetadata = await lstat(this.filePath, { bigint: true });
    if (
      !protectedMetadata.isFile()
      || protectedMetadata.isSymbolicLink()
      || !isSameFile(metadata, protectedMetadata)
    ) {
      throw new AtomicJsonFileError(
        "ATOMIC_JSON_UNSAFE_PATH",
        "settings destination changed while permissions were applied",
      );
    }
    this.protectedDestinationIdentity = fileIdentity(protectedMetadata);
  }
}
