# chatter — Design

An MCP server that lets independent human-in-the-loop agent sessions (Claude Code, etc.) chat on demand via shared named channels.

## Problem

Multiple agent sessions run on one machine. There's no built-in way for them to talk. We want a session to drop a message that another session can pick up — coordination without a human copy-pasting between terminals.

## Core constraint

An agent only acts on its turn. An MCP server is passive: it answers tool calls, it cannot push a new turn into an idle session. MCP server→client notifications exist but harnesses don't spawn a fresh agent turn from them. So **receiving cannot be event-driven** — it reduces to polling.

But _where_ the polling happens matters. An agent that busy-polls `recv` burns a full LLM turn per check, and the gap between a peer posting and the agent next polling is a race window (the original `evaluate AX` feedback hit exactly this coordinating over a shared resource). So `recv`/`peek` long-poll **inside the server**: a single call parks and re-checks the DB on a cheap interval, returning the instant a message lands. The agent makes one blocking call instead of a spin loop, and the race window shrinks to the poll interval. This is still polling — just moved off the expensive LLM-turn axis onto a cheap intra-process one. The wait is bounded (`MAX_WAIT_MS`, under the MCP request timeout) and holds no write lock, so it never stalls the broker.

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
- **Monorepo:** bun workspaces — `chatter-core` (private) + `@neffbirkley/chatter-mcp` + `@neffbirkley/chatter-cli`.
- **Build tool:** **tsdown** bundles each published package's `dist` (ESM `.mjs`), inlining `chatter-core`; runtime deps stay external. Bun `1.3.10` for install/scripts/test.
- **MCP:** `@modelcontextprotocol/sdk` (ESM-only).
- **DB:** `node:sqlite` (built-in, zero native dep) + **Kysely** query builder over a **vendored ~110-line dialect** (`core/src/kysely-node-sqlite.ts`). See decision below.
- **Validation:** `zod` (MCP SDK already depends on it).
- **Lint/format:** Biome (code), Prettier (markdown ONLY — disjoint globs, no overlap with Biome).
- **Hooks:** lefthook → Biome + commitlint on commit.
- **Commits:** Conventional Commits, enforced by commitlint.
- **Release:** semantic-release (lockstep, both packages one version) + GitHub Actions, npm OIDC + provenance.

### Dependency pinning

All deps installed at **fixed exact versions** (no `^`/`~`). Node pinned to `24.13.0` via `.nvmrc` + `engines` + CI `setup-node`.

### Final dep list

- **Runtime:** `@modelcontextprotocol/sdk`, `kysely`, `zod`. (`node:sqlite` = built-in, no package; the dialect is vendored, not a dependency.)
- **Dev:** `biome`, `prettier`, `lefthook`, `@commitlint/cli`, `@commitlint/config-conventional`, `semantic-release` (+ commit-analyzer, release-notes-generator, npm, github, changelog plugins), `typescript`, `@modelcontextprotocol/inspector`, `@types/node`.

## Identity & leases

A participant **declares a name** on join (`as: "alice"`) and `open` returns a **lease token** that `send`/`recv` require. The lease (`token` + `last_active`) lives on the cursor row, keyed by `(channel, participant)`.

- `open` grants a fresh token unless the name holds a **fresh** lease (active within `LEASE_TTL_MS` = 2 min) → rejected with `retryAfterMs`.
- `send`/`recv` validate the token in one atomic `UPDATE … WHERE token = ?` that also refreshes `last_active`. A wrong/revoked token raises `LeaseError` → an `isError` tool result.
- A **stale** lease (idle past the TTL, e.g. after a crash) is reclaimable; reclaim keeps the existing read position. `open` is serialized in a `BEGIN IMMEDIATE` transaction so two concurrent claims for one name can't both win.
- Limitation: chatter cannot distinguish _reconnect_ from _collision_, so reconnect-after-crash must wait out the TTL before reclaiming. Tunable via `LEASE_TTL_MS`.

## Tools (MCP surface)

Six tools. All inputs Zod-validated. Tool/param descriptions coach agents to pick stable, descriptive names; the server advertises usage `instructions`.

| Tool   | Input                                       | Behavior                                                                                                                                                                                                         |
| ------ | ------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `open` | `channel`, `as`, `from?`                    | Claim the name; return a lease `token` + `backlog` (unread at join), or reject if active. `from:"now"` skips backlog on a fresh join.                                                                            |
| `send` | `channel`, `as`, `token`, `text`, `to?`     | Validate lease, append message. `to` (recipient names) targets the message; null = broadcast. Bumps activity, throttled sweep.                                                                                   |
| `recv` | `channel`, `as`, `token`, `waitMs?`         | Validate lease; return messages visible to you (`id > cursor`, LIMIT 100) + `remaining`/`hasMore`; advance cursor. **Blocks** up to `waitMs` (server default 25s, cap 55s) for a message before returning empty. |
| `peek` | `channel`, `as`, `token`, `waitMs?`, `ids?` | Like `recv` but does NOT advance the cursor. `ids` fetches specific messages (any position) with `acks` — a sender's read-receipt query. Refreshes the lease.                                                    |
| `ack`  | `channel`, `as`, `token`, `ids`             | Record read receipts for the given message ids (idempotent). Returns how many valid ids were acked.                                                                                                              |
| `list` | `as?`                                       | Discovery: every channel with members, message count, `lastActivity` (+ISO); unread when `as` given.                                                                                                             |

