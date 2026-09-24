/**
 * Section 3b — the teacher's controls on a live evaluation: the dashboard
 * read, the state changes and the per-student actions the grid offers.
 */
import {
  iso,
  MockError,
  on,
} from "./runtime";
import {
  attemptInspect,
  dashboardView,
  evaluationOr404,
  makeRows,
  toEvaluation,
} from "./evaluation";

// --- Routes: the teacher's controls on a live evaluation -------------------

on("GET", "/app/api/evaluations/:id/dashboard", (m, _b, url) =>
  dashboardView(evaluationOr404(m.groups!.id!), url.searchParams.get("includeAnswers") === "1"),
);
on("POST", "/app/api/evaluations/:id/start", (m) => {
  const e = evaluationOr404(m.groups!.id!);
  e.state = "running";
  e.startedAt = iso(0);
  e.closesAt = iso((e.durationS ?? 2700) * 1000);
  e.rows = makeRows(e, true);
  return toEvaluation(e);
});
on("POST", "/app/api/evaluations/:id/pause", (m) => {
  const e = evaluationOr404(m.groups!.id!);
  // As the server: only an exam pauses (glossary; #77).
  if (e.mode !== "exam") throw new MockError(409, "only an exam can be paused");
  e.state = "paused";
  e.pausedAt = iso(0);
  return toEvaluation(e);
});
on("POST", "/app/api/evaluations/:id/resume", (m) => {
  const e = evaluationOr404(m.groups!.id!);
  e.state = "running";
  e.pausedAt = null;
  return toEvaluation(e);
});
on("POST", "/app/api/evaluations/:id/close", (m) => {
  const e = evaluationOr404(m.groups!.id!);
  e.state = "closed";
  e.closedAt = iso(0);
  for (const row of e.rows) {
    if (row.state === "in_progress") row.state = "expired";
  }
  return toEvaluation(e);
});
on("POST", "/app/api/evaluations/:id/extend", (m, body) => {
  const e = evaluationOr404(m.groups!.id!);
  const ms = Number(body.minutes ?? 5) * 60_000;
  const target = body.scope === "attempt" ? String(body.attemptId) : null;
  let updated = 0;
  for (const row of e.rows) {
    if (row.deadlineAt === null) continue;
    if (target !== null && row.attemptId !== target) continue;
    row.deadlineAt = new Date(Date.parse(row.deadlineAt) + ms).toISOString();
    updated += 1;
  }
  if (target === null && e.closesAt) {
    e.closesAt = new Date(Date.parse(e.closesAt) + ms).toISOString();
  }
  return { updated, serverNow: iso(0) };
});
on("GET", "/app/api/evaluations/:id/attempts/:attemptId", (m) =>
  attemptInspect(evaluationOr404(m.groups!.id!), m.groups!.attemptId!),
);
on("POST", "/app/api/evaluations/:id/attempts/:attemptId/close", (m) => {
  const e = evaluationOr404(m.groups!.id!);
  const row = e.rows.find((r) => r.attemptId === m.groups!.attemptId);
  if (row) row.state = "expired";
  return { state: row?.state ?? "expired", serverNow: iso(0) };
});
on("POST", "/app/api/evaluations/:id/attempts/:attemptId/reopen", (m) => {
  const e = evaluationOr404(m.groups!.id!);
  const row = e.rows.find((r) => r.attemptId === m.groups!.attemptId);
  if (row) {
    row.state = "in_progress";
    row.deadlineAt = iso(10 * 60_000);
  }
  return { state: "in_progress", deadlineAt: row?.deadlineAt ?? null, serverNow: iso(0) };
});

