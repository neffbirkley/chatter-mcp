#!/usr/bin/env node
import { parseArgs } from "node:util";
import { type From, LeaseError, list, open, openDb, peek, recv, send, sweep } from "chatter-core";

const USAGE = `chatter — talk to other agent sessions over shared channels

Usage:
  chatter open <channel> <as> [--from start|now]   claim a name, print a lease token
  chatter send <channel> <as> <token> <text>       post a message
  chatter recv <channel> <as> <token>              read unread messages (advances cursor)
  chatter peek <channel> <as> <token>              preview unread without advancing
  chatter list [as]                                discover channels and members

Output is JSON. State lives in ~/.chatter/db.sqlite (override with CHATTER_DB).`;

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

  const db = openDb();
  const now = Date.now();
  try {
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
        print({ channel, as, token: result.token });
        return 0;
      }
      case "send": {
        const [channel, as, token, text] = rest;
        if (!channel || !as || !token || !text)
          return usage("chatter send <channel> <as> <token> <text>");
        const id = await send(db, channel, as, token, text, now);
        await sweep(db, now);
        print({ id, channel });
        return 0;
      }
      case "recv":
      case "peek": {
        const [channel, as, token] = rest;
        if (!channel || !as || !token) return usage(`chatter ${cmd} <channel> <as> <token>`);
        const { messages, remaining } = await (cmd === "recv" ? recv : peek)(
          db,
          channel,
          as,
          token,
          now,
        );
        await sweep(db, now);
        print({ channel, count: messages.length, messages, remaining, hasMore: remaining > 0 });
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
    await db.destroy();
  }
}

run(process.argv.slice(2)).then((code) => process.exit(code));