Dropped `close` — channels are cheap; cleanup handles lifecycle. A lease auto-expires via its TTL.

Every tool declares an `outputSchema` and returns `structuredContent` plus a JSON text fallback. Any handler throw (lease failure, DB error) is mapped to an `isError` result rather than crashing the server. Messages carry `tsIso` (ISO 8601), `to` (recipients, if targeted), and `acks` (who's read them); `send` returns `listeners` (other participants in the channel).

**Blocking recv (long-poll).** Stdio MCP is request/response — the server can't push. `recv`/`peek` with `waitMs > 0` instead poll the DB on a short interval (`POLL_INTERVAL_MS`) until a visible message appears or the deadline passes. The lease is validated once up front (a bad token throws immediately, never parks). **Critically, no write transaction is held across the wait** — each poll is a brief, isolated read-and-advance, so a parked reader never locks out writers. A wait stays well under `LEASE_TTL_MS`, so presence survives without mid-wait writes; an injected `signal` (the MCP request's abort) ends the wait early.

**Targeting & receipts.** `recipients` (JSON array on `messages`, null = broadcast) gates visibility: a message is visible to a viewer iff `recipients IS NULL OR sender = viewer OR viewer ∈ recipients`. The same predicate filters `recv`, `peek`, `countAfter`, the `open` backlog, and `list` unread, so cursors and counts stay consistent. The cursor watermark only ever skips messages the viewer can't see, so it never strands a visible one. `acks` is a separate `(message_id, participant)` table; the sender reads receipts back via `peek ids` or the `acks` field on any returned message.

## Schema

```sql
CREATE TABLE IF NOT EXISTS channels (
  name          TEXT PRIMARY KEY,
  created_at    INTEGER NOT NULL,
  last_activity INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS messages (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  channel    TEXT NOT NULL,
  sender     TEXT NOT NULL,
  text       TEXT NOT NULL,
  ts         INTEGER NOT NULL,
  recipients TEXT      -- JSON array of target names; null = broadcast
);
CREATE TABLE IF NOT EXISTS cursors (
  channel      TEXT NOT NULL,
  participant  TEXT NOT NULL,
  last_seen_id INTEGER NOT NULL DEFAULT 0,
  token        TEXT,     -- current lease token; null if unleased
  last_active  INTEGER,  -- last activity under the lease, for reclaim
  PRIMARY KEY (channel, participant)
);
CREATE TABLE IF NOT EXISTS acks (   -- read receipts: who has read which message
  message_id  INTEGER NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
  channel     TEXT NOT NULL,
  participant TEXT NOT NULL,
  ts          INTEGER NOT NULL,
  PRIMARY KEY (message_id, participant)
);
CREATE INDEX IF NOT EXISTS idx_msg_channel_id ON messages(channel, id);
CREATE INDEX IF NOT EXISTS idx_acks_msg ON acks(message_id);
```

`recv` query: `SELECT * FROM messages WHERE channel=? AND id > ? AND <visible-to-viewer> ORDER BY id LIMIT 100`, then set cursor to max id. Idempotent, replayable, monotonic.

`list` unread: `COUNT(*) WHERE channel=? AND id > cursor AND <visible-to-viewer>`. Members derived from distinct message senders ∪ cursor participants.

Schema versioning: `PRAGMA user_version` (now **3**). `applySchema` runs `CREATE TABLE IF NOT EXISTS` then adds missing columns idempotently (`PRAGMA table_info` guard) — v1→v2 added the lease columns, v2→v3 adds `messages.recipients` (the `acks` table is created by the DDL). Tables are `STRICT` for type rigor.

## Concurrency — required PRAGMAs

N processes on one file. On every connection open:

