# chatter — Design

An MCP server that lets independent human-in-the-loop agent sessions (Claude Code, etc.) chat on demand via shared named channels.

## Problem

Multiple agent sessions run on one machine. There's no built-in way for them to talk. We want a session to drop a message that another session can pick up — coordination without a human copy-pasting between terminals.

## Core constraint

An agent only acts on its turn. An MCP server is passive: it answers tool calls, it cannot push a new turn into an idle session. MCP server→client notifications exist but harnesses don't spawn a fresh agent turn from them. So **receiving cannot be event-driven** — it reduces to polling. Modern harnesses can choose to wait/poll themselves, so we do not bake blocking into the server.

## Model: shared mailbox-style channels (not sockets)

State lives in the server's storage, not in any connection. Sessions drop messages into named channels; sessions drain them out. Append-only log per channel; each participant keeps a read cursor. Benefits:

- Multiple listeners fall out for free (each keeps own cursor).
- Survives session restart (cursor keyed by participant name, not connection).
- No subscriber registry, no pub/sub, no event emitters.

## Transport & process topology — critical

Stdio MCP servers are **launched by the client**. Each agent session spawns its **own** copy of this server as a subprocess. N sessions → N server processes sharing **no memory**.

⟹ The shared state MUST live on disk. The **SQLite DB file is the broker.** This is why persistence isn't optional and in-memory was never viable.

## Stack

- **Runtime:** Node `24.13.0` (pinned, latest 24.x). `engines.node >=24`.
- **Build tool:** Bun `1.3.10` (dev/build/test only — must NOT leak into runtime deps).
- **MCP:** `@modelcontextprotocol/sdk` (ESM-only).
- **DB:** `node:sqlite` (built-in, zero native dep) + **Kysely** query builder over a **vendored ~110-line dialect** (`src/kysely-node-sqlite.ts`). See decision below.
- **Validation:** `zod` (MCP SDK already depends on it).
- **Lint/format:** Biome (code), Prettier (markdown ONLY — disjoint globs, no overlap with Biome).
- **Hooks:** lefthook → Biome + commitlint on commit.
- **Commits:** Conventional Commits, enforced by commitlint.
- **Release:** semantic-release + GitHub Actions, npm provenance.

### Dependency pinning

All deps installed at **fixed exact versions** (no `^`/`~`). Node pinned to `24.13.0` via `.nvmrc` + `engines` + CI `setup-node`.

### Final dep list

- **Runtime:** `@modelcontextprotocol/sdk`, `kysely`, `zod`. (`node:sqlite` = built-in, no package; the dialect is vendored, not a dependency.)
- **Dev:** `biome`, `prettier`, `lefthook`, `@commitlint/cli`, `@commitlint/config-conventional`, `semantic-release` (+ commit-analyzer, release-notes-generator, npm, github, changelog plugins), `typescript`, `@modelcontextprotocol/inspector`, `@types/node`.

## Identity

A participant **declares a name** on join (`as: "alice"`). Cursor keyed by `(channel, participant)` survives restarts. Two sessions choosing the same name share a cursor (documented limitation; namespacing is v2).

## Tools (MCP surface)

Four tools. All inputs Zod-validated.

| Tool   | Input                   | Behavior                                                                                        |
| ------ | ----------------------- | ----------------------------------------------------------------------------------------------- |
| `open` | `channel`, `as`         | Ensure channel exists; register participant (cursor row at 0 if new). Bumps `last_activity`.    |
| `send` | `channel`, `as`, `text` | Append message. Bumps `last_activity`. Triggers throttled cleanup sweep.                        |
| `recv` | `channel`, `as`         | Return messages with `id > cursor` (ORDER BY id, LIMIT 100); advance cursor to max id returned. |
| `list` | `as`                    | All channels + this participant's unread count each.                                            |

Dropped `close` — channels are cheap; cleanup handles lifecycle.

## Schema

```sql
CREATE TABLE IF NOT EXISTS channels (
  name          TEXT PRIMARY KEY,
  created_at    INTEGER NOT NULL,
  last_activity INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS messages (
  id      INTEGER PRIMARY KEY AUTOINCREMENT,
  channel TEXT NOT NULL,
  sender  TEXT NOT NULL,
  text    TEXT NOT NULL,
  ts      INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS cursors (
  channel      TEXT NOT NULL,
  participant  TEXT NOT NULL,
  last_seen_id INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (channel, participant)
);
CREATE INDEX IF NOT EXISTS idx_msg_channel_id ON messages(channel, id);
```

`recv` query: `SELECT * FROM messages WHERE channel=? AND id > ? ORDER BY id LIMIT 100`, then set cursor to max id. Idempotent, replayable, monotonic.

`list` unread: `COUNT(*) WHERE channel=? AND id > cursor`.

