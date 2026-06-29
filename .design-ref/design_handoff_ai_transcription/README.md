# Handoff: Candor — AI Meeting Transcription

## Overview
Candor is an AI-powered meeting transcription product. It captures live audio, diarizes speakers in real time, surfaces action items and decisions as they happen, and produces a searchable recap when the meeting ends. This handoff covers the full UI: six visual direction explorations, three key app screens (live, recap, library, search), mobile equivalents, and a landing page.

## About the Design Files
The files in this bundle are **HTML design prototypes** — high-fidelity references showing intended look, layout, color, and interactive behaviour. They are not production code. Your task is to **recreate these designs in your target codebase** (React, Next.js, or whichever framework is already in use) using its established component patterns, routing, and data layer. Do not ship the HTML directly.

Open `AI Transcribe Layouts.dc.html` in a browser (with `support.js` in the same folder) to browse all screens on an infinite canvas. Pan to navigate; each frame is labelled.

## Fidelity
**High-fidelity.** Colors, typography, spacing, border-radius, shadows, and micro-interactions are all final. Recreate pixel-precisely using your codebase's design system; use the token table below as the source of truth.

---

## Chosen Direction
The product team's primary direction is **C · Sunrise** (warm cream, coral + gold + purple accents, Space Grotesk). The Band 2 screens (Recap, Library, Search), all mobile screens, and the landing page are already built in this theme. Direction A (Minimal Light, now editorially warmed) and Direction B (Editorial Warm, Newsreader serif) are alternate explorations for reference.

---

## Screens / Views

### 1. Live Transcription — Desktop (Sunrise)
**Purpose:** Real-time display of the meeting as it happens. Speaker-diarized transcript on the left; live AI insights panel on the right.

**Layout:** Full-viewport. Fixed 64px header. Two-column body: `1fr` transcript + `340px` insights panel.

**Header (64px, `border-bottom: 1px solid #efe1d8`):**
- Logo square `22×22px`, `border-radius: 6px`, `background: #f0714e`
- Meeting title, `font-weight: 600`, `font-size: 14px`
- Animated waveform (20 bars, `2.5px` wide, coral fill) centered in flex-1
- Recording timer pill: `8×8px` red dot (`#f0506e`, pulse animation) + `JetBrains Mono 500 15px` timer in coral
- Participant avatar stack: `28px` circles, `−7px` overlap, `2px border` matching card bg

**Transcript panel (left):**
- `padding: 24px 26px`
- Each utterance: avatar (`28px` circle) + name (`font-weight: 600, 13px`) + timestamp (`JetBrains Mono 500 11px, #a99cb5`) + body text (`14.5px, line-height: 1.6, color: #574a63`)
- Active speaker: name badge with `● speaking` in `#f0714e`; text color shifts to `#2b1f33`; blinking cursor `2px × 16px, background: #f0714e` at insertion point

**Insights panel (right, `background: #fffaf6`, `border-left: 1px solid #efe1d8`):**
- Section labels: `JetBrains Mono 500 11px, letter-spacing: .1em, #8c7f9a`, uppercased
- Pulsing live dot (`6px`, `#f0714e`) beside `LIVE INSIGHTS`
- Action items: unchecked checkbox `15×15px` + body text + `@owner` in `JetBrains Mono #a99cb5`
- Decision card: `background: #fbf2ec, border: 1px solid #e6d6ca, border-radius: 8px`
- Topic chips: `background: #fbe7de, border-radius: 999px, font-size: 12px`

---

### 2. Live Transcription — Desktop (Minimal Light, editorial-warmed)
Same layout as Sunrise variant. Key differences:
- Card background: `#fdf6ef`; border: `#e8d5c2`
- Insights panel: `background: #f5e3cf`; border: `#e8d5c2`
- Font: `Public Sans` throughout
- Active speaker bubble: `background: #fdf2ee; border-radius: 8px; padding: 8px 12px`
- Decision card: `background: #fdf6ef; border: 1px solid #e8d5c2`
- Avatar stack border: `2px solid #fdf6ef`

---

