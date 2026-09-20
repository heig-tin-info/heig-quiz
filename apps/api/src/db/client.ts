import { mkdirSync } from "node:fs";

import { PGlite } from "@electric-sql/pglite";
import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import { migrate as migrateNode } from "drizzle-orm/node-postgres/migrator";
import { drizzle as drizzlePglite } from "drizzle-orm/pglite";
import { migrate as migratePglite } from "drizzle-orm/pglite/migrator";
import pg from "pg";

import { pgliteDir } from "../config.js";
import * as schema from "./schema.js";

/**
 * The one database handle type. The embedded PGlite driver exposes the same
 * query builder surface as node-postgres, so the modules never learn which
 * of the two they are talking to; only migrations and shutdown differ, and
 * both live in this file.
 */
export type Db = NodePgDatabase<typeof schema>;

export interface DbHandle {
  db: Db;
  /** True when running on the embedded, single-process database. */
  embedded: boolean;
  /** Applies the Drizzle migrations of `drizzle/` to this handle. */
  migrate: (migrationsFolder: string) => Promise<void>;
  close: () => Promise<void>;
}

/** Just enough of `app.log` to report a pool failure; `console` also fits. */
type PoolLogger = { error: (obj: object, msg: string) => void };

export function createDb(databaseUrl: string, log: PoolLogger = console): DbHandle {
  const dir = pgliteDir(databaseUrl);
  if (dir) {
    // Embedded Postgres persisted on disk: `pnpm dev` with no container
    // engine and no server to install (see CLAUDE.md, Development).
    mkdirSync(dir, { recursive: true });
    const client = new PGlite(dir);
    const db = drizzlePglite(client, { schema }) as unknown as Db;
    return {
      db,
      embedded: true,
      migrate: (migrationsFolder) =>
        migratePglite(db as never, { migrationsFolder }),
      close: () => client.close(),
    };
  }

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
    embedded: false,
    migrate: (migrationsFolder) => migrateNode(db, { migrationsFolder }),
    close: () => pool.end(),
  };
}
