import { createHash } from "node:crypto";
import { deflateSync } from "node:zlib";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const repoRoot = resolve(__dirname, "..");
const checkOnly = process.argv.includes("--check");

const PNG_SIZES = [16, 20, 24, 32, 40, 48, 64, 128, 256, 512, 1024];
const ICO_SIZES = [16, 20, 24, 32, 40, 48, 64, 128, 256];
const ICNS_TYPES = new Map([
  [16, "icp4"],
  [32, "icp5"],
  [64, "icp6"],
  [128, "ic07"],
  [256, "ic08"],
  [512, "ic09"],
  [1024, "ic10"],
]);

const CRC_TABLE = new Uint32Array(256);
for (let index = 0; index < 256; index += 1) {
  let value = index;
  for (let bit = 0; bit < 8; bit += 1) {
    value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
  }
  CRC_TABLE[index] = value >>> 0;
}

function clamp(value, min = 0, max = 1) {
  return Math.min(max, Math.max(min, value));
}

function mix(start, end, amount) {
  return start + (end - start) * amount;
}

function roundedRectDistance(x, y, left, top, right, bottom, radius) {
  const centerX = (left + right) / 2;
  const centerY = (top + bottom) / 2;
  const innerHalfWidth = (right - left) / 2 - radius;
  const innerHalfHeight = (bottom - top) / 2 - radius;
  const deltaX = Math.abs(x - centerX) - innerHalfWidth;
  const deltaY = Math.abs(y - centerY) - innerHalfHeight;
  return (
    Math.hypot(Math.max(deltaX, 0), Math.max(deltaY, 0)) +
    Math.min(Math.max(deltaX, deltaY), 0) -
    radius
  );
}

function over(base, foreground, opacity = 1) {
  const amount = clamp(opacity);
  return [
    mix(base[0], foreground[0], amount),
    mix(base[1], foreground[1], amount),
    mix(base[2], foreground[2], amount),
    255,
  ];
}

function sampleIcon(x, y) {
  const shellDistance = roundedRectDistance(x, y, 0.055, 0.055, 0.945, 0.945, 0.205);
  if (shellDistance > 0) return [0, 0, 0, 0];

  const gradient = clamp((x * 0.58 + y * 0.42 - 0.04) / 0.92);
  const topLeft = [56, 91, 231];
  const bottomRight = [116, 73, 211];
  const lift = clamp(1 - Math.hypot(x - 0.24, y - 0.18) / 0.76) * 12;
  let color = [
    clamp(mix(topLeft[0], bottomRight[0], gradient) + lift, 0, 255),
    clamp(mix(topLeft[1], bottomRight[1], gradient) + lift, 0, 255),
    clamp(mix(topLeft[2], bottomRight[2], gradient) + lift, 0, 255),
    255,
  ];

  if (shellDistance > -0.012) {
    color = over(color, [255, 255, 255, 255], 0.18);
  }

  const centerX = 0.43;
  const centerY = 0.5;
  const deltaX = x - centerX;
  const deltaY = y - centerY;
  const radius = Math.hypot(deltaX, deltaY);
  const angle = Math.atan2(deltaY, deltaX);
  const ring = Math.abs(radius - 0.245) <= 0.043 && Math.abs(angle) >= 0.64;
  if (ring) {
    color = over(color, [255, 255, 255, 255], 0.98);
  }

  if (Math.hypot(deltaX, deltaY) <= 0.072) {
    color = over(color, [255, 76, 91, 255], 1);
  }

  const bars = [
    [0.68, 0.43, 0.714, 0.57, 0.017],
    [0.742, 0.37, 0.776, 0.63, 0.017],
    [0.804, 0.445, 0.838, 0.555, 0.017],
  ];
  for (const [left, top, right, bottom, radiusValue] of bars) {
    if (roundedRectDistance(x, y, left, top, right, bottom, radiusValue) <= 0) {
      color = over(color, [255, 255, 255, 255], 0.96);
    }
  }

  return color.map((value) => Math.round(value));
}

function renderRgba(size) {
  const supersample = size <= 256 ? 4 : size <= 512 ? 3 : 2;
  const sampleCount = supersample * supersample;
  const rgba = Buffer.alloc(size * size * 4);

  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      let alpha = 0;
      let red = 0;
      let green = 0;
      let blue = 0;
      for (let sampleY = 0; sampleY < supersample; sampleY += 1) {
        for (let sampleX = 0; sampleX < supersample; sampleX += 1) {
          const pointX = (x + (sampleX + 0.5) / supersample) / size;
          const pointY = (y + (sampleY + 0.5) / supersample) / size;
          const sample = sampleIcon(pointX, pointY);
          const sampleAlpha = sample[3] / 255;
          alpha += sampleAlpha;
          red += sample[0] * sampleAlpha;
          green += sample[1] * sampleAlpha;
          blue += sample[2] * sampleAlpha;
        }
      }
      const outputAlpha = alpha / sampleCount;
      const offset = (y * size + x) * 4;
      rgba[offset] = alpha > 0 ? Math.round(red / alpha) : 0;
      rgba[offset + 1] = alpha > 0 ? Math.round(green / alpha) : 0;
      rgba[offset + 2] = alpha > 0 ? Math.round(blue / alpha) : 0;
      rgba[offset + 3] = Math.round(outputAlpha * 255);
    }
  }

  return rgba;
}

