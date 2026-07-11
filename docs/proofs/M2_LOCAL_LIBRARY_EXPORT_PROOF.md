# M2 Local Library And Export Proof

## Purpose

This proof covers the M2 local library and structured document export harness:

- list local durable recordings
- read local transcript chunks
- search local transcript text
- create a polished Markdown report
- generate a native editable Word `.docx` package
- generate a searchable PDF with section bookmarks
- preserve one structured report contract across all three formats

The renderer still receives no raw filesystem paths, key material, arbitrary file access, process execution, or network authority.

## Command

```powershell
npm run m2:verify
```

The smoke script can also target a specific debug core binary:

```powershell
node scripts/m2-local-library-export-smoke.mjs C:\path\to\candor-core.exe
```

## Expected Result

The command starts `candor-core` over stdio JSON-RPC with an isolated `CANDOR_V3_DATA_DIR`, then verifies:

- `recording.durable.list` returns the finished recording and `rawPathExposed: false`
- `recording.durable.read` returns chunk text and no data root path
- `recording.durable.search` returns a snippet and no data root path
- `export.create` returns Markdown, native DOCX, searchable PDF, or WAV payloads,
  never raw export paths
- Word contains native Open XML document, table, list, footer, and page field
  structures rather than screenshots or pasted HTML
- PDF has selectable/searchable Unicode text, major-section bookmarks, stable
  page numbering, and Letter/A4 layout support
- action items retain text, owner, due date, status, and timestamp evidence
- decisions, risks, open questions, manual notes, and transcript sections are
  rendered from the same bounded report input
- report input limits reject oversized or control-character-bearing content
- unsupported export formats are denied with `EXPORT_FORMAT_UNSUPPORTED`
- any `keyMaterialExposedToRenderer` field is `false`

Passing output:

```text
M2 local library export smoke passed.
M2 local document export proof written to ...\release-v3\proofs\m2-local-document-export-win32-x64.json.
```

The machine-readable receipt records byte counts, SHA-256 hashes, native format
facts, and the zero-network/pathless custody facts without storing the generated
document payloads in the proof file.

## Dependency Audit

```powershell
npm run v3:dependency-audit
```

The native DOCX writer uses `quick-xml 0.41` plus `zip 0.6`, and the PDF writer
uses `krilla 0.8`. The lockfile no longer contains the vulnerable `docx-rs` /
`quick-xml 0.36` or `printpdf` / `lopdf 0.39` chains. The audit currently reports
zero npm or Rust vulnerabilities. It also reports one allowed maintenance warning:
`ttf-parser 0.25.1` is unmaintained and remains transitively required by Krilla's
current `rustybuzz` text shaping path. This is tracked as maintenance risk, not
silently waived, and should be removed when the upstream shaping dependency moves.
See [RUSTSEC-2026-0192](https://rustsec.org/advisories/RUSTSEC-2026-0192).

## Desktop Save Boundary

The production renderer calls `exportSaveLocal` with structured report data and
format options. Electron main asks `candor-core` to generate the document, checks
the declared MIME type, exact byte count, custody facts, output size, and native
file signature, then opens the OS save dialog. Only the user-selected destination
is written. The renderer receives the saved basename, byte count, SHA-256, and
format facts, never the destination path or filesystem authority.

## Boundary

This is not yet the real cross-OS 30-minute meeting proof. Native report rendering
and the Windows packaged path are implemented, but macOS/Linux packaged export
evidence remains part of the cross-OS release gate.
