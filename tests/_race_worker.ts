// Child process for the recv-contention test: interleave send+recv on one
// shared channel as a distinct participant. Each recv reads the cursor then
// writes it (read-modify-write) — the pattern that throws SQLITE_BUSY_SNAPSHOT
// across processes under a deferred BEGIN. Exits non-zero if any call throws.
import { openDb } from "../src/db.ts";
import { open, recv, send } from "../src/store.ts";

const [, , dbPath, id, itersStr] = process.argv;
if (!dbPath || !id || !itersStr) {
  process.stderr.write("usage: _race_worker.ts <dbPath> <id> <iters>\n");
  process.exit(2);
}

const db = openDb(dbPath);
const iters = Number(itersStr);
try {
  const lease = await open(db, "race", id, Date.now());
  if (!lease.granted) throw new Error("lease denied");
  for (let i = 0; i < iters; i++) {
    await send(db, "race", id, lease.token, `${id}:${i}`, Date.now());
    await recv(db, "race", id, lease.token, Date.now());
  }
  await db.destroy();
  process.exit(0);
} catch (err) {
  process.stderr.write(`${id}: ${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
}
