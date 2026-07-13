import { describe, expect, it } from "vitest";
import { isReleaseArtifactName, isUnsafeReleaseArtifactName } from "./release-artifacts.mjs";
import { validateReleaseChecksums } from "./release-checksum-validation.mjs";

function validProof() {
  const artifacts = [
    { name: "Candor Setup 2.0.0.exe", sha256: "a".repeat(64) },
    { name: "Candor Setup 2.0.0.exe.blockmap", sha256: "b".repeat(64) },
  ];
  return {
    ok: true,
    proofKind: "v3-release-checksums",
    mode: "verify",
    localOnly: true,
    cloudAi: false,
    networkAttempted: false,
    rawPathExposed: false,
    keyMaterialExposed: false,
    artifactCount: artifacts.length,
    artifacts,
    git: { head: "c".repeat(40), dirty: false },
    sourceManifest: {
      proofKind: "m0-artifact-manifest",
      gitHead: "c".repeat(40),
      dirty: false,
      artifactCount: artifacts.length,
      matchedArtifactNames: artifacts.map((artifact) => artifact.name),
    },
  };
}

describe("validateReleaseChecksums", () => {
  it("accepts a complete two-way package and manifest binding", () => {
    expect(validateReleaseChecksums(validProof())).toEqual([]);
  });

  it("rejects an extra checksummed package missing from the manifest", () => {
    const proof = validProof();
    proof.sourceManifest.artifactCount = 1;
    proof.sourceManifest.matchedArtifactNames = [proof.artifacts[0].name];
    expect(validateReleaseChecksums(proof)).toContain(
      "release checksum total artifact count does not match manifest artifact count",
    );
  });

  it("rejects duplicate package names in either side of the binding", () => {
    const proof = validProof();
    proof.artifacts[1].name = proof.artifacts[0].name;
    proof.sourceManifest.matchedArtifactNames[1] = proof.sourceManifest.matchedArtifactNames[0];
    expect(validateReleaseChecksums(proof)).toEqual(expect.arrayContaining([
      "release checksum artifact names must be unique",
      "release checksum source-manifest package names must be unique",
    ]));
  });
});

describe("release artifact names", () => {
  it("classifies package metadata while rejecting path-shaped names", () => {
    expect(isReleaseArtifactName("Candor Setup 2.0.0.exe.blockmap")).toBe(true);
    expect(isReleaseArtifactName("latest.yml")).toBe(true);
    expect(isUnsafeReleaseArtifactName("Candor\nSetup.exe")).toBe(true);
    expect(isUnsafeReleaseArtifactName("nested\\Candor.exe")).toBe(true);
    expect(isReleaseArtifactName("Candor\nSetup.exe")).toBe(false);
  });
});