```sql
PRAGMA journal_mode = WAL;     -- readers don't block writers across processes
PRAGMA busy_timeout = 15000;   -- wait instead of throwing SQLITE_BUSY on write contention
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
- Override: env `CHATTER_DB` for per-project isolation. Relative paths resolve against the server's cwd (the repo's `.mcp.json` uses `.chatter-test.sqlite` this way).
- **mkdir the parent dir on boot** before opening DB, or first run crashes.
- Security: `CHATTER_DB` is **operator-controlled and trusted** — it is used verbatim and the parent dir is created if missing. Not a user-facing input; the threat model is local single-user.

## Distribution

- Two published packages, each bin-only: `@neffbirkley/chatter-mcp` (bin `chatter-mcp`, the stdio server) and `@neffbirkley/chatter-cli` (bin `chatter`, the CLI). `#!/usr/bin/env node` shebang + executable bit preserved by tsdown.
- **tsdown** bundles each `dist/index.mjs` (ESM), inlining `chatter-core` (a devDependency); runtime deps (`@modelcontextprotocol/sdk`, `kysely`, `zod`) stay external. No `.d.ts` (bin-only).
- `files: ["dist"]` — publish only build output, not source. `publishConfig.access: public`.
- **Lockstep release:** one semantic-release run, two `@semantic-release/npm` `pkgRoot` instances, publishes both at the same version/tag (`v${version}`). Correct because both bundle the same core.
- CI publish via **npm OIDC trusted publishing** (`id-token: write`, no token) + automatic provenance. Each package needs a Trusted Publisher registered on npm; a brand-new package must be bootstrapped with a one-time token publish first.

## stdout is sacred

Stdio MCP uses **stdout for protocol framing**. ANY stray stdout corrupts the stream. ALL logging → **stderr**. No `console.log`. This is the top runtime footgun.

## CI (GitHub Actions) — `.github/workflows/main-ci.yml`

- **verify (PR + push):** `bun install --frozen-lockfile` → lint → typecheck → test (incl. a multi-process WAL concurrency test) → build. Root scripts fan out over workspaces via `bun --filter`.
- **release (push to main):** gates + `semantic-release` (lockstep) → OIDC publish both packages with provenance + GitHub release + CHANGELOG. `id-token: write`, `fetch-depth: 0`; only secret is the built-in `GITHUB_TOKEN`.

## Project layout

```
chatter/ (bun workspace root)
├── packages/
│   ├── core/                    # chatter-core (private) — transport-agnostic
│   │   ├── src/
│   │   │   ├── index.ts         # public API barrel
│   │   │   ├── db.ts            # node:sqlite open, PRAGMAs, mkdir, Kysely wrap
│   │   │   ├── schema.ts        # DDL + Kysely table types + migration
│   │   │   ├── kysely-node-sqlite.ts # vendored dialect — the only cast boundary
│   │   │   ├── store.ts         # open/send/recv/peek/list + leases
│   │   │   └── cleanup.ts       # opportunistic sweep
│   │   └── tests/               # tools + multi-process concurrency tests
│   ├── mcp/                     # @neffbirkley/chatter-mcp (bin chatter-mcp)
│   │   └── src/{index,server}.ts  # stdio bootstrap + tool registrations
│   └── cli/                     # @neffbirkley/chatter-cli (bin chatter)
│       └── src/index.ts         # argv → core
├── .github/workflows/main-ci.yml
├── tsconfig.base.json           # + per-package tsconfig.json
├── biome.json · lefthook.yml · commitlint.config.js · .releaserc.json
├── .nvmrc (24.13.0) · .prettierrc · package.json (workspaces)
├── README.md · LICENSE · DESIGN.md
```

Each `packages/{mcp,cli}` has its own `package.json` + `tsdown.config.ts`; `chatter-core` is their `workspace:*` devDependency, inlined at build.

## Out of scope (v1)

- Blocking/long-poll receive (harness waits itself).
- Cross-machine transport (HTTP). Stdio + same host only.
- Configurable TTLs (lease + inactivity are constants).
- Message edit/delete, threads, attachments.

## Decisions during build

- **Kysely, with a vendored dialect (2026-06-03).** Use Kysely for typed query building and cast-free domain code. Rather than depend on the only published node:sqlite dialect (`kysely-node-sqlite`, single-maintainer, ~10 months stale, pulls in `async-mutex`), we vendor `packages/core/src/kysely-node-sqlite.ts` (~110 lines): reuse Kysely's own `SqliteAdapter`/`SqliteQueryCompiler`/`SqliteIntrospector`, add a thin synchronous driver over `DatabaseSync` and a single shared connection serialized by an inlined promise mutex. Only added runtime dep: `kysely`. The only type assertions in the whole codebase live in that one boundary file.
  - **Reader detection:** the dialect routes a statement to `.all()` vs `.run()` by `stmt.columns().length > 0`, not by Kysely's query-node kind. The node-kind approach misclassifies raw `sql\`SELECT …\``(compiled as`RawNode`) as a non-select and silently returns no rows; `columns()` is correct for both builder and raw selects.
  - **recv atomicity:** read-cursor-then-advance runs inside a Kysely transaction; the driver's mutex holds the connection for the transaction's duration so concurrent reads can't interleave (a regression risk introduced by going async that the prior fully-synchronous version didn't have).

## Open items

None blocking. GitHub remote + npm publish deferred to a later session with user oversight.