### 3. Live Transcription — Desktop (Editorial Warm)
Same layout but with a editorial newspaper feel.
- Background: `#f9ece0`; border: `#ecdcc6`
- Font: `Newsreader` serif (display), `IBM Plex Mono` (timestamps/labels)
- Transcript laid out as `grid-template-columns: 1fr 168px` — right column is margin notes (action/topic labels)
- Speaker names: `Newsreader 600 15px`, accent-coloured per speaker
- Body text: `Newsreader 400 18px/1.62` in quoted form
- Footer summary strip: `background: #fff9f0`, `border-top: 1px solid #ecdcc6`

---

### 4. Meeting Recap — Desktop (Sunrise)
**Purpose:** Post-meeting summary view. AI narrative + decisions + action items on the left; AI chat + chapters + highlight quote on the right.

**Layout:** Fixed 66px header. Two-column: `1fr` main + `348px` sidebar.

**Header:** Meeting title + metadata (`JetBrains Mono 500 11px, #a99cb5`) + participant avatars + Share button (ghost) + Export notes button (`background: #f0714e`).

**Main column (`padding: 26px 30px`):**
- `⌁ AI SUMMARY` label (`JetBrains Mono 500 10px, #f0714e`) + "auto-generated" suffix
- Narrative paragraph: `16px/1.66, color: #574a63`; bold terms in `#2b1f33`
- `KEY DECISIONS` section: checkmark icon `18×18px` (`background: #fdeee9, border: 1px solid #f7d6cc, color: #f0714e`) + decision text
- `ACTION ITEMS` table: bordered list (`border: 1px solid #efe1d8, border-radius: 9px`). Each row: checkbox + task text + assignee avatar + due date pill

**Sidebar (`background: #fffaf6`, `padding: 22px 20px`):**
- `⌁ ASK THIS MEETING` card: `background: #fdeee9, border: 1px solid #f7d6cc, border-radius: 10px`. Contains a dark input field + send button + suggested prompts as ghost pills
- Chapters list: two-column (title + timestamp in coral)
- Highlight quote: `border-left: 2px solid #f0714e, padding-left: 13px, font-weight: 500`

---

### 5. Library — Desktop (Sunrise)
**Purpose:** Browse all past meetings.

**Layout:** `204px` sidebar + flex-1 main area.

**Sidebar:** Logo + nav items (7px square bullet + label, `font-size: 13.5px`). Active item: `background: #fbe7de, color: #2b1f33`. User profile at bottom.

**Main area:**
- Page title (`font-weight: 700, 21px`) + search input + `Start recording` CTA
- Filter chips: active = `background: #f0714e, color: #2a1006`; inactive = ghost border
- Meeting list: `border: 1px solid #efe1d8, border-radius: 11px`. Each row: meeting title + action-item count badge + AI summary blurb + topic tags + participant avatars + relative date + duration. `border-bottom: 1px solid #f1e6dd` between rows.

---

### 6. Search — Desktop (Sunrise)
**Purpose:** Full-text search across all transcripts.

**Layout:** Same `204px` sidebar + main area as Library. Search nav item is active.

**Main area:**
- Large search input: `background: #fbf2ec, border: 1px solid #e6d6ca, border-radius: 10px, padding: 13px 16px, font-size: 16px`; coral search icon
- Result count + filter pills (speaker, date, content type)
- Result cards: `border: 1px solid #efe1d8, border-radius: 10px`. Each shows: meeting name + date + `Jump to MM:SS →` link + speaker avatar + quote with `<mark>` highlight (`background: #f0714e, color: #2a1006, border-radius: 3px, padding: 0 3px`)

---

### 7. Live Transcription — Mobile
**Layout:** 392×812px, `border-radius: 42px` (phone shell). Status bar (9:41 + battery). Fixed bottom sheet for action detected + recording controls.

**Header:** Back chevron + meeting title + recording pill (dark bg `#1c1014`, red dot + timer)

**Transcript:** Same utterance pattern as desktop but compressed (`14px` body, `26px` avatars)

**Bottom sheet (`background: #fffaf6, border-top: 1px solid #efe1d8`):**
- Action detected card (`background: #fdeee9`)
- Recording controls row: pause (`46px` ghost circle) + stop (`58px` coral circle with white square icon) + AI (`46px` ghost circle)

---

