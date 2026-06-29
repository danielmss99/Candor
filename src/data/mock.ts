// Mock data mirroring the design handoff content. Replaced by real
// transcription/storage in later milestones; here it drives the layout.

export interface Person {
  initials: string;
  name: string;
  bg: string;
  fg: string;
}

export const people: Record<string, Person> = {
  MC: { initials: "MC", name: "Maya Chen", bg: "var(--coral)", fg: "#2a1006" },
  DP: { initials: "DP", name: "Devin Park", bg: "var(--purple)", fg: "#fff" },
  SL: { initials: "SL", name: "Sarah Liu", bg: "var(--gold)", fg: "#1a1204" },
  RK: { initials: "RK", name: "Riya Kapoor", bg: "#8b5cf6", fg: "#fff" },
  JO: { initials: "JO", name: "Jordan Ortiz", bg: "var(--coral)", fg: "#2a1006" },
};

export const currentMeeting = {
  title: "Q3 Roadmap Sync",
  date: "Jun 24, 2026",
  duration: "31 min",
  peopleCount: 5,
  elapsedLabel: "24:18",
};

export interface ParticipantLevel {
  key: keyof typeof people;
  share: number; // 0..1 talk-time bar
}

export const participantLevels: ParticipantLevel[] = [
  { key: "MC", share: 0.42 },
  { key: "DP", share: 0.28 },
  { key: "SL", share: 0.21 },
];

export const liveChapters = [
  { time: "00:00", label: "Intros", active: false },
  { time: "06:12", label: "Q3 status", active: false },
  { time: "21:40", label: "Roadmap tradeoffs", active: true },
];

export interface Utterance {
  speaker: keyof typeof people;
  time: string;
  text: string;
  speaking?: boolean;
}

export const liveTranscript: Utterance[] = [
  {
    speaker: "MC",
    time: "24:02",
    text: "If we ship the export feature in August, that pushes the mobile redesign to Q4. Are we all aligned on that tradeoff?",
  },
  {
    speaker: "DP",
    time: "24:09",
    text: "I'd rather protect the mobile work. Export can slip two weeks without hurting the enterprise deals on the table.",
  },
  {
    speaker: "SL",
    time: "24:15",
    text: "From a support standpoint, export is the number-one request this quarter, so I'd push back a little on letting it slip",
    speaking: true,
  },
];

export const liveInsights = {
  action: { text: "Devin to scope a 2-week export delay impact", owner: "@devin" },
  question: "Does an export delay risk any signed enterprise commitments?",
  decision: "Mobile redesign keeps its Q3 priority slot.",
  sentiment: { aligned: 64, tension: 14 },
};

// ----- Recap -----
export interface SummaryBullet {
  text: string;
  subBullets?: string[];
}

export interface SummarySection {
  heading: string;
  bullets: SummaryBullet[];
}

export interface RecapAction {
  text: string;
  owner: string;
  due: string;
  soon: boolean;
  /** Transcript segment index for citation badge (0-based). */
  sourceSegmentIndex?: number;
}

export interface RecapData {
  title: string;
  /** Descriptive subtitle shown under the title (Notion-style). */
  subtitle?: string;
  meta: string;
  summary: string;
  sections?: SummarySection[];
  decisions: string[];
  actions: RecapAction[];
  chapters: { label: string; time: string }[];
  suggestions: string[];
  highlight: { quote: string; by: string };
}

export const recap: RecapData = {
  title: "Meeting @ Jun 24, 2026 2:00 PM",
  subtitle: "Q3 roadmap sequencing — export vs mobile redesign",
  meta: "Jun 24, 2026 · 31 min · 5 people",
  summary:
    "The team debated sequencing the **export feature** against the **mobile redesign** for Q3. Support data shows export is the top customer request, but the group agreed mobile keeps its priority slot. Export will likely slip ~2 weeks, pending an impact review on signed enterprise deals.",
  sections: [
    {
      heading: "Scope clarifications",
      bullets: [
        { text: "Support data shows **export** is the top customer request this quarter." },
        { text: "**Mobile redesign** retains its Q3 priority slot per prior commitment." },
      ],
    },
    {
      heading: "Key decisions",
      bullets: [
        { text: "Mobile redesign retains its Q3 priority slot." },
        { text: "Export ships after mobile, contingent on enterprise impact review." },
      ],
    },
    {
      heading: "Open questions",
      bullets: [
        { text: "Impact of a **2-week export delay** on signed enterprise deals needs review." },
      ],
    },
  ],
  decisions: [
    "Mobile redesign retains its Q3 priority slot.",
    "Export ships after mobile, contingent on enterprise impact review.",
  ],
  actions: [
    { text: "Scope the 2-week export delay impact", owner: "DP", due: "Jun 27", soon: true, sourceSegmentIndex: 12 },
    { text: "Pull top support requests for Q3", owner: "SL", due: "Jul 1", soon: false, sourceSegmentIndex: 8 },
    { text: "Confirm enterprise commitments with sales", owner: "MC", due: "Jul 3", soon: false, sourceSegmentIndex: 15 },
  ],
  chapters: [
    { label: "Intros & agenda", time: "00:00" },
    { label: "Q3 status check", time: "06:12" },
    { label: "Roadmap tradeoffs", time: "21:40" },
    { label: "Wrap-up & owners", time: "28:55" },
  ],
  suggestions: ["Summarize for Slack", "Draft follow-up email"],
  highlight: {
    quote: "Export is the number-one request this quarter.",
    by: "Sarah Liu · 24:15",
  },
};

