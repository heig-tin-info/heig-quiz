/**
 * The few shared class strings and helpers of this package's components.
 *
 * A `qt-*` package cannot import `apps/web/src/ui.tsx` (packages never depend
 * on an app), and `packages/ui` is a later work package, so the markup here is
 * plain semantic HTML carrying the design tokens of `apps/web/DESIGN.md`:
 * hairlines and surfaces, no shadow in the page flow, no raw colour, no `dark:`
 * variant — the tokens swap by themselves.
 */
import type { ReactNode } from "react";
import type { ConfigIssue } from "@quiz/core/client";

export function cx(...parts: (string | false | null | undefined)[]): string {
  return parts.filter(Boolean).join(" ");
}

/**
 * Field chrome: the `--radius-field` token, `line-strong` hairline, accent
 * ring on focus. The RADIUS is a token and not `rounded-xl` on purpose — the
 * field radius of `apps/web/src/style.css` is a value the design owns, and a
 * literal here would drift the day it changes.
 */
export const inputClass =
  "rounded-field border border-line-strong bg-surface px-3 py-1.5 text-sm text-fg transition-colors placeholder:text-fg-faint hover:border-fg-faint focus:border-accent focus:outline-none focus:ring-3 focus:ring-accent/20 disabled:opacity-50";

/**
 * A native <select> in the same chrome as the inputs, with room on the right
 * for the browser's own arrow. `apps/web`'s `Select` draws its own chevron
 * over an `appearance-none` control; a leaf package copies the TOKENS, not the
 * icon set, so this one keeps the platform arrow and only reserves the space.
 */
export const selectClass =
  "rounded-field border border-line-strong bg-surface py-1.5 pl-3 pr-8 text-sm text-fg transition-colors hover:border-fg-faint focus:border-accent focus:outline-none focus:ring-3 focus:ring-accent/20 disabled:opacity-50";

export const labelClass = "text-[13px] font-medium text-fg";
export const helpClass = "text-xs text-fg-faint";
export const sectionClass = "flex flex-col gap-2";

/**
 * A card, in the little of `apps/web`'s `Card` a leaf package can carry: the
 * card radius, one hairline, the surface — and no shadow, because nothing in
 * the page flow has one. It dresses the block the editor PORTALS into the
 * host's aside (`EditorProps.aside`), so the scoring settings read as a card
 * of the right column beside "Properties" rather than as a stray section.
 */
export const cardClass = "rounded-card border border-line bg-surface p-4";

/** The 16 px section title of a card, as `SectionHeading` writes it. */
export const cardTitleClass = "text-base font-bold tracking-tight text-fg";
export const legendClass = "text-[13px] font-medium text-fg";

/** Secondary button chrome (pill, hairline), for the editor's add/remove actions. */
export const buttonClass =
  "inline-flex h-7 shrink-0 select-none items-center justify-center gap-1.5 rounded-full border border-line-strong bg-surface px-3 text-[13px] font-medium text-fg transition-colors hover:bg-surface-2 disabled:opacity-50";

/** The issues whose path starts with `path` (decision D16 reporting). */
export function issuesAt(
  issues: readonly ConfigIssue[],
  ...path: (string | number)[]
): ConfigIssue[] {
  return issues.filter((issue) => path.every((part, i) => issue.path[i] === part));
}

/** The issues that belong to the config as a whole (an empty zod path). */
export function rootIssues(issues: readonly ConfigIssue[]): ConfigIssue[] {
  return issues.filter((issue) => issue.path.length === 0);
}

/**
 * Validation feedback under a field. The message is shown verbatim: a `qt-*`
 * package emits i18n keys, the host decides how to present them.
 */
export function IssueList({ issues }: { issues: readonly ConfigIssue[] }): ReactNode {
  if (issues.length === 0) return null;
  return (
    <ul className="flex flex-col gap-0.5 text-xs text-danger">
      {issues.map((issue, i) => (
        <li key={`${issue.path.join(".")}-${i}`}>{issue.message}</li>
      ))}
    </ul>
  );
}

/** Letter of a choice, as the editor and the review show it: A, B, C… */
export function choiceLetter(index: number): string {
  return String.fromCharCode(65 + (index % 26));
}

/**
 * The segmented control of `apps/web/src/ui.tsx`, mirrored here class for
 * class: a pill track on `surface-3`, the selected option lifted onto
 * `surface` with a hairline ring. A `qt-*` package cannot import the app's
 * primitives (`packages/ui` is a later work package), so the markup is copied
 * and the TOKENS are what keeps the two in step.
 *
 * Native radios, visually hidden inside the labels: the arrow keys, the
 * grouping and the announcement come from the platform rather than from a
 * `role="radiogroup"` re-implementation.
 */
