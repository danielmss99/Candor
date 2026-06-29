# Candor v2 Roadmap

Otter/Notion research recommendations — implementation status.

**Project:** `C:\Claude_Config\candor-v2`  
**Run:** `npm run tauri:dev` (from candor-v2 directory)  
**App ID:** `com.candor.v2` (v1 uses `com.candor.app`)

---

## Phase 1 — Quick wins

| Feature | Status | Notes |
|---------|--------|-------|
| Recap transcript tab | ✅ Done | Summary / Transcript tabs on Recap |
| Takeaways rail (Ask · Chapters · Moments · Tasks) | ✅ Done | Right rail tab switcher |
| Live quick-highlight | ✅ Done | ⭐ on live segments |
| Bookmark timestamps | ✅ Done | 🔖 button + ⌘⇧B during recording |
| Live decision/action/question chips | ✅ Done | Appends structured lines to notes |
| Library smart filters | ✅ Done | All, This week, Has tasks, Long, Favorites |
| Favorites / pinned meetings | ✅ Done | Star on rows + Pinned section |
| Library view switcher (list + table) | ✅ Done | |
| Task source-meeting deep links | ✅ Done | Links to recap with timestamp |
| Due date sort | ✅ Done | Toggle on Tasks screen |
| My tasks filter | ✅ Done | All tasks / My tasks |
| Accept/dismiss extracted tasks | ✅ Done | Pending suggestions card on Tasks |
| Rich empty states | ✅ Done | Home, Library |
| Skeleton loading | ✅ Done | Home, Library, People |
| Calmer typography | ✅ Done | `section-label--calm` replaces ALL CAPS |
| Keyboard shortcuts overlay (`?`) | ✅ Done | |
| Onboarding checklist on Home | ✅ Done | 4-step getting started |
| Recap table of contents | ✅ Done | Sticky mini-nav on summary |

---

## Phase 2 — Core depth

| Feature | Status | Notes |
|---------|--------|-------|
| Synced audio playback + transcript highlight | 🟡 Partial | UI + click-to-seek on segments; no persisted audio file yet |
| Speaker labels (manual) | ✅ Done | Editable per segment on Transcript tab |
| Editable recap blocks | ✅ Done | Click summary/decisions to edit |
| Search snippets with context | ✅ Done | ±context around matches |
| Recent searches | ✅ Done | Last 5 under search bar |
| Cmd+K command palette | ✅ Done | Local scope: nav, meetings, record |

---

## Phase 3 — Differentiation

| Feature | Status | Notes |
|---------|--------|-------|
| Folders / collections | 🟡 Partial | Filter chips + metadata storage; assign via context menu TODO |
| Cross-meeting AI Ask | ✅ Done | Keyword search across saved meetings on Search screen |
| People ↔ meetings graph | 🟡 Partial | Name-based meeting links on People screen |
| Keyword cloud on recap | ✅ Done | Top terms, click to Ask |
| Audio waveform scrubber | ✅ Done | Live + recap player UI (playback stub without saved WAV) |

---

## Not in scope (future)

- Recording indicator + share link (needs local server/sync)
- Auto speaker diarization
- Full Notion-style block editor
- Task ↔ transcript bidirectional sync beyond complete action
- Export presets packaging (export exists; preset UI not added)

---

## App identifier differences (v1 vs v2)

| | Candor v1 | Candor v2 |
|---|-----------|-----------|
| Package | `candor` | `candor-v2` |
| Tauri identifier | `com.candor.app` | `com.candor.v2` |
| Window title | Candor | Candor v2 |
| localStorage prefix | `candor.*` | `candor-v2.*` |
| App data dir | Separate (per identifier) | Separate |

Both apps can run side by side without sharing user prefs; meetings storage is also separate per app data directory.

---

*Last updated: June 29, 2026*
