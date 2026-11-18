/**
 * The `paper` module (ADR-125 §9–§16, F-PAPER-01..05): a copy sat on paper,
 * typed in by a staff member and handed in ONCE, and its scan.
 *
 *   - {@link paperItems}: the paper as the student read it — the student
 *     views of the evaluation's paper seed, the hand-out's order — with the
 *     key beside each item, for the entry page. Staff only;
 *   - {@link enterPaperCopy}: the submission. Refused unless the evaluation
 *     is an exam that has run, is not released and prints, and the student
 *     holds a claimed student seat of its classroom; each answer read
 *     through the student save's path; then ONE transaction: the `live`
 *     module ends the student's unfinished attempt, inserts the paper
 *     attempt and marks what it replaces, and this module writes its
 *     `paper_sheets` row;
 *   - {@link attachScan}, {@link readScan}, {@link paperSheet}: the scan,
 *     stored under `ASSETS_DIR/paper/<attemptId>/<sha256>.<ext>`, served to
 *     the staff only.
 *
 * This module owns `paper_sheets` and is its only writer. It never writes
 * `attempts` nor `answers`: the `live` module does, through its service.
 */
import { readdir, rm } from "node:fs/promises";

import { and, eq } from "drizzle-orm";
import type { FastifyInstance } from "fastify";

import type { PaperAttemptBody, PaperItems, PaperRefusal, PaperScanMime, PaperSheet } from "@quiz/contracts";
import { localDate } from "@quiz/domain";

import { iso } from "../../clock.js";
import { isUniqueViolation, type Db, type Tx } from "../../db/client.js";
import { enrollments, evaluations, paperSheets, users } from "../../db/schema.js";
import * as evaluation from "../evaluation/service.js";
import type { EvaluationRecord, JoinedItem } from "../evaluation/service.js";
import { refusalClass, type Refusal } from "../http.js";
import * as live from "../live/service.js";
import { readAsset, safeJoin, sha256Of, sniffImage, writeAsset } from "../pool/assets.js";

/**
 * Every refusal of this module: the contract's `PAPER_REFUSALS` but the
 * student save's own (`answer_invalid`, the `live` module's), and the scan's.
 */
const REFUSALS = {
  // ADR-125 §11: an exam only, from its first run until its release.
  paper_mode: [409, "only an exam takes a paper copy"],
  paper_released: [409, "the results are released: no paper copy is entered any more"],
  paper_not_started: [409, "the exam has not run yet"],
  // §5: what does not print has no paper to type in; `PrintRefusal` in the body.
  not_printable: [409],
  // §9: the student is a claimed, non-staff seat of the classroom.
  paper_no_seat: [422, "this person holds no claimed student seat in the classroom"],
  // Two copies of one student handed in at the same instant: the second is refused.
  paper_conflict: [409, "another paper copy of this student was just handed in"],
  // §15: the bytes are neither a PDF, a PNG nor a JPEG.
  scan_unsupported: [415, "a scan is a PDF, a PNG or a JPEG"],
  not_found: [404],
} satisfies Record<Exclude<PaperRefusal, "answer_invalid">, Refusal> &
  Record<"scan_unsupported" | "not_found", Refusal>;

export class PaperError extends refusalClass("PaperError", REFUSALS) {}

/** The file extension of each scan type: the path is rebuilt from it, never stored. */
const EXTENSION: Record<PaperScanMime, string> = {
  "application/pdf": "pdf",
  "image/png": "png",
  "image/jpeg": "jpg",
};

/**
 * The items of `record`, or its refusal (ADR-125 §5, §11): the one rule
 * `paperRefusal`, which the screens read as `EvaluationDetail.exports.paper`.
 */
async function eligibleItems(db: Db, record: EvaluationRecord): Promise<JoinedItem[]> {
  const items = await evaluation.joinedItems(db, record.id);
  const refusal = evaluation.paperRefusal(record, items);
  if (refusal) throw new PaperError(refusal.code, undefined, refusal.print ?? undefined);
  return items;
}

/**
 * The student whose copy it is: a claimed, non-staff seat of the classroom
 * (invariant 6), else `422 paper_no_seat`. Inside the submission's
 * transaction, the seat is locked: two copies of one student entered at the
 * same instant are handed in one after the other.
 */