Schema versioning v1: `CREATE TABLE IF NOT EXISTS` + `PRAGMA user_version`. Add real migrations when schema evolves. Tables are `STRICT` for type rigor.

## Concurrency — required PRAGMAs

N processes on one file. On every connection open:

```sql
PRAGMA journal_mode = WAL;     -- readers don't block writers across processes
PRAGMA busy_timeout = 5000;    -- wait instead of throwing SQLITE_BUSY on write contention
PRAGMA foreign_keys = ON;
```

Without WAL + busy_timeout, concurrent writes throw `SQLITE_BUSY`. This is correctness, not tuning.

## Cleanup — opportunistic, no cron

No background timer (process is short-lived, N copies — a timer is wrong). Sweep instead:

- On startup, and throttled inside `send` (guard: skip if swept within last 1h, tracked via `PRAGMA user_version` companion or a `meta` row).
- `DELETE FROM channels WHERE last_activity < now - 7d`, cascade `messages` + `cursors` for dead channels.
- Default inactivity TTL: **7 days**. No config in v1.

## DB location

- Fixed: `~/.chatter/db.sqlite`. Single global store across all sessions on the host.
- Override: env `CHATTER_DB` (absolute path) for per-project isolation.
- **mkdir the parent dir on boot** before opening DB, or first run crashes.

## Distribution

- `bin` entry + `#!/usr/bin/env node` shebang + executable bit → launches as `npx chatter-mcp`.
- Ship ESM JS + `.d.ts`. Build via Bun (or tsdown) + `tsc` for types.
- `files: ["dist"]` — publish only build output, not source.
- `publishConfig.access: public` (if scoped).
- CI publish with `id-token: write` + `npm publish --provenance`.

## stdout is sacred

Stdio MCP uses **stdout for protocol framing**. ANY stray stdout corrupts the stream. ALL logging → **stderr**. No `console.log`. This is the top runtime footgun.

## CI (GitHub Actions)

- **PR gate:** install (frozen lockfile) → Biome lint → `tsc` typecheck → `bun test` (incl. a multi-process WAL concurrency test) → build.
- **Release (main):** gates + semantic-release → npm publish (provenance) + GitHub release + CHANGELOG. Secrets: `NPM_TOKEN`, `GITHUB_TOKEN`.

## Project layout

```
chatter/
├── src/
│   ├── index.ts        # entry: shebang, server bootstrap, stdio transport
│   ├── server.ts       # MCP server + four tool registrations
│   ├── db.ts                 # node:sqlite open, PRAGMAs, mkdir, schema apply, Kysely wrap
│   ├── schema.ts             # DDL + Kysely table types + user_version bootstrap
│   ├── kysely-node-sqlite.ts # vendored Kysely dialect — the only cast boundary
│   ├── store.ts              # open/send/recv/list query logic (Kysely)
│   └── cleanup.ts      # opportunistic sweep
├── tests/
│   ├── tools.test.ts
│   ├── concurrency.test.ts
│   └── _writer.ts      # child process for the concurrency test
├── .github/workflows/ci.yml
├── biome.json
├── lefthook.yml
├── commitlint.config.js
├── .releaserc.json
├── .nvmrc              # 24.13.0
├── .prettierrc         # markdown only
├── tsconfig.json
├── package.json
├── README.md
├── LICENSE
└── DESIGN.md
```

## Out of scope (v1)

- Blocking/long-poll receive (harness waits itself).
- Participant namespacing / auth.
- Cross-machine transport (HTTP). Stdio + same host only.
- Configurable TTL.
- Message edit/delete, threads, attachments.

## Decisions during build

- **Kysely, with a vendored dialect (2026-06-03).** Use Kysely for typed query building and cast-free domain code. Rather than depend on the only published node:sqlite dialect (`kysely-node-sqlite`, single-maintainer, ~10 months stale, pulls in `async-mutex`), we vendor `src/kysely-node-sqlite.ts` (~110 lines): reuse Kysely's own `SqliteAdapter`/`SqliteQueryCompiler`/`SqliteIntrospector`, add a thin synchronous driver over `DatabaseSync` and a single shared connection serialized by an inlined promise mutex. Only added runtime dep: `kysely`. The only type assertions in the whole codebase live in that one boundary file.
  - **Reader detection:** the dialect routes a statement to `.all()` vs `.run()` by `stmt.columns().length > 0`, not by Kysely's query-node kind. The node-kind approach misclassifies raw `sql\`SELECT …\``(compiled as`RawNode`) as a non-select and silently returns no rows; `columns()` is correct for both builder and raw selects.
  - **recv atomicity:** read-cursor-then-advance runs inside a Kysely transaction; the driver's mutex holds the connection for the transaction's duration so concurrent reads can't interleave (a regression risk introduced by going async that the prior fully-synchronous version didn't have).

## Open items

None blocking. GitHub remote + npm publish deferred to a later session with user oversight.
