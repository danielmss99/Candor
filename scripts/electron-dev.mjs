import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { createServer } from "node:net";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import electronPath from "electron";

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dirname, "..");
const mode = process.argv[2] ?? "--start";
const configuredRendererUrl = process.env.CANDOR_V3_RENDERER_URL?.trim() ?? "";
const children = new Set();
let stopping = false;

if (mode !== "--dev" && mode !== "--start") {
  throw new Error(`Unsupported Electron launcher mode: ${mode}`);
}

function spawnChild(command, args, options = {}) {
  const child = spawn(command, args, {
    cwd: repoRoot,
    stdio: "inherit",
    windowsHide: true,
    ...options,
  });
  children.add(child);
  child.once("exit", () => children.delete(child));
  return child;
}

function runStep(label, command, args) {
  return new Promise((resolveStep, rejectStep) => {
    const child = spawnChild(command, args);
    child.once("error", rejectStep);
    child.once("exit", (code, signal) => {
      if (code === 0) {
        resolveStep();
        return;
      }
      rejectStep(new Error(`${label} failed (${code ?? signal ?? "unknown"}).`));
    });
  });
}

function stopChildren(signal = "SIGTERM") {
  if (stopping) return;
  stopping = true;
  for (const child of children) {
    if (!child.killed) child.kill(signal);
  }
}

async function waitForRenderer(url, timeoutMs = 20_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(1_000) });
      if (response.ok) return;
    } catch {
      // Vite is still starting.
    }
    await new Promise((resolveWait) => setTimeout(resolveWait, 200));
  }
  throw new Error(`Renderer development server did not become ready at ${url}.`);
}

function findAvailablePort(startPort, host = "127.0.0.1") {
  return new Promise((resolvePort, rejectPort) => {
    const tryPort = (port) => {
      const server = createServer();
      server.unref();
      server.once("error", (error) => {
        if (error.code === "EADDRINUSE" && port < startPort + 20) {
          tryPort(port + 1);
          return;
        }
        rejectPort(error);
      });
      server.listen(port, host, () => {
        server.close(() => resolvePort(port));
      });
    };
    tryPort(startPort);
  });
}

function requireBuiltFile(relativePath, instruction) {
  const absolutePath = resolve(repoRoot, relativePath);
  if (!existsSync(absolutePath)) {
    throw new Error(`Missing ${relativePath}. ${instruction}`);
  }
}

async function buildDevelopmentRuntime() {
  await runStep("Rust core development build", process.execPath, [
    "scripts/cargo-with-local-perl.mjs",
    "build",
    "--manifest-path",
    "crates/candor-core/Cargo.toml",
    "--features",
    "sqlcipher-vault,local-whisper",
  ]);
  await runStep("Electron main build", process.execPath, ["scripts/m0-build-electron.mjs"]);
}

async function launch() {
  let vite = null;
  let rendererUrl = configuredRendererUrl;
  if (mode === "--dev") {
    await buildDevelopmentRuntime();
    if (!rendererUrl) {
      const port = await findAvailablePort(5173);
      rendererUrl = `http://127.0.0.1:${port}`;
    }
    const rendererPort = new URL(rendererUrl).port || "5173";
    vite = spawnChild(process.execPath, [
      "node_modules/vite/bin/vite.js",
      "--config",
      "vite.v3.config.ts",
      "--port",
      rendererPort,
    ]);
    await waitForRenderer(rendererUrl);
  } else {
    requireBuiltFile("dist-v3/electron/main.js", "Run npm run build first.");
    requireBuiltFile("dist-v3/renderer/index.html", "Run npm run build first.");
    const coreName = process.platform === "win32" ? "candor-core.exe" : "candor-core";
    requireBuiltFile(
      `build/core-bin/${coreName}`,
      "Run npm run build first.",
    );
  }

  const electron = spawnChild(electronPath, ["dist-v3/electron/main.js"], {
    env: {
      ...process.env,
      ...(mode === "--dev" ? { CANDOR_V3_RENDERER_URL: rendererUrl } : {}),
    },
  });
  electron.once("error", (error) => {
    stopChildren();
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
  electron.once("exit", (code) => {
    if (vite && !vite.killed) vite.kill();
    process.exitCode = code ?? 1;
  });
}

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.once(signal, () => {
    stopChildren(signal);
    process.exitCode = 130;
  });
}

launch().catch((error) => {
  stopChildren();
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
