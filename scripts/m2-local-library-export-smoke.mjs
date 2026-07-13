import { createVersionedCoreRequest } from "./core-rpc-envelope.mjs";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { createInterface } from "node:readline";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
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
const smokeRpcTimeoutMs = 20_000;

if (!existsSync(corePath)) {
  throw new Error(`candor-core debug binary not found: ${corePath}`);
}

const dataDir = mkdtempSync(path.join(tmpdir(), "candor-v3-m2-library-"));
const proofPath = path.join(
  repoRoot,
  "release-v3",
  "proofs",
  `m2-local-document-export-${process.platform}-${process.arch}.json`,
);
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
      reject(new Error(`timeout waiting for ${method} after ${smokeRpcTimeoutMs} ms`));
    }, smokeRpcTimeoutMs);
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

async function expectError(method, params, expectedCode) {
  try {
    await call(method, params);
  } catch (error) {
    if (error.code !== expectedCode) {
      throw new Error(`expected ${expectedCode} from ${method}, got ${error.code ?? "unknown"}`);
    }
    return;
  }
  throw new Error(`expected ${method} to fail with ${expectedCode}`);
}

function assertCustody(value, label) {
  const serialized = JSON.stringify(value);
  if (serialized.includes(dataDir)) {
    throw new Error(`${label} exposed the data root path`);
  }
  visit(value, label);
}

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function visit(value, label) {
  if (Array.isArray(value)) {
    for (const item of value) visit(item, label);
    return;
  }
  if (!value || typeof value !== "object") return;
  for (const [key, childValue] of Object.entries(value)) {
    if (key === "rawPathExposed" && childValue !== false) {
      throw new Error(`${label} reported raw path exposure`);
    }
    if (key === "keyMaterialExposedToRenderer" && childValue !== false) {
      throw new Error(`${label} reported key material exposure`);
    }
    visit(childValue, label);
  }
}

