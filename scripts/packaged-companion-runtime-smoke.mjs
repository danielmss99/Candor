import { createHash } from "node:crypto";
import { spawn, spawnSync } from "node:child_process";
import { createInterface } from "node:readline";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import preloadResponseContract from "../electron/preload-response-contract.cjs";
import { removeTemporaryDirectory, stopChildProcess } from "./child-process-cleanup.mjs";
import { createVersionedCoreRequest } from "./core-rpc-envelope.mjs";

const { hasRendererCustodyViolation } = preloadResponseContract;

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const PROCESS_TIMEOUT_MS = 30_000;
const PROCESS_OUTPUT_LIMIT_BYTES = 4_000_000;
const FIXTURE_LABEL = "Packaged Companion Encrypted Fixture";
const FIXTURE_SEARCH_QUERY = "orbitpathless";
const FIXTURE_TRANSCRIPT_TEXT = Object.freeze([
  "Orbitpathless confirms the encrypted local transcript is searchable.",
  "The packaged companions must leave every persistent byte unchanged.",
]);
const FIXTURE_TEXT_CHUNK = "Encrypted fixture source bytes stay on this device.";
const EXPECTED_TOOL_NAMES = Object.freeze([
  "list_meetings",
  "search_meetings",
  "meeting_summary",
  "get_transcript",
  "export_meeting",
  "library_statistics",
]);
const READ_RESULT_KEYS = Object.freeze([
  "list",
  "search",
  "summary",
  "transcript",
  "export",
  "statistics",
]);

function sha256Bytes(value) {
  return createHash("sha256").update(value).digest("hex");
}

function fileEvidence(path) {
  if (!existsSync(path)) throw new Error(`Packaged companion was missing: ${basename(path)}`);
  const bytes = readFileSync(path);
  return {
    fileName: basename(path),
    bytes: bytes.length,
    sha256: sha256Bytes(bytes),
  };
}

export function snapshotDirectory(root) {
  const entries = [];
  const walk = (directory) => {
    for (const name of readdirSync(directory).sort()) {
      const absolute = join(directory, name);
      const stats = lstatSync(absolute);
      const relativePath = relative(root, absolute).replaceAll("\\", "/");
      if (stats.isDirectory()) {
        entries.push({ path: relativePath, kind: "directory", modifiedMs: stats.mtimeMs });
        walk(absolute);
      } else if (stats.isFile()) {
        const bytes = readFileSync(absolute);
        entries.push({
          path: relativePath,
          kind: "file",
          bytes: bytes.length,
          sha256: sha256Bytes(bytes),
          modifiedMs: stats.mtimeMs,
        });
      } else {
        entries.push({ path: relativePath, kind: "other", modifiedMs: stats.mtimeMs });
      }
    }
  };
  walk(root);
  return entries;
}

function canonicalSnapshot(entries) {
  return [...entries]
    .map((entry) => ({ ...entry }))
    .sort((left, right) => left.path.localeCompare(right.path, "en"));
}

function snapshotDigest(entries) {
  return sha256Bytes(Buffer.from(JSON.stringify(canonicalSnapshot(entries)), "utf8"));
}

function persistentCategory(entry) {
  const normalized = entry.path.toLowerCase();
  const name = normalized.split("/").at(-1) ?? normalized;
  if (name.endsWith("-wal") || name.endsWith("-shm") || name.endsWith(".wal") || name.endsWith(".shm")) {
    return "walAndShm";
  }
  if (name === "candor-v3.sqlcipher" || name.endsWith(".sqlite") || name.endsWith(".sqlite3")) {
    return "sqliteVault";
  }
  if (normalized === "keys" || normalized.startsWith("keys/")) return "keySidecars";
  if (normalized === "recordings" || normalized.startsWith("recordings/")) return "recordingSidecars";
  return "otherSidecars";
}

function summarizeEntries(entries) {
  const files = entries.filter((entry) => entry.kind === "file");
  return {
    presence: files.length > 0 ? "present" : "notPresent",
    entryCount: entries.length,
    fileCount: files.length,
    directoryCount: entries.filter((entry) => entry.kind === "directory").length,
    totalBytes: files.reduce((total, entry) => total + entry.bytes, 0),
    inventorySha256: snapshotDigest(entries),
  };
}

export function summarizePersistentState(entries) {
  const categories = {
    sqliteVault: [],
    walAndShm: [],
    keySidecars: [],
    recordingSidecars: [],
    otherSidecars: [],
  };
  for (const entry of entries) categories[persistentCategory(entry)].push(entry);
  return {
    complete: summarizeEntries(entries),
    sqliteVault: summarizeEntries(categories.sqliteVault),
    walAndShm: summarizeEntries(categories.walAndShm),
    keySidecars: summarizeEntries(categories.keySidecars),
    recordingSidecars: summarizeEntries(categories.recordingSidecars),
    otherSidecars: summarizeEntries(categories.otherSidecars),
  };
}

