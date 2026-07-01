export type SummaryTemplateId =
  | "general"
  | "standup"
  | "one_on_one"
  | "sales"
  | "retro"
  | "client_call";

export interface SummaryTemplate {
  id: SummaryTemplateId;
  label: string;
  description: string;
  sections: string[];
}

export const SUMMARY_TEMPLATES: SummaryTemplate[] = [
  {
    id: "general",
    label: "General recap",
    description: "Balanced summary for any meeting",
    sections: ["Summary", "Decisions", "Action items"],
  },
  {
    id: "standup",
    label: "Team standup",
    description: "Yesterday / today / blockers format",
    sections: ["Progress", "Plans", "Blockers"],
  },
  {
    id: "one_on_one",
    label: "1:1",
    description: "Talking points and follow-ups",
    sections: ["Discussion", "Feedback", "Follow-ups"],
  },
  {
    id: "sales",
    label: "Sales call",
    description: "BANT-style capture",
    sections: ["Pain", "Budget/timeline", "Next step"],
  },
  {
    id: "retro",
    label: "Retro",
    description: "What went well / improve / actions",
    sections: ["Went well", "Improve", "Actions"],
  },
  {
    id: "client_call",
    label: "Client call",
    description: "Client-facing recap",
    sections: ["Context", "Agreements", "Deliverables"],
  },
];

const TEMPLATE_KEY = "candor.summaryTemplate";

export function loadSummaryTemplate(): SummaryTemplateId {
  const raw = localStorage.getItem(TEMPLATE_KEY);
  if (raw && SUMMARY_TEMPLATES.some((t) => t.id === raw)) return raw as SummaryTemplateId;
  return "general";
}

export function saveSummaryTemplate(id: SummaryTemplateId): void {
  localStorage.setItem(TEMPLATE_KEY, id);
}