try {
  const started = await call("recording.durable.start", { label: "M2 Strategy Sync" });
  const recordingId = started.recordingId;
  await call("recording.durable.writeTextChunk", {
    recordingId,
    channel: "mic",
    dataUtf8: "Focus on the local platform refresh.",
  });
  await call("recording.durable.writeTextChunk", {
    recordingId,
    channel: "system",
    dataUtf8: "Action: draft the offline export proof.",
  });
  const finished = await call("recording.durable.finish", { recordingId });
  assertCustody(finished, "finish");

  const list = await call("recording.durable.list");
  assertCustody(list, "list");
  if (list?.recordingCount !== 1 || list?.recordings?.[0]?.recordingId !== recordingId) {
    throw new Error("local library list did not include the finished recording");
  }

  const read = await call("recording.durable.read", { recordingId });
  assertCustody(read, "read");
  if (read?.chunkCount !== 2 || read?.chunks?.[0]?.textUtf8 !== "Focus on the local platform refresh.") {
    throw new Error("local library read did not return chunk text");
  }

  const search = await call("recording.durable.search", { query: "offline export" });
  assertCustody(search, "search");
  if (search?.matchCount !== 1 || !search?.matches?.[0]?.snippet?.includes("offline export")) {
    throw new Error("local text search did not find the expected chunk");
  }

  await call("recording.notes.save", {
    recordingId,
    markdown: "## Decisions\n\n- Keep Word and PDF export local.\n- [x] Verify editable tables.",
  });

  const report = {
    summary: "The team approved local document export with transcript evidence.",
    decisions: [
      { text: "Keep report generation in candor-core.", speaker: "Alex", startMs: 15_000 },
    ],
    actions: [
      {
        text: "Draft the offline export proof.",
        speaker: "Priya",
        startMs: 21_000,
        owner: "Priya",
        dueDate: "2026-07-15",
        status: "Open",
      },
    ],
    risks: [
      { text: "Unsigned installers remain a release risk.", speaker: "Lee", startMs: 24_000 },
    ],
    questions: [
      { text: "When will the macOS release runner be available?", speaker: "Diego", startMs: 28_000 },
    ],
  };
  const options = {
    includeSummary: true,
    includeDecisions: true,
    includeActions: true,
    includeRisks: true,
    includeQuestions: true,
    includeNotes: true,
    includeTranscript: true,
    includeTimestamps: true,
    paperSize: "letter",
  };

  const exported = await call("export.create", {
    recordingId,
    format: "markdown",
    report,
    options,
  });
  assertCustody(exported, "export");
  if (
    exported?.format !== "markdown" ||
    exported?.fileName !== "m2-strategy-sync.md" ||
    exported?.structuredReport !== true ||
    !exported?.markdown?.includes("## Executive Summary") ||
    !exported?.markdown?.includes("| Action item | Owner | Due date | Status | Source |") ||
    !exported?.markdown?.includes("Keep Word and PDF export local.") ||
    !exported?.markdown?.includes("Focus on the local platform refresh.") ||
    !exported?.markdown?.includes("Action: draft the offline export proof.")
  ) {
    throw new Error("structured Markdown export did not include the expected local report");
  }

  const word = await call("export.create", { recordingId, format: "docx", report, options });
  assertCustody(word, "word export");
  const wordBytes = Buffer.from(word?.dataBase64 ?? "", "base64");
  const wordArchiveText = wordBytes.toString("latin1");
  if (
    word?.format !== "docx" ||
    word?.mimeType !== "application/vnd.openxmlformats-officedocument.wordprocessingml.document" ||
    word?.editable !== true ||
    !wordBytes.subarray(0, 2).equals(Buffer.from("PK")) ||
    !wordArchiveText.includes("word/document.xml") ||
    !wordArchiveText.includes("word/footer1.xml")
  ) {
    throw new Error("Word export was not a native editable DOCX package");
  }

  const pdf = await call("export.create", { recordingId, format: "pdf", report, options });
  assertCustody(pdf, "PDF export");
  const pdfBytes = Buffer.from(pdf?.dataBase64 ?? "", "base64");
  if (
    pdf?.format !== "pdf" ||
    pdf?.mimeType !== "application/pdf" ||
    pdf?.searchableText !== true ||
    pdf?.bookmarks !== true ||
    pdf?.pageCount < 1 ||
    pdfBytes.subarray(0, 5).toString("ascii") !== "%PDF-"
  ) {
    throw new Error("PDF export was not a searchable bookmarked PDF document");
  }

  await expectError("export.create", { recordingId, format: "pptx" }, "EXPORT_FORMAT_UNSUPPORTED");

  mkdirSync(path.dirname(proofPath), { recursive: true });
  writeFileSync(
    proofPath,
    JSON.stringify(
      {
        ok: true,
        proofKind: "m2-local-document-export",
        generatedAt: new Date().toISOString(),
        platform: process.platform,
        arch: process.arch,
        formats: {
          markdown: {
            fileName: exported.fileName,
            bytes: exported.bytes,
            structuredReport: exported.structuredReport,
          },
          docx: {
            fileName: word.fileName,
            bytes: wordBytes.length,
            sha256: sha256(wordBytes),
            editable: word.editable,
            nativeOpenXml: true,
          },
          pdf: {
            fileName: pdf.fileName,
            bytes: pdfBytes.length,
            sha256: sha256(pdfBytes),
            pageCount: pdf.pageCount,
            searchableText: pdf.searchableText,
            bookmarks: pdf.bookmarks,
          },
        },
        localOnly: true,
        cloudAi: false,
        networkAttempted: false,
        rawPathExposed: false,
        keyMaterialExposedToRenderer: false,
      },
      null,
      2,
    ),
    "utf8",
  );

  await call("core.shutdown");
  console.log("M2 local library export smoke passed.");
  console.log(`M2 local document export proof written to ${proofPath}.`);
} finally {
  if (!child.killed) child.kill();
  rmSync(dataDir, { recursive: true, force: true });
}
