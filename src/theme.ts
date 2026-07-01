/** Client-side theme overrides — layered on top of light/dark base tokens. */

export const THEME_KEY = "candor.theme";
export const THEME_OVERRIDES_KEY = "candor.themeOverrides";

export type ThemeMode = "light" | "dark";

export interface ThemeVarDef {
  key: string;
  label: string;
  group: "Surfaces" | "Text" | "Accent";
}

/** CSS custom properties users may override (base values live in tokens.css). */
export const THEME_VARS: ThemeVarDef[] = [
  { key: "--bg", label: "Background", group: "Surfaces" },
  { key: "--bg-sidebar", label: "Sidebar", group: "Surfaces" },
  { key: "--border", label: "Borders", group: "Surfaces" },
  { key: "--card-alt-bg", label: "Card surface", group: "Surfaces" },
  { key: "--text-primary", label: "Primary text", group: "Text" },
  { key: "--text-body", label: "Body text", group: "Text" },
  { key: "--text-muted", label: "Muted text", group: "Text" },
  { key: "--coral", label: "Accent (coral)", group: "Accent" },
  { key: "--coral-dark", label: "Accent dark", group: "Accent" },
  { key: "--chip-bg", label: "Chip background", group: "Accent" },
  { key: "--action-bg", label: "Action surface", group: "Accent" },
];

export type ThemeOverrides = Record<string, string>;

export function loadThemeMode(): ThemeMode {
  const raw = localStorage.getItem(THEME_KEY);
  return raw === "dark" ? "dark" : "light";
}

export function saveThemeMode(mode: ThemeMode): void {
  localStorage.setItem(THEME_KEY, mode);
}

export function loadThemeOverrides(): ThemeOverrides {
  try {
    const raw = localStorage.getItem(THEME_OVERRIDES_KEY);
    return raw ? (JSON.parse(raw) as ThemeOverrides) : {};
  } catch {
    return {};
  }
}

export function saveThemeOverrides(overrides: ThemeOverrides): void {
  const cleaned = Object.fromEntries(
    Object.entries(overrides).filter(([, v]) => v.trim().length > 0),
  );
  if (Object.keys(cleaned).length === 0) {
    localStorage.removeItem(THEME_OVERRIDES_KEY);
  } else {
    localStorage.setItem(THEME_OVERRIDES_KEY, JSON.stringify(cleaned));
  }
}

export function applyTheme(mode: ThemeMode, overrides?: ThemeOverrides): void {
  const root = document.documentElement;
  root.setAttribute("data-theme", mode);

  for (const { key } of THEME_VARS) {
    root.style.removeProperty(key);
  }

  const o = overrides ?? loadThemeOverrides();
  for (const [key, value] of Object.entries(o)) {
    if (value.trim()) root.style.setProperty(key, value.trim());
  }
}

export const THEME_VAR_DEFAULTS: Record<ThemeMode, Record<string, string>> = {
  light: {
    "--bg": "#fbf4ef",
    "--bg-sidebar": "#fffaf6",
    "--border": "#efe1d8",
    "--card-alt-bg": "#fbf2ec",
    "--text-primary": "#2b1f33",
    "--text-body": "#574a63",
    "--text-muted": "#a99cb5",
    "--coral": "#f0714e",
    "--coral-dark": "#d23b1e",
    "--chip-bg": "#fbe7de",
    "--action-bg": "#fdeee9",
  },
  dark: {
    "--bg": "#17131a",
    "--bg-sidebar": "#1f1822",
    "--border": "#342b34",
    "--card-alt-bg": "#241c24",
    "--text-primary": "#f3ecef",
    "--text-body": "#c8bcc6",
    "--text-muted": "#8f8294",
    "--coral": "#f0714e",
    "--coral-dark": "#d23b1e",
    "--chip-bg": "#3a2a30",
    "--action-bg": "#3a2620",
  },
};

export function defaultVarColor(mode: ThemeMode, key: string): string {
  return THEME_VAR_DEFAULTS[mode][key] ?? "#888888";
}

export function clearThemeOverrides(): ThemeOverrides {
  saveThemeOverrides({});
  applyTheme(loadThemeMode(), {});
  return {};
}
