// @ts-check

/**
 * @typedef {{
 *   rawPathExposed: false,
 *   keyMaterialExposedToRenderer: false,
 * }} RendererCustody
 */

/**
 * @typedef {{
 *   action: "show-and-focus-recorder",
 *   recordsAudio: false,
 *   localOnly: true,
 *   rawPathExposed: false,
 *   keyMaterialExposedToRenderer: false,
 * }} ShortcutTriggeredPayload
 */

const SHORTCUT_PAYLOAD_KEYS = Object.freeze([
  "action",
  "recordsAudio",
  "localOnly",
  "rawPathExposed",
  "keyMaterialExposedToRenderer",
]);

// These fields are deliberate, bounded renderer metadata. Sensitive-looking
// fields not listed here fail closed so a newly added core or IPC response
// cannot expose ownership data merely by leaving the two custody sentinels
// set to false.
const SAFE_SENSITIVE_RENDERER_FIELDS = new Set([
  "contextTokens",
  "contextTokensEnv",
  "keyId",
  "osKeyBackend",
  "osKeyCreated",
  "osKeyStorage",
  "osKeyStorageAvailable",
  "previewToken",
  "signatureKeyId",
]);

const SENSITIVE_FIELD_PARTS = new Set([
  "key", "keys", "material", "materials", "path", "paths", "secret", "secrets", "token", "tokens",
]);
const SENSITIVE_COMPOUND_FIELD = /^(?:(?:raw|private|source|device|file|directory|storage|vault|model|runner|runtime|executable|output|input|userdata|coredata)path|(?:api|private|public|encryption|signing|vault|license)key|(?:api|client|auth|authentication|session|private)secret|(?:access|refresh|auth|authentication|session|bearer|license|api)token|(?:key|cryptographic|secret|private)material)$/u;
const NEGATIVE_RECEIPT_SUFFIX = /(?:Access|Accepted(?:FromRenderer)?|Exposed(?:ToRenderer)?|Included)$/u;

/**
 * @param {string} field
 * @returns {boolean}
 */
function isSensitiveRendererFieldName(field) {
  const parts = field
    .replace(/([a-z0-9])([A-Z])/gu, "$1 $2")
    .replace(/([A-Z]+)([A-Z][a-z])/gu, "$1 $2")
    .split(/[^A-Za-z0-9]+/u)
    .filter(Boolean)
    .map((part) => part.toLowerCase());
  if (parts.some((part) => SENSITIVE_FIELD_PARTS.has(part))) return true;
  return SENSITIVE_COMPOUND_FIELD.test(field.replace(/[^A-Za-z0-9]/gu, "").toLowerCase());
}

/**
 * Inspect object keys only. String values are intentionally opaque because a
 * transcript, note, or summary may legitimately contain a filesystem-looking
 * string.
 *
 * @param {unknown} value
 * @returns {boolean}
 */
function hasRendererCustodyViolation(value) {
  /** @type {{ value: unknown, depth: number }[]} */
  const pending = [{ value, depth: 0 }];
  const seen = new WeakSet();
  while (pending.length > 0) {
    const current = pending.pop();
    if (!current) break;
    if (current.value === null || typeof current.value !== "object") continue;
    if (current.depth > 64) return true;
    if (seen.has(current.value)) continue;
    seen.add(current.value);
    if (Array.isArray(current.value)) {
      for (const nested of current.value) pending.push({ value: nested, depth: current.depth + 1 });
      continue;
    }
    for (const [field, nested] of Object.entries(current.value)) {
      if (!SAFE_SENSITIVE_RENDERER_FIELDS.has(field) && isSensitiveRendererFieldName(field)) {
        if (!NEGATIVE_RECEIPT_SUFFIX.test(field) || nested !== false) return true;
      }
      pending.push({ value: nested, depth: current.depth + 1 });
    }
  }
  return false;
}

/**
 * The preload is the final ownership boundary before a result becomes renderer
 * state. Reject explicitly unsafe markers and non-object results, then attach
 * the complete custody receipt to legacy object responses that predate V4.
 *
 * @param {unknown} value
 * @returns {Readonly<Record<string, unknown> & RendererCustody>}
 */
function withRendererCustody(value) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Candor IPC returned an invalid renderer response");
  }
  if (hasRendererCustodyViolation(value)) {
    throw new Error("Candor IPC rejected an unsafe renderer response");
  }
  return Object.freeze({
    ...value,
    rawPathExposed: false,
    keyMaterialExposedToRenderer: false,
  });
}

/**
 * @param {unknown} value
 * @returns {Readonly<ShortcutTriggeredPayload> | null}
 */
function parseShortcutTriggeredPayload(value) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return null;
  const keys = Object.keys(value);
  if (
    keys.length !== SHORTCUT_PAYLOAD_KEYS.length
    || keys.some((key) => !SHORTCUT_PAYLOAD_KEYS.includes(key))
    || Reflect.get(value, "action") !== "show-and-focus-recorder"
    || Reflect.get(value, "recordsAudio") !== false
    || Reflect.get(value, "localOnly") !== true
    || Reflect.get(value, "rawPathExposed") !== false
    || Reflect.get(value, "keyMaterialExposedToRenderer") !== false
  ) {
    return null;
  }
  return Object.freeze({
    action: "show-and-focus-recorder",
    recordsAudio: false,
    localOnly: true,
    rawPathExposed: false,
    keyMaterialExposedToRenderer: false,
  });
}

exports.parseShortcutTriggeredPayload = parseShortcutTriggeredPayload;
exports.hasRendererCustodyViolation = hasRendererCustodyViolation;
exports.withRendererCustody = withRendererCustody;
