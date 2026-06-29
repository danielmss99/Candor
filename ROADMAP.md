# Candor Roadmap

Desktop meeting recorder — private, on-device Whisper transcription.

**Run:** `npm run tauri:dev` from this directory  
**App ID:** `com.candor.app` (v2 is now main)  
**Repo:** https://github.com/danielmss99/Candor

---

## Phase A — Close review loop ✅

| Feature | Status | Notes |
|---------|--------|-------|
| System/loopback audio capture | ✅ Done | Windows WASAPI loopback via cpal; enable in Settings → Privacy |
| Persisted WAV + synced playback | ✅ Done | Saved to app data/audio; recap player uses convertFileSrc |
| Auto speaker diarization | ✅ Done | Heuristic pause-based Speaker 1/2 (best effort) |
| Export presets | ✅ Done | Slack, email, HTML/PDF, markdown on Recap |

---

## Phase B — AI + privacy ✅

| Feature | Status | Notes |
|---------|--------|-------|
| Improved Ask with citations | ✅ Done | `src/v2/askMeeting.ts` — heuristic + timestamp links |
| Local LLM hook scaffold | 🟡 Partial | `localStorage` path flag; wire llama.cpp later |
| Summary templates | ✅ Done | Standup, 1:1, sales, retro, client call in Settings |
| Scratchpad → recap | ✅ Done | Live notes merged in `recapGenerate.ts` |
| Regenerate summary | ✅ Done | Button on Recap after edits |
| Privacy settings | ✅ Done | Retention, delete audio, system audio, webhook |

---

## Phase C — Differentiation ✅ / scaffold

| Feature | Status | Notes |
|---------|--------|-------|
| File import (MP3/WAV/M4A) | ✅ Done | Import audio on Library; symphonia decode |
| Highlight audio clips | ✅ Done | Export 30s WAV clip from Moments (when audio exists) |
| Folder assignment UI | ✅ Done | Context menu → assign folder |
| Calendar notification | ✅ Done | Toast when meeting starts in 2 min |
| Start from calendar event | ✅ Done | Pre-fills title, attendees, event id |
| Webhook on meeting saved | ✅ Done | Optional URL in Settings |
| Local MCP server | 🟡 Scaffold | `docs/mcp-server.md` — not a running server yet |
| Noise preprocessing | 🟡 Partial | Light high-pass in Rust; RNNoise TODO |

---

## Polish ✅

| Feature | Status |
|---------|--------|
| Recording consent reminder (system audio) | ✅ Done |
| Catch-up digest on Home (7-day) | ✅ Done |
| ROADMAP.md | ✅ This file |

---

## Known blockers / honest stubs

1. **RNNoise** — No stable Rust binding wired; light DSP only. Full Krisp-style NC deferred.
2. **Local MCP server** — Documentation + settings flag only; implement stdio server when needed.
3. **Retention auto-delete** — Setting stored; scheduled cleanup not implemented yet.
4. **macOS loopback** — System audio capture returns None on non-Windows; mic-only on Mac until Core Audio loopback added.

---

## v1 archive

Candor v1 remains on the `v1` branch for reference. v1 used the same `com.candor.app` identifier but older UI; data dirs may differ if you changed identifiers between installs.

---

*Last updated: June 29, 2026*
