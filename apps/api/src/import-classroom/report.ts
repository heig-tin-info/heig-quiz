/**
 * The report of the import: one object, machine-readable (`--report-json`)
 * and rendered for a person by `formatReport`. Lines name people: for the
 * operator's terminal and file only, never committed nor shared.
 *
 * Red lines are the failures of the PARITY report (a source row neither
 * carried nor deliberately left out, a table the import must never write
 * that changed, a check that found a mismatch): the CLI exits non-zero on
 * any, and an `--apply` that finds one inside its transaction rolls back.
 */
import type { PreflightLine } from "./preflight.js";

/**
 * The decisions the product owner took on 2026-10-05 (open items 3 and 4 of
 * the M1-06 card), now defaults: nothing is created for a student absent from
 * the mapped Quiz roster nor for a classroom assistant; each is LISTED, for
 * the rosters to be fixed by hand before the final import.
 */
export interface OpenDecisions {
  /**
   * A heig-classroom ASSISTANT becomes staff of the Quiz course, which
   * widens their access to every classroom of it (D04 (a)). `skip`
   * (default): no seat, listed; `staff`: a seat, listed.
   */
  assistants: "staff" | "skip";
  /**
   * A student on the heig-classroom roster but not on the mapped Quiz
   * roster. `report` (default): listed only; `enroll`: a line added
   * (claimed when the account is known), listed.
   */
  missingStudents: "enroll" | "report";
}

export const DEFAULTS: OpenDecisions = { assistants: "skip", missingStudents: "report" };

/** The sections of findings, in the order of the steps. */
export const FINDINGS = {
  source: "Source",
  addresses: "Addresses",
  github: "GitHub account links",
  grants: "Teacher grants",
  staff: "Course staff",
  enrollments: "Enrollments",
  projects: "Projects, repositories and what hangs on them",
  reimport: "Kept on re-import (modified in Quiz since the previous import)",
  journals: "Classroom journals",
  webhooks: "Webhook deliveries",
  audit: "Legacy audit",
  roles: "Role changes",
  "not carried": "Not carried",
} as const;

export interface ParityRow {
  table: string;
  source: number;
  carried: number;
  leftOut: number;
  /** `source - carried - leftOut`: not zero is a red line. */
  missing: number;
}

export interface CheckFinding {
  check: string;
  severity: "red" | "warn" | "info";
  detail: string;
}

export interface KeptRow {
  table: string;
  sourceId: string;
  targetId: string;
  label: string;
  reason: string;
}

/** What the import did or would do. */
export interface ImportReport {
  mode: "dry-run" | "apply";
  /** `final`: the cutover import, which enforces the source-state pre-flight. */
  final: boolean;
  outcome: "rolled_back" | "applied" | "nothing_to_do" | "refused" | "red_lines";
  /** Blocking: `--apply` writes nothing while there is one. */
  refusals: string[];
  /** The source-state and data checks of `preflight.ts`, each with its verdict. */
  preflight: PreflightLine[];
  /** What no query can check: the cutover runbook's (M8-05). */
  runbook: string[];
  mapping: string[];
  decisions: string[];
  identity: Record<
    "alreadyImported" | "swissEduId" | "address" | "placeholder" | "created" | "ambiguous" | "excluded" | "notReached",
    number
  >;
  /** Rows written, per table (a dry run counts what it rolled back). */
  written: Record<string, number>;
  /** Findings, by section. */
  findings: Partial<Record<keyof typeof FINDINGS, string[]>>;
  /** The lists the operator acts on before the final import. */
  lists: { missingStudents: string[]; skippedAssistants: string[] };
  reimport: { overwritten: Record<string, number>; kept: KeptRow[] };
  parity: {
    tables: ParityRow[];
    findings: CheckFinding[];
    /** Every red line, as a sentence; non-empty means a non-zero exit. */
    redLines: string[];
    /** GitHub-bound checks that did not run (a dry run does not reach GitHub). */
    notRun: string[];
  };
}

export function newReport(mode: ImportReport["mode"], final: boolean): ImportReport {
  return {
    mode,
    final,
    outcome: "refused",
    refusals: [],
    preflight: [],
    runbook: [],
    mapping: [],
    decisions: [],
    identity: { alreadyImported: 0, swissEduId: 0, address: 0, placeholder: 0, created: 0, ambiguous: 0, excluded: 0, notReached: 0 },
    written: {},
    findings: {},
    lists: { missingStudents: [], skippedAssistants: [] },
    reimport: { overwritten: {}, kept: [] },
    parity: { tables: [], findings: [], redLines: [], notRun: [] },
  };
}

/** The report, for a person to read. */
export function formatReport(report: ImportReport): string {
  const out: string[] = [];
  const section = (title: string, lines: readonly string[]) => {
    out.push("", `## ${title}`);
    out.push(...(lines.length > 0 ? lines.map((l) => `- ${l}`) : ["- (none)"]));
  };
  const outcome = {
    rolled_back: "dry run: every write below was rolled back",
    applied: "applied",
    nothing_to_do: "nothing to do: the database already holds this import, nothing written",
    refused: "REFUSED: nothing written",
    red_lines: "RED LINES: the parity report failed, nothing written",
  }[report.outcome];
  out.push(`# heig-classroom import, ${report.mode}${report.final ? " (final)" : ""}: ${outcome}`);
  section("Refusals (blocking --apply)", report.refusals);
  section(
    "Pre-flight (source)",
    report.preflight.map((p) => {
      const verdict = { ok: "ok", refused: "REFUSED", final_only: "would refuse --final" }[p.status];
      return `${p.id}: ${verdict}${p.problems.map((x) => `\n    ${x}`).join("")}`;
    }),
  );
  section("Runbook checks (M8-05, not checkable here)", report.runbook);
  section("Mapping", report.mapping);
  section("Decisions", report.decisions);
  const i = report.identity;
  section("Identity", [
    `already imported: ${i.alreadyImported}`,
    `matched by swiss_edu_id: ${i.swissEduId}`,
    `matched by verified address: ${i.address}`,
    `matched to an earlier placeholder account: ${i.placeholder}`,
    `new accounts (classroom:<sub>, adopted at first login): ${i.created}`,
    `ambiguous, not merged: ${i.ambiguous}`,
    `left out (heig-classroom development accounts): ${i.excluded}`,
    `not reached by a mapped classroom, not imported: ${i.notReached}`,
  ]);
  section(
    "Rows written",
    Object.entries(report.written)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([table, n]) => `${table}: ${n}`),
  );
  for (const [key, title] of Object.entries(FINDINGS) as [keyof typeof FINDINGS, string][]) {
    const lines = report.findings[key];
    if (lines) section(title, lines);
  }
  section("To settle by hand before the final import: students missing from the Quiz rosters", report.lists.missingStudents);
  section("To settle by hand before the final import: assistants not given a seat", report.lists.skippedAssistants);
  section(
    "Parity (source vs target)",
    report.parity.tables.map(
      (t) => `${t.table}: source ${t.source}, carried ${t.carried}, left out ${t.leftOut}${t.missing === 0 ? "" : `, MISSING ${t.missing}`}`,
    ),
  );
  section(
    "Parity findings",
    report.parity.findings.map((f) => `[${f.severity}] ${f.check}: ${f.detail}`),
  );
  section("Checks not run", report.parity.notRun);
  section("RED LINES (non-zero exit)", report.parity.redLines);
  return out.join("\n");
}
