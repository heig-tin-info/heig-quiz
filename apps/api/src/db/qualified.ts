import { getTableName, sql, type AnyColumn, type SQL } from "drizzle-orm";

/**
 * `"table"."column"`, always. A bare `${table.column}` inside a `sql`
 * fragment renders WITHOUT its table whenever drizzle believes the
 * surrounding statement reads a single table — a correlated subquery in the
 * select list of `select … from pools` came out as `"pool_id" = "id"`, both
 * resolved against the subquery's table, and every pool counted zero.
 * Qualifying by hand makes a fragment independent of the statement it is
 * dropped into. Its own file, without the client, so a schema file may use
 * it (`db/gradebook.ts`) without importing the schema back.
 */
export function qualified(column: AnyColumn): SQL {
  return sql`${sql.identifier(getTableName(column.table))}.${sql.identifier(column.name)}`;
}