async function studentSeat(db: Db | Tx, record: EvaluationRecord, userId: string, lock = false) {
  const query = db
    .select({ prenom: enrollments.prenom, nom: enrollments.nom, email: enrollments.email })
    .from(enrollments)
    .innerJoin(users, eq(users.id, enrollments.userId))
    .where(and(evaluation.seatsOf(record), eq(enrollments.userId, userId), eq(enrollments.staff, false)))
    .limit(1);
  const [seat] = lock ? await query.for("update", { of: enrollments }) : await query;
  if (!seat) throw new PaperError("paper_no_seat");
  return { userId, displayName: `${seat.prenom} ${seat.nom}`.trim() || seat.email };
}

/**
 * The entry page's paper (ADR-125 §8, §9): the evaluation exactly as the
 * hand-out printed it — the student views of the paper seed, built by the
 * one builder of an attempt's view — with the whole key of each item in the
 * coordinates of that view, and the attempt the copy would replace. Refused
 * like the submission, so the page never offers what the server refuses.
 * The seed itself goes nowhere.
 */
export async function paperItems(
  db: Db,
  record: EvaluationRecord,
  userId: string,
  now: Date,
): Promise<PaperItems> {
  const items = await eligibleItems(db, record);
  const student = await studentSeat(db, record, userId);
  const seed = await evaluation.paperSeedOf(db, record);
  const current = await live.attemptOf(db, record.id, userId);
  return {
    student,
    view: await live.previewView(db, record, now, seed, items),
    solutions: live.paperKey(record, items, seed),
    replaces: current && { attemptId: current.id, state: current.state, origin: current.origin },
    examDate: localDate(record.opensAt ?? record.startedAt!),
  };
}

/**
 * The submission (ADR-125 §9): refused as a whole, or the paper attempt
 * handed in, with its sheet, in one transaction — then the dashboard told,
 * and a closed exam's grading sent. Audited by the route.
 */
export async function enterPaperCopy(
  app: FastifyInstance,
  record: EvaluationRecord,
  body: PaperAttemptBody,
  by: string,
  now: Date,
): Promise<live.InsertedPaperAttempt> {
  const { db } = app;
  const items = await eligibleItems(db, record);
  await studentSeat(db, record, body.userId);
  const seed = await evaluation.paperSeedOf(db, record);
  // Before any write: one refused answer refuses the copy.
  const answers = live.paperAnswers(record, items, seed, body.answers, body.coordinates);
  let inserted: live.InsertedPaperAttempt;
  try {
    inserted = await db.transaction(async (tx) => {
      // The evaluation as it stands now, held until the commit: a release (or
      // any move of its state) between the checks above and the insert either
      // waits for this copy or is seen here and refuses it.
      const [current] = await tx.select().from(evaluations).where(eq(evaluations.id, record.id)).for("share");
      const moved = current ? evaluation.paperRefusal(current, []) : { code: "paper_mode" as const };
      if (moved) throw new PaperError(moved.code);
      await studentSeat(tx, record, body.userId, true);
      const rows = await live.insertPaperAttempt(tx, { evaluation: record, userId: body.userId, seed, answers, now });
      await tx.insert(paperSheets).values({ attemptId: rows.attempt.id, examDate: body.examDate, enteredBy: by });
      return rows;
    });
  } catch (error) {
    throw conflictOf(error);
  }
  await live.announcePaperAttempt(app, record, inserted, now);
  return inserted;
}

/**
 * The seat's lock serializes two entries of one student; a race it misses
 * still lands on the attempt number's unique index, and is told as
 * `409 paper_conflict`. Anything else is thrown as it came.
 */
export function conflictOf(error: unknown): unknown {
  return isUniqueViolation(error, "attempts_evaluation_user_number_uq") ? new PaperError("paper_conflict") : error;
}

/** The sheet of a paper attempt, or `404` for any other attempt. */
export async function paperSheet(db: Db, attemptId: string): Promise<PaperSheet> {
  return sheetOut(await sheetRow(db, attemptId));
}

async function sheetRow(db: Db, attemptId: string) {
  const [row] = await db.select().from(paperSheets).where(eq(paperSheets.attemptId, attemptId)).limit(1);
  if (!row) throw new PaperError("not_found", "No such paper copy");
  return row;
}

