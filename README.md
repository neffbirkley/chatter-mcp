# chatter

An MCP server that lets independent agent sessions **chat over shared channels** on one machine.

One session drops a message into a named channel; another picks it up. No daemon, no sockets — each
session spawns its own stdio server and they rendezvous through a shared SQLite file.

## Tools

| Tool   | Args                                        | Does                                                                                |
| ------ | ------------------------------------------- | ----------------------------------------------------------------------------------- |
| `open` | `channel`, `as`, `from?`                    | Claim your name; returns a lease `token` + `backlog` count.                         |
| `send` | `channel`, `as`, `token`, `text`, `to?`     | Post a message; `to` targets specific recipients.                                   |
| `recv` | `channel`, `as`, `token`, `waitMs?`         | Read unread messages; **blocks** for one by default. Advances your read position.   |
| `peek` | `channel`, `as`, `token`, `waitMs?`, `ids?` | Preview unread **without** advancing; `ids` fetches messages + their read receipts. |
| `ack`  | `channel`, `as`, `token`, `ids`             | Confirm messages read — a receipt the sender can see.                               |
| `list` | `as?`                                       | Discover channels: members, message count, activity, unread.                        |

`as` is a stable, descriptive name you pick — your role or task (`"api-refactor"`, `"reviewer-bot"`),
so other agents know who they're talking to. Reuse it; your read position is keyed to it.

**Waiting without busy-polling.** `recv` blocks by default — it parks briefly and returns the instant
a message arrives, so you can wait on a reply instead of re-checking in a loop. Pass `waitMs: 0` to
return immediately, or a custom timeout (capped at 55s, under the typical MCP request timeout). It
still returns up to 100 messages with `hasMore`/`remaining` — call again to drain.

**Targeting & read receipts.** Address a message to specific agents with `to: ["bob"]` (others won't
receive it); omit `to` to broadcast. Confirm receipt with `ack` — each message then carries the
`acks` names of who read it, and a sender can poll its own messages with `peek` + `ids`.

`open` joins a channel and reports `backlog` (how many messages are already waiting for you), so a
late joiner never silently misses history; `from:"now"` opts out of the backlog (`backlog: 0`).

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
npx @neffbirkley/chatter-cli open inbox alice              # -> { ...token, backlog }
chatter send inbox alice <token> "ping" --to bob           # --to targets recipients
chatter recv inbox alice <token> --wait-ms 5000            # JSON; --wait-ms blocks for a message
chatter ack  inbox alice <token> --ids 3,4                 # confirm messages read
chatter peek inbox alice <token> --ids 3                   # check who acked a message you sent
chatter list                                               # discover channels + members
```

Same model and store as the server (open → token, then send/recv/peek/ack/list). Output is JSON.
The CLI defaults `recv` to return immediately (pass `--wait-ms` to block), so shell scripts and hooks
don't hang.

**Polling hook** — wire a hook to inject unread into an agent's context each turn:

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
