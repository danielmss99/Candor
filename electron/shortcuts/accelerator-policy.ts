export const SUGGESTED_RECORDER_ACCELERATOR = "CommandOrControl+Shift+Space";

export type AcceleratorPolicyErrorCode =
  | "ACCELERATOR_REQUIRED"
  | "ACCELERATOR_TOO_LONG"
  | "ACCELERATOR_INVALID_TOKEN"
  | "ACCELERATOR_DUPLICATE_MODIFIER"
  | "ACCELERATOR_MODIFIER_CONFLICT"
  | "ACCELERATOR_PRIMARY_KEY_REQUIRED"
  | "ACCELERATOR_MULTIPLE_PRIMARY_KEYS"
  | "ACCELERATOR_SYSTEM_MODIFIER_REQUIRED"
  | "ACCELERATOR_TWO_MODIFIERS_REQUIRED"
  | "ACCELERATOR_RESERVED";

export class AcceleratorPolicyError extends Error {
  constructor(readonly code: AcceleratorPolicyErrorCode, message: string) {
    super(message);
    this.name = "AcceleratorPolicyError";
  }
}

const MAX_ACCELERATOR_CHARS = 64;
const MODIFIER_ALIASES = new Map<string, string>([
  ["cmdorctrl", "CommandOrControl"],
  ["commandorcontrol", "CommandOrControl"],
  ["cmd", "Command"],
  ["command", "Command"],
  ["ctrl", "Control"],
  ["control", "Control"],
  ["alt", "Alt"],
  ["option", "Option"],
  ["shift", "Shift"],
  ["super", "Super"],
  ["meta", "Super"],
]);
const MODIFIER_ORDER = ["CommandOrControl", "Command", "Control", "Alt", "Option", "Shift", "Super"];
const SYSTEM_MODIFIERS = new Set(["CommandOrControl", "Command", "Control", "Alt", "Option", "Super"]);
const NAMED_KEYS = new Map<string, string>([
  ["space", "Space"],
  ["tab", "Tab"],
  ["enter", "Enter"],
  ["return", "Enter"],
  ["escape", "Escape"],
  ["esc", "Escape"],
  ["backspace", "Backspace"],
  ["delete", "Delete"],
  ["insert", "Insert"],
  ["home", "Home"],
  ["end", "End"],
  ["pageup", "PageUp"],
  ["pagedown", "PageDown"],
  ["up", "Up"],
  ["down", "Down"],
  ["left", "Left"],
  ["right", "Right"],
]);

function normalizedPrimaryKey(value: string): string | null {
  const lower = value.toLowerCase();
  const named = NAMED_KEYS.get(lower);
  if (named) return named;
  if (/^[a-z]$/i.test(value)) return value.toUpperCase();
  if (/^[0-9]$/.test(value)) return value;
  const functionKey = /^f([1-9]|1[0-9]|2[0-4])$/i.exec(value);
  return functionKey ? `F${functionKey[1]}` : null;
}

function isReserved(modifiers: ReadonlySet<string>, primaryKey: string): boolean {
  const commandLike = modifiers.has("CommandOrControl")
    || modifiers.has("Command")
    || modifiers.has("Control");
  if (commandLike && !modifiers.has("Shift") && (primaryKey === "Q" || primaryKey === "W")) return true;
  if (modifiers.has("Alt") && primaryKey === "F4") return true;
  const windowsControlLike = modifiers.has("Control") || modifiers.has("CommandOrControl");
  if (windowsControlLike && modifiers.has("Alt") && primaryKey === "Delete") return true;
  if (windowsControlLike && modifiers.has("Shift") && primaryKey === "Escape") return true;
  if (windowsControlLike && modifiers.has("Alt") && primaryKey === "Tab") return true;
  if (modifiers.has("Alt") && modifiers.has("Shift") && primaryKey === "Tab") return true;

  const macCommandLike = modifiers.has("Command") || modifiers.has("CommandOrControl");
  const macOptionLike = modifiers.has("Option") || modifiers.has("Alt");
  if (macCommandLike && macOptionLike && primaryKey === "Escape") return true;
  if (modifiers.has("Command") && modifiers.has("Control") && primaryKey === "Q") return true;

  return modifiers.has("Super") && modifiers.has("Shift") && primaryKey === "S";
}

