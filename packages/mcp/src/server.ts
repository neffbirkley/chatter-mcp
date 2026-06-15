import { createRequire } from "node:module";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import * as store from "chatter-core";
import { type Database, DEFAULT_WAIT_MS, MAX_WAIT_MS, openDb, sweep } from "chatter-core";
import { z } from "zod";

const pkg = createRequire(import.meta.url)("../package.json") as { version: string };

const channel = z
  .string()
  .min(1)
  .max(200)
  .describe(
    "Channel name — a short topic/purpose label others can recognize and discover (e.g. 'auth-migration', 'release-2.0'). Shared across all sessions on this machine; created on first use.",
  );
const as = z
  .string()
  .min(1)
  .max(100)
  .describe(
    "The name you go by to other agents — stable and descriptive of your role or task (e.g. 'backend-refactor', 'alice-reviewer'), not a random id, so others know who they're talking to. Reuse it across calls; your read position and lease are keyed to it.",
  );
const text = z
  .string()
  .min(1)
  .max(64_000)
  .describe("The message to post (plain text, or your own structured format).");
const token = z
  .string()
  .min(1)
  .max(100)
  .describe(
    "The lease token returned by open. Proves you currently hold this name in the channel; required for send, recv, peek, and ack.",
  );
const from = z
  .enum(["start", "now"])
  .default("start")
  .describe(
    "For a new join: 'start' replays the channel's history, 'now' skips it and reads only messages sent after you join. Ignored when you already hold the name (you keep your read position).",
  );
const to = z
  .array(z.string().min(1).max(100))
  .optional()
  .describe(
    "Optional recipients: names this message is addressed to. Only they (and you) will receive it. Omit to broadcast to everyone in the channel.",
  );
const waitMs = z
  .number()
  .int()
  .min(0)
  .max(MAX_WAIT_MS)
  .optional()
  .describe(
    `How long (ms) to block waiting for a message when none are unread, instead of returning empty — the long-poll that avoids busy-checking. Defaults to ${DEFAULT_WAIT_MS}; pass 0 to return immediately. Returns as soon as a message arrives.`,
  );
const ids = z.array(z.number().int()).describe("Message ids (from send/recv results) to act on.");

const INSTRUCTIONS =
  "chatter lets separate agent sessions on this machine coordinate by leaving messages in shared, named channels — for handing off work, sharing findings, or asking another session for input. " +
  "Pick a stable name for yourself with `as` that describes your role or task (e.g. 'api-refactor', 'release-reviewer'), not a random id — other agents see this name on your messages, so a meaningful one tells them who they're talking to. Reuse it for the whole session. Name channels by topic so others can find them (e.g. 'auth-migration'). " +
  "Typical flow: (1) `list` to see existing channels and who's in them; (2) `open` a channel under your name to get a lease token — this reserves the name so two sessions can't post as the same person; if `open` is rejected, that name is in use, so pick another; `open` also reports `backlog`, how many messages are already waiting for you. (3) `send` with the token to post, `recv` with the token to read. " +
  "`recv` blocks by default: it parks for a short while and returns the instant a message arrives, so you can wait on a reply without busy-polling (pass `waitMs: 0` to return immediately). `recv` returns `hasMore: true` when more than one batch is waiting; call again to drain. Use `peek` to look without marking messages read. " +
  "Address a message to specific agents with `to: [names]` (others won't see it); omit it to broadcast. Confirm you've read a message by calling `ack` with its id — the sender can then see the receipt (acked-by names appear on each message, and a sender can check its own messages with `peek` + `ids`).";

// Output schemas — clients with structured-output support read these; others
// fall back to the JSON text content.
const messageOut = z.object({
  id: z.number(),
  channel: z.string(),
  sender: z.string(),
  text: z.string(),
  ts: z.number().describe("Epoch milliseconds."),
  tsIso: z.string().describe("ISO 8601 timestamp."),
  to: z.array(z.string()).optional().describe("Recipients, if addressed; absent for a broadcast."),
  acks: z.array(z.string()).describe("Participants who have acked (read) this message."),
});
const channelOut = z.object({
  channel: z.string(),
  members: z.array(z.string()),
  messages: z.number(),
  lastActivity: z.number(),
  lastActivityIso: z.string(),
  unread: z.number().optional(),
});
const openOut = {
  channel: z.string(),
  as: z.string(),
  token: z.string(),
  backlog: z.number().describe("Messages already waiting for you, unread, at open time."),
};
const ackOut = {
  channel: z.string(),
  acked: z.number().describe("How many of the given messages were recorded as read."),
};
const sendOut = {
  id: z.number(),
  channel: z.string(),
  listeners: z.number().describe("Other participants currently in the channel."),
};
const batchOut = {
  channel: z.string(),
  count: z.number(),
  messages: z.array(messageOut),
  remaining: z.number().describe("Unread messages beyond this batch."),
  hasMore: z.boolean(),
};
const listOut = { channels: z.array(channelOut) };

/** Successful tool result: structured content plus a JSON text fallback. */
function ok(structured: Record<string, unknown>) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(structured, null, 2) }],
    structuredContent: structured,
  };
}

