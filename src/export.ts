import type { RecapData } from "./data/mock";

/** Build a markdown export from recap data. */
export function recapToMarkdown(recap: RecapData): string {
  const lines: string[] = [
    `# ${recap.title}`,
    "",
    recap.meta,
    "",
    "## AI Summary",
    "",
    recap.summary.replace(/\*\*/g, ""),
    "",
  ];

  if (recap.decisions.length > 0) {
    lines.push("## Key Decisions", "");
    for (const d of recap.decisions) lines.push(`- ${d}`);
    lines.push("");
  }

  if (recap.actions.length > 0) {
    lines.push("## Action Items", "");
    for (const a of recap.actions) {
      lines.push(`- [ ] ${a.text} (@${a.owner}, due ${a.due})`);
    }
    lines.push("");
  }

  if (recap.chapters.length > 0) {
    lines.push("## Chapters", "");
    for (const c of recap.chapters) lines.push(`- ${c.time} — ${c.label}`);
    lines.push("");
  }

  lines.push("## Highlight", "", `> ${recap.highlight.quote}`, "", `— ${recap.highlight.by}`);
  return lines.join("\n");
}

export type ExportPreset = "markdown" | "slack" | "email" | "pdf";

export function recapToSlack(recap: RecapData): string {
  return `*${recap.title}* (${recap.meta.split(" · ")[0]})\n\n${recap.summary.replace(/\*\*/g, "*")}\n\n${
    recap.decisions.length
      ? `*Decisions*\n${recap.decisions.map((d) => `• ${d}`).join("\n")}\n\n`
      : ""
  }${
    recap.actions.length
      ? `*Actions*\n${recap.actions.map((a) => `• ${a.text} — ${a.owner}`).join("\n")}`
      : ""
  }`.trim();
}

export function recapToEmail(recap: RecapData): string {
  return `Subject: Follow-up — ${recap.title}\n\nHi team,\n\nThanks for the discussion. ${recap.summary.replace(/\*\*/g, "")}\n\nNext steps:\n${
    recap.actions.map((a) => `• ${a.text} (${a.owner}, due ${a.due})`).join("\n") || "None captured."
  }\n\nBest`;
}

export function recapToHtml(recap: RecapData): string {
  const esc = (s: string) =>
    s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  return `<!DOCTYPE html><html><head><meta charset="utf-8"><title>${esc(recap.title)}</title>
<style>body{font-family:system-ui,sans-serif;max-width:720px;margin:2rem auto;line-height:1.5;color:#222}
h1{font-size:1.5rem}h2{font-size:1rem;margin-top:1.5rem;color:#666}</style></head><body>
<h1>${esc(recap.title)}</h1><p>${esc(recap.meta)}</p>
<h2>Summary</h2><p>${esc(recap.summary.replace(/\*\*/g, ""))}</p>
${
  recap.decisions.length
    ? `<h2>Decisions</h2><ul>${recap.decisions.map((d) => `<li>${esc(d)}</li>`).join("")}</ul>`
    : ""
}
${
  recap.actions.length
    ? `<h2>Action items</h2><ul>${recap.actions.map((a) => `<li>${esc(a.text)} (${esc(a.owner)})</li>`).join("")}</ul>`
    : ""
}
</body></html>`;
}

function downloadBlob(content: string, filename: string, mime: string): void {
  const blob = new Blob([content], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

function slug(title: string): string {
  return title.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "meeting-notes";
}

/** Download recap using a preset format. */
export function downloadRecapPreset(recap: RecapData, preset: ExportPreset): void {
  const base = slug(recap.title);
  switch (preset) {
    case "markdown":
      downloadBlob(recapToMarkdown(recap), `${base}.md`, "text/markdown;charset=utf-8");
      break;
    case "slack":
      downloadBlob(recapToSlack(recap), `${base}-slack.txt`, "text/plain;charset=utf-8");
      break;
    case "email":
      downloadBlob(recapToEmail(recap), `${base}-email.txt`, "text/plain;charset=utf-8");
      break;
    case "pdf":
      downloadBlob(recapToHtml(recap), `${base}.html`, "text/html;charset=utf-8");
      break;
  }
}

/** @deprecated Use downloadRecapPreset(recap, "markdown") */
export function downloadRecapMarkdown(recap: RecapData): void {
  downloadRecapPreset(recap, "markdown");
}

/** Copy recap summary to clipboard for sharing. */
export async function shareRecapSummary(recap: RecapData): Promise<boolean> {
  const text = `${recap.title}\n${recap.meta}\n\n${recap.summary.replace(/\*\*/g, "")}`;
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    return false;
  }
}

/** @deprecated Use askMeeting from v2/askMeeting.ts */
export function answerMeetingQuestion(recap: RecapData, question: string): string {
  const q = question.trim().toLowerCase();
  if (!q) return "Ask a question about this meeting.";
  if (q.includes("slack")) return recapToSlack(recap);
  if (q.includes("email")) return recapToEmail(recap);
  if (q.includes("decision")) {
    return recap.decisions.length ? recap.decisions.join(" ") : "No formal decisions were logged.";
  }
  return recap.summary.replace(/\*\*/g, "");
}
