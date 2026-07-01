/** Custom vocabulary — stored locally; fed to Whisper as initial_prompt when supported. */

const KEY = "candor.dictionary";

export function loadDictionary(): string[] {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((w): w is string => typeof w === "string" && w.trim().length > 0);
  } catch {
    return [];
  }
}

export function saveDictionary(words: string[]): void {
  const cleaned = words.map((w) => w.trim()).filter(Boolean);
  localStorage.setItem(KEY, JSON.stringify(cleaned));
}

/** Comma-separated prompt bias for whisper.cpp initial_prompt (max ~224 tokens). */
export function dictionaryPrompt(words: string[] = loadDictionary()): string | null {
  if (words.length === 0) return null;
  const text = words.join(", ");
  return text.length > 800 ? text.slice(0, 800) : text;
}
