import { createHash } from "node:crypto";
import { createWriteStream, existsSync } from "node:fs";
import { chmod, mkdir, open, rename, rm, stat } from "node:fs/promises";
import { request } from "node:https";
import { dirname, join } from "node:path";

export const SHERPA_ONNX_VERSION = "1.13.4";
export const SHERPA_ONNX_ARCHIVE_NAME =
  "sherpa-onnx-v1.13.4-win-x64-static-MT-Release-lib.tar.bz2";
export const SHERPA_ONNX_ARCHIVE_BYTES = 119_847_445;
export const SHERPA_ONNX_ARCHIVE_SHA256 =
  "d81bd1d25112540862d2387072e76b2b6843ef962918d6b5c7db5a19c6276b4c";

const DOWNLOAD_URL =
  `https://github.com/k2-fsa/sherpa-onnx/releases/download/v${SHERPA_ONNX_VERSION}/${SHERPA_ONNX_ARCHIVE_NAME}`;
const ALLOWED_HOSTS = new Set([
  "github.com",
  "release-assets.githubusercontent.com",
  "objects.githubusercontent.com",
]);
const MAX_REDIRECTS = 5;

function validateUrl(value) {
  const url = new URL(value);
  if (
    url.protocol !== "https:"
    || url.username
    || url.password
    || (url.port && url.port !== "443")
    || !ALLOWED_HOSTS.has(url.hostname.toLowerCase())
  ) {
    throw new Error("The sherpa-onnx build archive URL was rejected.");
  }
  return url;
}

function openResponse(url, redirects = 0) {
  return new Promise((resolve, reject) => {
    const handle = request(validateUrl(url), {
      method: "GET",
      headers: {
        Accept: "application/octet-stream",
        "User-Agent": "Candor-Sherpa-Build/1",
      },
    }, (response) => {
      if (response.statusCode && response.statusCode >= 300 && response.statusCode < 400) {
        const location = response.headers.location;
        response.destroy();
        if (!location || redirects >= MAX_REDIRECTS) {
          reject(new Error("The sherpa-onnx build archive redirect was rejected."));
          return;
        }
        openResponse(new URL(location, url).toString(), redirects + 1).then(resolve, reject);
        return;
      }
      if (response.statusCode !== 200) {
        response.destroy();
        reject(new Error(`The sherpa-onnx build archive returned HTTP ${response.statusCode ?? "unknown"}.`));
        return;
      }
      resolve(response);
    });
    handle.setTimeout(30_000, () => handle.destroy(new Error("The sherpa-onnx build archive download timed out.")));
    handle.once("error", reject);
    handle.end();
  });
}

async function sha256File(path) {
  const file = await open(path, "r");
  const digest = createHash("sha256");
  const buffer = Buffer.allocUnsafe(1024 * 1024);
  try {
    while (true) {
      const { bytesRead } = await file.read(buffer, 0, buffer.length, null);
      if (bytesRead === 0) break;
      digest.update(buffer.subarray(0, bytesRead));
    }
  } finally {
    await file.close();
  }
  return digest.digest("hex");
}

async function verifiedArchive(path) {
  if (!existsSync(path)) return false;
  const metadata = await stat(path);
  return metadata.isFile()
    && metadata.size === SHERPA_ONNX_ARCHIVE_BYTES
    && await sha256File(path) === SHERPA_ONNX_ARCHIVE_SHA256;
}

async function downloadArchive(path) {
  const partPath = `${path}.part`;
  await rm(partPath, { force: true });
  const response = await openResponse(DOWNLOAD_URL);
  const contentLength = Number(response.headers["content-length"]);
  if (contentLength !== SHERPA_ONNX_ARCHIVE_BYTES) {
    response.destroy();
    throw new Error("The sherpa-onnx build archive size did not match the pinned release.");
  }
  const digest = createHash("sha256");
  let received = 0;
  const output = createWriteStream(partPath, { flags: "wx", mode: 0o600 });
  try {
    for await (const incoming of response) {
      const bytes = Buffer.isBuffer(incoming) ? incoming : Buffer.from(incoming);
      received += bytes.length;
      if (received > SHERPA_ONNX_ARCHIVE_BYTES) {
        throw new Error("The sherpa-onnx build archive exceeded its pinned size.");
      }
      digest.update(bytes);
      if (!output.write(bytes)) await new Promise((resolve) => output.once("drain", resolve));
    }
    await new Promise((resolve, reject) => output.end((error) => error ? reject(error) : resolve()));
    if (received !== SHERPA_ONNX_ARCHIVE_BYTES || digest.digest("hex") !== SHERPA_ONNX_ARCHIVE_SHA256) {
      throw new Error("The sherpa-onnx build archive failed its pinned SHA-256 check.");
    }
    await rename(partPath, path);
    if (process.platform !== "win32") await chmod(path, 0o600);
  } catch (error) {
    output.destroy();
    await rm(partPath, { force: true });
    throw error;
  }
}

export async function ensureSherpaOnnxBuildArchive(env = process.env) {
  if (process.platform !== "win32") return null;
  const configured = env.SHERPA_ONNX_ARCHIVE_DIR;
  const root = configured || join(
    env.LOCALAPPDATA || dirname(env.USERPROFILE || process.cwd()),
    "CandorToolchains",
    `sherpa-onnx-${SHERPA_ONNX_VERSION}`,
  );
  await mkdir(root, { recursive: true });
  const archivePath = join(root, SHERPA_ONNX_ARCHIVE_NAME);
  if (!await verifiedArchive(archivePath)) {
    if (configured && existsSync(archivePath)) {
      throw new Error(`SHERPA_ONNX_ARCHIVE_DIR contains an unverified ${SHERPA_ONNX_ARCHIVE_NAME}.`);
    }
    await rm(archivePath, { force: true });
    console.error(`Downloading and verifying ${SHERPA_ONNX_ARCHIVE_NAME}...`);
    await downloadArchive(archivePath);
  }
  env.SHERPA_ONNX_ARCHIVE_DIR = root;
  return { root, archivePath };
}
