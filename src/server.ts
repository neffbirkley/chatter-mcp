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
  .describe("Channel name. Shared across all sessions on this machine.");
const as = z
  .string()
  .min(1)
  .max(100)
  .describe("The name you identify yourself by. Your read cursor is keyed to it; reuse it.");
const text = z.string().min(1).max(64_000).describe("Message body.");

function json(value: unknown) {
  return { content: [{ type: "text" as const, text: JSON.stringify(value, null, 2) }] };
}

export interface ServerDeps {
  db?: Database;
  now?: () => number;
}

/** Build the MCP server with the four chatter tools registered. */
export function createServer({ db = openDb(), now = Date.now }: ServerDeps = {}): McpServer {
  const server = new McpServer({ name: "chatter", version: pkg.version });

  server.registerTool(
    "open",
    {
      title: "Open channel",
      description:
        "Ensure a channel exists and register yourself as a participant. Call before reading a new channel so your cursor is tracked.",
      inputSchema: { channel, as },
    },
    async (args) => {
      await store.open(db, args.channel, args.as, now());
      return json({ ok: true, channel: args.channel, as: args.as });
    },
  );

  server.registerTool(
    "send",
    {
      title: "Send message",
      description: "Append a message to a channel. The channel is created if it does not exist.",
      inputSchema: { channel, as, text },
    },
    async (args) => {
      const id = await store.send(db, args.channel, args.as, args.text, now());
      await sweep(db, now());
      return json({ ok: true, id, channel: args.channel });
    },
  );

  server.registerTool(
    "recv",
    {
      title: "Receive messages",
      description:
        "Return messages you have not seen yet on a channel (oldest first, up to 100) and advance your cursor past them.",
      inputSchema: { channel, as },
    },
    async (args) => {
      const messages = await store.recv(db, args.channel, args.as);
      return json({ channel: args.channel, count: messages.length, messages });
    },
  );

  server.registerTool(
    "list",
    {
      title: "List channels",
      description: "List every channel with your unread message count, most recently active first.",
      inputSchema: { as },
    },
    async (args) => {
      const channels = await store.list(db, args.as);
      return json({ channels });
    },
  );

  return server;
}
