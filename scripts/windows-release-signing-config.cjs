const { readFileSync } = require("node:fs");
const path = require("node:path");
const yaml = require("js-yaml");

const REQUIRED_ENVIRONMENT = Object.freeze([
  "AZURE_TENANT_ID",
  "AZURE_CLIENT_ID",
  "AZURE_CLIENT_SECRET",
  "AZURE_TRUSTED_SIGNING_PUBLISHER_NAME",
  "AZURE_TRUSTED_SIGNING_ENDPOINT",
  "AZURE_TRUSTED_SIGNING_ACCOUNT_NAME",
  "AZURE_TRUSTED_SIGNING_CERTIFICATE_PROFILE_NAME",
]);

function requireSigningEnvironment(environment) {
  const missing = REQUIRED_ENVIRONMENT.filter((name) => {
    const value = environment[name];
    return typeof value !== "string" || value.trim().length === 0;
  });
  if (missing.length > 0) {
    throw new Error(
      `Windows public release signing is not configured. Missing: ${missing.join(", ")}`,
    );
  }

  const endpoint = environment.AZURE_TRUSTED_SIGNING_ENDPOINT.trim();
  let parsedEndpoint;
  try {
    parsedEndpoint = new URL(endpoint);
  } catch {
    throw new Error("AZURE_TRUSTED_SIGNING_ENDPOINT must be a valid HTTPS URL");
  }
  if (parsedEndpoint.protocol !== "https:") {
    throw new Error("AZURE_TRUSTED_SIGNING_ENDPOINT must be a valid HTTPS URL");
  }

  return {
    publisherName: environment.AZURE_TRUSTED_SIGNING_PUBLISHER_NAME.trim(),
    endpoint,
    codeSigningAccountName: environment.AZURE_TRUSTED_SIGNING_ACCOUNT_NAME.trim(),
    certificateProfileName:
      environment.AZURE_TRUSTED_SIGNING_CERTIFICATE_PROFILE_NAME.trim(),
    fileDigest: "SHA256",
    timestampDigest: "SHA256",
    timestampRfc3161: "http://timestamp.acs.microsoft.com",
  };
}

function buildWindowsReleaseConfig({
  environment = process.env,
  baseConfigPath = path.resolve(__dirname, "..", "electron-builder.v3.yml"),
} = {}) {
  const baseConfig = yaml.load(readFileSync(baseConfigPath, "utf8"));
  if (!baseConfig || typeof baseConfig !== "object") {
    throw new Error("electron-builder.v3.yml must contain an object configuration");
  }

  const azureSignOptions = requireSigningEnvironment(environment);
  const existingSignExts = Array.isArray(baseConfig.win?.signExts)
    ? baseConfig.win.signExts
    : [];

  return {
    ...baseConfig,
    forceCodeSigning: true,
    win: {
      ...baseConfig.win,
      azureSignOptions,
      signExecutable: true,
      signAndEditExecutable: true,
      signExts: [...new Set([...existingSignExts, ".exe"])],
      signingHashAlgorithms: ["sha256"],
    },
  };
}

module.exports = {
  REQUIRED_ENVIRONMENT,
  buildWindowsReleaseConfig,
  requireSigningEnvironment,
};