export function assertPersistentStateUnchanged(before, after) {
  const beforeSummary = summarizePersistentState(before);
  const afterSummary = summarizePersistentState(after);
  if (beforeSummary.sqliteVault.fileCount < 1) {
    throw new Error("Populated fixture did not contain an encrypted SQLCipher vault");
  }
  if (beforeSummary.keySidecars.fileCount < 1) {
    throw new Error("Populated fixture did not contain an encrypted key sidecar");
  }
  if (beforeSummary.recordingSidecars.fileCount < 2) {
    throw new Error("Populated fixture did not contain recording manifest and chunk sidecars");
  }
  if (beforeSummary.sqliteVault.inventorySha256 !== afterSummary.sqliteVault.inventorySha256) {
    throw new Error("Packaged read-only companions changed the SQLCipher vault state");
  }
  if (beforeSummary.walAndShm.inventorySha256 !== afterSummary.walAndShm.inventorySha256) {
    throw new Error("Packaged read-only companions changed the SQLite WAL or SHM state");
  }
  if (beforeSummary.keySidecars.inventorySha256 !== afterSummary.keySidecars.inventorySha256) {
    throw new Error("Packaged read-only companions changed a persistent key sidecar");
  }
  if (beforeSummary.recordingSidecars.inventorySha256 !== afterSummary.recordingSidecars.inventorySha256) {
    throw new Error("Packaged read-only companions changed a persistent recording sidecar");
  }
  if (beforeSummary.otherSidecars.inventorySha256 !== afterSummary.otherSidecars.inventorySha256) {
    throw new Error("Packaged read-only companions changed another persistent sidecar");
  }
  if (beforeSummary.complete.inventorySha256 !== afterSummary.complete.inventorySha256) {
    throw new Error("Packaged read-only companions changed the persistent fixture tree");
  }
  return {
    exactMatch: true,
    before: beforeSummary,
    after: afterSummary,
    sqlcipherVaultUnchanged: true,
    walAndShmStateUnchanged: true,
    keySidecarsUnchanged: true,
    recordingSidecarsUnchanged: true,
    otherSidecarsUnchanged: true,
  };
}

function assertFixturePayloadPlaintextAbsent(root, plaintextValues) {
  const pending = [root];
  const needles = plaintextValues.map((value) => Buffer.from(value, "utf8"));
  while (pending.length > 0) {
    const directory = pending.pop();
    for (const name of readdirSync(directory)) {
      const target = join(directory, name);
      const state = lstatSync(target);
      if (state.isDirectory()) {
        pending.push(target);
        continue;
      }
      if (!state.isFile()) continue;
      const bytes = readFileSync(target);
      if (needles.some((needle) => bytes.includes(needle))) {
        throw new Error("A tested fixture chunk or transcript payload was present as plaintext in a persistent file");
      }
    }
  }
}

function delay(milliseconds) {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, milliseconds));
}

async function runBounded(executable, args, options = {}) {
  const startedAt = Date.now();
  const child = spawn(executable, args, {
    cwd: options.cwd,
    env: options.env,
    windowsHide: true,
    stdio: ["pipe", "pipe", "pipe"],
  });
  const stdout = [];
  const stderr = [];
  let stdoutBytes = 0;
  let stderrBytes = 0;
  let outputExceeded = false;
  const collect = (target, chunk, stream) => {
    const nextBytes = stream === "stdout"
      ? stdoutBytes + chunk.length
      : stderrBytes + chunk.length;
    if (stream === "stdout") stdoutBytes = nextBytes;
    else stderrBytes = nextBytes;
    if (nextBytes > PROCESS_OUTPUT_LIMIT_BYTES) {
      outputExceeded = true;
      return;
    }
    target.push(chunk);
  };
  child.stdout.on("data", (chunk) => collect(stdout, chunk, "stdout"));
  child.stderr.on("data", (chunk) => collect(stderr, chunk, "stderr"));
  child.stdin.on("error", () => undefined);
  child.stdin.end(options.input ?? "");

  const closed = new Promise((resolveClose) => {
    child.once("close", (code, signal) => resolveClose({ code, signal }));
  });
  const result = await Promise.race([
    closed,
    delay(PROCESS_TIMEOUT_MS).then(() => null),
  ]);
  if (result === null) {
    await stopChildProcess(child, { gracefulTimeoutMs: 0, forcedTimeoutMs: 5_000 });
    throw new Error(`${basename(executable)} exceeded the bounded runtime`);
  }
  if (outputExceeded) {
    throw new Error(`${basename(executable)} exceeded the bounded output limit`);
  }
  return {
    ...result,
    durationMs: Date.now() - startedAt,
    stdoutBytes,
    stderrBytes,
    stdout: Buffer.concat(stdout).toString("utf8"),
    stderr: Buffer.concat(stderr).toString("utf8"),
  };
}

