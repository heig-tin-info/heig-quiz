/**
 * Section 5c of the mock — the paper copy a staff member types in (ADR-125
 * §9–§15). Registered after the preview, whose view of a seed it reads: the
 * paper is that view under one fixed seed, the hand-out's.
 *
 * The refusals follow the API's (`paper/service.ts`): an exam only, once it
 * ran, not released, that prints, for a student's row. The submission turns the row into a paper attempt, handed
 * in, so the dashboard and the results show its badge; the scan is kept in
 * memory, its bytes counted and never read.
 */
import type { PaperAttemptCreated, PaperItems, PaperSheet } from "@quiz/contracts";

import {
  evaluationOr404,
  evaluations,
  itemQuestion,
  mockPaperRefusal,
  PRINTABLE_TYPES,
  uuid,
  type MockEvaluation,
} from "./evaluation";
import { solutionOf } from "./pool";
import { viewOf } from "./preview";
import { MockError, nextId, on, refuse } from "./runtime";

/** The hand-out's seed: one per evaluation, never sent anywhere. */
const PAPER_SEED = 4_242;

const sheets = new Map<string, PaperSheet>();

/** The running exam that prints (ADR-125 §5), addressable by id: the screenshots' paper scenes. */
export const PAPER_EXAM_ID = "eeeeeeee-0000-4000-8000-000000000125";

/**
 * A running exam of the printable questions of the running one, with its
 * class: the server's rule (`exports.paper`) offers the paper copy on it.
 * Built from the other's rows, so no draw of the rest of the mock moves.
 */
function seedPaperExam(): void {
  const running = evaluations.find((e) => e.state === "running" && e.mode === "exam");
  if (!running) return;
  const items = running.items
    .filter((item) => PRINTABLE_TYPES.has(item.type))
    .map((item, position) => ({ ...item, id: uuid(), position, milestone: false, intro: null }));
  if (items.length === 0) return;
  evaluations.push({
    ...running,
    id: PAPER_EXAM_ID,
    title: "Examen sur papier — pointeurs",
    items,
    rows: running.rows.map((row) => ({
      ...row,
      seatId: uuid(),
      attemptId: row.attemptId === null ? null : uuid(),
      cells: items.map((item, i) => ({ ...(row.cells[i] ?? row.cells[0]!), itemId: item.id })),
    })),
  });
}
seedPaperExam();

/** The API's refusal, from the same rule the evaluation's `exports.paper` says. */
function eligible(e: MockEvaluation): void {
  const refusal = mockPaperRefusal(e);
  if (refusal) throw refuse(409, refusal.code, refusal.code, refusal.print ?? {});
}

function studentRow(e: MockEvaluation, userId: string) {
  const row = e.rows.find((r) => r.userId === userId && !r.staff);
  if (!row) throw refuse(422, "paper_no_seat", "no claimed student seat");
  return row;
}

on("GET", "/app/api/evaluations/:id/paper/items", (m, _body, url): PaperItems => {
  const e = evaluationOr404(m.groups!.id!);
  eligible(e);
  const row = studentRow(e, url.searchParams.get("user") ?? "");
  const view = viewOf(e, PAPER_SEED);
  return {
    student: { userId: row.userId, displayName: row.displayName },
    view,
    solutions: Object.fromEntries(
      e.items.flatMap((item) => {
        const q = itemQuestion(item);
        return q ? [[item.id, solutionOf(q)]] : [];
      }),
    ),
    replaces: row.attemptId === null ? null : { attemptId: row.attemptId, state: row.state, origin: row.origin ?? "digital" },
    examDate: (e.opensAt ?? e.startedAt ?? new Date().toISOString()).slice(0, 10),
  };
});

on("POST", "/app/api/evaluations/:id/paper", (m, body): PaperAttemptCreated => {
  const e = evaluationOr404(m.groups!.id!);
  eligible(e);
  const row = studentRow(e, String(body.userId));
  const replaced = row.attemptId;
  const attemptId = nextId("paper-");
  Object.assign(row, { attemptId, state: "submitted", origin: "paper", deadlineAt: null, attemptCount: 1 });
  sheets.set(attemptId, { attemptId, examDate: String(body.examDate), scan: null });
  return { attemptId, supersededAttemptId: replaced };
});

const sheetOr404 = (attemptId: string): PaperSheet => {
  const sheet = sheets.get(attemptId);
  if (!sheet) throw new MockError(404, "not_found");
  return sheet;
};

on("GET", "/app/api/evaluations/:id/attempts/:attemptId/paper", (m) => sheetOr404(m.groups!.attemptId!));

on("PUT", "/app/api/evaluations/:id/attempts/:attemptId/paper/scan", (m): PaperSheet => {
  const sheet = sheetOr404(m.groups!.attemptId!);
  // The mock does not read a multipart body: a plausible scan of two pages.
  const next: PaperSheet = {
    ...sheet,
    scan: { mime: "application/pdf", bytes: 1_840_000, uploadedAt: new Date().toISOString() },
  };
  sheets.set(sheet.attemptId, next);
  return next;
});
