# Design

## Register

product — earned familiarity, restrained accent, one type family, fixed rem scale, 150–250ms motion.

## Brand: "Local Recorder"

Dark-first, blue-accent product UI whose identity is local custody: the interface
constantly proves "your data stays on this machine." Blue is the brand; red is
reserved for recording; green is reserved for custody proof.

## Tokens (`src/styles/tokens.css`)

Dark is the brand's home; light mirrors it with the same hues darkened to ≥4.5:1.
Every legacy var name is kept and aliased (`--coral: var(--accent)` etc.) so the
whole stylesheet re-skins from one file.

| Role | Dark | Light |
| --- | --- | --- |
| `--bg` | `#101214` | `#f6f7f9` |
| `--bg-sidebar` | `#0d0f11` | `#ffffff` |
| `--bg-muted` (surface) | `#16181c` | `#eff1f4` |
| `--card-alt-bg` (surface-2) | `#1c1f24` | `#eff1f4` |
| `--border` / `--border-inner` | `#262a30` / `#1f2328` | `#e2e5ea` / `#eceef2` |
| `--text-primary` | `#eceef1` | `#16181c` |
| `--text-body` | `#b4bac2` | `#3f4650` |
| `--text-muted` | `#7a828c` | `#6b7280` |
| `--accent` (brand blue) | `#4d7cfe` | `#3d63e8` |
| `--accent-2` (violet) | `#7c5bf5` | `#7c5bf5` |
| `--red-live` (recording ONLY) | `#e5484d` | `#d93a3f` |
| `--custody-green` | `#3dbe7b` | `#1f9d63` |
| `--gold` (warn/risk) | `#e2a33c` | `#b97f2e` |
| `--purple` (quotes) | `#8b6fd6` | `#7458c9` |

**Color roles (non-negotiable):**

- **Blue `--accent`** — brand, selection, links, focus, primary buttons.
- **Red `--red-live`** — recording, REC badges, timers, stop buttons, play transport. Nothing else.
- **Green `--custody-green`** — local-custody proof (Secured badge, connected state).
- **Moments:** decision = accent · risk = gold · quote = purple · action = green.
  Highlight fills are the hue at 14–16% alpha (`--hl-*`); text stays `--text-primary`.
- **Speakers:** rotating 6 — accent, gold, green, rec, violet, cyan `#45b8cc`
  (`--speaker-1…6`, mirrored in `VOICE_COLORS` in `src/api/local.ts`).

## Typography

- **Inter** (`@fontsource/inter` 400/500/600/700, bundled locally — no CDN) is `--font-sans`.
- **JetBrains Mono** stays for timestamps, timers, rulers, and micro-labels (`--font-mono`).
- Fixed scale: 12 / 13 / 14 / 16 / 18 / 20 px equivalents; headings step up from there.
- Space Grotesk remains installed but unreferenced (safe to remove later).

## Brand mark

`src/components/BrandMark.tsx`: rounded-square SVG, 135° blue→violet gradient,
white 3-bar waveform glyph. Used in Sidebar, NamePrompt, and Landing header.
ScalesLogo components remain in the tree but are unused by the shell.

## Component vocabulary

- **TopStrip** — slim custody statement on all sidebar screens ("Local recorder · no cloud sync…").
- **Sidebar** — brand row, exactly 4 nav items (Record / Library / Tasks / Ask, inline SVG icons),
  folder tree under Library, LOCAL ONLY card, user row. Active item = `--card-alt-bg` pill,
  accent icon (Record's icon stays red).
- **Recorder** (idle flagship) — red CTA ring, Up next (calendar), Recent, right rail.
- **CustodyRail** — the proof panel. Every card is a true, checkable statement:
  real Whisper model from settings, real file count/size from `get_storage_usage`,
  "No upload", link to the actual privacy policy. **Never** add claims the code
  can't back (no encryption claims while the index is plaintext; no "0 network calls").
- **TasksRail** — count, top-4 pending tasks, colored circle checkboxes, "View all tasks →".
- **LiveWaveStrip** — live bars from `audio-level` events, red tail, time ruler,
  typed moment markers (dots + chips).
- **Player bar** (`AudioPlayer` + Recap actions) — ⟲15 / red play / ⟳15, speed cycle,
  mono time, waveform scrubber, key-hint actions: Highlight (H), Create task (T),
  Bookmark (B), Export.
- **Transcript rows** — mono timestamp, speaker rule color (rotating palette),
  translucent highlight fills from `MeetingMoments.highlights`.

## Motion

`--duration-fast` 120ms · `--duration-base` 200ms · `--duration-slow` 320ms,
`--ease-out` / `--ease-in-out`. Respect `prefers-reduced-motion` (global override exists).

## Honesty rules

The custody UI is evidence, not marketing. If a stat can't be read from the
system (model name, file count, bytes on disk), don't show it. No fake window
chrome (no macOS traffic lights), no decorative fake status bars, no encryption
claims, no "0 network calls" while the updater/calendar can touch the network.

## Follow-ups

- **App icon regen** — `src-tauri/icons/*` still carry the old mark; regenerating
  needs a raster pipeline (SVG → PNG sizes → .ico/.icns). In-app marks are switched.
- **Landing art** — PRODUCT.md lists legal scales as an anti-reference; the landing's
  ScalesOfJustice piece was recolored to brand blue steel as an interim step.
  Long-term: replace with a waveform-object hero per "signature visual object".