function parseJson(text, label) {
  try {
    return JSON.parse(text.trim());
  } catch {
    throw new Error(`${label} did not return valid JSON`);
  }
}

function assertPathlessValue(value, label, forbiddenPaths = []) {
  if (hasRendererCustodyViolation(value)) {
    throw new Error(`${label} contained a structurally sensitive renderer field`);
  }
  const forbiddenTokens = forbiddenPaths
    .flatMap((value) => [value, basename(value)])
    .filter(Boolean)
    .map((value) => String(value).replaceAll("\\", "/").toLowerCase());
  const visit = (candidate) => {
    if (typeof candidate === "string") {
      const normalized = candidate.replaceAll("\\", "/").toLowerCase();
      if (forbiddenTokens.some((token) => token.length > 0 && normalized.includes(token))) {
        throw new Error(`${label} exposed the isolated fixture path`);
      }
      return;
    }
    if (Array.isArray(candidate)) {
      for (const item of candidate) visit(item);
      return;
    }
    if (candidate === null || typeof candidate !== "object") return;
    for (const [key, child] of Object.entries(candidate)) {
      if (new Set(["rawPath", "filePath", "directoryPath", "dataRoot", "vaultPath", "databasePath"]).has(key)) {
        throw new Error(`${label} exposed a forbidden path field`);
      }
      if (key === "rawPathExposed" && child !== false) {
        throw new Error(`${label} reported raw path exposure`);
      }
      if (key === "keyMaterialExposedToRenderer" && child !== false) {
        throw new Error(`${label} reported renderer key exposure`);
      }
      visit(child);
    }
  };
  visit(value);
}

function rejectMcpStderr(stderr, forbiddenPaths = []) {
  if (typeof stderr !== "string" || stderr.trim() === "") return;
  for (const line of stderr.split(/\r?\n/u).filter(Boolean)) {
    let value = line;
    try {
      value = JSON.parse(line);
    } catch {
      // Non-JSON stderr is still scanned for the isolated fixture path below.
    }
    assertPathlessValue(value, "candor-mcp stderr", forbiddenPaths);
  }
  throw new Error("Packaged candor-mcp wrote to stderr");
}

function assertCustody(value, label, forbiddenPaths = []) {
  if (
    value === null
    || typeof value !== "object"
    || value.rawPathExposed !== false
    || value.keyMaterialExposedToRenderer !== false
  ) {
    throw new Error(`${label} omitted the path and key custody receipt`);
  }
  assertPathlessValue(value, label, forbiddenPaths);
}

function assertFixtureReadResults(results, expected, labelPrefix, forbiddenPaths = []) {
  for (const key of READ_RESULT_KEYS) {
    assertCustody(results[key], `${labelPrefix} ${key}`, forbiddenPaths);
  }
  if (
    results.list.count !== 1
    || results.list.totalCount !== 1
    || !Array.isArray(results.list.meetings)
    || results.list.meetings.length !== 1
    || results.list.meetings[0]?.recordingId !== expected.recordingId
    || results.list.meetings[0]?.label !== expected.label
    || results.list.meetings[0]?.encryptedAtRest !== true
  ) {
    throw new Error(`${labelPrefix} list did not return the populated encrypted fixture`);
  }
  const searchMatch = Array.isArray(results.search.matches)
    ? results.search.matches.find((match) => match.recordingId === expected.recordingId)
    : null;
  if (
    results.search.count < 1
    || !searchMatch
    || !String(searchMatch.snippet ?? "").toLowerCase().includes(expected.query.toLowerCase())
  ) {
    throw new Error(`${labelPrefix} search did not find the populated fixture transcript`);
  }
  if (
    results.summary.recordingId !== expected.recordingId
    || results.summary.label !== expected.label
    || results.summary.state !== "finished"
    || results.summary.encryptedAtRest !== true
    || results.summary.transcriptSegmentCount !== expected.transcriptText.length
  ) {
    throw new Error(`${labelPrefix} summary did not prove the encrypted finished fixture`);
  }
  const transcriptText = Array.isArray(results.transcript.segments)
    ? results.transcript.segments.map((segment) => segment.text)
    : [];
  if (
    results.transcript.recordingId !== expected.recordingId
    || results.transcript.count !== expected.transcriptText.length
    || !expected.transcriptText.every((text) => transcriptText.includes(text))
  ) {
    throw new Error(`${labelPrefix} transcript did not return every expected segment`);
  }
  if (
    results.export.recordingId !== expected.recordingId
    || results.export.format !== "markdown"
    || results.export.destination !== "stdout-only"
    || !(results.export.bytes > 0)
    || !expected.transcriptText.every((text) => String(results.export.content ?? "").includes(text))
  ) {
    throw new Error(`${labelPrefix} export was not the expected bounded stdout-only document`);
  }
  if (
    results.statistics.totalMeetingCount !== 1
    || results.statistics.meetingsScanned !== 1
    || results.statistics.encryptedAtRestMeetingCount !== 1
    || results.statistics.transcriptSegmentCount !== expected.transcriptText.length
  ) {
    throw new Error(`${labelPrefix} statistics did not aggregate the populated encrypted fixture`);
  }
}

