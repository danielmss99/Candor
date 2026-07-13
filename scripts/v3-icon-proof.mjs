import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const repoRoot = resolve(__dirname, "..");

function argValue(name, fallback) {
  const index = process.argv.indexOf(name);
  return index >= 0 && process.argv[index + 1] ? process.argv[index + 1] : fallback;
}

function rel(path) {
  return relative(repoRoot, path).replaceAll("\\", "/");
}

function sha256(data) {
  return createHash("sha256").update(data).digest("hex");
}

function read(relativePath) {
  const path = join(repoRoot, relativePath);
  if (!existsSync(path)) {
    throw new Error("Icon proof input is missing: " + relativePath);
  }
  return { path, data: readFileSync(path) };
}

function pngDimensions(data, label) {
  if (!data.subarray(0, 8).equals(Buffer.from("89504e470d0a1a0a", "hex"))) {
    throw new Error(label + " is not a PNG file");
  }
  if (data.subarray(12, 16).toString("ascii") !== "IHDR") {
    throw new Error(label + " does not start with a PNG IHDR chunk");
  }
  return {
    width: data.readUInt32BE(16),
    height: data.readUInt32BE(20),
    bitDepth: data[24],
    colorType: data[25],
  };
}

function inspectIco(data) {
  if (data.length < 6 || data.readUInt16LE(0) !== 0 || data.readUInt16LE(2) !== 1) {
    throw new Error("Windows icon does not have a valid ICO header");
  }
  const count = data.readUInt16LE(4);
  const entries = [];
  for (let index = 0; index < count; index += 1) {
    const offset = 6 + index * 16;
    if (offset + 16 > data.length) throw new Error("Windows ICO directory is truncated");
    const width = data[offset] || 256;
    const height = data[offset + 1] || 256;
    const bytes = data.readUInt32LE(offset + 8);
    const imageOffset = data.readUInt32LE(offset + 12);
    if (imageOffset + bytes > data.length) {
      throw new Error("Windows ICO image payload is truncated");
    }
    const image = data.subarray(imageOffset, imageOffset + bytes);
    const dimensions = pngDimensions(image, "Windows ICO image");
    if (dimensions.width !== width || dimensions.height !== height) {
      throw new Error("Windows ICO directory dimensions do not match its PNG payload");
    }
    entries.push({ width, height, bytes, png: true });
  }
  return { count, entries };
}

function inspectIcns(data) {
  if (data.length < 8 || data.subarray(0, 4).toString("ascii") !== "icns") {
    throw new Error("macOS icon does not have a valid ICNS header");
  }
  if (data.readUInt32BE(4) !== data.length) {
    throw new Error("macOS ICNS declared length does not match its payload");
  }
  const chunks = [];
  let offset = 8;
  while (offset < data.length) {
    if (offset + 8 > data.length) throw new Error("macOS ICNS chunk header is truncated");
    const type = data.subarray(offset, offset + 4).toString("ascii");
    const length = data.readUInt32BE(offset + 4);
    if (length < 8 || offset + length > data.length) {
      throw new Error("macOS ICNS chunk is truncated");
    }
    const payload = data.subarray(offset + 8, offset + length);
    const dimensions = pngDimensions(payload, "macOS " + type + " chunk");
    chunks.push({ type, bytes: payload.length, ...dimensions });
    offset += length;
  }
  return { count: chunks.length, chunks };
}

function inspectPngFamily() {
  const sizes = [16, 20, 24, 32, 40, 48, 64, 128, 256, 512, 1024];
  return sizes.map((size) => {
    const relativePath = "build/icons/" + size + "x" + size + ".png";
    const asset = read(relativePath);
    const dimensions = pngDimensions(asset.data, relativePath);
    if (dimensions.width !== size || dimensions.height !== size) {
      throw new Error(relativePath + " has unexpected dimensions");
    }
    if (dimensions.bitDepth !== 8 || dimensions.colorType !== 6) {
      throw new Error(relativePath + " must be an 8-bit RGBA PNG");
    }
    return {
      path: relativePath,
      bytes: asset.data.length,
      sha256: sha256(asset.data),
      ...dimensions,
    };
  });
}