function crc32(buffer) {
  let crc = 0xffffffff;
  for (const byte of buffer) {
    crc = CRC_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function pngChunk(type, data) {
  const typeBytes = Buffer.from(type, "ascii");
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length, 0);
  const checksum = Buffer.alloc(4);
  checksum.writeUInt32BE(crc32(Buffer.concat([typeBytes, data])), 0);
  return Buffer.concat([length, typeBytes, data, checksum]);
}

function encodePng(size, rgba) {
  const signature = Buffer.from("89504e470d0a1a0a", "hex");
  const header = Buffer.alloc(13);
  header.writeUInt32BE(size, 0);
  header.writeUInt32BE(size, 4);
  header[8] = 8;
  header[9] = 6;
  const scanlines = Buffer.alloc((size * 4 + 1) * size);
  for (let row = 0; row < size; row += 1) {
    const target = row * (size * 4 + 1);
    scanlines[target] = 0;
    rgba.copy(scanlines, target + 1, row * size * 4, (row + 1) * size * 4);
  }
  return Buffer.concat([
    signature,
    pngChunk("IHDR", header),
    pngChunk("IDAT", deflateSync(scanlines, { level: 9 })),
    pngChunk("IEND", Buffer.alloc(0)),
  ]);
}

function encodeIco(pngBySize) {
  const images = ICO_SIZES.map((size) => ({ size, data: pngBySize.get(size) }));
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0);
  header.writeUInt16LE(1, 2);
  header.writeUInt16LE(images.length, 4);
  const entries = Buffer.alloc(images.length * 16);
  let offset = header.length + entries.length;
  images.forEach((image, index) => {
    const entry = index * 16;
    entries[entry] = image.size >= 256 ? 0 : image.size;
    entries[entry + 1] = image.size >= 256 ? 0 : image.size;
    entries[entry + 2] = 0;
    entries[entry + 3] = 0;
    entries.writeUInt16LE(1, entry + 4);
    entries.writeUInt16LE(32, entry + 6);
    entries.writeUInt32LE(image.data.length, entry + 8);
    entries.writeUInt32LE(offset, entry + 12);
    offset += image.data.length;
  });
  return Buffer.concat([header, entries, ...images.map((image) => image.data)]);
}

function encodeIcns(pngBySize) {
  const chunks = [...ICNS_TYPES.entries()].map(([size, type]) => {
    const data = pngBySize.get(size);
    const header = Buffer.alloc(8);
    header.write(type, 0, 4, "ascii");
    header.writeUInt32BE(data.length + 8, 4);
    return Buffer.concat([header, data]);
  });
  const totalLength = chunks.reduce((sum, chunk) => sum + chunk.length, 8);
  const header = Buffer.alloc(8);
  header.write("icns", 0, 4, "ascii");
  header.writeUInt32BE(totalLength, 4);
  return Buffer.concat([header, ...chunks]);
}

function sha256(data) {
  return createHash("sha256").update(data).digest("hex");
}

function emit(relativePath, data) {
  const path = join(repoRoot, relativePath);
  if (checkOnly) {
    if (!existsSync(path)) {
      throw new Error("Generated icon asset is missing: " + relativePath);
    }
    const current = readFileSync(path);
    if (!current.equals(data)) {
      throw new Error(
        "Generated icon asset is stale: " +
          relativePath +
          "\nexpected " +
          sha256(data) +
          "\nactual   " +
          sha256(current),
      );
    }
  } else {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, data);
  }
  return { relativePath, bytes: data.length, sha256: sha256(data) };
}

const pngBySize = new Map();
for (const size of PNG_SIZES) {
  pngBySize.set(size, encodePng(size, renderRgba(size)));
}

const outputs = [];
for (const size of PNG_SIZES) {
  outputs.push(emit("build/icons/" + size + "x" + size + ".png", pngBySize.get(size)));
}
outputs.push(emit("build/icon.png", pngBySize.get(512)));
outputs.push(emit("build/icon.ico", encodeIco(pngBySize)));
outputs.push(emit("build/icon.icns", encodeIcns(pngBySize)));
outputs.push(emit("v3/renderer/public/candor-mark.png", pngBySize.get(128)));

console.log((checkOnly ? "Verified" : "Generated") + " " + outputs.length + " Candor icon assets.");
for (const output of outputs) {
  console.log(output.relativePath + " " + output.bytes + " " + output.sha256);
}
