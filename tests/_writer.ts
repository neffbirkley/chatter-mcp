// Child process used by concurrency.test.ts: hammer the shared DB with writes
// through the real openDb() path (WAL + busy_timeout) to prove concurrent
// writers from separate processes don't throw SQLITE_BUSY.
import { openDb } from "../src/db.ts";
import { send } from "../src/store.ts";

const [, , dbPath, sender, countStr] = process.argv;
if (!dbPath || !sender || !countStr) {
  process.stderr.write("usage: _writer.ts <dbPath> <sender> <count>\n");
  process.exit(2);
}

const db = openDb(dbPath);
const count = Number(countStr);
for (let i = 0; i < count; i++) {
  send(db, "race", sender, `${sender}:${i}`, Date.now());
}
process.exit(0);
