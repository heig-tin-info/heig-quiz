/**
 * The small facts under a title: a deadline, a commit, a score. One fact is a
 * {@link MetaItem} (a quiet icon and its text, 13 px), the facts of one record
 * are a {@link MetaLine}, which wraps. The student's activity cards and the
 * student's project page draw the same items (DESIGN.md, "The student's
 * activity card"). Imports only the base layer.
 */
import type { ReactNode } from "react";
import { cx, Tip, type IconType } from "./layers";

/** One fact: an icon in `fg-faint` (decoration; the text says it) and its text. */
export function MetaItem({ icon: Icon, children, className }: { icon: IconType; children: ReactNode; className?: string }) {
  return (
    <span className={cx("inline-flex min-w-0 items-center gap-1.5 text-[13px] text-fg-muted", className)}>
      <Icon className="size-3.5 shrink-0 text-fg-faint" />
      <span className="min-w-0">{children}</span>
    </span>
  );
}

/** The facts of a record, side by side while they fit, wrapped under each other when they do not. */
export function MetaLine({ children, className }: { children: ReactNode; className?: string }) {
  return <div className={cx("flex flex-wrap items-center gap-x-4 gap-y-1", className)}>{children}</div>;
}

/**
 * An icon that stands for a word (a card's kind): an image named by `label`
 * for a screen reader, and by a `Tip` on hover. Not a tab stop.
 */
export function IconTip({ icon: Icon, label, className }: { icon: IconType; label: string; className?: string }) {
  return (
    <Tip label={label}>
      <span role="img" aria-label={label} className="inline-flex">
        <Icon className={cx("size-4 shrink-0 text-fg-faint", className)} />
      </span>
    </Tip>
  );
}
