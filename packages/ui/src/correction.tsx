/**
 * The pieces of the debrief's answer key (ADR-033, ADR-109) that the host and
 * more than one type's `Key` draw: the scale both densities share, the count
 * at the end of a row, the "Expected answer" line of a written answer, and
 * the caption and the frame of a key that is a drawing. A size only one type draws lives in that type's package; one only the host
 * draws, in `apps/web/src/results/CorrectionQuestion.tsx`.
 */
import { Fragment, useEffect, useRef, useState, type ReactNode } from "react";
import type { KeyProps, KeyStats } from "@quiz/core/client";

import { cx } from "./styles.js";

/** `wall`: the correction projection's `clamp()` scale; `page`: the Results "Questions" tab. */
export type Density = KeyProps<unknown, unknown>["density"];

/** A program's two columns, either density; the density adds its gap. */
const PROGRAM = "grid items-start lg:grid-cols-[minmax(0,1.15fr)_minmax(0,1fr)]";

/**
 * The sizes the host and the keys share, per density (DESIGN.md, "Correction
 * projection"). `program` is the two columns of a program, its code then its
 * test cases: a program's key fills both, the host the second alone for a
 * type that counts cases and draws no key.
 */
export const CORRECTION_SCALE = {
  wall: {
    count: "font-mono text-base",
    answer: "text-[clamp(17px,1.6vw,24px)]",
    note: "text-[clamp(16px,1.4vw,21px)]",
    caption: "text-[clamp(13px,1.2vw,17px)]",
    program: `${PROGRAM} gap-6`,
  },
  page: {
    count: "text-[13px]",
    answer: "text-sm",
    note: "text-sm",
    caption: "text-xs",
    program: `${PROGRAM} gap-4`,
  },
} as const satisfies Record<Density, Record<string, string>>;

/** The papers every figure of a question is over: its four outcomes summed. */
export const answeredCount = ({ outcomes: o }: Pick<KeyStats, "outcomes">): number =>
  o.correct + o.partial + o.wrong + o.blank;

/** The figure at the end of a row: a count of papers. */
export function CorrectionCount({ density, children }: { density: Density; children: ReactNode }) {
  return (
    <span className={cx("text-right tabular-nums text-fg-muted", CORRECTION_SCALE[density].count)}>{children}</span>
  );
}

/**
 * A key's drawing under its caption: a program, a diagram, a schematic. The
 * caption says which — the reference, what the class started from, or that
 * it is hidden — so a block never reads as an unnamed field.
 */
export function KeyFigure({ density, caption, children }: { density: Density; caption: string; children: ReactNode }) {
  return (
    <figure className="flex min-w-0 flex-col gap-2">
      <figcaption className={cx("font-medium text-fg-muted", CORRECTION_SCALE[density].caption)}>{caption}</figcaption>
      {children}
    </figure>
  );
}

/** A hidden key's hatching: `surface-2` and `surface-3` stripes, framed. */
const HATCH =
  "rounded-card border border-line bg-[repeating-linear-gradient(135deg,var(--surface-2)_0_8px,var(--surface-3)_8px_16px)]";

/**
 * Where a key's drawing stands while it is hidden and the class had nothing
 * to start from: a hatched block of the size the drawing will take, never
 * the drawing itself made transparent, so nothing moves at the reveal.
 */
export function KeyHatch({ className }: { className: string }) {
  return <div aria-hidden className={cx(className, HATCH)} />;
}

/**
 * The height of a drawn key's frame, per density (DESIGN.md, "Correction
 * projection"): on the wall it follows the screen, so a diagram is read
 * across a room, and no taller than a narrow screen's drawing needs; on the
 * page it is the Results tab's.
 */
const FRAME = { wall: "h-[clamp(240px,min(56vh,70vw),760px)]", page: "h-80" } as const satisfies Record<Density, string>;

/**
 * The height a drawing gets before its frame is measured, or where nothing
 * lays out (a test): `FRAME.page`'s 320 px (`h-80`) inside its `p-4` padding
 * and its 1 px border, both sides.
 */
const UNMEASURED = 320 - 2 * 16 - 2;

/**
 * The frame of a key that is a drawing — a diagram, a schematic, a program
 * of blocks: ONE element of a fixed height per density, hatched while hidden
 * with nothing to stand in, recessed around what the class started from
 * (`revealed` false), on the surface around the key. The reveal changes what
 * is inside it, never its size, so nothing below moves.
 *
 * `children` draws `shown` into it at the height it measures inside its
 * padding: the renderers take a height in pixels (`DiagramView`'s
 * `maxHeight`, `SchematicView`'s and `BlocklyHost`'s `height`).
 * `framed: false` leaves the border and the padding to a drawing that has
 * its own.
 */
export function KeyFrame<T>({
  density,
  shown,
  revealed,
  framed = true,
  children,
}: {
  density: Density;
  /** What to draw; `null`: hidden with nothing to stand in. */
  shown: T | null;
  /** `shown` is the key; otherwise, what the class started from. */
  revealed: boolean;
  framed?: boolean;
  children: (shown: T, height: number) => ReactNode;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [height, setHeight] = useState(UNMEASURED);
  useEffect(() => {
    const frame = ref.current;
    if (frame === null || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(([entry]) => {
      if (entry !== undefined) setHeight(Math.floor(entry.contentRect.height));
    });
    observer.observe(frame);
    return () => observer.disconnect();
  }, []);
  return (
    <div
      ref={ref}
      aria-hidden={shown === null || undefined}
      className={cx(
        "flex min-w-0 items-center justify-center",
        FRAME[density],
        shown === null
          ? HATCH
          : framed && cx("rounded-card border border-line p-4", revealed ? "bg-surface" : "bg-surface-2"),
      )}
    >
      {shown === null ? null : children(shown, height)}
    </div>
  );
}

/**
 * The answers a written one is measured against, above the answer groups:
 * "Expected answer 3 · 3.0", once revealed. With no answer named, the groups
 * alone — and nothing when there are none: the blanks alone say nothing the
 * head of the question does not.
 */
export function ExpectedAnswers({
  label,
  answers,
  revealed,
  density,
  rows,
  grouped,
}: {
  label: string;
  answers: readonly ReactNode[];
  revealed: boolean;
  density: Density;
  /** The host's answer groups (`KeyProps.rows`). */
  rows: ReactNode;
  /** The class's answers fall into at least one group (`KeyProps.stats.distribution`). */
  grouped: boolean;
}) {
  if (answers.length === 0) return grouped ? rows : null;
  return (
    <div className="flex flex-col gap-3">
      {revealed ? (
        <p className={cx("text-fg-muted", CORRECTION_SCALE[density].note)}>
          {label}{" "}
          <span className="font-semibold text-success">
            {answers.map((answer, i) => (
              <Fragment key={i}>
                {i > 0 ? " · " : null}
                {answer}
              </Fragment>
            ))}
          </span>
        </p>
      ) : null}
      {rows}
    </div>
  );
}