export function Segmented<T extends string>({
  name,
  value,
  options,
  onChange,
  disabled,
  wrap,
  labelledBy,
}: {
  /** Groups the native radios (one editor holds several groups). */
  name: string;
  value: T;
  options: { value: T; label: ReactNode }[];
  onChange: (value: T) => void;
  disabled?: boolean;
  /**
   * Lets the pills fall on a second row instead of sizing the track to their
   * total width. Six policies do not fit the 288 px right column on one line,
   * and a track that overflows its card is worse than a track two rows tall —
   * the pill radius is what says "press me", and it survives the wrap.
   */
  wrap?: boolean;
  /**
   * The id of the element that names the group. A segmented control is a
   * radiogroup, and a radiogroup without a name is six pills the reader has
   * to guess the subject of.
   */
  labelledBy?: string;
}): ReactNode {
  return (
    <div
      role="radiogroup"
      {...(labelledBy === undefined ? {} : { "aria-labelledby": labelledBy })}
      className={cx(
        "gap-0.5 bg-surface-3 p-0.75",
        // A track two rows tall is not a pill any more: `rounded-full` on it
        // draws two half-circles the height of both rows. It becomes what it
        // now is — a recessed panel — and keeps the card radius of the design
        // scale, while the pills inside stay pills.
        wrap ? "flex w-full flex-wrap rounded-card" : "inline-flex shrink-0 flex-wrap rounded-full",
        disabled && "opacity-60",
      )}
    >
      {options.map((o) => (
        <label
          key={o.value}
          className={cx(
            "inline-flex h-7 items-center justify-center rounded-full px-3 text-[13px] font-medium transition-colors has-focus-visible:ring-2 has-focus-visible:ring-accent/50",
            value === o.value
              ? "bg-surface text-fg ring-1 ring-line-strong/70"
              : cx("text-fg-muted", !disabled && "cursor-pointer hover:text-fg"),
          )}
        >
          <input
            type="radio"
            name={name}
            className="sr-only"
            checked={value === o.value}
            disabled={disabled}
            onChange={() => onChange(o.value)}
          />
          {o.label}
        </label>
      ))}
    </div>
  );
}

/**
 * The app's tooltip, in the little that a leaf package can carry of it: a
 * bubble on `fg` with `canvas` ink, shown on hover and on focus, out of the
 * accessibility tree (the control it wraps already carries the same sentence
 * as its accessible name) and out of the pointer's way.
 *
 * `apps/web`'s `Tip` portals itself and arms on a timer; a package cannot
 * import it (`packages/ui` is a later work package), so what is mirrored here
 * are the TOKENS and the two rules that matter — never focusable, never
 * clickable. The absolute position is enough for the one place this is used:
 * a row of a list nothing clips.
 */
export function Tip({ label, children }: { label: string; children: ReactNode }): ReactNode {
  return (
    <span className="group/tip relative inline-flex">
      {children}
      <span
        aria-hidden
        className="pointer-events-none absolute bottom-full left-1/2 z-20 mb-1.5 -translate-x-1/2 whitespace-nowrap rounded-lg bg-fg px-2.5 py-1.5 text-xs font-medium leading-snug text-canvas opacity-0 transition-opacity duration-150 group-hover/tip:opacity-100 group-focus-within/tip:opacity-100"
      >
        {label}
      </span>
    </span>
  );
}

/**
 * Two icons, drawn here rather than imported: `lucide-react` is a dependency
 * of `apps/web`, not of this package, and a leaf question type has no business
 * pulling an icon set of its own (`McqIcon` in `client.tsx` does the same).
 */
export function GripIcon({ className = "size-3.5" }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.6}
      strokeLinecap="round"
      className={className}
      aria-hidden
    >
      <path d="M9 6h.01M9 12h.01M9 18h.01M15 6h.01M15 12h.01M15 18h.01" />
    </svg>
  );
}

export function TrashIcon({ className = "size-3.5" }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.5}
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
      aria-hidden
    >
      <path d="M4 7h16M9.5 7V5.5A1.5 1.5 0 0 1 11 4h2a1.5 1.5 0 0 1 1.5 1.5V7M6.5 7l.8 12A1.5 1.5 0 0 0 8.8 20.5h6.4a1.5 1.5 0 0 0 1.5-1.5l.8-12" />
    </svg>
  );
}

/**
 * The drag handle of a choice row.
 *
 * VISIBLE at rest, which the first version was not: the grip was drawn in the
 * hover colour only, so a teacher looking at the list saw no affordance at all
 * and the reordering might as well not have existed. `fg-muted` at rest,
 * `fg` as soon as the pointer is anywhere on the row or the handle has the
 * focus, and the two cursors that say what the thing does.
 */
export const gripClass =
  "inline-flex h-7 w-6 shrink-0 cursor-grab items-center justify-center rounded-md text-fg-muted transition-colors group-hover/choice:text-fg hover:bg-surface-2 focus-visible:text-fg focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent active:cursor-grabbing disabled:pointer-events-none disabled:opacity-40";

/** Round, borderless control the size of a row: the handle and the bin. */
export const iconButtonClass =
  "inline-flex size-7 shrink-0 items-center justify-center rounded-full text-fg-faint transition-colors hover:bg-surface-2 hover:text-fg focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent disabled:pointer-events-none disabled:opacity-40";