export function normalizeAccelerator(value: unknown): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new AcceleratorPolicyError("ACCELERATOR_REQUIRED", "A keyboard shortcut is required.");
  }
  const trimmed = value.trim();
  if (trimmed.length > MAX_ACCELERATOR_CHARS) {
    throw new AcceleratorPolicyError("ACCELERATOR_TOO_LONG", "The keyboard shortcut is too long.");
  }
  if (!/^[\x20-\x7e]+$/.test(trimmed)) {
    throw new AcceleratorPolicyError("ACCELERATOR_INVALID_TOKEN", "The keyboard shortcut contains unsupported characters.");
  }

  const rawTokens = trimmed.split("+").map((token) => token.trim());
  if (rawTokens.some((token) => !token)) {
    throw new AcceleratorPolicyError("ACCELERATOR_INVALID_TOKEN", "The keyboard shortcut contains an empty key.");
  }
  const modifiers = new Set<string>();
  let primaryKey: string | null = null;
  for (const token of rawTokens) {
    const modifier = MODIFIER_ALIASES.get(token.toLowerCase());
    if (modifier) {
      if (modifiers.has(modifier)) {
        throw new AcceleratorPolicyError("ACCELERATOR_DUPLICATE_MODIFIER", "The keyboard shortcut repeats a modifier.");
      }
      modifiers.add(modifier);
      continue;
    }
    const normalizedKey = normalizedPrimaryKey(token);
    if (!normalizedKey) {
      throw new AcceleratorPolicyError("ACCELERATOR_INVALID_TOKEN", "The keyboard shortcut contains an unsupported key.");
    }
    if (primaryKey !== null) {
      throw new AcceleratorPolicyError("ACCELERATOR_MULTIPLE_PRIMARY_KEYS", "The keyboard shortcut must contain one primary key.");
    }
    primaryKey = normalizedKey;
  }
  if (primaryKey === null) {
    throw new AcceleratorPolicyError("ACCELERATOR_PRIMARY_KEY_REQUIRED", "The keyboard shortcut needs a primary key.");
  }
  if (modifiers.has("CommandOrControl") && (modifiers.has("Command") || modifiers.has("Control"))) {
    throw new AcceleratorPolicyError(
      "ACCELERATOR_MODIFIER_CONFLICT",
      "CommandOrControl cannot be combined with Command or Control.",
    );
  }
  if (modifiers.has("Alt") && modifiers.has("Option")) {
    throw new AcceleratorPolicyError("ACCELERATOR_MODIFIER_CONFLICT", "Alt and Option cannot be combined.");
  }
  if (![...modifiers].some((modifier) => SYSTEM_MODIFIERS.has(modifier))) {
    throw new AcceleratorPolicyError(
      "ACCELERATOR_SYSTEM_MODIFIER_REQUIRED",
      "The keyboard shortcut needs Command, Control, Alt, Option, or Super.",
    );
  }
  if (isReserved(modifiers, primaryKey)) {
    throw new AcceleratorPolicyError("ACCELERATOR_RESERVED", "That keyboard shortcut is reserved by the operating system or app.");
  }
  if (modifiers.size < 2) {
    throw new AcceleratorPolicyError(
      "ACCELERATOR_TWO_MODIFIERS_REQUIRED",
      "The keyboard shortcut needs at least two modifiers.",
    );
  }
  return [
    ...MODIFIER_ORDER.filter((modifier) => modifiers.has(modifier)),
    primaryKey,
  ].join("+");
}

export function isAllowedAccelerator(value: unknown): value is string {
  try {
    normalizeAccelerator(value);
    return true;
  } catch {
    return false;
  }
}
