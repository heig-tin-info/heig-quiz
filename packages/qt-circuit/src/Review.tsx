/**
 * The feedback view of a `circuit` answer.
 *
 * Audience-aware, and that is its whole job. A teacher sees the student's
 * circuit BESIDE their own reference, the hidden stimuli by name and the
 * simulator's log; a student sees their circuit, the visible stimuli, and the
 * hidden ones as `#1`, `#2` — never their names, never their waveforms
 * (decision D15). The filtering itself happened server-side in
 * `studentDetails`; this component renders what it was given and never
 * reconstructs a key.
 */
import type { MarkdownRenderer, ReviewProps } from "@quiz/core/client";

import { Plot, SchematicView, type CanvasStrings } from "./canvas/index.js";
import type {
  CircuitAnswer,
  CircuitDetails,
  CircuitSolution,
  CircuitStudent,
  StimulusDetail,
} from "./schema.js";
import { REVIEW_STRINGS, withStrings, type CircuitReviewStrings } from "./strings.js";
import { badge, card, cx, hint, lockedBlock, sectionTitle, table } from "./styles.js";

interface CircuitReviewProps
  extends ReviewProps<CircuitStudent, CircuitAnswer, CircuitSolution, CircuitDetails> {
  strings?: Partial<CircuitReviewStrings> | undefined;
  /** The canvas has a dictionary of its own; the host translates it too. */
  canvasStrings?: Partial<CanvasStrings> | undefined;
  /** The host's sanitised markdown view; plain text when absent. */
  renderMarkdown?: MarkdownRenderer | undefined;
}

/**
 * `gradings.details` stores the extraction diagnostics as `code:ref` strings
 * (`floating_pin:R1.2`), because that is a payload and not a sentence. They
 * are turned back into sentences HERE, once.
 */
function diagnostic(raw: string, s: CircuitReviewStrings): string {
  const colon = raw.indexOf(":");
  const code = colon === -1 ? raw : raw.slice(0, colon);
  const ref = colon === -1 ? "" : raw.slice(colon + 1);
  switch (code) {
    case "floating_pin":
      return s.issueFloatingPin(ref);
    case "unconnected_port":
      return s.issueUnconnectedPort(ref);
    case "dangling_wire":
      return s.issueDanglingWire(ref);
    case "no_ground":
      return s.issueNoGround;
    case "missing_value":
      return s.issueMissingValue(ref);
    case "invalid_value":
      return s.issueInvalidValue(ref);
    case "value_out_of_range":
      return s.issueValueOutOfRange(ref);
    case "duplicate_name":
      return s.issueDuplicateName(ref);
    case "too_many_components":
      return s.issueTooManyComponents;
    case "kind_not_allowed":
      return s.issueKindNotAllowed(ref);
    default:
      return raw;
  }
}

/**
 * Why a stimulus did not pass, when the cause is not the distance.
 *
 * The stored `reason` is a machine token, and a reader is owed a sentence.
 * The extraction codes all mean the same thing to someone reading a grade —
 * the circuit never became a netlist — so they share one line.
 */
function reasonText(reason: string, s: CircuitReviewStrings): string {
  switch (reason) {
    case "not_run":
    case "no_series":
      return s.reasonNotSimulated;
    case "spice_failed":
      return s.reasonSpiceFailed;
    case "spice_timeout":
      return s.reasonTimeout;
    case "floating_pin":
    case "unconnected_port":
    case "dangling_wire":
    case "no_ground":
    case "missing_value":
    case "invalid_value":
    case "value_out_of_range":
    case "duplicate_name":
    case "too_many_components":
    case "kind_not_allowed":
      return s.reasonNetlist;
    default:
      return s.reasonOther;
  }
}

/** The distance to the reference, as the percentage a teacher compares to the tolerance. */
function errorPercent(error: number): string {
  const percent = error * 100;
  return percent >= 10 ? percent.toFixed(0) : percent.toFixed(1);
}

