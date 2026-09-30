/**
 * Attested kiosk stations (ADR-051): the school's Chromebooks locked on
 * `/kiosk`, and the pairings that open a `kiosk` session on one of them from
 * the student's phone (RFC 8628, adapted). The whole schema lands at once
 * (migration `0039_kiosk`) so that the steps of ADR-051 §10 never collide on
 * migrations; the kiosk module that writes these tables comes with steps 4
 * and 6. Every other module reads them by join and never writes them.
 *
 * `sessions.device_id` (db/auth.ts) points here. The two files import each
 * other; that holds because a Drizzle `references(() => …)` is resolved
 * lazily, the same way auth.ts and evaluation.ts already do.
 */
import { char, index, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";

import { KIOSK_ATTESTATIONS, KIOSK_DEVICE_STATUSES } from "@quiz/contracts";
import { KIOSK_WATCHES } from "@quiz/domain";

import { users } from "./auth.js";
import { evaluations } from "./evaluation.js";

/**
 * The station registry (ADR-051 §5), platform-wide and admin-only: a station
 * belongs to no course. A device that attests for the first time is created
 * `unnamed`; only an admin makes it `active` (by naming it) or `retired`, and
 * only an `active` station can be paired.
 */
export const kioskDevices = pgTable("kiosk_devices", {
  id: uuid("id").primaryKey(),
  /** Verified Access's `devicePermanentId`. */
  googleDeviceId: text("google_device_id").notNull().unique(),
  /** What the station's screen and the student's phone show: "Poste de secours n° 7". */
  label: text("label"),
  status: text("status", { enum: KIOSK_DEVICE_STATUSES })
    .notNull()
    .default("unnamed"),
  /** The last attestation Google accepted. */
  attestedAt: timestamp("attested_at", { withTimezone: true }),
  /** The last attempt at an attestation (§6), and what came of it. */
  checkedAt: timestamp("checked_at", { withTimezone: true }),
  attestation: text("attestation", { enum: KIOSK_ATTESTATIONS }),
  /**
   * What the supervisor was last told of this station (ADR-051 §6):
   * `ok`, `unavailable` (Google cannot attest it) or `suspended` (refused, or
   * silent). A change is told once, by the conditional UPDATE that moves it
   * (`modules/kiosk/watch.ts`).
   */
  watch: text("watch", { enum: KIOSK_WATCHES }).notNull().default("ok"),
  /** Hex SHA-256 of the station's `quiz_kiosk` cookie, never the cookie itself. */
  credentialHash: char("credential_hash", { length: 64 }).unique(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

/**
 * One pairing of a station with a student and an exam (ADR-051 §7):
 * `pending → approved → consumed`, or `expired`. Only the SHA-256 of the two
 * codes is stored; the student, the evaluation and who approved are set on
 * approval. Consumed by one conditional UPDATE, like a launch ticket.
 */
export const kioskPairings = pgTable(
  "kiosk_pairings",
  {
    id: uuid("id").primaryKey(),
    deviceId: uuid("device_id")
      .notNull()
      .references(() => kioskDevices.id, { onDelete: "cascade" }),
    deviceCodeHash: char("device_code_hash", { length: 64 }).notNull().unique(),
    userCodeHash: char("user_code_hash", { length: 64 }).notNull(),
    state: text("state", { enum: ["pending", "approved", "consumed", "expired"] }).notNull(),
    /** The student the station will sit as; null until approved. */
    userId: uuid("user_id").references(() => users.id, { onDelete: "cascade" }),
    evaluationId: uuid("evaluation_id").references(() => evaluations.id, { onDelete: "cascade" }),
    /** Who approved: the student from their phone, or the supervisor (`kiosk-assign`). */
    approvedBy: uuid("approved_by").references(() => users.id, { onDelete: "set null" }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    approvedAt: timestamp("approved_at", { withTimezone: true }),
    consumedAt: timestamp("consumed_at", { withTimezone: true }),
  },
  (t) => [
    index("kiosk_pairings_user_code_idx").on(t.userCodeHash),
    index("kiosk_pairings_device_state_idx").on(t.deviceId, t.state),
  ],
);
