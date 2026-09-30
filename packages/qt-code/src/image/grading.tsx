/**
 * The `codeimage` column of the grading table (ADR-044): ONE wide column,
 * the PICTURE the student's program drew as a thumbnail, beside the program
 * itself in `code`'s clamped box. The picture is the grading's own
 * (`details.image`, parsed from stdout on the server — the field the review
 * reads), never re-run here; the expected row shows the target and the
 * reference solution.
 *
 * A class is a hundred rows and a picture is a canvas of up to 128 × 128
 * cells, so a thumbnail is drawn only once its row scrolls into view
 * (`IntersectionObserver`), and at once where the browser has none.
 */
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";

import type { QuestionTypeGrading } from "@quiz/core/client";
import { resolveStrings } from "@quiz/core/client";
import { breakdownOf, WordChip } from "@quiz/ui";

import { programColumn } from "../grading.js";
import { decodeImage } from "./pixels.js";
import { PixelGrid } from "./PixelGrid.js";
import {
  targetPixels,
  type CodeImageAnswer,
  type CodeImageDetails,
  type CodeImageSolution,
  type CodeImageStudent,
  type ImageSpec,
} from "./schema.js";
import { CODEIMAGE_GRADING_DEFAULTS } from "./strings.js";

/** The thumbnail's width: a picture a teacher tells from another at a glance. */
const THUMB = "w-14";

/**
 * Whether the element has come near the viewport once. `true` from the
 * start where there is no `IntersectionObserver` (jsdom, an old engine):
 * drawing everything is slower, never wrong.
 */
function useSeen() {
  const ref = useRef<HTMLDivElement>(null);
  const [seen, setSeen] = useState(() => typeof IntersectionObserver === "undefined");
  useEffect(() => {
    const el = ref.current;
    if (seen || el === null) return;
    const observer = new IntersectionObserver(
      (entries) => {
        if (!entries.some((entry) => entry.isIntersecting)) return;
        setSeen(true);
        observer.disconnect();
      },
      // A screen ahead: the pictures are there before the scroll gets to them.
      { rootMargin: "400px 0px" },
    );
    observer.observe(el);
    return () => observer.disconnect();
  }, [seen]);
  return { ref, seen };
}

/** A picture as a thumbnail, drawn once it is near the viewport. */
export function Thumbnail({
  spec,
  pixels,
  label,
}: {
  spec: ImageSpec;
  /** Encoded, as the grading and the target store it. */
  pixels: string;
  label: string;
}): ReactNode {
  const { ref, seen } = useSeen();
  const decoded = useMemo(
    () => (seen ? decodeImage(pixels, spec.palette, spec.width * spec.height) : null),
    [seen, pixels, spec],
  );
  return (
    <div ref={ref} className={THUMB} data-thumbnail={seen ? "drawn" : "waiting"}>
      {decoded === null ? (
        <div
          className="w-full rounded-field border border-line-strong bg-surface-2"
          style={{ aspectRatio: `${spec.width} / ${spec.height}` }}
        />
      ) : (
        <PixelGrid width={spec.width} height={spec.height} palette={spec.palette} pixels={decoded} label={label} />
      )}
    </div>
  );
}

export const codeimageGrading: QuestionTypeGrading<
  CodeImageStudent,
  CodeImageAnswer,
  CodeImageSolution,
  CodeImageDetails
> = {
  columns(student, solution, strings) {
    const s = resolveStrings(CODEIMAGE_GRADING_DEFAULTS, strings);
    const spec = student.image;
    const target = (solution ?? student).target;
    const hasTarget = targetPixels({ target, image: spec }) !== null;

    return [
      programColumn<CodeImageAnswer, CodeImageDetails>({
        s,
        label: s.column,
        solution,
        lead: (details) => {
          const image = breakdownOf(details, "warnings")?.image ?? null;
          return image === null ? (
            <WordChip tone="bad" text={s.noPicture} />
          ) : (
            <Thumbnail spec={spec} pixels={image} label={s.picture} />
          );
        },
        expectedLead:
          hasTarget && target !== null ? <Thumbnail spec={spec} pixels={target.pixels} label={s.target} /> : null,
      }),
    ];
  },
};
