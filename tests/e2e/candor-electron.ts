import { _electron as electron, type ElectronApplication, type Page } from "@playwright/test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const repoRoot = path.resolve(import.meta.dirname, "..", "..");
const electronExecutable = require("electron") as string;
const electronMain = path.join(repoRoot, "dist-v3", "electron", "main.js");
const coreExecutable = path.join(
  repoRoot,
  "build",
  "core-bin",
  process.platform === "win32" ? "candor-core.exe" : "candor-core",
);

interface LaunchCandorOptions {
  seedMeeting?: boolean;
  width?: number;
  height?: number;
  scaleFactor?: number;
}

interface CoreResponseLike {
  ok: boolean;
  result?: unknown;
  error?: { message?: string };
}

export interface CandorElectronSession {
  app: ElectronApplication;
  page: Page;
  dataDir: string;
  recordingId: string;
  close(): Promise<void>;
}

function launchEnvironment(dataDir: string, scaleFactor: number): Record<string, string> {
  const inherited = Object.fromEntries(
    Object.entries(process.env).filter((entry): entry is [string, string] => typeof entry[1] === "string"),
  );
  return {
    ...inherited,
    CANDOR_E2E: "1",
    CANDOR_E2E_SCALE_FACTOR: String(scaleFactor),
    CANDOR_V3_DATA_DIR: dataDir,
    CANDOR_NETWORK_POLICY: "disabled-by-default",
  };
}

async function seedLocalMeeting(dataDir: string): Promise<string> {
  const previousDataDir = process.env.CANDOR_V3_DATA_DIR;
  process.env.CANDOR_V3_DATA_DIR = dataDir;
  const { CoreClient } = await import("../../dist-v3/electron/core/core-client.js");
  const { privateCoreMethods } = await import("../../dist-v3/electron/core/protocol.js");
  const core = new CoreClient({
    executablePath: () => coreExecutable,
    allowedMethods: privateCoreMethods,
    isDev: false,
  });
  const call = async (method: string, params: unknown = null): Promise<unknown> => {
    const response = await core.call(method, params, 15_000) as CoreResponseLike;
    if (!response.ok) throw new Error(response.error?.message ?? `${method} failed`);
    return response.result ?? null;
  };

  try {
    await core.ensureHandshake();
    const started = await call("recording.durable.start", { label: "Product Strategy Sync" });
    const recordingId = typeof started === "object" && started !== null
      ? Reflect.get(started, "recordingId")
      : null;
    if (typeof recordingId !== "string" || !recordingId) {
      throw new Error("Electron test fixture did not receive a recording ID.");
    }
    const segments = [
      ["Alex Morgan", "Decision: keep the report editable and local.", 2_000],
      ["Priya Mehta", "Action: validate the desktop workflow with keyboard access.", 7_000],
      ["Daniel Moss", "The transcript and notes should remain visible together.", 12_000],
    ] as const;
    for (const [index, [speaker, text, startMs]] of segments.entries()) {
      await call("recording.durable.writeTranscriptSegment", {
        recordingId,
        channel: index % 2 === 0 ? "mic" : "system",
        speaker,
        text,
        startMs,
        durationMs: 3_000,
        confidence: 0.98,
      });
    }
    await call("recording.notes.save", {
      recordingId,
      markdown: "- Keep reports editable\n- Validate keyboard access\n- Preserve local evidence",
    });
    await call("recording.durable.finish", { recordingId });
    return recordingId;
  } finally {
    await core.shutdown().catch(() => undefined);
    if (previousDataDir === undefined) delete process.env.CANDOR_V3_DATA_DIR;
    else process.env.CANDOR_V3_DATA_DIR = previousDataDir;
  }
}

export async function launchCandor(options: LaunchCandorOptions = {}): Promise<CandorElectronSession> {
  const dataDir = mkdtempSync(path.join(tmpdir(), "candor-electron-e2e-"));
  const recordingId = options.seedMeeting ? await seedLocalMeeting(dataDir) : "";
  const app = await electron.launch({
    executablePath: electronExecutable,
    args: [electronMain],
    cwd: repoRoot,
    env: launchEnvironment(dataDir, options.scaleFactor ?? 1),
  });
  const page = await app.firstWindow({ timeout: 30_000 });
  await page.waitForLoadState("domcontentloaded");
  await app.evaluate(({ BrowserWindow }, size) => {
    const window = BrowserWindow.getAllWindows()[0];
    window?.setSize(size.width, size.height);
  }, { width: options.width ?? 1366, height: options.height ?? 768 });

  return {
    app,
    page,
    dataDir,
    recordingId,
    async close() {
      await app.close().catch(() => undefined);
      rmSync(dataDir, { recursive: true, force: true });
    },
  };
}
