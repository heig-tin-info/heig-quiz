/**
 * The paper sheet of a paper attempt (ADR-125 §9, §13, §15, §16). Owned by
 * the `paper` module, its only writer (`modules/paper/service.ts`).
 *
 * One row per attempt of origin `paper`, written in the transaction that
 * creates the attempt, and rewritten only by a scan upload. It records what
 * the attempt row cannot say: the day the paper was sat (the attempt's
 * `submitted_at` is the server's time of entry, invariant 5), who entered
 * it, the paper variant it was typed from, and the scan of the copy when one
 * is attached.
 *
 * The scan's file lives under `ASSETS_DIR/paper/<attempt_id>/<sha256>.<ext>`:
 * its path is rebuilt from the attempt id, the hash and the type, never
 * stored, and no `assets` row points at it — `/app/api/assets/:id` never
 * serves it. The row goes with its attempt (cascade); the file is swept by
 * the service.
 */
import { sql } from "drizzle-orm";
import { check, date, integer, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";

import { PAPER_SCAN_MIMES } from "@quiz/domain";

import { users } from "./auth.js";
import { attempts } from "./live.js";

export const paperSheets = pgTable("paper_sheets", {
  attemptId: uuid("attempt_id")
    .primaryKey()
    .references(() => attempts.id, { onDelete: "cascade" }),
  /** The day the paper was sat, as written; the evaluation's opening day by default. */
  examDate: date("exam_date", { mode: "string" }).notNull(),
  /**
   * The number of the paper variant the copy was typed from (ADR-148), as its
   * page footer names it; 1 for every copy entered before variants. Not a
   * reference: no variant is removed once the evaluation opened, and a copy
   * needs it opened (ADR-148 §11).
   */
  variant: integer("variant").notNull().default(1),
  /** The staff member who typed the copy in. NO ACTION, like `attempts.user_id`. */
  enteredBy: uuid("entered_by")
    .notNull()
    .references(() => users.id),
  scanMime: text("scan_mime", { enum: PAPER_SCAN_MIMES }),
  scanBytes: integer("scan_bytes"),
  scanSha256: text("scan_sha256"),
  scanUploadedAt: timestamp("scan_uploaded_at", { withTimezone: true }),
  scanUploadedBy: uuid("scan_uploaded_by").references(() => users.id),
}, (t) => [check("paper_sheets_variant_ck", sql`${t.variant} >= 1`)]);
