/**
 * Column types shared by the schemas of several modules. Not a table file:
 * `db/schema.ts` does not re-export it.
 */
import { customType } from "drizzle-orm/pg-core";

/** A `bytea` column, read and written as a Buffer (avatars, journal assets). */
export const bytea = customType<{ data: Buffer }>({
  dataType() {
    return "bytea";
  },
});
