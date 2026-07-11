import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(fileURLToPath(new URL("..", import.meta.url)));

function read(relativePath) {
  return readFileSync(resolve(repoRoot, relativePath), "utf8");
}

function requireIncludes(text, pattern, label) {
  if (!text.includes(pattern)) {
    throw new Error(`M1 macOS privacy contract missing ${label}: ${pattern}`);
  }
}

function requireRegex(text, pattern, label) {
  if (!pattern.test(text)) {
    throw new Error(`M1 macOS privacy contract missing ${label}: ${pattern}`);
  }
}

const builderConfig = read("electron-builder.v3.yml");
const cargoManifest = read("crates/candor-core/Cargo.toml");
const consentStore = read("crates/candor-core/src/consent_store.rs");
const captureService = read("crates/candor-core/src/capture_service.rs");
const macosCapture = read("crates/candor-core/src/capture_service_macos.rs");
const appEntitlements = read("build/entitlements.mac.plist");
const inheritedEntitlements = read("build/entitlements.mac.inherit.plist");
const releaseArtifactSmoke = read("scripts/v3-release-artifact-smoke.mjs");
const consentProof = read("docs/proofs/M1_CONSENT_PROOF.md");

requireIncludes(builderConfig, "mac:", "mac packaging block");
requireIncludes(builderConfig, "hardenedRuntime: true", "hardened runtime");
requireIncludes(builderConfig, 'minimumSystemVersion: "13.0"', "ScreenCaptureKit minimum macOS version");
requireIncludes(builderConfig, "entitlements: build/entitlements.mac.plist", "parent entitlements file");
requireIncludes(
  builderConfig,
  "entitlementsInherit: build/entitlements.mac.inherit.plist",
  "inherited entitlements file",
);
requireIncludes(builderConfig, "Contents/Resources/bin/candor-core", "signed Rust sidecar path");
requireIncludes(builderConfig, "extendInfo:", "Info.plist extension block");
requireIncludes(builderConfig, "NSMicrophoneUsageDescription:", "microphone usage purpose key");
requireIncludes(builderConfig, "NSScreenCaptureUsageDescription:", "screen and system audio purpose key");
requireRegex(
  builderConfig,
  /NSMicrophoneUsageDescription:\s+\S.{24,}/,
  "reader-facing microphone purpose string",
);
requireRegex(
  builderConfig,
  /NSScreenCaptureUsageDescription:\s+\S.{48,}/,
  "reader-facing Screen & System Audio Recording purpose string",
);

requireIncludes(
  cargoManifest,
  '[target.\'cfg(target_os = "macos")\'.dependencies]',
  "macOS-only dependency block",
);
requireIncludes(cargoManifest, 'screencapturekit = { version = "8.0.0"', "pinned ScreenCaptureKit binding");
requireIncludes(cargoManifest, 'features = ["macos_13_0"]', "macOS 13 audio feature");

requireIncludes(
  consentStore,
  'id: "macosScreenCaptureSystemAudio"',
  "macOS screen recording consent item",
);
requireIncludes(
  consentStore,
  "required_for_system_audio: true",
  "macOS system audio consent requirement",
);
requireIncludes(
  captureService,
  '"macos" => "screencapturekit-system-audio"',
  "implemented ScreenCaptureKit backend",
);
requireIncludes(macosCapture, ".with_captures_audio(true)", "system audio capture configuration");
requireIncludes(
  macosCapture,
  ".with_excludes_current_process_audio(true)",
  "current-process audio exclusion",
);
requireIncludes(macosCapture, "SCStreamOutputType::Audio", "system audio output handler");
requireIncludes(macosCapture, "float32_audio_buffers_to_pcm16", "validated PCM conversion");
requireIncludes(macosCapture, "flush_pending_audio", "durable chunk flush path");
requireIncludes(appEntitlements, "com.apple.security.device.audio-input", "parent audio-input entitlement");
requireIncludes(
  inheritedEntitlements,
  "com.apple.security.device.audio-input",
  "sidecar audio-input entitlement",
);
requireIncludes(releaseArtifactSmoke, '"LSMinimumSystemVersion"', "packaged minimum-version audit");
requireIncludes(
  releaseArtifactSmoke,
  '"NSScreenCaptureUsageDescription"',
  "packaged screen capture purpose-string audit",
);
requireIncludes(
  releaseArtifactSmoke,
  '"com.apple.security.device.audio-input"',
  "packaged audio-input entitlement audit",
);
requireIncludes(
  consentProof,
  "macOS app bundle includes `NSMicrophoneUsageDescription`",
  "proof documentation for microphone purpose string",
);
requireIncludes(
  consentProof,
  "`NSScreenCaptureUsageDescription`",
  "proof documentation for Screen & System Audio Recording purpose string",
);

console.log("M1 macOS privacy contract smoke passed.");
