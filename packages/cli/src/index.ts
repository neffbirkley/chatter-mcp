#!/usr/bin/env node
import { parseArgs } from "node:util";
import {
  ack,
  type Database,
  type From,
  LeaseError,
  list,
  open,
  openDb,
  peek,
  receipts,
  recv,
  send,
  sweep,
} from "chatter-core";

const USAGE = `chatter — talk to other agent sessions over shared channels

Usage:
  chatter open <channel> <as> [--from start|now]   claim a name, print a lease token (+ backlog)
  chatter send <channel> <as> <token> <text> [--to a,b]   post a message (--to targets recipients)
  chatter recv <channel> <as> <token> [--wait-ms N]       read unread (advances cursor; --wait-ms blocks)
  chatter peek <channel> <as> <token> [--wait-ms N] [--ids 1,2]   preview unread, or fetch ids w/ receipts
  chatter ack  <channel> <as> <token> --ids 1,2           confirm messages read (read receipts)
  chatter list [as]                                discover channels and members

Output is JSON. State lives in ~/.chatter/db.sqlite (override with CHATTER_DB).`;

/** Parse a comma-separated list flag into trimmed non-empty parts. */
function csv(value: string | undefined): string[] {
  return (value ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

function print(value: unknown): void {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

function usage(line: string): number {
  process.stderr.write(`usage: ${line}\n`);
  return 1;
}

async function run(argv: string[]): Promise<number> {
  const [cmd, ...rest] = argv;
  if (!cmd || cmd === "-h" || cmd === "--help") {
    process.stdout.write(`${USAGE}\n`);
    return 0;
  }

  let db: Database | undefined;
  try {
    db = openDb();
    const now = Date.now();
    switch (cmd) {
      case "open": {
        const { values, positionals } = parseArgs({
          args: rest,
          allowPositionals: true,
          options: { from: { type: "string", default: "start" } },
        });
        const [channel, as] = positionals;
        if (!channel || !as) return usage("chatter open <channel> <as> [--from start|now]");
        const result = await open(db, channel, as, now, values.from as From);
        if (!result.granted) {
          print({
            ok: false,
            error: `name '${as}' is active in '${channel}'`,
            retryAfterMs: result.retryAfterMs,
          });
          return 2;
        }
        print({ channel, as, token: result.token, backlog: result.backlog });
        return 0;
      }
      case "send": {
        const { values, positionals } = parseArgs({
          args: rest,
          allowPositionals: true,
          options: { to: { type: "string" } },
        });
        const [channel, as, token, text] = positionals;
        if (!channel || !as || !token || !text)
          return usage("chatter send <channel> <as> <token> <text> [--to a,b]");
        const recipients = values.to ? csv(values.to) : undefined;
        const id = await send(db, channel, as, token, text, now, recipients);
        await sweep(db, now);
        print({ id, channel });
        return 0;
      }
      case "recv":
      case "peek": {
        const { values, positionals } = parseArgs({
          args: rest,
          allowPositionals: true,
          options: { "wait-ms": { type: "string" }, ids: { type: "string" } },
        });
        const [channel, as, token] = positionals;
        if (!channel || !as || !token)
          return usage(`chatter ${cmd} <channel> <as> <token> [--wait-ms N]`);
        // peek --ids: fetch specific messages with their read receipts.
        if (cmd === "peek" && values.ids !== undefined) {
          const messages = await receipts(db, channel, as, token, now, csv(values.ids).map(Number));
          await sweep(db, now);
          print({ channel, count: messages.length, messages, remaining: 0, hasMore: false });
          return 0;
        }
        const waitMs = values["wait-ms"] ? Number(values["wait-ms"]) : 0;
        const { messages, remaining } = await (cmd === "recv" ? recv : peek)(
          db,
          channel,
          as,
          token,
          now,
          { waitMs },
        );
        await sweep(db, now);
        print({ channel, count: messages.length, messages, remaining, hasMore: remaining > 0 });
        return 0;
      }
      case "ack": {
        const { values, positionals } = parseArgs({
          args: rest,
          allowPositionals: true,
          options: { ids: { type: "string" } },
        });
        const [channel, as, token] = positionals;
        if (!channel || !as || !token || !values.ids)
          return usage("chatter ack <channel> <as> <token> --ids 1,2");
        const acked = await ack(db, channel, as, token, now, csv(values.ids).map(Number));
        await sweep(db, now);
        print({ channel, acked });
        return 0;
      }
      case "list": {
        const channels = await list(db, rest[0]);
        await sweep(db, now);
        print({ channels });
        return 0;
      }
      default:
        process.stderr.write(`chatter: unknown command '${cmd}'. Run 'chatter --help'.\n`);
        return 1;
    }
  } catch (err) {
    process.stderr.write(
      `chatter: ${err instanceof LeaseError || err instanceof Error ? err.message : String(err)}\n`,
    );
    return 1;
  } finally {
    if (db) await db.destroy();
  }
}

run(process.argv.slice(2)).then((code) => process.exit(code));