export function assertCandorctlResults(commandRuns, deniedRun, expected, options = {}) {
  const results = {};
  for (const key of READ_RESULT_KEYS) {
    const run = commandRuns[key];
    if (!run || run.code !== 0 || run.stderr.trim() !== "") {
      let errorCode = "NO_BOUNDED_RESULT";
      if (run?.stderr?.trim()) {
        const errorFrame = parseJson(run.stderr, `candorctl ${key} error`);
        assertPathlessValue(errorFrame, `candorctl ${key} error`, options.forbiddenPaths);
        const candidate = errorFrame?.error?.code;
        if (typeof candidate === "string" && /^[A-Z][A-Z0-9_]{0,63}$/u.test(candidate)) {
          errorCode = candidate;
        }
      }
      const exitCode = Number.isInteger(run?.code) ? run.code : "missing";
      throw new Error(`Packaged candorctl ${key} command failed (exit ${exitCode}, error ${errorCode})`);
    }
    results[key] = parseJson(run.stdout, `candorctl ${key}`);
  }
  assertFixtureReadResults(results, expected, "candorctl", options.forbiddenPaths);
  if (deniedRun.code === 0) throw new Error("Packaged candorctl accepted a mutating command");
  const denied = parseJson(deniedRun.stderr, "candorctl mutation denial");
  assertCustody(denied.error, "candorctl mutation denial", options.forbiddenPaths);
  if (denied.error.code !== "OPERATION_DENIED") {
    throw new Error("Packaged candorctl returned the wrong mutation-denial code");
  }
  return { results, denied };
}

function parseMcpToolResult(frame, label, expectedIsError) {
  if (frame?.result?.isError !== expectedIsError) {
    throw new Error(`${label} returned the wrong MCP error state`);
  }
  const content = frame?.result?.content;
  if (!Array.isArray(content) || content.length !== 1 || content[0]?.type !== "text") {
    throw new Error(`${label} returned an invalid bounded MCP content frame`);
  }
  return parseJson(content[0].text ?? "", label);
}

export function assertMcpResults(run, expected, options = {}) {
  rejectMcpStderr(run.stderr, options.forbiddenPaths);
  if (run.code !== 0) throw new Error("Packaged candor-mcp failed");
  const frames = run.stdout
    .split(/\r?\n/u)
    .filter(Boolean)
    .map((line) => parseJson(line, "candor-mcp frame"));
  if (frames.length !== 10) throw new Error("Packaged candor-mcp returned an unexpected frame count");
  assertPathlessValue(frames, "candor-mcp frames", options.forbiddenPaths);
  const framesById = new Map(frames.map((frame) => [frame.id, frame]));
  if (framesById.get(1)?.result?.serverInfo?.name !== "candor-mcp") {
    throw new Error("Packaged candor-mcp did not initialize as the expected server");
  }
  const toolNames = framesById.get(2)?.result?.tools?.map((tool) => tool.name);
  if (JSON.stringify(toolNames) !== JSON.stringify(EXPECTED_TOOL_NAMES)) {
    throw new Error("Packaged candor-mcp exposed an unexpected tool allowlist");
  }
  if (framesById.get(3)?.error?.code !== -32601) {
    throw new Error("Packaged candor-mcp accepted a non-allowlisted protocol method");
  }
  assertCustody(framesById.get(3)?.error?.data, "candor-mcp method denial", options.forbiddenPaths);

  const toolResults = {};
  for (const [index, key] of READ_RESULT_KEYS.entries()) {
    toolResults[key] = parseMcpToolResult(
      framesById.get(10 + index),
      `candor-mcp ${EXPECTED_TOOL_NAMES[index]}`,
      false,
    );
  }
  assertFixtureReadResults(toolResults, expected, "candor-mcp", options.forbiddenPaths);

  const mutationDenial = parseMcpToolResult(
    framesById.get(20),
    "candor-mcp mutation denial",
    true,
  );
  assertCustody(mutationDenial, "candor-mcp mutation denial", options.forbiddenPaths);
  if (mutationDenial.code !== "OPERATION_DENIED") {
    throw new Error("Packaged candor-mcp returned the wrong mutation-denial code");
  }
  return { frames, toolResults, mutationDenial };
}

