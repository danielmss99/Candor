import { invoke, isTauri } from "@tauri-apps/api/core";
import type { TranscriptSegment } from "../App";

export interface VoicePerson {
  id: string;
  name: string;
  initials: string;
  color: string;
  voiceLabel: string;
}

export interface SavedMeeting {
  id: string;
  title: string;
  date: string;
  whenLabel: string;
  blurb: string;
  durationMinutes: number;
  path: string;
}

export interface MeetingDetail {
  id: string;
  title: string;
  date: string;
  durationSeconds: number;
  userNotes: string;
  transcript: TranscriptSegment[];
  audioPath?: string | null;
  folderId?: string | null;
  calendarEventId?: string | null;
  status?: string | null;
  transcriptionError?: string | null;
}

export interface StorageFolder {
  id: string;
  label: string;
  description: string;
  path: string;
}

export interface StopRecordingResult {
  segments: TranscriptSegment[];
  meetingId: string;
  status: string;
  transcriptionError?: string | null;
}

const PEOPLE_KEY = "candor-v2.people";

export const VOICE_COLORS = [
  "#E8744F",
  "#8B5CF6",
  "#D4A017",
  "#06B6D4",
  "#10B981",
  "#F472B6",
  "#6366F1",
  "#F59E0B",
];

function initialsFromName(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length >= 2) return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
  return name.trim().slice(0, 2).toUpperCase() || "?";
}

export function newPerson(name: string, voiceLabel: string, color: string): VoicePerson {
  return {
    id: crypto.randomUUID(),
    name: name.trim(),
    initials: initialsFromName(name),
    color,
    voiceLabel: voiceLabel.trim(),
  };
}

export async function loadPeople(): Promise<VoicePerson[]> {
  if (isTauri()) {
    return invoke<VoicePerson[]>("get_people");
  }
  try {
    const raw = localStorage.getItem(PEOPLE_KEY);
    return raw ? JSON.parse(raw) : [];
  } catch {
    return [];
  }
}

export async function persistPeople(people: VoicePerson[]): Promise<void> {
  if (isTauri()) {
    await invoke("save_people", { people });
    return;
  }
  localStorage.setItem(PEOPLE_KEY, JSON.stringify(people));
}

export async function loadSavedMeetings(): Promise<SavedMeeting[]> {
  if (!isTauri()) return [];
  const rows = await invoke<SavedMeeting[]>("list_meetings");
  return rows;
}

export async function loadMeetingDetail(id: string): Promise<MeetingDetail | null> {
  if (!isTauri()) return null;
  try {
    const m = await invoke<MeetingDetail>("read_meeting", { id });
    return m;
  } catch {
    return null;
  }
}

export async function loadStorageFolders(): Promise<StorageFolder[]> {
  if (!isTauri()) return [];
  return invoke<StorageFolder[]>("list_storage_folders");
}

export async function openStorageFolder(folderId: string): Promise<void> {
  if (!isTauri()) return;
  await invoke("open_storage_folder", { folderId });
}

export interface PrivacySettings {
  deleteAudioAfterTranscribe: boolean;
  retentionDays: number;
  captureSystemAudio: boolean;
  webhookUrl: string | null;
  mcpServerEnabled: boolean;
}

export async function loadPrivacySettings(): Promise<PrivacySettings> {
  if (!isTauri()) {
    return {
      deleteAudioAfterTranscribe: false,
      retentionDays: 0,
      captureSystemAudio: false,
      webhookUrl: null,
      mcpServerEnabled: false,
    };
  }
  return invoke<PrivacySettings>("get_privacy_settings");
}

export async function savePrivacySettings(settings: PrivacySettings): Promise<void> {
  if (!isTauri()) return;
  await invoke("set_privacy_settings", { settings });
}

export async function getMeetingAudioPath(meetingId: string): Promise<string | null> {
  if (!isTauri()) return null;
  return invoke<string | null>("get_meeting_audio_path", { id: meetingId });
}

export async function pickAndImportAudio(): Promise<StopRecordingResult | null> {
  if (!isTauri()) return null;
  const path = await invoke<string | null>("pick_audio_file");
  if (!path) return null;
  return invoke<StopRecordingResult>("import_audio_file", { path, title: null });
}

export async function retryTranscription(meetingId: string): Promise<StopRecordingResult> {
  return invoke<StopRecordingResult>("retry_transcription", { meetingId });
}

export async function stopRecordingWithNotes(
  userNotes: string | null,
  durationSeconds: number,
  options?: {
    titleOverride?: string;
    calendarEventId?: string;
    folderId?: string;
  },
): Promise<StopRecordingResult> {
  return invoke<StopRecordingResult>("stop_recording", {
    userNotes,
    durationSeconds,
    titleOverride: options?.titleOverride ?? null,
    calendarEventId: options?.calendarEventId ?? null,
    folderId: options?.folderId ?? null,
  });
}
