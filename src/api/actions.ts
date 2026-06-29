import { invoke, isTauri } from "@tauri-apps/api/core";
import { actionItems } from "../data/mock";

export interface CompletedAction {
  id: string;
  text: string;
  owner: string;
  due: string;
  meeting: string;
  meetingId?: string;
  soon?: boolean;
  completedAt: string;
}

const COMPLETED_KEY = "candor.completedActions";

export function recapActionId(meetingId: string, index: number): string {
  return `${meetingId}::action::${index}`;
}

/** Prefer a shared mock id when recap text matches a known action item. */
export function resolveActionId(
  meetingId: string,
  index: number,
  text: string,
  meetingTitle: string,
): string {
  const match = actionItems.find((a) => a.text === text && a.meeting === meetingTitle);
  return match?.id ?? recapActionId(meetingId, index);
}

export async function loadCompletedActions(): Promise<CompletedAction[]> {
  if (isTauri()) {
    return invoke<CompletedAction[]>("get_completed_actions");
  }
  try {
    const raw = localStorage.getItem(COMPLETED_KEY);
    return raw ? JSON.parse(raw) : [];
  } catch {
    return [];
  }
}

export async function persistCompletedActions(actions: CompletedAction[]): Promise<void> {
  if (isTauri()) {
    await invoke("save_completed_actions", { actions });
    return;
  }
  localStorage.setItem(COMPLETED_KEY, JSON.stringify(actions));
}

export interface UserTask {
  id: string;
  text: string;
  owner: string;
  due: string;
  meeting: string;
  soon?: boolean;
  createdAt: string;
}

const USER_TASKS_KEY = "candor.userTasks";

export function formatDueLabel(isoDate: string): string {
  const d = new Date(`${isoDate}T12:00:00`);
  return d.toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

export function dueSoonFromIso(isoDate: string): boolean {
  const due = new Date(`${isoDate}T23:59:59`);
  const now = new Date();
  const diff = due.getTime() - now.getTime();
  return diff >= 0 && diff <= 2 * 24 * 60 * 60 * 1000;
}

export function newUserTask(params: {
  text: string;
  owner: string;
  dueDate?: string;
  meeting?: string;
}): UserTask {
  const due = params.dueDate ? formatDueLabel(params.dueDate) : "No date";
  const soon = params.dueDate ? dueSoonFromIso(params.dueDate) : false;
  return {
    id: `user::${crypto.randomUUID()}`,
    text: params.text.trim(),
    owner: params.owner,
    due,
    meeting: params.meeting?.trim() || "Manual",
    soon: soon || undefined,
    createdAt: new Date().toISOString(),
  };
}

export async function loadUserTasks(): Promise<UserTask[]> {
  if (isTauri()) {
    return invoke<UserTask[]>("get_user_tasks");
  }
  try {
    const raw = localStorage.getItem(USER_TASKS_KEY);
    return raw ? JSON.parse(raw) : [];
  } catch {
    return [];
  }
}

export async function persistUserTasks(tasks: UserTask[]): Promise<void> {
  if (isTauri()) {
    await invoke("save_user_tasks", { tasks });
    return;
  }
  localStorage.setItem(USER_TASKS_KEY, JSON.stringify(tasks));
}