async function seedPopulatedEncryptedFixture(corePath, options) {
  const child = spawn(corePath, [], {
    cwd: options.cwd,
    env: options.env,
    windowsHide: true,
    stdio: ["pipe", "pipe", "pipe"],
  });
  const lines = createInterface({ input: child.stdout });
  const pending = new Map();
  let outputBytes = 0;
  let transportFailure = null;
  let shutdownCompleted = false;

  const rejectPending = (error) => {
    transportFailure = transportFailure ?? error;
    for (const entry of pending.values()) {
      clearTimeout(entry.timeout);
      entry.reject(transportFailure);
    }
    pending.clear();
  };
  child.once("error", () => rejectPending(new Error("Packaged fixture core failed to start")));
  child.once("close", () => {
    if (!shutdownCompleted) rejectPending(new Error("Packaged fixture core closed unexpectedly"));
  });
  child.stdin.on("error", () => rejectPending(new Error("Packaged fixture core input closed")));
  child.stderr.on("data", (chunk) => {
    outputBytes += chunk.length;
    if (outputBytes > PROCESS_OUTPUT_LIMIT_BYTES) {
      rejectPending(new Error("Packaged fixture core exceeded the bounded output limit"));
    }
  });
  lines.on("line", (line) => {
    outputBytes += Buffer.byteLength(line, "utf8");
    if (outputBytes > PROCESS_OUTPUT_LIMIT_BYTES) {
      rejectPending(new Error("Packaged fixture core exceeded the bounded output limit"));
      return;
    }
    let response;
    try {
      response = JSON.parse(line);
    } catch {
      rejectPending(new Error("Packaged fixture core returned invalid JSON"));
      return;
    }
    const entry = pending.get(response.requestId ?? response.id);
    if (!entry) return;
    pending.delete(response.requestId ?? response.id);
    clearTimeout(entry.timeout);
    if (response.ok === true) {
      entry.resolve(response.result);
    } else {
      const error = new Error("Packaged fixture core rejected fixture population");
      error.code = response.error?.code;
      entry.reject(error);
    }
  });

  const call = (method, params = null) => {
    if (transportFailure) return Promise.reject(transportFailure);
    const request = createVersionedCoreRequest(method, params);
    return new Promise((resolveCall, rejectCall) => {
      const timeout = setTimeout(() => {
        pending.delete(request.requestId);
        rejectCall(new Error(`Packaged fixture core timed out during ${method}`));
      }, PROCESS_TIMEOUT_MS);
      pending.set(request.requestId, { resolve: resolveCall, reject: rejectCall, timeout });
      child.stdin.write(`${JSON.stringify(request)}\n`, (error) => {
        if (!error) return;
        clearTimeout(timeout);
        pending.delete(request.requestId);
        rejectCall(new Error("Packaged fixture core input write failed"));
      });
    });
  };

  try {
    const storage = await call("recording.durable.status");
    const vault = await call("vault.openLocal");
    assertPathlessValue(storage, "fixture storage status", [options.dataRoot]);
    assertPathlessValue(vault, "fixture vault status", [options.dataRoot]);
    if (
      storage?.chunkEncryptionAvailable !== true
      || storage?.chunkEncryption !== "os-key-encrypted"
      || storage?.chunkCipher !== "chacha20poly1305"
    ) {
      throw new Error("Packaged core could not create an encrypted companion fixture");
    }
    if (vault?.backend !== "sqlcipher" || vault?.encrypted !== true || vault?.openMode !== "os-key") {
      throw new Error("Packaged core did not open the encrypted SQLCipher fixture vault");
    }

    const started = await call("recording.durable.start", { label: FIXTURE_LABEL });
    const recordingId = started?.recordingId;
    if (typeof recordingId !== "string" || !/^[A-Za-z0-9_-]{1,96}$/u.test(recordingId)) {
      throw new Error("Packaged core returned an invalid fixture recording identifier");
    }
    await call("recording.durable.writeTextChunk", {
      recordingId,
      channel: "mic",
      dataUtf8: FIXTURE_TEXT_CHUNK,
    });
    const finished = await call("recording.durable.finish", { recordingId });
    const firstTranscript = await call("recording.durable.writeTranscriptSegment", {
      recordingId,
      channel: "mic",
      speaker: "Avery",
      text: FIXTURE_TRANSCRIPT_TEXT[0],
      startMs: 0,
      durationMs: 1_200,
      confidence: 0.98,
    });
    const secondTranscript = await call("recording.durable.writeTranscriptSegment", {
      recordingId,
      channel: "system",
      speaker: "Morgan",
      text: FIXTURE_TRANSCRIPT_TEXT[1],
      startMs: 1_200,
      durationMs: 1_300,
      confidence: 0.97,
    });
    for (const [label, value] of [
      ["fixture finish", finished],
      ["fixture first transcript", firstTranscript],
      ["fixture second transcript", secondTranscript],
    ]) {
      assertPathlessValue(value, label, [options.dataRoot]);
    }
    if (
      finished?.state !== "finished"
      || finished?.encryptedAtRest !== true
      || finished?.vaultIndex?.backend !== "sqlcipher"
      || finished?.vaultIndex?.indexed !== true
      || firstTranscript?.encryptedAtRest !== true
      || secondTranscript?.encryptedAtRest !== true
      || secondTranscript?.transcriptSegmentCount !== FIXTURE_TRANSCRIPT_TEXT.length
      || secondTranscript?.encryptedChunkCount !== secondTranscript?.chunkCount
    ) {
      throw new Error("Packaged core did not persist a fully encrypted populated fixture");
    }

    const listed = await call("recording.durable.listPage", { offset: 0, limit: 10 });
    const transcript = await call("recording.durable.transcriptPage", {
      recordingId,
      offset: 0,
      limit: 10,
    });
    assertPathlessValue(listed, "fixture list confirmation", [options.dataRoot]);
    assertPathlessValue(transcript, "fixture transcript confirmation", [options.dataRoot]);
    if (
      listed?.totalCount !== 1
      || listed?.recordings?.[0]?.recordingId !== recordingId
      || transcript?.segmentCount !== FIXTURE_TRANSCRIPT_TEXT.length
      || !FIXTURE_TRANSCRIPT_TEXT.every((text) => transcript.segments?.some((segment) => segment.text === text))
    ) {
      throw new Error("Packaged core could not reopen the populated fixture before companion proof");
    }

    await call("core.shutdown");
    shutdownCompleted = true;
    return {
      recordingId,
      label: FIXTURE_LABEL,
      query: FIXTURE_SEARCH_QUERY,
      transcriptText: [...FIXTURE_TRANSCRIPT_TEXT],
      meetingCount: 1,
      transcriptSegmentCount: FIXTURE_TRANSCRIPT_TEXT.length,
      encryptedAtRest: true,
      chunkCipher: storage.chunkCipher,
      vaultBackend: vault.backend,
    };
  } finally {
    lines.close();
    if (!child.stdin.destroyed && !child.stdin.writableEnded) child.stdin.end();
    await stopChildProcess(child, { gracefulTimeoutMs: 500, forcedTimeoutMs: 5_000 });
  }
}

