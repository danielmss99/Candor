const releaseArtifactPattern = /(?:\.exe|\.dmg|\.AppImage|\.deb|\.rpm|\.blockmap|\.sig|^latest[^/]*\.ya?ml)$/i;

function excludedReleaseOutput(name) {
  return /^SHA256SUMS(?:\.|$)/i.test(name) || /^builder-/i.test(name) || /\.__uninstaller\.exe$/i.test(name);
}

export function isUnsafeReleaseArtifactName(name) {
  return (
    typeof name === "string" &&
    !excludedReleaseOutput(name) &&
    releaseArtifactPattern.test(name) &&
    /[\\/\r\n]/.test(name)
  );
}

export function isReleaseArtifactName(name) {
  if (typeof name !== "string" || !name || isUnsafeReleaseArtifactName(name)) return false;
  if (excludedReleaseOutput(name)) return false;
  return releaseArtifactPattern.test(name);
}

export function releaseArtifactKind(name) {
  if (/\.blockmap$/i.test(name)) return "release-blockmap";
  if (/\.sig$/i.test(name)) return "detached-signature";
  if (/^latest[^/]*\.ya?ml$/i.test(name)) return "update-metadata";
  if (/\.AppImage$/i.test(name)) return "linux-appimage";
  if (/\.deb$/i.test(name)) return "linux-deb";
  if (/\.rpm$/i.test(name)) return "linux-rpm";
  if (/\.dmg$/i.test(name)) return "macos-dmg";
  if (/\.exe$/i.test(name)) return "windows-installer";
  return "unknown";
}
