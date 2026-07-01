import { createContext, useContext } from "react";

export interface UserInfo {
  name: string;
  firstName: string;
  initials: string;
  /** Base64 data URL or remote URL for profile image. */
  avatarUrl?: string | null;
  /** Account-menu actions + state (set by App). */
  onEditName?: () => void;
  onConnectCalendar?: () => void;
  calendar?: { microsoft: boolean; google: boolean; apple: boolean };
  onDisconnect?: (provider: "microsoft" | "google" | "apple") => void;
  onOpenSettings?: () => void;
  onSignOut?: () => void;
}

export const UserContext = createContext<UserInfo>({
  name: "Candor",
  firstName: "there",
  initials: "C",
  avatarUrl: null,
});

export const useUser = () => useContext(UserContext);

/** Derive a display first name + avatar initials from a full name. */
export function deriveUser(name: string): { name: string; firstName: string; initials: string } {
  const trimmed = name.trim();
  const parts = trimmed.split(/\s+/).filter(Boolean);
  const firstName = parts[0] || trimmed;
  const initials = (
    parts.length >= 2 ? parts[0][0] + parts[parts.length - 1][0] : trimmed.slice(0, 2)
  ).toUpperCase();
  return { name: trimmed, firstName, initials };
}

export const NAME_KEY = "candor.userName";
export const PROFILE_IMAGE_KEY = "candor.profileImage";

export function loadProfileImage(): string | null {
  try {
    return localStorage.getItem(PROFILE_IMAGE_KEY);
  } catch {
    return null;
  }
}

export function saveProfileImage(dataUrl: string | null): void {
  if (!dataUrl) {
    localStorage.removeItem(PROFILE_IMAGE_KEY);
    return;
  }
  localStorage.setItem(PROFILE_IMAGE_KEY, dataUrl);
}

/** Read a file as a compressed JPEG data URL (max ~200 KB target). */
export function readImageAsDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    const url = URL.createObjectURL(file);
    img.onload = () => {
      URL.revokeObjectURL(url);
      const max = 256;
      let { width, height } = img;
      if (width > max || height > max) {
        const scale = max / Math.max(width, height);
        width = Math.round(width * scale);
        height = Math.round(height * scale);
      }
      const canvas = document.createElement("canvas");
      canvas.width = width;
      canvas.height = height;
      const ctx = canvas.getContext("2d");
      if (!ctx) {
        reject(new Error("Canvas unavailable"));
        return;
      }
      ctx.drawImage(img, 0, 0, width, height);
      resolve(canvas.toDataURL("image/jpeg", 0.85));
    };
    img.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error("Could not load image"));
    };
    img.src = url;
  });
}