function listCoreProcessIds() {
  if (process.platform === "win32") {
    const result = spawnSync(
      "tasklist",
      ["/FI", "IMAGENAME eq candor-core.exe", "/FO", "CSV", "/NH"],
      { encoding: "utf8", timeout: 5_000, windowsHide: true },
    );
    if (result.status !== 0) return null;
    return new Set(
      result.stdout
        .split(/\r?\n/u)
        .map((line) => /^"candor-core\.exe","([0-9]+)"/iu.exec(line)?.[1])
        .filter(Boolean),
    );
  }
  const result = spawnSync("ps", ["-A", "-o", "pid=,comm="], {
    encoding: "utf8",
    timeout: 5_000,
  });
  if (result.status !== 0) return null;
  return new Set(
    result.stdout
      .split(/\r?\n/u)
      .map((line) => /^\s*([0-9]+)\s+candor-core\s*$/u.exec(line)?.[1])
      .filter(Boolean),
  );
}

function requireProcessEnumeration(value, phase) {
  if (!(value instanceof Set)) {
    throw new Error(`candor-core process enumeration was unavailable ${phase}`);
  }
  return value;
}

export async function assertNoNewCoreProcesses(before, options = {}) {
  const initial = requireProcessEnumeration(before, "before the proof operation");
  const enumerate = options.enumerate ?? listCoreProcessIds;
  const timeoutMs = options.timeoutMs ?? 5_000;
  const pollIntervalMs = options.pollIntervalMs ?? 50;
  let enumerationChecks = 0;
  const enumerateRequired = () => {
    enumerationChecks += 1;
    return requireProcessEnumeration(enumerate(), "during proof cleanup");
  };
  let after = enumerateRequired();
  const newIds = () => [...after].filter((id) => !initial.has(id));
  const deadline = Date.now() + timeoutMs;
  while (newIds().length > 0 && Date.now() < deadline) {
    await delay(pollIntervalMs);
    after = enumerateRequired();
  }
  if (newIds().length > 0) throw new Error("Packaged companion left a candor-core process running");
  return { supported: true, enumerationChecks, newProcessCount: 0 };
}

