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

/** Download recap as a markdown file in the browser/Tauri webview. */
export function downloadRecapMarkdown(recap: RecapData): void {
  const md = recapToMarkdown(recap);
  const slug = recap.title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
  const blob = new Blob([md], { type: "text/markdown;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `${slug || "meeting-notes"}.md`;
  a.click();
  URL.revokeObjectURL(url);
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

/** Mock Q&A responses for the "Ask this meeting" feature. */
export function answerMeetingQuestion(recap: RecapData, question: string): string {
  const q = question.trim().toLowerCase();
  if (!q) return "Ask a question about this meeting.";

  if (q.includes("slack") || q.includes("summarize")) {
    return `*${recap.title}* (${recap.meta.split(" · ")[0]})\n\n${recap.summary.replace(/\*\*/g, "*")}\n\nKey decisions:\n${recap.decisions.map((d) => `• ${d}`).join("\n")}`;
  }

  if (q.includes("email") || q.includes("follow-up") || q.includes("follow up")) {
    return `Subject: Follow-up — ${recap.title}\n\nHi team,\n\nThanks for the discussion today. ${recap.summary.replace(/\*\*/g, "")}\n\nNext steps:\n${recap.actions.map((a) => `• ${a.text} (${a.owner}, due ${a.due})`).join("\n") || "None captured."}\n\nBest`;
  }

  if (q.includes("export") || q.includes("delay")) {
    const hit = recap.decisions.find((d) => d.toLowerCase().includes("export"));
    return hit ?? recap.summary.replace(/\*\*/g, "");
  }

  if (q.includes("decision")) {
    return recap.decisions.length > 0
      ? recap.decisions.join(" ")
      : "No formal decisions were logged for this meeting.";
  }

  if (q.includes("action") || q.includes("todo") || q.includes("task")) {
    return recap.actions.length > 0
      ? recap.actions.map((a) => `${a.text} (${a.owner}, due ${a.due})`).join("\n")
      : "No action items were captured for this meeting.";
  }

  if (recap.summary.toLowerCase().includes(q)) {
    return recap.summary.replace(/\*\*/g, "");
  }

  return `I couldn't find a specific answer for "${question.trim()}". Try asking about decisions, action items, or export timing.`;
}
