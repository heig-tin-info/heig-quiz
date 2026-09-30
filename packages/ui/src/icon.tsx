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

/** A circled exclamation mark: what marks an error line ({@link ErrorText}). */
export function AlertIcon({ className = "size-3.5" }: { className?: string | undefined }): ReactNode {
  return (
    <StrokeIcon className={className} strokeWidth={2}>
      <circle cx="12" cy="12" r="9" />
      <path d="M12 7.5v5.5M12 16.5h.01" />
    </StrokeIcon>
  );
}