function commandEvidence(run) {
  return {
    exitCode: run.code,
    signal: run.signal,
    durationMs: run.durationMs,
    stdoutBytes: run.stdoutBytes,
    stderrBytes: run.stderrBytes,
    boundedRuntimeMs: PROCESS_TIMEOUT_MS,
    boundedOutputBytes: PROCESS_OUTPUT_LIMIT_BYTES,
  };
}

export async function verifyPackagedCompanionRuntime(options = {}) {
  const binDirectory = resolve(options.binDirectory ?? defaultBinDirectory());
  const candorctlPath = join(binDirectory, process.platform === "win32" ? "candorctl.exe" : "candorctl");
  const candorMcpPath = join(binDirectory, process.platform === "win32" ? "candor-mcp.exe" : "candor-mcp");
  const corePath = join(binDirectory, process.platform === "win32" ? "candor-core.exe" : "candor-core");
  const binaries = {
    candorctl: fileEvidence(candorctlPath),
    candorMcp: fileEvidence(candorMcpPath),
    core: fileEvidence(corePath),
  };
  const dataRoot = mkdtempSync(join(tmpdir(), "candor-packaged-companions-"));
  const environment = {
    ...process.env,
    CANDOR_V3_DATA_DIR: dataRoot,
  };
  delete environment.CANDOR_CORE_BINARY;

  try {
    const processesBeforeSeed = requireProcessEnumeration(
      listCoreProcessIds(),
      "before fixture seeding",
    );
    const fixture = await seedPopulatedEncryptedFixture(corePath, {
      cwd: binDirectory,
      env: environment,
      dataRoot,
    });
    const seederCleanup = await assertNoNewCoreProcesses(processesBeforeSeed);
    assertFixturePayloadPlaintextAbsent(dataRoot, [FIXTURE_TEXT_CHUNK, ...FIXTURE_TRANSCRIPT_TEXT]);
    const before = snapshotDirectory(dataRoot);
    const coreProcessesBefore = requireProcessEnumeration(
      listCoreProcessIds(),
      "before companion execution",
    );

    const commandArguments = {
      list: ["list", "--limit", "10"],
      search: ["search", fixture.query, "--limit", "10"],
      summary: ["summary", fixture.recordingId],
      transcript: ["transcript", fixture.recordingId, "--limit", "10"],
      export: ["export", fixture.recordingId, "--format", "markdown", "--limit", "10"],
      statistics: ["stats"],
    };
    const commandRuns = {};
    for (const key of READ_RESULT_KEYS) {
      commandRuns[key] = await runBounded(candorctlPath, commandArguments[key], {
        cwd: binDirectory,
        env: environment,
      });
    }
    const deniedRun = await runBounded(candorctlPath, ["delete", fixture.recordingId], {
      cwd: binDirectory,
      env: environment,
    });
    const ctl = assertCandorctlResults(commandRuns, deniedRun, fixture, {
      forbiddenPaths: [dataRoot],
    });

    const mcpFrames = [
      { jsonrpc: "2.0", id: 1, method: "initialize", params: {} },
      { jsonrpc: "2.0", id: 2, method: "tools/list", params: {} },
      { jsonrpc: "2.0", id: 3, method: "resources/read", params: {} },
      {
        jsonrpc: "2.0",
        id: 10,
        method: "tools/call",
        params: { name: "list_meetings", arguments: { limit: 10 } },
      },
      {
        jsonrpc: "2.0",
        id: 11,
        method: "tools/call",
        params: { name: "search_meetings", arguments: { query: fixture.query, limit: 10 } },
      },
      {
        jsonrpc: "2.0",
        id: 12,
        method: "tools/call",
        params: { name: "meeting_summary", arguments: { recordingId: fixture.recordingId } },
      },
      {
        jsonrpc: "2.0",
        id: 13,
        method: "tools/call",
        params: { name: "get_transcript", arguments: { recordingId: fixture.recordingId, limit: 10 } },
      },
      {
        jsonrpc: "2.0",
        id: 14,
        method: "tools/call",
        params: {
          name: "export_meeting",
          arguments: { recordingId: fixture.recordingId, format: "markdown", limit: 10 },
        },
      },
      {
        jsonrpc: "2.0",
        id: 15,
        method: "tools/call",
        params: { name: "library_statistics", arguments: {} },
      },
      {
        jsonrpc: "2.0",
        id: 20,
        method: "tools/call",
        params: { name: "delete_meeting", arguments: { recordingId: fixture.recordingId } },
      },
    ];
    const mcpInput = `${mcpFrames.map((frame) => JSON.stringify(frame)).join("\n")}\n`;
    const mcpRun = await runBounded(candorMcpPath, [], {
      cwd: binDirectory,
      env: environment,
      input: mcpInput,
    });
    const mcp = assertMcpResults(mcpRun, fixture, { forbiddenPaths: [dataRoot] });
    const processCleanup = await assertNoNewCoreProcesses(coreProcessesBefore);
    const after = snapshotDirectory(dataRoot);
    const persistentState = assertPersistentStateUnchanged(before, after);

    return {
      ok: true,
      proofKind: "packaged-companion-runtime-smoke",
      verifiedBy: "scripts/packaged-companion-runtime-smoke.mjs",
      binaries,
      adjacencyOverrideUsed: false,
      isolatedData: true,
      populatedFixture: {
        meetingCount: fixture.meetingCount,
        transcriptSegmentCount: fixture.transcriptSegmentCount,
        recordingIdSha256: sha256Bytes(Buffer.from(fixture.recordingId, "utf8")),
        encryptedAtRest: fixture.encryptedAtRest,
        testedPayloadPlaintextScan: {
          scope: "one fixture text chunk and two fixture transcript segment payloads",
          payloadCount: 1 + fixture.transcriptSegmentCount,
          plaintextFoundInPersistentFiles: false,
          excludedFields: ["meeting label", "speaker labels", "manifest metadata"],
        },
        chunkCipher: fixture.chunkCipher,
        vaultBackend: fixture.vaultBackend,
      },
      dataMutationDetected: false,
      persistentState,
      processCleanup: {
        fixtureSeeder: seederCleanup,
        companions: processCleanup,
      },
      candorctl: {
        commands: Object.fromEntries(
          READ_RESULT_KEYS.map((key) => [key, commandEvidence(commandRuns[key])]),
        ),
        mutationDenial: commandEvidence(deniedRun),
        allReadCommandsVerified: [...READ_RESULT_KEYS],
        custodyReceiptsVerified: true,
        deniedCode: ctl.denied.error.code,
      },
      candorMcp: {
        session: commandEvidence(mcpRun),
        initialized: true,
        exactToolNames: [...EXPECTED_TOOL_NAMES],
        nonAllowlistedMethodDenied: true,
        readOnlyToolCallsVerified: [...EXPECTED_TOOL_NAMES],
        mutationToolCallDenied: true,
        deniedCode: mcp.mutationDenial.code,
        custodyReceiptsVerified: true,
      },
      temporaryDataRemoved: true,
      rawPathExposed: false,
      keyMaterialExposedToRenderer: false,
    };
  } finally {
    removeTemporaryDirectory(dataRoot);
  }
}

