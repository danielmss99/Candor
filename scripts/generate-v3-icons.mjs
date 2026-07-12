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
const BRAND_PNG_SIZES = [16, 24, 32, 48, 64, 128, 256, 512, 1024];
const ICO_SIZES = [16, 20, 24, 32, 40, 48, 64, 128, 256];
const BRAND_SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512" role="img" aria-labelledby="title desc">
  <title id="title">Candor selected app icon</title>
  <desc id="desc">The selected Candor Keep Tab mark in the Soft Signal palette.</desc>
  <rect width="512" height="512" rx="104" fill="#161616"/>
  <path d="M366 150A158 158 0 1 0 366 362" fill="none" stroke="#FFF9EE" stroke-width="76" stroke-linecap="round"/>
  <path d="M368 210H414V270L391 294L368 270Z" fill="#FF6B5E"/>
</svg>
`;
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

function pointInPolygon(x, y, points) {
  let inside = false;
  for (let index = 0, previous = points.length - 1; index < points.length; previous = index, index += 1) {
    const [currentX, currentY] = points[index];
    const [previousX, previousY] = points[previous];
    const intersects =
      currentY > y !== previousY > y &&
      x < ((previousX - currentX) * (y - currentY)) / (previousY - currentY) + currentX;
    if (intersects) inside = !inside;
  }
  return inside;
}

function sampleIcon(x, y) {
  const shellDistance = roundedRectDistance(x, y, 0, 0, 1, 1, 104 / 512);
  if (shellDistance > 0) return [0, 0, 0, 0];

  let color = [22, 22, 22, 255];

  const endpointDeltaY = 106;
  const centerToEndpointX = Math.sqrt(158 ** 2 - endpointDeltaY ** 2);
  const centerX = (366 - centerToEndpointX) / 512;
  const centerY = 0.5;
  const deltaX = x - centerX;
  const deltaY = y - centerY;
  const radius = Math.hypot(deltaX, deltaY);
  const angle = Math.atan2(deltaY, deltaX);
  const cRadius = 158 / 512;
  const cHalfStroke = 38 / 512;
  const capRadius = cHalfStroke;
  const openAngle = Math.atan2(endpointDeltaY, centerToEndpointX);
  const upperCap = Math.hypot(x - 366 / 512, y - 150 / 512) <= capRadius;
  const lowerCap = Math.hypot(x - 366 / 512, y - 362 / 512) <= capRadius;
  const openC = Math.abs(radius - cRadius) <= cHalfStroke && Math.abs(angle) >= openAngle;

  if (openC || upperCap || lowerCap) {
    color = [255, 249, 238, 255];
  }

  const tab = [
    [368 / 512, 210 / 512],
    [414 / 512, 210 / 512],
    [414 / 512, 270 / 512],
    [391 / 512, 294 / 512],
    [368 / 512, 270 / 512],
  ];
  if (pointInPolygon(x, y, tab)) {
    color = [255, 107, 94, 255];
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
outputs.push(emit("assets/icons/candor-app-icon-master.svg", Buffer.from(BRAND_SVG, "utf8")));
for (const size of BRAND_PNG_SIZES) {
  outputs.push(emit("assets/icons/candor-app-icon-" + size + ".png", pngBySize.get(size)));
}
for (const size of PNG_SIZES) {
  outputs.push(emit("build/icons/" + size + "x" + size + ".png", pngBySize.get(size)));
}
outputs.push(emit("build/icon.png", pngBySize.get(512)));
const windowsIcon = encodeIco(pngBySize);
const macosIcon = encodeIcns(pngBySize);
outputs.push(emit("assets/platform/candor.ico", windowsIcon));
outputs.push(emit("assets/platform/candor.icns", macosIcon));
outputs.push(emit("build/icon.ico", windowsIcon));
outputs.push(emit("build/icon.icns", macosIcon));
outputs.push(emit("v3/renderer/public/candor-mark.png", pngBySize.get(128)));

console.log((checkOnly ? "Verified" : "Generated") + " " + outputs.length + " Candor icon assets.");
for (const output of outputs) {
  console.log(output.relativePath + " " + output.bytes + " " + output.sha256);
}
