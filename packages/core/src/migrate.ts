/**
 * The two config helpers a type whose schema stamps its own `configVersion`
 * shares — `code`, `codeimage` and `circuit` — instead of writing them out
 * three times.
 */
import type { z } from "zod";
import type { QuestionTypeId } from "./contract.js";
import { ConfigMigrationError } from "./errors.js";

const asRecord = (raw: unknown): object => (typeof raw === "object" && raw !== null ? raw : {});

/**
 * A {@link QuestionTypeServer.migrate} that reparses: a newer version throws,
 * the current one is returned as it stands — a DRAFT may be invalid (decision
 * D16: the empty draft is), and the contract says `migrate` never throws on a
 * config the type emitted — and an older one is parsed with its version
 * stamped, the issues joined into the error when it fails.
 */
export function reparseMigrate<T>(
  id: QuestionTypeId,
  schema: z.ZodType<T>,
  version: number,
): (config: unknown, fromVersion: number) => T {
  return (config, fromVersion) => {
    if (fromVersion > version) {
      throw new ConfigMigrationError(
        id,
        fromVersion,
        version,
        "config written by a newer version of the platform",
      );
    }
    if (fromVersion === version) return config as T;
    const parsed = schema.safeParse({ ...asRecord(config), configVersion: version });
    if (!parsed.success) {
      throw new ConfigMigrationError(
        id,
        fromVersion,
        version,
        parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; "),
      );
    }
    return parsed.data;
  };
}

/**
 * A {@link QuestionTypeServer.fromCanonical} for a schema that carries its
 * `configVersion`: the canonical form never writes it, so it is stamped
 * before the parse.
 */
export function canonicalParse<T>(schema: z.ZodType<T>, version: number): (raw: unknown) => T {
  return (raw) => schema.parse({ ...asRecord(raw), configVersion: version });
}
