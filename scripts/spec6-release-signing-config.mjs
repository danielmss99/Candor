import assert from "node:assert/strict";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const {
  REQUIRED_ENVIRONMENT,
  buildWindowsReleaseConfig,
} = require("./windows-release-signing-config.cjs");

const completeEnvironment = {
  AZURE_TENANT_ID: "tenant-fixture",
  AZURE_CLIENT_ID: "client-fixture",
  AZURE_CLIENT_SECRET: "secret-fixture",
  AZURE_TRUSTED_SIGNING_PUBLISHER_NAME: "Candor Fixture Publisher",
  AZURE_TRUSTED_SIGNING_ENDPOINT: "https://eus.codesigning.azure.net/",
  AZURE_TRUSTED_SIGNING_ACCOUNT_NAME: "candor-fixture-account",
  AZURE_TRUSTED_SIGNING_CERTIFICATE_PROFILE_NAME: "candor-fixture-profile",
};

assert.throws(
  () => buildWindowsReleaseConfig({ environment: {} }),
  (error) => {
    assert.match(error.message, /Windows public release signing is not configured/);
    for (const name of REQUIRED_ENVIRONMENT) assert.match(error.message, new RegExp(name));
    return true;
  },
  "a public release config without credentials must fail closed",
);

assert.throws(
  () => buildWindowsReleaseConfig({
    environment: {
      ...completeEnvironment,
      AZURE_TRUSTED_SIGNING_ENDPOINT: "http://insecure.invalid/",
    },
  }),
  /must be a valid HTTPS URL/,
  "Azure Trusted Signing must use HTTPS",
);

const config = buildWindowsReleaseConfig({ environment: completeEnvironment });
assert.equal(config.forceCodeSigning, true);
assert.deepEqual(config.win.signingHashAlgorithms, ["sha256"]);
assert.ok(config.win.signExts.includes(".exe"));
assert.equal(config.win.signExecutable, true);
assert.equal(config.win.signAndEditExecutable, true);
assert.equal(config.win.azureSignOptions.publisherName, "Candor Fixture Publisher");
assert.equal(config.win.azureSignOptions.fileDigest, "SHA256");
assert.equal(config.win.azureSignOptions.timestampDigest, "SHA256");
assert.ok(
  JSON.stringify(config).includes("AZURE_CLIENT_SECRET") === false
    && JSON.stringify(config).includes("secret-fixture") === false,
  "authentication credentials must remain in the process environment",
);
assert.ok(
  config.extraResources.some((entry) => (
    entry.to === "bin" && entry.filter?.includes("candor-core.exe")
  )),
  "the Windows sidecar must remain in the packaged resources covered by .exe signing",
);

process.stdout.write(
  `SPEC-6 Windows release signing configuration passed for ${path.basename(repoRoot)}.\n`,
);