### 8. Recap — Mobile
Same content as desktop recap but linearised vertically. Bottom bar has an AI chat input (`background: #0a0f0d, border: 1px solid #f7d6cc`) with send button.

---

### 9. Library — Mobile
Header: title + avatar. Search bar below. Meeting cards as `border-radius: 12px` tiles. Bottom tab bar: Meetings (active, coral bullet) / Search / Record FAB (`58×58px, background: #f0506e, margin-top: -26px`) / Tasks / You.

---

### 10. Landing Page — Sunrise
**Layout:** Two-column: `528px` left (image/3D panel) + flex-1 right copy panel.
- Background: `linear-gradient(160deg, #33245e 0%, #9c3f7e 32%, #f0714e 66%, #ffc36b 100%)`
- Logo + wordmark + `AI MEETING TRANSCRIPTION` meta label
- Hero headline: `font-weight: 700, 52px, letter-spacing: -0.025em`; accent word in `#ffd98a`
- CTA button: `linear-gradient(90deg, #f0714e, #ff9e5b)`, `border-radius: 999px`, `box-shadow: 0 12px 30px rgba(240,113,78,.5)`
- Three entry cards (Folders, Notes, Transcriptions): alternating white card (`box-shadow: 0 6px 20px rgba(60,25,40,.2)`) and frosted glass (`background: rgba(255,255,255,.18), border: 1.5px solid rgba(255,255,255,.55)`)

---

### 11. Recording Overlay (Modal)
**Trigger:** "Start recording" / "Wrap up" buttons on any screen.

**Phases:**
1. **Countdown (3→1):** Large numeral `118px bold`; overlay `background: rgba(26,12,20,.5); backdrop-filter: blur(7px)`. Modal card: `linear-gradient(158deg, #33245e, #9c3f7e, #f0714e)`, `border-radius: 24px`.
2. **Recording:** Animated EQ bars (13 bars, `4px` wide, white fill, `@keyframes eq` staggered); live elapsed timer in `JetBrains Mono 700 66px`; Stop button (white pill, coral text).

**State:** `phase: null | 'countdown' | 'recording'`, `count: 3→0`, `elapsed: 0→N` (seconds, increments every 1 s via `setInterval`).

---

## Interactions & Behaviour

| Interaction | Detail |
|---|---|
| Start recording | 850 ms countdown (3→2→1), then live timer starts |
| Stop recording | Clears intervals, closes overlay, returns to browsing |
| Speaking indicator | Blinking `2px` cursor at transcript end; `● speaking` badge on speaker name |
| Action detected card | Appears in real time in both desktop insights panel and mobile bottom sheet |
| Search highlight | `<mark>` wraps matched terms; coral fill, dark text |
| Library filter chips | Toggle active state (coral fill ↔ ghost border) |
| Avatar stacks | `−7px` margin-left overlap; border color matches card background |

### Animations
- `pulse`: `opacity + scale` oscillation, `1.2–1.6s ease-in-out infinite` — used on recording dots and live indicators
- `blink`: `opacity` 0/1 step at 1s — blinking text cursor
- `eq`: `scaleY(0.28 → 1)` on EQ bars, staggered `animation-delay` per bar, `0.9s infinite`

---

## State Management

```
// Recording overlay
phase: null | 'countdown' | 'recording'
count: number          // 3 → 1 during countdown
elapsed: number        // seconds since recording started

// Library
activeFilter: 'all' | 'this-week' | 'my-meetings' | 'has-actions'

// Search
query: string
results: TranscriptResult[]

// Transcript
activeSpeaker: string | null
utterances: Utterance[]   // { speaker, timestamp, text, isLive }
insights: {
  actions: Action[]        // { text, owner, done }
  decisions: string[]
  topics: string[]
}
```

---

## Design Tokens

