#!/usr/bin/env node
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { openDb, sweep } from "chatter-core";
import { createServer } from "./server.js";

async function main(): Promise<void> {
  const db = openDb();
  // Prune stale channels once at startup; `send` keeps it swept thereafter.
  await sweep(db, Date.now(), { force: true });

  const server = createServer({ db });
  const transport = new StdioServerTransport();

  // Close the DB on exit so WAL is checkpointed and no -wal/-shm files leak.
  let closing = false;
  const shutdown = async () => {
    if (closing) return;
    closing = true;
    try {
      await server.close();
      await db.destroy();
    } finally {
      process.exit(0);
    }
  };
  // Client disconnect (stdin EOF) and process signals both trigger cleanup.
  transport.onclose = shutdown;
  process.once("SIGINT", shutdown);
  process.once("SIGTERM", shutdown);

  await server.connect(transport);
  // stdout is the MCP protocol channel — never write to it. Logs go to stderr.
  process.stderr.write("chatter: ready on stdio\n");
}

main().catch((err) => {
  process.stderr.write(`chatter: fatal: ${err instanceof Error ? err.stack : String(err)}\n`);
  process.exit(1);
});
