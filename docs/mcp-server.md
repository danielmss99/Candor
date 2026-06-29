# Candor Local MCP Server (scaffold)

Candor stores meetings as markdown + WAV on disk. This scaffold describes a **local-only** MCP server so Claude Desktop / Cursor can query your meetings without cloud upload.

## Status

**Not fully implemented** — enable the toggle in Settings → Privacy to reserve the flag. Implement when you need agent access.

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

## Webhook alternative

If MCP is too heavy, set **Webhook on meeting saved** in Settings. Candor POSTs:

```json
{ "event": "meeting_saved", "meetingId": "…", "durationSeconds": 360, "segmentCount": 42 }
```

Wire your automation (Zapier, n8n, custom script) to pull the markdown file from the notes folder.