/** A tool result flagged as an error for the MCP client. */
function fail(value: unknown) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(value, null, 2) }],
    isError: true,
  };
}

/** Map any handler throw to an isError result instead of crashing the server. */
function toError(err: unknown) {
  if (err instanceof store.LeaseError) return fail({ ok: false, error: err.message });
  return fail({ ok: false, error: err instanceof Error ? err.message : String(err) });
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
        "Claim a name in a channel and get a lease token (required for send/recv); creates the channel if new. Call once per channel, then reuse the returned token. If the name is already active under another session, the call is rejected with a retry time — choose a different name. Pass from:'now' to read only new messages instead of replaying history.",
      inputSchema: { channel, as, from },
      outputSchema: openOut,
    },
    async (args) => {
      try {
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
        return ok({
          channel: args.channel,
          as: args.as,
          token: result.token,
          backlog: result.backlog,
        });
      } catch (err) {
        return toError(err);
      }
    },
  );

  server.registerTool(
    "send",
    {
      title: "Send message",
      description:
        "Post a message to a channel. Requires the lease token from open. Address it to specific agents with `to: [names]`, or omit `to` to broadcast. Returns `listeners` — how many other participants are present; if 0, no one is currently there to read it.",
      inputSchema: { channel, as, token, text, to },
      outputSchema: sendOut,
    },
    async (args) => {
      try {
        const id = await store.send(
          db,
          args.channel,
          args.as,
          args.token,
          args.text,
          now(),
          args.to,
        );
        const listeners = await store.listenerCount(db, args.channel, args.as);
        await maybeSweep();
        return ok({ id, channel: args.channel, listeners });
      } catch (err) {
        return toError(err);
      }
    },
  );

  server.registerTool(
    "recv",
    {
      title: "Receive messages",
      description:
        "Read messages you haven't seen yet (oldest first, up to 100) and advance your read position past them. Requires the lease token from open. Blocks by default until a message arrives (pass `waitMs: 0` to return immediately, or a custom timeout). `hasMore: true` means more is waiting — call again to keep draining.",
      inputSchema: { channel, as, token, waitMs },
      outputSchema: batchOut,
    },
    async (args, extra) => {
      try {
        const { messages, remaining } = await store.recv(
          db,
          args.channel,
          args.as,
          args.token,
          now(),
          {
            waitMs: args.waitMs ?? DEFAULT_WAIT_MS,
            signal: extra?.signal,
          },
        );
        await maybeSweep();
        return ok({
          channel: args.channel,
          count: messages.length,
          messages,
          remaining,
          hasMore: remaining > 0,
        });
      } catch (err) {
        return toError(err);
      }
    },
  );

  server.registerTool(
    "peek",
    {
      title: "Peek messages",
      description:
        "Preview unread messages without marking them read — same result as recv, but your read position doesn't move, so a later recv still delivers them. Pass `ids` to instead fetch specific messages by id (e.g. ones you sent) to inspect their `acks` read receipts. Returns immediately by default; pass `waitMs` to block for new messages. Requires the lease token from open.",
      inputSchema: { channel, as, token, waitMs, ids: ids.optional() },
      outputSchema: batchOut,
    },
    async (args, extra) => {
      try {
        if (args.ids !== undefined) {
          const messages = await store.receipts(
            db,
            args.channel,
            args.as,
            args.token,
            now(),
            args.ids,
          );
          await maybeSweep();
          return ok({
            channel: args.channel,
            count: messages.length,
            messages,
            remaining: 0,
            hasMore: false,
          });
        }
        const { messages, remaining } = await store.peek(
          db,
          args.channel,
          args.as,
          args.token,
          now(),
          {
            waitMs: args.waitMs ?? 0,
            signal: extra?.signal,
          },
        );
        await maybeSweep();
        return ok({
          channel: args.channel,
          count: messages.length,
          messages,
          remaining,
          hasMore: remaining > 0,
        });
      } catch (err) {
        return toError(err);
      }
    },
  );

  server.registerTool(
    "ack",
    {
      title: "Acknowledge messages",
      description:
        "Confirm you've read one or more messages (by id, from recv/send results). Records a read receipt the sender can observe — message `acks` lists who acked, and a sender can check its own messages with peek + `ids`. Requires the lease token from open.",
      inputSchema: { channel, as, token, ids },
      outputSchema: ackOut,
    },
    async (args) => {
      try {
        const acked = await store.ack(db, args.channel, args.as, args.token, now(), args.ids);
        await maybeSweep();
        return ok({ channel: args.channel, acked });
      } catch (err) {
        return toError(err);
      }
    },
  );

  server.registerTool(
    "list",
    {
      title: "List channels",
      description:
        "Discover channels: each with its participants (`members`), message count, and last activity, most recent first. Pass your `as` name to also get your unread count per channel. Use before joining to see what exists and who's in it.",
      inputSchema: { as: as.optional() },
      outputSchema: listOut,
    },
    async (args) => {
      try {
        const channels = await store.list(db, args.as);
        await maybeSweep();
        return ok({ channels });
      } catch (err) {
        return toError(err);
      }
    },
  );

  return server;
}
