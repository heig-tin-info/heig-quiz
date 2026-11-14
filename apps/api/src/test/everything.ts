/**
 * Every row of every table of every non-system schema, as text: what a
 * person who can read the database could read. The search of the identity
 * wipes (`stagingScrub.db.test.ts`, `modules/account/service.db.test.ts`).
 * A bytea shows as its hex, so a marker is looked for in both forms.
 */
import type { PGlite } from "@electric-sql/pglite";

/** One dump per table, `schema.table`, in a stable order. */
export async function tableDumps(pg: PGlite): Promise<{ table: string; dump: string }[]> {
  const tables = await pg.query<{ schema: string; name: string }>(
    `SELECT table_schema AS schema, table_name AS name FROM information_schema.tables
     WHERE table_type = 'BASE TABLE' AND table_schema NOT IN ('pg_catalog', 'information_schema') AND table_schema NOT LIKE 'pg\\_%'
     ORDER BY 1, 2`,
  );
  const dumps: { table: string; dump: string }[] = [];
  for (const { schema, name } of tables.rows) {
    const rows = await pg.query<{ dump: string | null }>(`SELECT json_agg(t ORDER BY t::text)::text AS dump FROM "${schema}"."${name}" t`);
    dumps.push({ table: `${schema}.${name}`, dump: rows.rows[0]?.dump ?? "" });
  }
  return dumps;
}

/** The whole database as one text. */
export async function everything(pg: PGlite): Promise<string> {
  return (await tableDumps(pg)).map((t) => `${t.table}: ${t.dump}`).join("\n");
}

export const hex = (text: string) => Buffer.from(text, "utf8").toString("hex");

/** The tables in which `marker` appears, as text or as a bytea's hex. */
export function tablesHolding(dumps: readonly { table: string; dump: string }[], marker: string): string[] {
  return dumps.filter((t) => t.dump.includes(marker) || t.dump.includes(hex(marker))).map((t) => t.table);
}
