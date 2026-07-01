# Candor Local MCP Server (scaffold)

Candor stores meetings as markdown + WAV on disk. This scaffold describes a **local-only** MCP server so Claude Desktop / Cursor can query your meetings without cloud upload.

## Status

**Not implemented in the app.** This document is a design note for a future local-only stdio server. There is no Settings toggle and no running network service in the current build.

## Planned tools

| Tool | Description |
|------|-------------|
| `list_meetings` | Return recent meeting ids, titles, dates |
| `read_meeting` | Full transcript + summary metadata for one id |
| `search_meetings` | Keyword search across transcripts |

## Data locations (Windows)

- Notes: `%APPDATA%\com.candor.app\notes\`
- Audio: `%APPDATA%\com.candor.app\audio\`
- Settings: `%APPDATA%\com.candor.app\settings.json`

## Minimal stdio server sketch (Node)

```js
// mcp-server/index.js — run: node mcp-server/index.js
const notesDir = process.env.CANDOR_NOTES_DIR;
// Read *.md files, parse frontmatter, expose via MCP JSON-RPC over stdio.
```

## Claude Desktop config (future)

```json
{
  "mcpServers": {
    "candor": {
      "command": "node",
      "args": ["C:/path/to/candor/mcp-server/index.js"],
      "env": { "CANDOR_NOTES_DIR": "%APPDATA%/com.candor.app/notes" }
    }
  }
}
```

## Security boundary

The future MCP server should use stdio, read only the active Candor library by default, and require an explicit user-controlled launch. Do not add a background HTTP server or outbound webhook path without a separate security review.