### Colors
```
// Brand
--coral:         #f0714e   // primary CTA, accents, recording
--coral-dark:    #e0613a   // editorial warm variant
--gold:          #ffb24d   // secondary accent / avatar
--gold-dark:     #d97706
--purple-soft:   #8b6fd6   // tertiary accent / avatar
--red-live:      #f0506e   // recording indicator

// Sunrise theme (primary)
--bg:            #fbf4ef
--bg-sidebar:    #fffaf6
--border:        #efe1d8
--border-inner:  #f1e6dd
--text-primary:  #2b1f33
--text-body:     #574a63
--text-muted:    #a99cb5
--text-label:    #8c7f9a
--chip-bg:       #fbe7de
--action-bg:     #fdeee9
--action-border: #f7d6cc
--mark-bg:       #f0714e   // search highlight

// Minimal Light (editorial-warmed)
--bg-ml:         #fdf6ef
--bg-insights:   #f5e3cf
--border-ml:     #e8d5c2

// Editorial Warm
--bg-ew:         #f9ece0
--border-ew:     #ecdcc6
--text-ew:       #2a2318
--accent-ew:     #e0613a
```

### Typography
```
// Families
Public Sans      — weights 400 500 600 700  (Minimal Light theme)
Space Grotesk    — weights 400 500 600 700  (Sunrise theme, primary)
Newsreader       — weights 400 500 600 700, opsz 6–72  (Editorial Warm)
JetBrains Mono   — weights 400 500  (timestamps, labels, monospace everywhere)
IBM Plex Mono    — weights 400 500  (Editorial Warm labels)

// Scale (Sunrise)
--text-xs:    10px / JetBrains Mono / letter-spacing .08–.16em / labels
--text-sm:    11px / JetBrains Mono or Space Grotesk
--text-base:  13–14px / Space Grotesk 400 / body
--text-md:    14.5–16px / Space Grotesk 400 / transcript text, line-height 1.6
--text-lg:    21px / Space Grotesk 700 / page titles
--text-xl:    30px / Space Grotesk 700 / landing stats
--text-hero:  52px / Space Grotesk 700 / landing headline, letter-spacing -.025em
```

### Spacing
```
4px, 6px, 8px, 9px, 11px, 12px, 13px, 14px, 16px, 18px, 20px, 22px, 24px, 26px, 28px, 30px, 34px, 40px, 48px, 52px
```

### Border Radius
```
4px   — small chips, tags
6px   — logo squares
7px   — cards, modals
8px   — action cards, buttons
9px   — action item rows
10px  — search input, result cards
11px  — library list container
12px  — mobile cards
14px  — landing entry rows, AI copilot cards
24px  — recording modal
42px  — mobile phone shell
999px — pills, avatar circles
```

### Shadows
```
card:    0 1px 3px rgba(0,0,0,.08)
landing: 0 6px 20px rgba(60,25,40,.2)   (white cards on gradient)
cta:     0 12px 30px rgba(240,113,78,.5)
overlay: 0 30px 90px rgba(20,8,30,.5)
```

---

## Participant Colour Map
Each participant gets a consistent avatar colour used across all screens:

| Person | Initials | Color |
|---|---|---|
| Maya Chen | MC | `#f0714e` (coral) |
| Sarah Liu | SL | `#cf8a2e` / `#ffb24d` (gold) |
| Devin Park | DP | `#8b6fd6` (purple) |
| Others overflow | +N | `#efe2d9` bg, `#8a7d70` text |

---

## Assets
- **Logo:** A `22–34px` square with `border-radius: 6–9px` and `background: #f0714e`. No external image — CSS only.
- **Image slot (landing left panel):** Drag-and-drop placeholder component (`image-slot.js`). In production, replace with a real photo asset — the brief calls for something symbolic (open hand, clear glass, sunlight, open door).
- **3D canvas (landing Sunrise variant):** A procedural Three.js sunrise environment used as a decorative left panel. In production this can be a static illustration or photo; the Three.js code is in the prototype for reference only.
- **Icons:** All icons in the prototype are CSS-only shapes (squares, bars, chevrons). Use your codebase's existing icon library.

---

## Files
```
design_handoff_ai_transcription/
├── README.md                    ← this file
├── AI Transcribe Layouts.dc.html  ← full canvas with all screens (open in browser)
├── support.js                   ← runtime needed to open the DC in browser
└── image-slot.js                ← drag-and-drop image placeholder component
```

Open `AI Transcribe Layouts.dc.html` locally (with the other files alongside it) to browse the live interactive prototype. The canvas is panned with click-drag; each frame has a label above it.
