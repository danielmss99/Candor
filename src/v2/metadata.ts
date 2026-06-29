/** Candor v2 — client-side metadata (localStorage; separate keys from v1). */

const PREFIX = "candor-v2.";

function get<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(PREFIX + key);
    return raw ? (JSON.parse(raw) as T) : fallback;
  } catch {
    return fallback;
  }
}

function set<T>(key: string, value: T): void {
  localStorage.setItem(PREFIX + key, JSON.stringify(value));
}

// --- Favorites / pinned ---
export function loadFavorites(): Set<string> {
  return new Set(get<string[]>("favorites", []));
}

export function toggleFavorite(meetingId: string): Set<string> {
  const favs = loadFavorites();
  if (favs.has(meetingId)) favs.delete(meetingId);
  else favs.add(meetingId);
  set("favorites", [...favs]);
  return favs;
}

export function isFavorite(meetingId: string): boolean {
  return loadFavorites().has(meetingId);
}

// --- Folders / collections ---
export interface MeetingFolder {
  id: string;
  name: string;
  color: string;
}

export function loadFolders(): MeetingFolder[] {
  return get<MeetingFolder[]>("folders", [
    { id: "client", name: "Client calls", color: "#E8744F" },
    { id: "1on1", name: "1:1s", color: "#8B5CF6" },
    { id: "interviews", name: "Interviews", color: "#D4A017" },
  ]);
}

export function saveFolders(folders: MeetingFolder[]): void {
  set("folders", folders);
}

export function loadMeetingFolders(): Record<string, string> {
  return get<Record<string, string>>("meetingFolders", {});
}

export function setMeetingFolder(meetingId: string, folderId: string | null): void {
  const map = loadMeetingFolders();
  if (folderId) map[meetingId] = folderId;
  else delete map[meetingId];
  set("meetingFolders", map);
}

// --- Live bookmarks & highlights (per meeting) ---
export interface LiveBookmark {
  time: string;
  note?: string;
}

export interface LiveHighlight {
  time: string;
  text: string;
}

export interface MeetingMoments {
  bookmarks: LiveBookmark[];
  highlights: LiveHighlight[];
}

export function loadMoments(meetingId: string): MeetingMoments {
  return get<MeetingMoments>(`moments.${meetingId}`, { bookmarks: [], highlights: [] });
}

export function saveMoments(meetingId: string, moments: MeetingMoments): void {
  set(`moments.${meetingId}`, moments);
}

// --- Speaker labels (per meeting, segment index -> label) ---
export function loadSpeakerLabels(meetingId: string): Record<number, string> {
  return get<Record<number, string>>(`speakers.${meetingId}`, {});
}

export function saveSpeakerLabel(meetingId: string, index: number, label: string): void {
  const labels = loadSpeakerLabels(meetingId);
  if (label.trim()) labels[index] = label.trim();
  else delete labels[index];
  set(`speakers.${meetingId}`, labels);
}

// --- Recent searches ---
export function loadRecentSearches(): string[] {
  return get<string[]>("recentSearches", []);
}

export function pushRecentSearch(query: string): string[] {
  const q = query.trim();
  if (!q) return loadRecentSearches();
  const next = [q, ...loadRecentSearches().filter((s) => s !== q)].slice(0, 5);
  set("recentSearches", next);
  return next;
}

// --- Onboarding checklist ---
export interface OnboardingState {
  calendarConnected: boolean;
  firstRecording: boolean;
  recapReviewed: boolean;
  taskCompleted: boolean;
}

export function loadOnboarding(): OnboardingState {
  return get<OnboardingState>("onboarding", {
    calendarConnected: false,
    firstRecording: false,
    recapReviewed: false,
    taskCompleted: false,
  });
}

export function patchOnboarding(patch: Partial<OnboardingState>): OnboardingState {
  const next = { ...loadOnboarding(), ...patch };
  set("onboarding", next);
  return next;
}

// --- Pending extracted tasks (accept/dismiss before Tasks list) ---
export interface PendingTask {
  id: string;
  meetingId: string;
  meetingTitle: string;
  text: string;
  owner: string;
  due: string;
  soon: boolean;
  timestamp?: string;
}

export function loadPendingTasks(): PendingTask[] {
  return get<PendingTask[]>("pendingTasks", []);
}

export function savePendingTasks(tasks: PendingTask[]): void {
  set("pendingTasks", tasks);
}

export function addPendingTasks(tasks: PendingTask[]): void {
  const existing = loadPendingTasks();
  const ids = new Set(existing.map((t) => t.id));
  const merged = [...existing, ...tasks.filter((t) => !ids.has(t.id))];
  savePendingTasks(merged);
}

export function dismissPendingTask(id: string): void {
  savePendingTasks(loadPendingTasks().filter((t) => t.id !== id));
}

// --- Editable recap overrides ---
export interface RecapEdits {
  summary?: string;
  decisions?: string[];
  outline?: string[];
}

export function loadRecapEdits(meetingId: string): RecapEdits {
  return get<RecapEdits>(`recapEdits.${meetingId}`, {});
}

export function saveRecapEdits(meetingId: string, edits: RecapEdits): void {
  set(`recapEdits.${meetingId}`, edits);
}

// --- Cross-meeting ask history ---
export interface AskThread {
  id: string;
  question: string;
  answer: string;
  at: string;
}

export function loadCrossAskHistory(): AskThread[] {
  return get<AskThread[]>("crossAsk", []);
}

export function pushCrossAsk(question: string, answer: string): AskThread[] {
  const thread: AskThread = {
    id: crypto.randomUUID(),
    question,
    answer,
    at: new Date().toISOString(),
  };
  const next = [thread, ...loadCrossAskHistory()].slice(0, 20);
  set("crossAsk", next);
  return next;
}
