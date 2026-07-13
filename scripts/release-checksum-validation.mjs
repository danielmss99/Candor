export function validateReleaseChecksums(payload) {
  const failures = [];
  if (payload?.ok !== true) failures.push("release checksum proof did not pass");
  if (payload?.proofKind !== "v3-release-checksums") {
    failures.push("release checksum proofKind must be v3-release-checksums");
  }
  if (payload?.mode !== "verify") failures.push("release checksum proof must come from verification mode");
  if (payload?.localOnly !== true) failures.push("release checksum proof localOnly must be true");
  if (payload?.cloudAi !== false) failures.push("release checksum proof cloudAi must be false");
  if (payload?.networkAttempted !== false) failures.push("release checksum proof must not attempt network");
  if (payload?.rawPathExposed !== false) failures.push("release checksum proof must not expose raw paths");
  if (payload?.keyMaterialExposed !== false) failures.push("release checksum proof must not expose key material");
  if (typeof payload?.git?.head !== "string" || !/^[a-f0-9]{40}$/.test(payload.git.head)) {
    failures.push("release checksum proof must identify a committed source revision");
  }
  if (payload?.git?.dirty !== false) failures.push("release checksum proof must come from a clean tracked source tree");
  if (payload?.sourceManifest?.proofKind !== "m0-artifact-manifest") {
    failures.push("release checksum proof must bind to the M0 artifact manifest");
  }
  if (payload?.sourceManifest?.gitHead !== payload?.git?.head || payload?.sourceManifest?.dirty !== false) {
    failures.push("release checksum proof source manifest must match the clean committed revision");
  }

  const artifacts = Array.isArray(payload?.artifacts) ? payload.artifacts : [];
  const matchedNames = Array.isArray(payload?.sourceManifest?.matchedArtifactNames)
    ? payload.sourceManifest.matchedArtifactNames
    : [];
  if (!Number.isInteger(payload?.artifactCount) || payload.artifactCount < 1) {
    failures.push("release checksum proof must include at least one package");
  }
  if (payload?.artifactCount !== artifacts.length) {
    failures.push("release checksum artifact count does not match the artifact list");
  }
  if (!Number.isInteger(payload?.sourceManifest?.artifactCount) || payload.sourceManifest.artifactCount < 1) {
    failures.push("release checksum proof source manifest must include at least one package");
  }
  if (payload?.artifactCount !== payload?.sourceManifest?.artifactCount) {
    failures.push("release checksum total artifact count does not match manifest artifact count");
  }
  if (matchedNames.length !== payload?.sourceManifest?.artifactCount) {
    failures.push("release checksum proof must match every package recorded by the source manifest");
  }
  if (new Set(matchedNames).size !== matchedNames.length) {
    failures.push("release checksum source-manifest package names must be unique");
  }

  const artifactNames = [];
  for (const artifact of artifacts) {
    if (typeof artifact?.name !== "string" || artifact.name.length === 0 || artifact.name !== artifact.name.replaceAll("\\", "/").split("/").at(-1)) {
      failures.push("release checksum artifact names must be non-empty basenames");
    } else {
      artifactNames.push(artifact.name);
    }
    if (typeof artifact?.sha256 !== "string" || !/^[a-f0-9]{64}$/.test(artifact.sha256)) {
      failures.push(`release checksum is invalid for ${artifact?.name ?? "unknown artifact"}`);
    }
  }
  if (new Set(artifactNames).size !== artifactNames.length) {
    failures.push("release checksum artifact names must be unique");
  }
  for (const name of matchedNames) {
    if (typeof name !== "string" || name.length === 0 || name !== name.replaceAll("\\", "/").split("/").at(-1)) {
      failures.push("release checksum source-manifest matches must use basename-only package names");
    }
    if (!artifacts.some((artifact) => artifact?.name === name)) {
      failures.push(`release checksum source-manifest package is absent: ${name}`);
    }
  }
  return failures;
}
