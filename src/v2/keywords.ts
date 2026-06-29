const STOP = new Set([
  "that", "this", "with", "from", "have", "been", "were", "they", "what", "when",
  "your", "about", "would", "there", "their", "which", "could", "should", "into",
  "just", "like", "some", "than", "then", "them", "these", "those", "very", "also",
  "will", "going", "really", "think", "know", "need", "want", "yeah", "okay",
]);

export function extractTopTerms(text: string, count = 8): { word: string; weight: number }[] {
  const words = text.toLowerCase().match(/\b[a-z]{4,}\b/g) ?? [];
  const freq = new Map<string, number>();
  for (const w of words) {
    if (!STOP.has(w)) freq.set(w, (freq.get(w) ?? 0) + 1);
  }
  return [...freq.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, count)
    .map(([word, weight]) => ({ word, weight }));
}

export function buildOutline(
  chapters: { label: string; time: string }[],
  transcript: { time: string; text: string }[],
): string[] {
  if (chapters.length > 0) {
    return chapters.map((c) => `${c.label} (${c.time})`);
  }
  const every = Math.max(1, Math.floor(transcript.length / 4));
  return transcript
    .filter((_, i) => i % every === 0)
    .slice(0, 5)
    .map((s) => `${s.time} — ${s.text.slice(0, 60)}${s.text.length > 60 ? "…" : ""}`);
}
