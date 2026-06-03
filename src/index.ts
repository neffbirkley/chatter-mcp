#!/usr/bin/env node
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { sweep } from "./cleanup.js";
import { openDb } from "./db.js";
import { createServer } from "./server.js";

async function main(): Promise<void> {
  const db = openDb();
  // Prune stale channels once at startup; `send` keeps it swept thereafter.
  await sweep(db, Date.now(), { force: true });

  const server = createServer({ db });
  const transport = new StdioServerTransport();
  await server.connect(transport);
  // stdout is the MCP protocol channel — never write to it. Logs go to stderr.
  process.stderr.write("agent-mailbox: ready on stdio\n");
}

main().catch((err) => {
  process.stderr.write(`agent-mailbox: fatal: ${err instanceof Error ? err.stack : String(err)}\n`);
  process.exit(1);
});
