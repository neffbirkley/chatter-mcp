// Child process used by concurrency.test.ts: hammer the shared DB with writes
// through the real openDb() path (WAL + busy_timeout) to prove concurrent
// writers from separate processes don't throw SQLITE_BUSY.
import { openDb } from "../src/db.ts";
import { open, send } from "../src/store.ts";

const [, , dbPath, sender, countStr] = process.argv;
if (!dbPath || !sender || !countStr) {
  process.stderr.write("usage: _writer.ts <dbPath> <sender> <count>\n");
  process.exit(2);
}

const db = openDb(dbPath);
const count = Number(countStr);
const lease = await open(db, "race", sender, Date.now());
if (!lease.granted) {
  process.stderr.write(`${sender}: lease denied\n`);
  process.exit(1);
}
for (let i = 0; i < count; i++) {
  await send(db, "race", sender, lease.token, `${sender}:${i}`, Date.now());
}
await db.destroy();
process.exit(0);
