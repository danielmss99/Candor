# Candor read-only CLI and MCP companions

Candor includes two local Rust automation companions in `crates/candor-tools`:

- `candorctl` provides bounded read-only commands for local scripts.
- `candor-mcp` provides the same allowlisted operations over MCP JSON-RPC on stdin and stdout.

These companions do not read Candor files directly. They start a `candor-core` child process and use its pathless stdio contract. The companions never open a TCP listener, create a socket, make an outbound request, accept a webhook, or expose an arbitrary core method.

## Build

From `crates/candor-tools`:

```powershell
cargo build --release
```

For an installed build, place `candorctl`, `candor-mcp`, and `candor-core` in the same directory. During development, the companions also look for the debug or release core under the adjacent `candor-core` crate.

If the core is not adjacent, set `CANDOR_CORE_BINARY` to an absolute path for an existing executable whose file name is exactly `candor-core.exe` on Windows or `candor-core` on other supported platforms. Relative paths are rejected. The value selects only the core executable. It cannot add arguments or select another command.

## CLI

```text
candorctl list [--limit N] [--cursor N]
candorctl search QUERY [--limit N] [--cursor N]
candorctl summary RECORDING_ID
candorctl transcript RECORDING_ID [--limit N] [--cursor N]
candorctl export RECORDING_ID [--format markdown|text] [--limit N] [--cursor N]
candorctl stats
```

Every command writes bounded JSON to stdout. Errors are bounded JSON on stderr. `export` returns markdown or text in the JSON response with `destination: "stdout-only"`. It does not accept a destination path. Use the caller's normal stdout redirection only after choosing and reviewing the destination yourself.

When `hasMore` is true, pass `nextCursor` to the next call. A cursor is a bounded decimal token, not a filesystem path.

## MCP configuration

Example Claude Desktop configuration for a packaged companion:

```json
{
  "mcpServers": {
    "candor": {
      "command": "C:/Users/YOU/AppData/Local/Programs/Candor/resources/bin/candor-mcp.exe",
      "args": []
    }
  }
}
```

Replace `YOU` with the Windows account name and use the directory selected by
the installer. A per-machine installation uses the same
`resources/bin/candor-mcp.exe` suffix under its chosen installation directory.

The process uses newline-delimited MCP JSON-RPC over stdin and stdout. It supports `initialize`, `ping`, `tools/list`, `tools/call`, and the fixed initialization and cancellation notifications. Other MCP methods are rejected.

## Exposed MCP tools

| Tool | Access | Default page | Maximum page or scan |
|---|---|---:|---:|
| `list_meetings` | Meeting identifiers and bounded metadata | 20 meetings | 50 meetings per page from a core-owned scan bounded to 2,000 recording directories, 4,000 directory entries, 100,000 chunk descriptors, and 32 MiB of manifest reads |
| `search_meetings` | Meeting labels, transcript snippets, and meeting-note snippets | 10 matches | 25 matches per page from a core-owned scan bounded to 100 meetings, 2,000 directory entries, 50,000 chunk descriptors, 16 MiB of manifest reads, and 16 MiB of decrypted text |
| `meeting_summary` | Bounded metadata for one meeting | One result | 2,000 meetings scanned to locate the identifier |
| `get_transcript` | Bounded transcript page | 20 segments | 50 segments, 4,096 bytes per segment from the core and 2,048 bytes per segment from the companion |
| `export_meeting` | Markdown or text returned to stdout | 20 segments | 50 segments and 96 KiB of content |
| `library_statistics` | Aggregate local library counts | One result | 2,000 meetings scanned |

Read-only list responses include `sourceTruncated` and `totalCountExact`. The core first collects bounded lightweight directory and manifest-file metadata, orders candidates deterministically by manifest modification time with the recording identifier as a tie-breaker, and then parses and validates only the requested page. The unparsed next candidate is used only as bounded lookahead for `hasMore`. A count is not exact when candidates outside the page have not been validated or the source scan was truncated. Search reports its bounded condition through `truncated`, and statistics report partial results. Clients must not infer completeness when `sourceTruncated`, `truncated`, `partial`, or `hasMore` is true. Automation search reads encrypted durable transcript and note chunks through the core using the existing OS-protected key, never persists a plaintext index, and never creates a missing key or search index. It deliberately does not attach to or rebuild the desktop SQLCipher FTS index because a separate read-only process cannot prove that another process's in-memory index generation is current.

The core caps serialized read-only list and search responses at 1 MiB each. Transcript responses are capped at 512 KiB. Transcript pagination is applied to bounded chunk descriptors before any selected segment is decrypted, so a one-segment request decrypts at most one segment. Labels, channels, speakers, and returned segment text also have independent UTF-8 byte limits.

## Security and privacy boundary

The companions enforce all of these properties in native code:

- The core request allowlist contains only `recording.durable.listPage`, `recording.durable.transcriptPage`, the non-mutating `recording.durable.search`, and lifecycle-only `core.shutdown`.
- Mutation, deletion, capture, microphone access, transcription jobs, AI jobs, direct core dispatch, binary audio export, and key operations are not exposed.
- Tool inputs reject unknown fields, invalid meeting identifiers, oversized queries, oversized pages, and oversized JSON frames.
- Tool results are reconstructed from explicit field allowlists. Unknown core fields are dropped.
- Recording directories, manifests, and chunks must be owned directories or regular files. Static symlinks, Windows reparse points, directories in place of files, fixed-limit violations, committed size mismatches on selected chunks, and type or reported-length changes observed across an open-file read are rejected without writing a quarantine receipt or modifying the source recording. This does not claim complete TOCTOU elimination or detection of a concurrent same-length content rewrite. Chunk AEAD authentication and committed content hashes provide the separate content-integrity checks when those chunks are selected and read.
- Input frames are limited to 64 KiB, tool results to 128 KiB, and MCP output frames to 256 KiB.
- Every successful result and structured error reports `rawPathExposed: false` and `keyMaterialExposedToRenderer: false`.
- The configured core path, local data root, encryption keys, vault material, and core stderr are never returned to a caller.
- The MCP process is sequential and local. It contains no HTTP client or server dependency.
- The companion requests a clean `core.shutdown` on normal exit and force-stops only if the child does not exit promptly.

The companions start `candor-core` in its exact read-only automation mode. In that mode, the core skips startup crash recovery, background jobs, dictionary maintenance, and other mutation-capable startup work. Transcript pages apply accepted terminology corrections through a read-only overlay that can use only an existing OS-protected key. The companions expose no mutation method.

## Verification

Focused checks for this crate:

```powershell
cargo fmt --manifest-path crates/candor-tools/Cargo.toml -- --check
cargo test --manifest-path crates/candor-tools/Cargo.toml
cargo clippy --manifest-path crates/candor-tools/Cargo.toml --all-targets -- -D warnings
```

The tests prove the external tool allowlist, internal core method allowlist, bounded framing, pagination, output sanitization, stdout-only export, MCP method denial, CLI command denial, and clean pathless privacy flags. Hardware is not required for these read-only checks.
