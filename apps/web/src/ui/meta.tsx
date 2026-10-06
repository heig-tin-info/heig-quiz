/**
 * The small facts under a title: a deadline, a commit, a score. One fact is a
 * {@link MetaItem} (a quiet icon and its text, 13 px), the facts of one record
 * are a {@link MetaLine}, which wraps. The student's activity cards and the
 * student's project page draw the same items (DESIGN.md, "The student's
 * activity card"). Imports only the base layer.
 */
import type { ReactNode } from "react";
import { cx, Tip, type IconType } from "./layers";

/**
 * One fact: an icon in `fg-faint` and its text. The icon is decoration, since
 * the text says it; when the icon carries a meaning the text does not (a lock
 * on a frozen score), `label` names it, in a `Tip` and for a screen reader.
 */
export function MetaItem({
  icon: Icon,
  label,
  children,
  className,
}: {
  icon: IconType;
  label?: string;
  children: ReactNode;
  className?: string;
}) {
  const icon = <Icon className="size-3.5 shrink-0 text-fg-faint" />;
  return (
    <span className={cx("inline-flex min-w-0 items-center gap-1.5 text-[13px] text-fg-muted", className)}>
      {label ? (
        <Tip label={label}>
          <span role="img" aria-label={label} tabIndex={0} className="inline-flex rounded-sm">
            {icon}
          </span>
        </Tip>
      ) : (
        icon
      )}
      <span className="min-w-0">{children}</span>
    </span>
  );
}

/** The facts of a record, side by side while they fit, wrapped under each other when they do not. */
export function MetaLine({ children, className }: { children: ReactNode; className?: string }) {
  return <div className={cx("flex flex-wrap items-center gap-x-4 gap-y-1", className)}>{children}</div>;
}
