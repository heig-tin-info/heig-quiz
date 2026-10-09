/**
 * The outline icons of the question-type surfaces, as inline SVG.
 *
 * A `qt-*` package does not depend on lucide-react, which `apps/web` draws
 * its icons with: a handful of 24 px outlines do not justify a second icon
 * set in the bundle. The wrapper is written once here; each icon is its
 * paths. Decorative every time — an icon sits beside a word or inside a
 * labelled button — so it is hidden from assistive technology.
 */
import type { ReactNode } from "react";

import { cx } from "./styles.js";

/** A 24 px outline drawn in `currentColor`. `size` fixes its box when no class sizes it. */
export function StrokeIcon({
  className,
  strokeWidth = 1.5,
  size,
  children,
}: {
  className?: string | undefined;
  strokeWidth?: number;
  size?: number;
  children: ReactNode;
}): ReactNode {
  return (
    <svg
      viewBox="0 0 24 24"
      {...(size === undefined ? {} : { width: size, height: size })}
      fill="none"
      stroke="currentColor"
      strokeWidth={strokeWidth}
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
      aria-hidden="true"
      focusable="false"
    >
      {children}
    </svg>
  );
}

/** The `Icon` of a question type, from its outline: what a type picker shows. */
export function typeIcon(
  outline: ReactNode,
  defaultClassName?: string,
): (props: { className?: string }) => ReactNode {
  return ({ className = defaultClassName }) => (
    <StrokeIcon className={className}>{outline}</StrokeIcon>
  );
}

/**
 * The six dots of a drag handle. Shared because every reorderable list of
 * the question surfaces draws the same one (the mcq choices, the categorize
 * cards), and two copies of it had already drifted by a stroke width.
 *
 * FILLED discs, not the zero-length strokes the outline set draws dots
 * with: at 14 px a 1.6 stroke is a sub-pixel speck, which several browsers
 * anti-aliased into nothing, and the handle looked like an empty gap.
 */
export function GripIcon({ className = "size-3.5" }: { className?: string | undefined }): ReactNode {
  return (
    <svg viewBox="0 0 24 24" fill="currentColor" className={className} aria-hidden="true" focusable="false">
      {[6, 12, 18].flatMap((cy) => [9, 15].map((cx) => <circle key={`${cx}-${cy}`} cx={cx} cy={cy} r={1.75} />))}
    </svg>
  );
}

/** The magic wand of "Generate answers" (ADR-059): every type's wand draws this one. */
export function WandIcon({ className = "size-3.5" }: { className?: string | undefined }): ReactNode {
  return (
    <StrokeIcon className={className} strokeWidth={1.6}>
      <path d="m21.64 3.64-1.28-1.28a1.21 1.21 0 0 0-1.72 0L2.36 18.64a1.21 1.21 0 0 0 0 1.72l1.28 1.28a1.2 1.2 0 0 0 1.72 0L21.64 5.36a1.2 1.2 0 0 0 0-1.72" />
      <path d="m14 7 3 3M5 6v4M19 14v4M10 2v2M7 8H3M21 16h-4M11 3H9" />
    </StrokeIcon>
  );
}

/** A circled exclamation mark: what marks an error line ({@link ErrorText}). */
export function AlertIcon({ className = "size-3.5" }: { className?: string | undefined }): ReactNode {
  return (
    <StrokeIcon className={className} strokeWidth={2}>
      <circle cx="12" cy="12" r="9" />
      <path d="M12 7.5v5.5M12 16.5h.01" />
    </StrokeIcon>
  );
}

/*
 * The glyphs of a row's own controls — add one, remove one, close — that
 * several types draw. Each was drawn per package, and the same plus existed
 * at three stroke widths. They keep their size (`shrink-0`) in a flex row;
 * a button that sizes its icons (`[&_svg]:size-*`) still wins over the
 * default `size-3.5`.
 */
type GlyphProps = { className?: string | undefined };

/** Add a row, a choice, a column. */
export function PlusIcon({ className = "size-3.5" }: GlyphProps): ReactNode {
  return (
    <StrokeIcon className={cx("shrink-0", className)} strokeWidth={1.7}>
      <path d="M12 5v14M5 12h14" />
    </StrokeIcon>
  );
}

/** Close, remove from a set, or "wrong" beside a verdict. */
export function CloseIcon({ className = "size-3.5" }: GlyphProps): ReactNode {
  return (
    <StrokeIcon className={cx("shrink-0", className)} strokeWidth={1.7}>
      <path d="M6 6l12 12M18 6 6 18" />
    </StrokeIcon>
  );
}

/** Delete a row: lucide's bin (ISC), so it matches the app's. */
export function TrashIcon({ className = "size-3.5" }: GlyphProps): ReactNode {
  return (
    <StrokeIcon className={cx("shrink-0", className)} strokeWidth={1.7}>
      <path d="M3 6h18M19 6v14c0 1-1 2-2 2H7c-1 0-2-1-2-2V6M8 6V4c0-1 1-2 2-2h4c1 0 2 1 2 2v2" />
    </StrokeIcon>
  );
}