export function CircuitReview({
  student,
  answer,
  solution,
  details,
  points,
  maxPoints,
  audience,
  strings,
  canvasStrings,
  renderMarkdown,
}: CircuitReviewProps) {
  const s = withStrings(REVIEW_STRINGS, strings);
  const teacher = audience === "teacher";

  /* The statement, so a verdict is never read without the question it judges. */
  const statement = (
    <div className="whitespace-pre-wrap text-sm text-fg">
      {renderMarkdown ? renderMarkdown(student.prompt) : student.prompt}
    </div>
  );

  const canvas = canvasStrings === undefined ? {} : { strings: canvasStrings };

  /*
   * `details` is whatever `gradings.details` holds: this type's breakdown, or
   * a grading-level marker with no `stimuli` at all — an absent answer, an
   * unreadable configuration, a grader that threw. Reading a marker as a
   * breakdown is a blank page, so the two are told apart here.
   */
  const breakdown = details !== null && Array.isArray(details.stimuli) ? details : null;

  /*
   * An answer stored before this type had its shape — or by anything but the
   * player — may not carry a schematic at all. The feedback screen is the
   * last place that may throw, so it reads as "not answered" instead.
   */
  const schematic = answer?.schematic ?? null;

  /*
   * Hidden stimuli are numbered in the order they were graded, so `#2` means
   * the same thing to the student and to the teacher reading over their
   * shoulder. The counter runs over ALL of them, visible ones included, and
   * only shows on the hidden rows.
   */
  let hiddenSeen = 0;
  const rows: { detail: StimulusDetail; label: string }[] = (breakdown?.stimuli ?? []).map(
    (detail) => {
      if (detail.visible) return { detail, label: detail.name };
      hiddenSeen += 1;
      return { detail, label: teacher ? detail.name : s.hiddenStimulus(hiddenSeen) };
    },
  );

  return (
    <div className="flex flex-col gap-4">
      {statement}

      <div className="flex flex-wrap items-center gap-2">
        <span className={cx(sectionTitle, "tabular-nums")}>{s.score(points ?? 0, maxPoints)}</span>
        {breakdown?.mode === "manual" ? <span className={badge()}>{s.manualGrade}</span> : null}
        {breakdown?.mode === "llm" ? <span className={badge()}>{s.llmPending}</span> : null}
        {breakdown?.runner === "unavailable" ? (
          <span className={badge("warning")}>{s.runnerUnavailable}</span>
        ) : null}
        {breakdown?.runner === "busy" ? (
          <span className={badge("warning")}>{s.runnerBusy}</span>
        ) : null}
        {breakdown?.runner === "error" ? (
          <span className={badge("danger")}>{s.runnerError}</span>
        ) : null}
        {/* `none` under a manual grade is the normal state and needs no
            badge — "graded by the teacher" already says it. */}
        {breakdown?.runner === "none" && breakdown.mode !== "manual" ? (
          <span className={badge()}>{s.runnerNone}</span>
        ) : null}
      </div>

      {schematic === null ? (
        <p className={hint}>{s.noAnswer}</p>
      ) : (
        /*
         * Side by side for a teacher, alone for a student: the reference is
         * the KEY, and the only reason it is on this screen at all is that
         * the teacher is correcting against it.
         */
        <div className={cx("grid gap-3", teacher && solution?.reference ? "lg:grid-cols-2" : "")}>
          <section className={cx(card, "flex flex-col gap-2 p-4")}>
            <h3 className={sectionTitle}>{s.yourCircuit}</h3>
            <SchematicView schematic={schematic} {...canvas} />
          </section>
          {teacher && solution?.reference ? (
            <section className={cx(card, "flex flex-col gap-2 p-4")}>
              <h3 className={sectionTitle}>{s.reference}</h3>
              <SchematicView schematic={solution.reference} {...canvas} />
            </section>
          ) : null}
        </div>
      )}

      {breakdown === null ? null : (
        <div className="flex flex-col gap-1">
          <p className={hint}>
            <span className="font-medium text-fg">{s.diagnostics}</span>{" "}
            <span>{s.netSummary(breakdown.netlist.components, breakdown.netlist.nets)}</span>
          </p>
          {breakdown.netlist.issues.length === 0 ? (
            <p className={hint}>{s.noIssues}</p>
          ) : (
            <ul className="flex flex-col gap-0.5 text-[13px] text-warning">
              {breakdown.netlist.issues.map((raw, i) => (
                <li key={`${raw}-${i}`}>{diagnostic(raw, s)}</li>
              ))}
            </ul>
          )}
        </div>
      )}

      {rows.length === 0 ? null : (
        <div className="overflow-x-auto">
          <table className={table.table}>
            <caption className="sr-only">{s.stimuli}</caption>
            <thead className={table.head}>
              <tr>
                <th scope="col" className={table.th}>
                  {s.stimulusName}
                </th>
                <th scope="col" className={table.th}>
                  {s.verdict}
                </th>
                <th scope="col" className={cx(table.th, "text-right")}>
                  {s.error}
                </th>
                <th scope="col" className={table.th}>
                  {s.reason}
                </th>
                <th scope="col" className={cx(table.th, "text-right")}>
                  {s.points}
                </th>
              </tr>
            </thead>
            <tbody>
              {rows.map(({ detail, label }, i) => (
                <tr key={i} className={table.row}>
                  <td className={cx(table.td, "font-medium")}>{label}</td>
                  <td className={table.td}>
                    <span
                      className={badge(
                        detail.series === null && detail.error === null
                          ? "neutral"
                          : detail.ok
                            ? "success"
                            : "danger",
                      )}
                    >
                      {detail.series === null && detail.error === null
                        ? s.notRun
                        : detail.ok
                          ? s.passed
                          : s.failed}
                    </span>
                  </td>
                  <td className={cx(table.td, "text-right tabular-nums")}>
                    {detail.error === null ? "—" : s.errorPercent(errorPercent(detail.error))}
                  </td>
                  <td className={cx(table.td, "text-fg-muted")}>
                    {detail.reason === undefined ? "—" : reasonText(detail.reason, s)}
                  </td>
                  <td className={cx(table.td, "text-right tabular-nums")}>
                    {detail.ok ? detail.points : 0} / {detail.points}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {rows.some(({ detail }) => detail.series !== null) ? (
        // One waveform is a wide waveform; two or more share the row.
        <div
          className={cx(
            "grid gap-3",
            rows.filter(({ detail }) => detail.series !== null).length > 1 && "lg:grid-cols-2",
          )}
        >
          {rows.map(({ detail, label }, i) =>
            detail.series === null ? null : (
              <Plot
                key={i}
                title={label}
                series={detail.series}
                height={180}
                {...(detail.expected === null ? {} : { expected: detail.expected })}
                {...canvas}
              />
            ),
          )}
        </div>
      ) : null}

      {/* The simulator's own words, for the teacher alone: it is a log, and a
          student reading `ngspice: singular matrix` learns nothing. */}
      {teacher
        ? rows
            .filter(({ detail }) => detail.log !== undefined && detail.log !== "")
            .map(({ detail, label }, i) => (
              <section key={i} className={cx(card, "flex flex-col gap-2 p-4")}>
                <h3 className={sectionTitle}>
                  {s.log} — {label}
                </h3>
                <pre className={lockedBlock} aria-label={s.log}>
                  <code>{detail.log}</code>
                </pre>
              </section>
            ))
        : null}

      {teacher && solution !== null && solution.reference === null ? (
        <p className={hint}>{s.noReference}</p>
      ) : null}
    </div>
  );
}

export default CircuitReview;
