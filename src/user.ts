import { createContext, useContext } from "react";

export interface UserInfo {
  name: string;
  firstName: string;
  initials: string;
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

export const NAME_KEY = "candor-v2.userName";
