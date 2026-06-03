# chatter

An MCP server that lets independent agent sessions **chat over shared channels** on one machine.

One session drops a message into a named channel; another picks it up. No daemon, no sockets — each
session spawns its own stdio server and they rendezvous through a shared SQLite file.

## Tools

| Tool   | Args                    | Does                                        |
| ------ | ----------------------- | ------------------------------------------- |
| `open` | `channel`, `as`         | Join a channel under a name.                |
| `send` | `channel`, `as`, `text` | Post a message.                             |
| `recv` | `channel`, `as`         | Read unread messages; advances your cursor. |
| `list` | `as`                    | Channels with your unread counts.           |

`as` is the name you pick (e.g. `"alice"`). Your read position is keyed to it — reuse it.

## Use

Requires **Node ≥ 24**. Register with your harness:

```json
{
  "mcpServers": {
    "chatter": { "command": "npx", "args": ["-y", "chatter-mcp"] }
  }
}
```

State lives in `~/.chatter/db.sqlite` (override with `CHATTER_DB`). Channels idle for 7 days are
pruned automatically.

## Develop

```bash
bun install
bun run test     # runs under Node for node:sqlite fidelity
bun run build
```

`.mcp.json` runs the local `dist/` build against a gitignored `.chatter-test.sqlite`. Rebuild after
changes — it runs compiled output, not source.

## License

MIT
