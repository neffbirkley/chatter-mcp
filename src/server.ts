import { createRequire } from "node:module";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { sweep } from "./cleanup.js";
import { type Database, openDb } from "./db.js";
import * as store from "./store.js";

const pkg = createRequire(import.meta.url)("../package.json") as { version: string };

const channel = z
  .string()
  .min(1)
  .max(200)
  .describe(
    "Channel name — a short topic/purpose label other agents can discover and recognize (e.g. 'auth-migration', 'release-2.0'). Shared across all sessions on this machine; created on first use.",
  );
const as = z
  .string()
  .min(1)
  .max(100)
  .describe(
    "A stable, human-meaningful name identifying you to other agents — your role or task, not a random id (e.g. 'backend-refactor', 'alice-reviewer'). Reuse the same name across calls; your read position is keyed to it.",
  );
const text = z.string().min(1).max(64_000).describe("Message body.");
const token = z
  .string()
  .min(1)
  .max(100)
  .describe("Your lease token from `open`. Proves you hold this name; required to send and recv.");
const from = z
  .enum(["start", "now"])
  .default("start")
  .describe(
    "Where a new join starts reading: 'start' replays channel history, 'now' skips the backlog. Ignored when reclaiming a name you already hold.",
  );

const INSTRUCTIONS =
  "chatter lets independent agent sessions talk over shared, named channels on this machine. " +
  "Identify yourself with a stable, descriptive `as` name — your role or task ('api-refactor', 'reviewer-bot'), not a random id — so other agents know who they're talking to; reuse it for the whole session. " +
  "Name channels by topic/purpose ('auth-migration', 'release-2.0') so others can find them. " +
  "Call `open` to claim your `as` name in a channel and receive a lease token, then `send`/`recv` with that token. " +
  "If `open` is rejected, the name is active under another session — pick a different name. " +
  "Use `list` to discover channels and who's in them. recv polls (chatter does not push) and returns `hasMore` when more unread remains than one batch; `peek` previews without consuming.";

function json(value: unknown) {
  return { content: [{ type: "text" as const, text: JSON.stringify(value, null, 2) }] };
}

/** A tool result flagged as an error for the MCP client. */
function fail(value: unknown) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(value, null, 2) }],
    isError: true,
  };
}

export interface ServerDeps {
  db?: Database;
  now?: () => number;
}

/** Build the MCP server with the chatter tools registered. */
export function createServer({ db = openDb(), now = Date.now }: ServerDeps = {}): McpServer {
  const server = new McpServer(
    { name: "chatter", version: pkg.version },
    { instructions: INSTRUCTIONS },
  );

  // Opportunistic, throttled cleanup runs on activity. Best-effort: a sweep
  // failure must never fail the user's actual operation.
  const maybeSweep = async (): Promise<void> => {
    try {
      await sweep(db, now());
    } catch (err) {
      process.stderr.write(`chatter: sweep failed: ${err instanceof Error ? err.message : err}\n`);
    }
  };

  server.registerTool(
    "open",
    {
      title: "Open channel",
      description:
        "Claim your name in a channel and receive a lease token, required before send/recv. The channel is created if needed. Rejected if the name is currently active under another session — pick a different name and retry. Use from:'now' to skip the backlog on a fresh join.",
      inputSchema: { channel, as, from },
    },
    async (args) => {
      const result = await store.open(db, args.channel, args.as, now(), args.from);
      if (!result.granted) {
        return fail({
          ok: false,
          error: `Name '${args.as}' is currently active in '${args.channel}'. Retry in ~${Math.ceil(
            result.retryAfterMs / 1000,
          )}s or choose a different name.`,
          retryAfterMs: result.retryAfterMs,
        });
      }
      return json({ ok: true, channel: args.channel, as: args.as, token: result.token });
    },
  );

  server.registerTool(
    "send",
    {
      title: "Send message",
      description: "Post a message to a channel. Requires the lease token from open.",
      inputSchema: { channel, as, token, text },
    },
    async (args) => {
      try {
        const id = await store.send(db, args.channel, args.as, args.token, args.text, now());
        await maybeSweep();
        return json({ ok: true, id, channel: args.channel });
      } catch (err) {
        if (err instanceof store.LeaseError) return fail({ ok: false, error: err.message });
        throw err;
      }
    },
  );

  server.registerTool(
    "recv",
    {
      title: "Receive messages",
      description:
        "Return messages you have not seen yet on a channel (oldest first, up to 100) and advance your read position. Requires the lease token from open. Polling — chatter does not push. `hasMore`/`remaining` indicate unread messages beyond this batch — call again to drain them.",
      inputSchema: { channel, as, token },
    },
    async (args) => {
      try {
        const { messages, remaining } = await store.recv(
          db,
          args.channel,
          args.as,
          args.token,
          now(),
        );
        await maybeSweep();
        return json({
          channel: args.channel,
          count: messages.length,
          messages,
          remaining,
          hasMore: remaining > 0,
        });
      } catch (err) {
        if (err instanceof store.LeaseError) return fail({ ok: false, error: err.message });
        throw err;
      }
    },
  );

  server.registerTool(
    "peek",
    {
      title: "Peek messages",
      description:
        "Preview your unread messages without advancing your read position (recv consumes them; peek does not). Same result shape as recv. Requires the lease token from open.",
      inputSchema: { channel, as, token },
    },
    async (args) => {
      try {
        const { messages, remaining } = await store.peek(
          db,
          args.channel,
          args.as,
          args.token,
          now(),
        );
        await maybeSweep();
        return json({
          channel: args.channel,
          count: messages.length,
          messages,
          remaining,
          hasMore: remaining > 0,
        });
      } catch (err) {
        if (err instanceof store.LeaseError) return fail({ ok: false, error: err.message });
        throw err;
      }
    },
  );

  server.registerTool(
    "list",
    {
      title: "List channels",
      description:
        "Discover channels: each channel with its members, message count, and last activity, most recently active first. Optionally pass `as` to also get your unread count per channel.",
      inputSchema: { as: as.optional() },
    },
    async (args) => {
      const channels = await store.list(db, args.as);
      await maybeSweep();
      return json({ channels });
    },
  );

  return server;
}
