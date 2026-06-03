# agent-mailbox

An [MCP](https://modelcontextprotocol.io) server that lets independent, human-in-the-loop agent
sessions (Claude Code and other harnesses) exchange messages on demand through shared **named
mailboxes** on the same machine.

No sockets, no daemon. Every session launches its own copy of the server over stdio; they
rendezvous through a shared SQLite file. Drop a message into a channel from one session, pick it up
from another.

## How it works

- **Mailbox model.** A channel is an append-only message log. Each participant keeps a read cursor,
  so multiple readers and restarts are handled for free.
- **Polling, not push.** MCP cannot wake an idle agent, so `recv` returns whatever is unread. Let
  your harness decide when to check.
- **The DB file is the broker.** Stdio MCP servers are spawned per session, sharing no memory. State
  lives in `~/.agent-mailbox/db.sqlite` (override with `AGENT_MAILBOX_DB`).

## Tools

| Tool   | Input                   | Behavior                                            |
| ------ | ----------------------- | --------------------------------------------------- |
| `open` | `channel`, `as`         | Ensure a channel exists and register a participant. |
| `send` | `channel`, `as`, `text` | Append a message to a channel.                      |
| `recv` | `channel`, `as`         | Return unread messages and advance your cursor.     |
| `list` | `as`                    | List channels with your unread counts.              |

`as` is the name you pick for yourself (e.g. `"alice"`). Your read cursor is keyed by it, so reuse
the same name across restarts.

## Install / run

Requires **Node.js >= 24** (uses the built-in `node:sqlite`).

Register it with your harness as an MCP server, for example:

```json
{
  "mcpServers": {
    "mailbox": {
      "command": "npx",
      "args": ["-y", "agent-mailbox"]
    }
  }
}
```

## Housekeeping

Channels inactive for **7 days** are pruned opportunistically. No configuration, no background
process.

## Development

```bash
bun install
bun run typecheck
bun run test     # runs under Node for node:sqlite fidelity
bun run build
bun run inspect  # manual testing via the MCP inspector
```

### Testing against a local build

`.mcp.json` registers the server (`mailbox`) from the local `dist/` build, writing to a gitignored
`.mcp-test.sqlite` so testing never touches a real mailbox. `dist/` is gitignored, so build first:

```bash
bun run build   # refresh dist/ after any source change
```

Then reload the MCP server in your harness (it requires one-time approval). Rebuild after edits —
the config runs the compiled output, not the TypeScript source.

See [DESIGN.md](./DESIGN.md) for the full design rationale.

## License

MIT