function defaultBinDirectory() {
  if (process.platform === "win32") {
    return join(repoRoot, "release-v3", "win-unpacked", "resources", "bin");
  }
  if (process.platform === "darwin") {
    const candidates = ["mac", "mac-arm64"]
      .map((folder) => join(repoRoot, "release-v3", folder, "Candor.app", "Contents", "Resources", "bin"));
    return candidates.find((candidate) => existsSync(candidate)) ?? candidates[0];
  }
  return join(repoRoot, "release-v3", "linux-unpacked", "resources", "bin");
}

async function main() {
  const binDirectory = process.argv[2] ? resolve(process.argv[2]) : defaultBinDirectory();
  const proofPath = process.env.CANDOR_PACKAGED_COMPANION_PROOF
    ? resolve(process.env.CANDOR_PACKAGED_COMPANION_PROOF)
    : join(
      repoRoot,
      "release-v3",
      "proofs",
      `packaged-companion-runtime-smoke-${process.platform}-${process.arch}.json`,
    );
  const proof = await verifyPackagedCompanionRuntime({ binDirectory });
  mkdirSync(dirname(proofPath), { recursive: true });
  writeFileSync(proofPath, `${JSON.stringify({
    ...proof,
    generatedAt: new Date().toISOString(),
  }, null, 2)}\n`, "utf8");
  process.stdout.write(`${JSON.stringify({ ok: true, proofPath, proofKind: proof.proofKind })}\n`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
