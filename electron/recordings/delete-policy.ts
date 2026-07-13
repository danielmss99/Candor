import type { MessageBoxOptions } from "electron";

export function deleteRecordingConfirmationOptions(): MessageBoxOptions {
  return {
    type: "warning",
    title: "Delete local meeting",
    message: "Delete this meeting permanently?",
    detail:
      "Candor will permanently remove the local audio, transcript, notes, and meeting metadata. This cannot be undone.",
    buttons: ["Cancel", "Delete permanently"],
    defaultId: 0,
    cancelId: 0,
    noLink: true,
  };
}