export const recaps: Record<string, RecapData> = {
  "q3-roadmap": recap,
  "design-crit": {
    title: "Design Critique — Onboarding",
    meta: "Jun 23, 2026 · 47 min · 2 people",
    summary:
      "The team reviewed **v3 of the signup flow** and agreed to **cut the welcome modal**. Progressive profiling will ship instead, with copy updates tracked as follow-ups.",
    decisions: [
      "Remove the welcome modal from onboarding.",
      "Ship progressive profiling for signup.",
    ],
    actions: [
      { text: "Remove the welcome modal from onboarding", owner: "MC", due: "Jun 27", soon: true },
      { text: "Ship progressive profiling for signup", owner: "RK", due: "Jun 28", soon: true },
      { text: "Rewrite onboarding copy for clarity", owner: "RK", due: "Jul 2", soon: false },
    ],
    chapters: [
      { label: "Walkthrough v3", time: "00:00" },
      { label: "Modal debate", time: "12:40" },
      { label: "Progressive profiling", time: "28:10" },
      { label: "Copy & owners", time: "41:05" },
    ],
    suggestions: ["Summarize for Slack", "Draft follow-up email"],
    highlight: {
      quote: "Cut the welcome modal; ship progressive profiling instead.",
      by: "Maya Chen · 28:22",
    },
  },
  northwind: {
    title: "Customer Call — Northwind",
    meta: "Jun 22, 2026 · 28 min · 1 person",
    summary:
      "Northwind's **renewal looks healthy**, but they need **SSO and an audit log** before expanding seats next quarter. Sales will confirm timelines before the renewal call.",
    decisions: ["Renewal on track pending SSO + audit-log delivery dates."],
    actions: [
      { text: "Send SSO + audit-log timeline to Northwind", owner: "DP", due: "Jul 1", soon: false },
    ],
    chapters: [
      { label: "Renewal status", time: "00:00" },
      { label: "SSO requirements", time: "08:15" },
      { label: "Audit log ask", time: "11:32" },
      { label: "Next steps", time: "22:00" },
    ],
    suggestions: ["Summarize for Slack", "Draft follow-up email"],
    highlight: {
      quote: "They want SSO and an audit log before expanding seats next quarter.",
      by: "Devin Park · 11:32",
    },
  },
  "eng-standup": {
    title: "Weekly Eng Standup",
    meta: "Jun 22, 2026 · 15 min · 7 people",
    summary:
      "**Search indexing is unblocked** and two PRs are in review. The **deploy freeze lifts Thursday**; CSV export UI is the remaining gate.",
    decisions: ["Deploy freeze lifts Thursday."],
    actions: [],
    chapters: [
      { label: "Blockers", time: "00:00" },
      { label: "Search indexing", time: "03:10" },
      { label: "Export status", time: "04:50" },
      { label: "Deploy plan", time: "11:00" },
    ],
    suggestions: ["Summarize for Slack"],
    highlight: {
      quote: "Search indexing is unblocked.",
      by: "Jordan Ortiz · 03:10",
    },
  },
};

// ----- Library -----
export interface MeetingSummary {
  id: string;
  title: string;
  actions: number;
  blurb: string;
  tags: string[];
  when: string;
  avatars: { key: keyof typeof people; over?: string }[];
}

