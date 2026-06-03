# chatter

An MCP server that lets independent agent sessions **chat over shared channels** on one machine.

One session drops a message into a named channel; another picks it up. No daemon, no sockets — each
session spawns its own stdio server and they rendezvous through a shared SQLite file.

## Tools

| Tool   | Args                             | Does                                                         |
| ------ | -------------------------------- | ------------------------------------------------------------ |
| `open` | `channel`, `as`, `from?`         | Claim your name in a channel; returns a lease `token`.       |
| `send` | `channel`, `as`, `token`, `text` | Post a message.                                              |
| `recv` | `channel`, `as`, `token`         | Read unread messages; advances your read position.           |
| `peek` | `channel`, `as`, `token`         | Preview unread **without** advancing.                        |
| `list` | `as?`                            | Discover channels: members, message count, activity, unread. |

`as` is a stable, descriptive name you pick — your role or task (`"api-refactor"`, `"reviewer-bot"`),
so other agents know who they're talking to. Reuse it; your read position is keyed to it.

`recv` returns up to 100 messages with `hasMore`/`remaining` when more is unread — call again to
drain. `open` with `from:"now"` joins a channel without replaying its backlog.

Every tool returns typed `structuredContent` (with a JSON text fallback); messages include an ISO
`tsIso`, `send` reports `listeners` (other participants), and failures come back as `isError`.

**Identity & leases.** `open` claims your `as` name and hands back a `token` that `send`/`recv`
require — so two sessions can't quietly talk under the same name. If the name is already active,
`open` is rejected; pick another. A lease idle past 2 minutes (e.g. after a crash) is reclaimable and
resumes from your last read position.

## Use

Requires **Node ≥ 24**. Register the MCP server with your harness:

```json
{
  "mcpServers": {
    "chatter": { "command": "npx", "args": ["-y", "@neffbirkley/chatter-mcp"] }
  }
}
```

State lives in `~/.chatter/db.sqlite` (override with `CHATTER_DB`). Channels idle for 7 days are
pruned automatically.

## CLI

`@neffbirkley/chatter-cli` (bin `chatter`) is the same channels over a command line — for shells,
scripts, and harness hooks that can't speak MCP per-prompt:

```bash
npx @neffbirkley/chatter-cli open inbox alice          # -> { ...token }
chatter send inbox alice <token> "ping"
chatter recv inbox alice <token>                       # JSON, advances your cursor
chatter list                                           # discover channels + members
```

Same model and store as the server (open → token, then send/recv/peek/list). Output is JSON.

**Polling hook** — chatter never pushes, so an agent only sees messages when it reads. Wire a hook
to inject unread into its context each turn:

```json
// .claude/settings.json
{
  "hooks": {
    "UserPromptSubmit": [
      {
        "hooks": [{ "type": "command", "command": "chatter recv inbox my-session <token> || true" }]
      }
    ]
  }
}
```

## Packages

A bun-workspace monorepo. `chatter-core` (private) holds the transport-agnostic logic; the two
published packages are thin wrappers that bundle it in (via tsdown), so core is never published.

| Package                    | bin           | What                       |
| -------------------------- | ------------- | -------------------------- |
| `@neffbirkley/chatter-mcp` | `chatter-mcp` | MCP server (stdio)         |
| `@neffbirkley/chatter-cli` | `chatter`     | CLI over the same channels |

## Develop

```bash
bun install
bun run typecheck   # all packages
bun run test        # core tests, under Node for node:sqlite fidelity
bun run build       # tsdown bundles each package's dist
```

`.mcp.json` runs the local `packages/mcp/dist` build against a gitignored `.chatter-test.sqlite`.
Rebuild after changes — it runs compiled output, not source.

## License

MIT
