import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import { migrate as migrateNode } from "drizzle-orm/node-postgres/migrator";
import pg from "pg";

import * as schema from "./schema.js";

/** The one database handle type. */
export type Db = NodePgDatabase<typeof schema>;

export interface DbHandle {
  db: Db;
  /** Applies the Drizzle migrations of `drizzle/` to this handle. */
  migrate: (migrationsFolder: string) => Promise<void>;
  close: () => Promise<void>;
}

/** Just enough of `app.log` to report a pool failure; `console` also fits. */
type PoolLogger = { error: (obj: object, msg: string) => void };

export function createDb(databaseUrl: string, log: PoolLogger = console): DbHandle {
  const pool = new pg.Pool({
    connectionString: databaseUrl,
    max: 10,
    // The database is local (same VM): a slow connect is an outage, not
    // latency, so we fail fast and /healthz turns degraded.
    connectionTimeoutMillis: 2000,
  });
  // pg.Pool is an EventEmitter, and an *idle* client that dies (Postgres
  // restart, OOM kill, network reset) has no pending query to reject: pg-pool
  // drops the client and emits `error` on the pool. Node turns an unhandled
  // `error` event into an uncaught exception, so this listener is what keeps
  // the process alive, not just diagnostics.
  pool.on("error", (err) => {
    log.error({ err, cause: err.cause }, "idle database client error");
  });
  const db = drizzle(pool, { schema });
  return {
    db,
    migrate: (migrationsFolder) => migrateNode(db, { migrationsFolder }),
    close: () => pool.end(),
  };
}
