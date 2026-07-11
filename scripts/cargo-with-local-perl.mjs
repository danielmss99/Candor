import { existsSync } from "node:fs";
import { delimiter, dirname } from "node:path";
import { spawn, spawnSync } from "node:child_process";

const args = process.argv.slice(2);
if (args.length === 0) {
  throw new Error("Usage: node scripts/cargo-with-local-perl.mjs <cargo args...>");
}

const env = { ...process.env };

function findCommandPath(command) {
  const probe = process.platform === "win32"
    ? spawnSync("where", [command], { encoding: "utf8", windowsHide: true })
    : spawnSync("which", [command], { encoding: "utf8" });
  if (probe.status !== 0) return "";
  return (probe.stdout ?? "")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find(Boolean) ?? "";
}

function argsRequestSqlcipherVault(cargoArgs) {
  return cargoArgs.some((arg, index) => {
    if (arg === "--all-features") return true;
    if (arg === "--features") return (cargoArgs[index + 1] ?? "").includes("sqlcipher-vault");
    return arg.startsWith("--features=") && arg.includes("sqlcipher-vault");
  });
}

function isNativeWindowsPerl(perlPath) {
  if (!existsSync(perlPath)) return false;
  const probe = spawnSync(perlPath, ["-V:osname", "-V:archname"], {
    encoding: "utf8",
    windowsHide: true,
  });
  const output = `${probe.stdout ?? ""}\n${probe.stderr ?? ""}`;
  return probe.status === 0 && output.includes("MSWin32");
}

function nativePerlCandidates() {
  const candidates = [];
  if (env.LOCALAPPDATA) {
    candidates.push(
      `${env.LOCALAPPDATA}\\CandorToolchains\\strawberry-perl-5.42.2.1-portable\\perl\\bin\\perl.exe`,
      `${env.LOCALAPPDATA}\\Programs\\Strawberry Perl\\perl\\bin\\perl.exe`,
    );
  }
  candidates.push(
    "C:\\Strawberry\\perl\\bin\\perl.exe",
    "C:\\Program Files\\Strawberry Perl\\perl\\bin\\perl.exe",
  );
  return candidates;
}

if (process.platform === "win32") {
  const sqlcipherRequested = argsRequestSqlcipherVault(args);
  if (env.OPENSSL_SRC_PERL && sqlcipherRequested && !isNativeWindowsPerl(env.OPENSSL_SRC_PERL)) {
    console.error(`OPENSSL_SRC_PERL is not a native Windows Perl: ${env.OPENSSL_SRC_PERL}`);
    console.error("SQLCipher vendored OpenSSL requires an MSWin32 Perl, not MSYS/Cygwin Perl.");
    process.exit(1);
  }

  if (!env.OPENSSL_SRC_PERL) {
    const perlPath = nativePerlCandidates().find(isNativeWindowsPerl);
    if (perlPath) {
      const perlBin = dirname(perlPath);
      env.OPENSSL_SRC_PERL = perlPath;
      env.PATH = `${perlBin}${delimiter}${env.PATH ?? ""}`;
    } else if (sqlcipherRequested) {
      console.error("No native Windows Perl found for SQLCipher vendored OpenSSL.");
      console.error(
        "Expected a native Perl at LOCALAPPDATA\\CandorToolchains\\strawberry-perl-5.42.2.1-portable\\perl\\bin\\perl.exe or C:\\Strawberry\\perl\\bin\\perl.exe.",
      );
      console.error("MSYS and Git Perl are intentionally ignored because OpenSSL rejects their path style.");
      process.exit(1);
    }
  }
}

if (!env.CMAKE) {
  const cmakePath = findCommandPath("cmake");
  if (cmakePath) {
    env.CMAKE = cmakePath;
  }
}

const userCargoExe = env.USERPROFILE ? `${env.USERPROFILE}\\.cargo\\bin\\cargo.exe` : "";
const cargoBin = process.platform === "win32" && existsSync(userCargoExe) ? userCargoExe : "cargo";
const child = spawn(cargoBin, args, {
  cwd: process.cwd(),
  stdio: "inherit",
  env,
  shell: false,
});

child.on("exit", (code, signal) => {
  if (signal) {
    process.kill(process.pid, signal);
    return;
  }
  process.exit(code ?? 1);
});
