/**
 * The student's view of a `codeimage` question (docs/spec/04 §4.9).
 *
 * The program half is `code`'s own (`../ProgramPlayer.tsx`): the statement,
 * the template as a stack of locked blocks and editable regions, the Run
 * button and its status lines. Under it, instead of a table of cases, the
 * picture: the target the teacher set, the image the last run printed, and
 * their difference, one grid or two side by side.
 *
 * Every run — in the browser or on the server, the host decides exactly as
 * it does for `code` — replaces the computed image. Its stdout is read with
 * `parseImageOutput`, the very rule the grader applies, so what the student
 * sees here is what they will be graded on (their final code, on the
 * server). Nothing about a run is graded.
 */
import { useMemo, useState } from "react";

import { fmt, plural, resolveStrings } from "@quiz/core/client";
import type { MarkdownRenderer, PlayerProps } from "@quiz/core/client";
import { badge, card, cx, hint, isLocked, sectionTitle } from "@quiz/ui";

import {
  ProgramRegions,
  ProgramStatement,
  regionsOf,
  RunButton,
  RunStatus,
  useRunSlot,
  type CodeRunStage,
  type ProgramRunResult,
} from "../ProgramPlayer.js";
import { ImagePanel, type ImageLayout, type ImageView } from "./ImagePanel.js";
import { decodeImage, imageStringIssue, parseImageOutput, warningsOf } from "./pixels.js";
import type { CodeImageAnswer, CodeImageStudent, ImageWarning } from "./schema.js";
import { CODEIMAGE_PLAYER_DEFAULTS, type CodeImagePlayerStrings } from "./strings.js";

export interface CodeImagePlayerProps extends PlayerProps<CodeImageStudent, CodeImageAnswer> {
  /**
   * Runs the program once and resolves with the runner's outcome, whose one
   * case holds the stdout to draw. The host picks the runner (`runtime`,
   * ADR-015) and, for the server, posts to `POST /attempts/:id/simulate`,
   * which rebuilds the source from the stored template (invariant 14).
   * `"unavailable"` and `"rate_limited"` are graceful paths, not failures.
   */
  onRun?:
    | ((
        answer: CodeImageAnswer,
        options?: { onStage?: ((stage: CodeRunStage) => void) | undefined },
      ) => Promise<ProgramRunResult>)
    | undefined;
  disabled?: boolean | undefined;
  strings?: Partial<CodeImagePlayerStrings> | undefined;
  renderMarkdown?: MarkdownRenderer | undefined;
  /** Forces the Monaco path on or off (tests use the textarea). */
  monaco?: boolean | undefined;
}

/** What the last run printed, read as an image. */
interface Computed {
  pixels: Int16Array;
  warnings: ImageWarning[];
  end: "timedOut" | "oom" | "crashed" | null;
  truncated: boolean;
}

/** One sentence per warning, in the student's words. */
export function warningText(warning: ImageWarning, s: CodeImagePlayerStrings): string {
  const key =
    warning.code === "extra"
      ? "warningExtra"
      : warning.code === "missing"
        ? "warningMissing"
        : "warningInvalid";
  return plural(s, key, warning.count, { count: warning.count });
}

export function CodeImagePlayer({
  student,
  answer,
  onChange,
  readOnly,
  disabled,
  onRun,
  strings,
  renderMarkdown,
  monaco,
}: CodeImagePlayerProps) {
  const s = resolveStrings(CODEIMAGE_PLAYER_DEFAULTS, strings);
  const locked = isLocked(readOnly, disabled);
  const [run, runInto] = useRunSlot();
  const [computed, setComputed] = useState<Computed | null>(null);
  const [view, setView] = useState<ImageView>("target");
  const [layout, setLayout] = useState<ImageLayout>("split");

  const spec = student.image;
  const count = spec.width * spec.height;
  const regions = regionsOf(student, answer);
  // A draft previewed before its target was captured has none to show.
  const target = useMemo(
    () =>
      imageStringIssue(student.target, spec) === null
        ? decodeImage(student.target, spec.palette, count)
        : null,
    [student.target, spec, count],
  );

  const writeRegion = (index: number, next: string) =>
    onChange({ regions: regions.map((text, i) => (i === index ? next : text)) });

  async function runProgram() {
    if (onRun === undefined) return;
    await runInto(async (onStage) => {
      const outcome = await onRun({ regions }, { onStage });
      if (outcome === "unavailable" || outcome === "rate_limited") return outcome;
      const result = outcome.cases[0];
      if (!outcome.compile.ok) {
        setComputed(null);
      } else {
        // Graded regardless of how the run ended (ADR-021): a crash after
        // half the image still drew half the image.
        const parsed = parseImageOutput(result?.stdout ?? "", spec);
        setComputed({
          pixels: parsed.pixels,
          warnings: warningsOf(parsed),
          end:
            result === undefined
              ? null
              : result.timedOut
                ? "timedOut"
                : result.oom
                  ? "oom"
                  : result.exitCode === null
                    ? "crashed"
                    : null,
          truncated: result?.truncated ?? false,
        });
        // The student pressed Run to see their picture: a single grid that
        // was showing the target turns to it.
        if (layout === "single" && view === "target") setView("computed");
      }
      return outcome;
    });
  }

  return (
    <div className="flex flex-col gap-5">
      <ProgramStatement
        student={student}
        s={s}
        renderMarkdown={renderMarkdown}
        badges={
          <span className={badge()}>
            {spec.width} × {spec.height}
          </span>
        }
      />

      <ProgramRegions
        student={student}
        regions={regions}
        locked={locked}
        onWrite={writeRegion}
        s={s}
        monaco={monaco}
      />

      <section className={cx(card, "flex flex-col gap-3 p-4")}>
        <div className="flex flex-wrap items-center gap-3">
          <h3 className={sectionTitle}>{s.imageSection}</h3>
          {onRun === undefined ? null : (
            <RunButton
              state={run}
              disabled={locked || run.status === "running"}
              onClick={() => void runProgram()}
              s={s}
            />
          )}
        </div>
        <p className={hint}>{fmt(s.runHint, { count })}</p>
        <RunStatus
          state={run}
          runtime={student.runtime}
          canRun={onRun !== undefined}
          s={s}
          rateLimited={s.rateLimited}
        />

        {computed === null ? null : <RunNotes computed={computed} s={s} />}

        <ImagePanel
          spec={spec}
          target={target}
          computed={computed?.pixels ?? null}
          view={view}
          onView={setView}
          layout={layout}
          onLayout={setLayout}
          s={s}
        />
      </section>
    </div>
  );
}

/** How the run ended and what the parse noticed, one line each. */
function RunNotes({ computed, s }: { computed: Computed; s: CodeImagePlayerStrings }) {
  const lines = [
    computed.end === "timedOut"
      ? s.endTimedOut
      : computed.end === "oom"
        ? s.endOutOfMemory
        : computed.end === "crashed"
          ? s.endCrashed
          : null,
    computed.truncated ? s.endTruncated : null,
    ...computed.warnings.map((w) => warningText(w, s)),
  ].filter((line): line is string => line !== null);
  if (lines.length === 0) return null;
  return (
    <ul className="flex flex-col gap-1 rounded-field bg-warning-soft px-3 py-2 text-[13px] text-warning">
      {lines.map((line) => (
        <li key={line}>{line}</li>
      ))}
    </ul>
  );
}

export default CodeImagePlayer;