export const meetings: MeetingSummary[] = [
  {
    id: "q3-roadmap",
    title: "Q3 Roadmap Sync",
    actions: 3,
    blurb: "Team agreed mobile keeps Q3 priority; export slips ~2 weeks pending enterprise impact review.",
    tags: ["roadmap", "export"],
    when: "Today · 31 min",
    avatars: [{ key: "MC" }, { key: "DP" }, { key: "SL" }],
  },
  {
    id: "design-crit",
    title: "Design Critique — Onboarding",
    actions: 5,
    blurb: "Reviewed v3 of the signup flow. Cut the welcome modal; ship progressive profiling instead.",
    tags: ["design", "onboarding"],
    when: "Yesterday · 47 min",
    avatars: [{ key: "RK" }, { key: "MC" }],
  },
  {
    id: "northwind",
    title: "Customer Call — Northwind",
    actions: 1,
    blurb: "Renewal looks healthy. They want SSO and an audit log before expanding seats next quarter.",
    tags: ["sales", "renewal"],
    when: "Mon · 28 min",
    avatars: [{ key: "DP" }],
  },
  {
    id: "eng-standup",
    title: "Weekly Eng Standup",
    actions: 0,
    blurb: "Search indexing is unblocked. Two PRs in review; deploy freeze lifts Thursday.",
    tags: ["eng", "standup"],
    when: "Mon · 15 min",
    avatars: [{ key: "MC", over: "+6" }],
  },
];

export function getRecapForMeeting(id: string): RecapData {
  return recaps[id] ?? recap;
}

export function getMeetingById(id: string): MeetingSummary | undefined {
  return meetings.find((m) => m.id === id);
}

// ----- Search -----
export interface SearchResult {
  meeting: string;
  when: string;
  jump: string;
  speaker: keyof typeof people;
  // text split into segments; `mark: true` highlights the term
  segments: { t: string; mark?: boolean }[];
  contextBefore?: string;
  contextAfter?: string;
}

export const searchQuery = "export delay";

export const searchResults: SearchResult[] = [
  {
    meeting: "Q3 Roadmap Sync",
    when: "Today",
    jump: "24:09",
    speaker: "DP",
    segments: [
      { t: '"Export can ' },
      { t: "slip two weeks", mark: true },
      { t: ' without hurting the enterprise deals on the table."' },
    ],
  },
  {
    meeting: "Q3 Roadmap Sync",
    when: "Today",
    jump: "24:15",
    speaker: "SL",
    segments: [
      { t: '"Export is the number-one request this quarter, so I\'d push back on letting it ' },
      { t: "slip", mark: true },
      { t: '."' },
    ],
  },
  {
    meeting: "Customer Call — Northwind",
    when: "Mon",
    jump: "11:32",
    speaker: "DP",
    segments: [
      { t: '"If the ' },
      { t: "export delay", mark: true },
      { t: ' hits us, we\'d need a heads-up before the renewal call."' },
    ],
  },
  {
    meeting: "Weekly Eng Standup",
    when: "Mon",
    jump: "04:50",
    speaker: "JO",
    segments: [
      { t: '"The CSV ' },
      { t: "export", mark: true },
      { t: " endpoint is done — only the UI is gating the " },
      { t: "delay", mark: true },
      { t: '."' },
    ],
  },
];

export const searchMeta = "12 results across 4 meetings";

// ----- Action items (aggregated across meetings) -----
export interface ActionItem {
  id: string;
  text: string;
  owner: keyof typeof people;
  due: string;
  soon?: boolean;
  meeting: string;
  done?: boolean;
}

export const actionItems: ActionItem[] = [
  { id: "a1", text: "Scope the 2-week export delay impact", owner: "DP", due: "Jun 27", soon: true, meeting: "Q3 Roadmap Sync" },
  { id: "a2", text: "Remove the welcome modal from onboarding", owner: "MC", due: "Jun 27", soon: true, meeting: "Design Critique — Onboarding", done: true },
  { id: "a3", text: "Ship progressive profiling for signup", owner: "RK", due: "Jun 28", soon: true, meeting: "Design Critique — Onboarding" },
  { id: "a4", text: "Pull top support requests for Q3", owner: "SL", due: "Jul 1", meeting: "Q3 Roadmap Sync" },
  { id: "a5", text: "Send SSO + audit-log timeline to Northwind", owner: "DP", due: "Jul 1", meeting: "Customer Call — Northwind" },
  { id: "a6", text: "Rewrite onboarding copy for clarity", owner: "RK", due: "Jul 2", meeting: "Design Critique — Onboarding" },
  { id: "a7", text: "Confirm enterprise commitments with sales", owner: "MC", due: "Jul 3", meeting: "Q3 Roadmap Sync" },
];