function verifyGenerator() {
  const result = spawnSync(
    process.execPath,
    [join(repoRoot, "scripts", "generate-v3-icons.mjs"), "--check"],
    { cwd: repoRoot, encoding: "utf8", shell: false },
  );
  if (result.status !== 0) {
    throw new Error("Icon reproducibility check failed: " + (result.stderr || result.stdout).trim());
  }
  return {
    passed: true,
    output: result.stdout.trim().split(/\r?\n/)[0] || "verified",
  };
}

function verifyBuilderConfig() {
  const config = readFileSync(join(repoRoot, "electron-builder.v3.yml"), "utf8");
  const expected = [
    "buildResources: build",
    "icon: assets/platform/candor.ico",
    "icon: assets/platform/candor.icns",
    "icon: build/icons",
  ];
  const missing = expected.filter((line) => !config.includes(line));
  if (missing.length > 0) {
    throw new Error("Electron builder icon configuration is incomplete: " + missing.join(", "));
  }
  return { passed: true, expected };
}

function verifyBrandMaster() {
  const master = read("assets/icons/candor-app-icon-master.svg");
  const source = master.data.toString("utf8");
  const required = [
    'viewBox="0 0 512 512"',
    'fill="#161616"',
    'stroke="#FFF9EE"',
    'd="M368 210H414V270L391 294L368 270Z"',
    'fill="#FF6B5E"',
  ];
  const missing = required.filter((value) => !source.includes(value));
  if (missing.length > 0) {
    throw new Error("Approved Keep Tab SVG is incomplete: " + missing.join(", "));
  }
  if (/(?:linear|radial)Gradient|\bfilter=|<filter|<image/i.test(source)) {
    throw new Error("Approved Keep Tab SVG contains a forbidden effect or remote asset");
  }
  const colors = [...source.matchAll(/#[0-9A-Fa-f]{6}/g)].map((match) => match[0].toUpperCase());
  const approved = new Set(["#161616", "#FFF9EE", "#FF6B5E"]);
  if (colors.some((color) => !approved.has(color))) {
    throw new Error("Approved Keep Tab SVG contains a color outside the Soft Signal palette");
  }
  return {
    passed: true,
    path: rel(master.path),
    bytes: master.data.length,
    sha256: sha256(master.data),
    colors: [...approved],
    pointedKeepTab: true,
  };
}

function verifyPlatformCopies() {
  const windows = read("assets/platform/candor.ico");
  const macos = read("assets/platform/candor.icns");
  const builderWindows = read("build/icon.ico");
  const builderMacos = read("build/icon.icns");
  if (!windows.data.equals(builderWindows.data) || !macos.data.equals(builderMacos.data)) {
    throw new Error("Builder compatibility icons differ from the approved platform assets");
  }
  return {
    passed: true,
    windows: { path: rel(windows.path), sha256: sha256(windows.data) },
    macos: { path: rel(macos.path), sha256: sha256(macos.data) },
  };
}

function verifyWindowsExecutable(executablePath, sourcePath, outputPath) {
  const powershell = [
    "Add-Type -AssemblyName System.Drawing",
    "$source = [System.Drawing.Bitmap]::FromFile($env:CANDOR_ICON_SOURCE)",
    "$icon = [System.Drawing.Icon]::ExtractAssociatedIcon($env:CANDOR_ICON_EXE)",
    "if ($null -eq $icon) { throw 'Windows executable has no associated icon' }",
    "$actual = $icon.ToBitmap()",
    "if ($actual.Width -ne $source.Width -or $actual.Height -ne $source.Height) { throw 'Embedded icon dimensions differ from source' }",
    "$different = 0",
    "$delta = 0L",
    "for ($y = 0; $y -lt $source.Height; $y++) { for ($x = 0; $x -lt $source.Width; $x++) { $a = $source.GetPixel($x,$y); $b = $actual.GetPixel($x,$y); if ($a.ToArgb() -ne $b.ToArgb()) { $different++ }; $delta += [Math]::Abs([int]$a.A-[int]$b.A)+[Math]::Abs([int]$a.R-[int]$b.R)+[Math]::Abs([int]$a.G-[int]$b.G)+[Math]::Abs([int]$a.B-[int]$b.B) } }",
    "$actual.Save($env:CANDOR_ICON_OUT, [System.Drawing.Imaging.ImageFormat]::Png)",
    "$result = [pscustomobject]@{ width=$actual.Width; height=$actual.Height; differentPixels=$different; totalChannelDelta=$delta }",
    "$actual.Dispose(); $icon.Dispose(); $source.Dispose()",
    "$result | ConvertTo-Json -Compress",
  ].join("; ");
  const result = spawnSync(
    "powershell",
    [
      "-NoProfile",
      "-ExecutionPolicy",
      "Bypass",
      "-Command",
      powershell,
    ],
    {
      cwd: repoRoot,
      encoding: "utf8",
      shell: false,
      env: {
        ...process.env,
        CANDOR_ICON_EXE: executablePath,
        CANDOR_ICON_SOURCE: sourcePath,
        CANDOR_ICON_OUT: outputPath,
      },
    },
  );
  if (result.status !== 0) {
    throw new Error("Windows embedded icon proof failed: " + (result.stderr || result.stdout).trim());
  }
  const comparison = JSON.parse(result.stdout.trim());
  if (comparison.differentPixels !== 0 || comparison.totalChannelDelta !== 0) {
    throw new Error("Windows executable icon pixels differ from the generated source icon");
  }
  return {
    passed: true,
    executable: rel(executablePath),
    source: rel(sourcePath),
    extractedPreview: rel(outputPath),
    ...comparison,
  };
}

const releaseDir = resolve(repoRoot, argValue("--release-dir", "release-v3"));
const proofDir = join(repoRoot, "release-v3", "proofs");
const proofPath = join(proofDir, "v3-icon-proof-" + process.platform + "-" + process.arch + ".json");
const extractedPreviewPath = join(
  proofDir,
  "candor-executable-icon-" + process.platform + "-" + process.arch + ".png",
);
const report = {
  ok: false,
  proofKind: "v3-icon-proof",
  generatedAt: new Date().toISOString(),
  platform: process.platform,
  arch: process.arch,
  releaseDir: rel(releaseDir),
  generator: null,
  brandMaster: null,
  platformCopies: null,
  builderConfig: null,
  ico: null,
  icns: null,
  pngs: null,
  packaged: null,
};

try {
  report.generator = verifyGenerator();
  report.brandMaster = verifyBrandMaster();
  report.platformCopies = verifyPlatformCopies();
  report.builderConfig = verifyBuilderConfig();
  const ico = read("assets/platform/candor.ico");
  report.ico = {
    path: rel(ico.path),
    bytes: ico.data.length,
    sha256: sha256(ico.data),
    ...inspectIco(ico.data),
  };
  const icns = read("assets/platform/candor.icns");
  report.icns = {
    path: rel(icns.path),
    bytes: icns.data.length,
    sha256: sha256(icns.data),
    ...inspectIcns(icns.data),
  };
  report.pngs = inspectPngFamily();

  if (process.platform === "win32") {
    const executablePath = join(releaseDir, "win-unpacked", "Candor.exe");
    if (!existsSync(executablePath)) {
      throw new Error("Packaged Windows executable is missing: " + rel(executablePath));
    }
    mkdirSync(proofDir, { recursive: true });
    report.packaged = verifyWindowsExecutable(
      executablePath,
      join(repoRoot, "build", "icons", "32x32.png"),
      extractedPreviewPath,
    );
  } else {
    report.packaged = {
      passed: true,
      status: "source-format-proof-only",
      note: "Packaged icon extraction is implemented for Windows; source assets are cross-platform.",
    };
  }

  report.ok = true;
} catch (error) {
  report.error = error instanceof Error ? error.message : String(error);
}

mkdirSync(proofDir, { recursive: true });
writeFileSync(proofPath, JSON.stringify(report, null, 2) + "\n");
if (!report.ok) {
  console.error("V3 icon proof failed: " + report.error);
  process.exit(1);
}
console.log("V3 icon proof passed. Proof written to " + proofPath + ".");
