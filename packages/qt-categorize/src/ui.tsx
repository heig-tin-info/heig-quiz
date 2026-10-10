/**
 * The small pieces only this type draws: the chrome of a card, its rank
 * pastille and three icons (the grip is `@quiz/ui`'s). Semantic tokens only
 * (apps/web/DESIGN.md): no raw colour, no `dark:` variant, no shadow but the
 * drag overlay's.
 *
 * The icons are `@quiz/ui`'s `StrokeIcon` around their paths: `lucide-react`
 * is a dependency of `apps/web`, not of a leaf question type.
 */
import type { ReactNode } from "react";
import { cx, StrokeIcon } from "@quiz/ui";

/**
 * A card, in every surface: a field-radius tile, 13 px text. The tray lays
 * them out as a wrapping row, a column as a stack, so the width is the
 * caller's. The tone — border and fill — is a separate list on purpose:
 * Tailwind orders conflicting utilities by its stylesheet, not by the class
 * attribute, so a `bg-success-soft` written after a `bg-surface` would not
 * reliably win. One tone per card, never two.
 */
export const cardClass =
  "flex min-w-0 items-center gap-2 rounded-field border px-2.5 py-1.5 text-[13px] text-fg";

export const cardTone = {
  neutral: "border-line-strong bg-surface",
  /** The selected card of the click-then-click move: the calm blue of "a set of possibilities". */
  selected: "border-info bg-surface ring-2 ring-info-soft",
  right: "border-success bg-success-soft",
  wrong: "border-danger bg-danger-soft",
} as const;

/** The 1-based rank of a card in its column, when the order counts. */
export function Rank({ n }: { n: number }): ReactNode {
  return (
    <span
      aria-hidden
      className="grid size-5 shrink-0 place-items-center rounded-full bg-surface-3 text-[11px] font-semibold tabular-nums text-fg-muted"
    >
      {n}
    </span>
  );
}

export const CheckIcon = ({ className = "size-3.5" }: { className?: string }) => (
  <StrokeIcon className={cx("shrink-0", className)} strokeWidth={1.7}>
    <path d="m5 12.5 4.5 4.5L19 7.5" />
  </StrokeIcon>
);

