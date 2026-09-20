import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Drizzle migrations folder, resolved from THIS module rather than from the
 * working directory: `dist/` and `src/` both sit one level under the package
 * root, so the same expression works for `tsx` and for the built server.
 */
export const MIGRATIONS_DIR = join(dirname(fileURLToPath(import.meta.url)), "../drizzle");