function sheetOut(row: typeof paperSheets.$inferSelect): PaperSheet {
  const scanned = row.scanMime !== null && row.scanBytes !== null && row.scanUploadedAt !== null;
  return {
    attemptId: row.attemptId,
    examDate: row.examDate,
    scan: scanned ? { mime: row.scanMime!, bytes: row.scanBytes!, uploadedAt: iso(row.scanUploadedAt!) } : null,
  };
}

/** The scan's directory, relative to `ASSETS_DIR`: one per attempt. */
const scanDir = (attemptId: string) => `paper/${attemptId}`;

/** The scan's file, rebuilt from the attempt, the hash and the type. */
const scanPath = (attemptId: string, sha256: string, mime: PaperScanMime) =>
  `${scanDir(attemptId)}/${sha256}.${EXTENSION[mime]}`;

/** A scan's type, by its bytes alone (ADR-125 §15): the header is never believed. */
export function scanMimeOf(bytes: Buffer): PaperScanMime | null {
  if (bytes.subarray(0, 5).toString("latin1") === "%PDF-") return "application/pdf";
  const image = sniffImage(bytes)?.mime;
  return image === "image/png" || image === "image/jpeg" ? image : null;
}

/**
 * Attaches the scan of a paper copy (ADR-125 §15): a PDF, PNG or JPEG by its
 * bytes, else `415`; written content-addressed under the attempt's own
 * directory, then the sheet rewritten. A second upload replaces the first:
 * the old file is swept once the row names the new one.
 */
export async function attachScan(
  db: Db,
  assetsDir: string,
  attemptId: string,
  bytes: Buffer,
  by: string,
  now: Date,
): Promise<PaperSheet> {
  const before = await sheetRow(db, attemptId);
  const mime = scanMimeOf(bytes);
  if (!mime) throw new PaperError("scan_unsupported");
  const sha256 = sha256Of(bytes);
  const path = scanPath(attemptId, sha256, mime);
  await writeAsset(assetsDir, path, bytes);
  const [row] = await db
    .update(paperSheets)
    .set({ scanMime: mime, scanBytes: bytes.length, scanSha256: sha256, scanUploadedAt: now, scanUploadedBy: by })
    .where(eq(paperSheets.attemptId, attemptId))
    .returning();
  const old = before.scanSha256 !== null && before.scanMime !== null ? scanPath(attemptId, before.scanSha256, before.scanMime) : null;
  if (old !== null && old !== path) await sweep(assetsDir, old);
  return sheetOut(row!);
}

/** The scan's bytes and type, or `404` when the copy has none (or its file went missing). */
export async function readScan(
  db: Db,
  assetsDir: string,
  attemptId: string,
): Promise<{ bytes: Buffer; mime: PaperScanMime; filename: string }> {
  const row = await sheetRow(db, attemptId);
  if (row.scanSha256 === null || row.scanMime === null) throw new PaperError("not_found", "No scan");
  try {
    const bytes = await readAsset(assetsDir, scanPath(attemptId, row.scanSha256, row.scanMime));
    return { bytes, mime: row.scanMime, filename: `paper-${attemptId}.${EXTENSION[row.scanMime]}` };
  } catch {
    throw new PaperError("not_found", "No scan");
  }
}

/** Removes a file or a directory under `ASSETS_DIR`; one already gone is no error. */
async function sweep(assetsDir: string, relative: string): Promise<void> {
  await rm(safeJoin(assetsDir, relative), { recursive: true, force: true });
}

/**
 * The scheduled sweep (ADR-125 §15): the scan directories under
 * `ASSETS_DIR/paper/` whose attempt has no sheet any more — its attempt was
 * deleted, and the row with it by cascade (an evaluation, a classroom or a
 * course deleted) — removed with their files. Answers how many.
 */
export async function sweepOrphanScans(db: Db, assetsDir: string): Promise<number> {
  let names: string[];
  try {
    names = await readdir(safeJoin(assetsDir, "paper"));
  } catch {
    return 0; // No scan was ever stored.
  }
  const kept = new Set(
    (await db.select({ id: paperSheets.attemptId }).from(paperSheets)).map((row) => row.id),
  );
  const orphans = names.filter((name) => !kept.has(name));
  for (const name of orphans) await sweep(assetsDir, scanDir(name));
  return orphans.length;
}
