import { Loader2 } from "lucide-react";
import type { ReactNode } from "react";

import { useI18n, useT } from "../i18n";
import { percent } from "./dates";
import { cx, type IconType } from "./layers";

// Feedback: loading, key caps, status and notices.

/** Centered spinner for a panel whose data is still loading. */
export function Spinner({ label, className = "py-12" }: { label?: string; className?: string }) {
  const t = useT();
  return (
    <div
      role="status"
      aria-live="polite"
      aria-label={label ?? t("common.loading")}
      className={`flex flex-col items-center justify-center gap-2 ${className}`}
    >
      <Loader2 className="size-5 animate-spin text-fg-faint" />
      {label ? <p className="text-sm text-fg-muted">{label}</p> : null}
    </div>
  );
}

/** Placeholder block for content still loading (lists, cards). */
export function Skeleton({ className = "h-4 w-full" }: { className?: string }) {
  return <div aria-hidden className={`animate-pulse rounded-md bg-surface-3 ${className}`} />;
}

/**
 * A job that takes seconds, as a thin bar under its label (DESIGN.md ›
 * Progress). With a `value` it is determinate — the fill is the share and
 * the percentage is written at the right end; without one it is
 * indeterminate — a third of the track slides across and no number is
 * invented. Either way it is one `progressbar` named by the label.
 */
export function Progress({
  label,
  value,
  max = 100,
  className,
}: {
  /** What is happening, already translated: "Importing the roster…". */
  label: string;
  /** Done so far, 0 to `max`; leave it out when the duration is unknown. */
  value?: number;
  max?: number;
  className?: string;
}) {
  const { locale } = useI18n();
  const now = value === undefined ? undefined : Math.min(max, Math.max(0, value));
  const share = now === undefined || max <= 0 ? 0 : now / max;
  return (
    <div
      role="progressbar"
      aria-label={label}
      aria-valuemin={0}
      aria-valuemax={max}
      aria-valuenow={now}
      aria-busy={now === undefined || undefined}
      className={cx("space-y-1.5", className)}
    >
      <div className="flex items-baseline justify-between gap-3 text-[13px] text-fg-muted">
        <span className="min-w-0 truncate">{label}</span>
        {now === undefined ? null : <span className="shrink-0 tabular-nums">{percent(share, locale)}</span>}
      </div>
      <div className="h-1 overflow-hidden rounded-full bg-surface-3">
        {now === undefined ? (
          <div className="progress-indeterminate h-full w-1/3 rounded-full bg-info" />
        ) : (
          <div
            className="h-full rounded-full bg-info transition-[width] duration-200"
            style={{ width: `${share * 100}%` }}
          />
        )}
      </div>
    </div>
  );
}

/**
 * The loading state of a whole page, in one shape: a title bar (plus the
 * tabs or toolbar row under it, `header="title-and-bar"`), then the body — a
 * block, or a summary strip over a block (`body="summary-and-block"`, for a
 * page that opens on figures). 24 px between the rows, the header-to-body gap
 * of DESIGN.md › Spacing. The widths mean nothing: a skeleton says "a page is
 * coming", not what it will hold. `className` carries the page's column
 * (`mx-auto max-w-180`), never a height.
 */
export function PageSkeleton({
  header = "title",
  body = "block",
  className = "",
}: {
  header?: "title" | "title-and-bar";
  body?: "block" | "summary-and-block";
  className?: string;
}) {
  return (
    <div className={cx("space-y-6", className)}>
      <Skeleton className="h-8 w-64" />
      {header === "title-and-bar" ? <Skeleton className="h-9 w-80" /> : null}
      {body === "summary-and-block" ? <Skeleton className="h-24 w-full" /> : null}
      <Skeleton className="h-64 w-full" />
    </div>
  );
}

/**
 * A key cap, for the places that teach a shortcut (the command palette and
 * its sidebar trigger). `font-sans` on purpose: the mono face is reserved for
 * SHAs, repository names and the rest of what a student copies, and a key is
 * none of those — it is a picture of a key, so it takes the hairline, the
 * recessed surface and the caption weight the rest of the chrome uses.
 */
export function Kbd({ children, className = "" }: { children: ReactNode; className?: string }) {
  return (
    <kbd
      className={cx(
        "inline-flex items-center rounded-key border border-line bg-surface-2 px-1.5 py-0.5 font-sans text-[11px] font-medium text-fg-muted",
        className,
      )}
    >
      {children}
    </kbd>
  );
}

/**
 * The modifier key of a shortcut, spelled the way the reader's own keyboard
 * spells it. `userAgentData` first because `navigator.platform` is deprecated
 * and lies on some browsers; both are read defensively, since neither exists
 * under jsdom and a missing key hint must not take a test down with it.
 */
export function modKey(): string {
  if (typeof navigator === "undefined") return "Ctrl";
  const agent = navigator as Navigator & { userAgentData?: { platform?: string } };
  const platform = agent.userAgentData?.platform ?? navigator.platform ?? "";
  return /mac|iphone|ipad|ipod/i.test(platform) ? "⌘" : "Ctrl";
}

export type Tone = "green" | "amber" | "red" | "zinc" | "accent";

const TONES: Record<Tone, string> = {
  green: "bg-success-soft text-success",
  amber: "bg-warning-soft text-warning",
  red: "bg-danger-soft text-danger",
  zinc: "bg-surface-3 text-fg-muted",
  accent: "bg-accent-soft text-accent",
};

/** Status pill. A status is a badge; a plain count is text. */
export function Badge({
  tone,
  icon: Icon,
  children,
  className = "",
}: {
  tone: Tone;
  icon?: IconType;
  children: ReactNode;
  className?: string;
}) {
  return (
    <span
      className={cx(
        "inline-flex h-5.5 shrink-0 items-center gap-1 whitespace-nowrap rounded-full px-2 text-xs font-medium",
        TONES[tone],
        className,
      )}
    >
      {Icon ? <Icon className="size-3" /> : null}
      {children}
    </span>
  );
}

/** Inline notice: neutral information, a warning, a failure or a success. */
export function Alert({
  tone = "neutral",
  icon: Icon,
  title,
  children,
  action,
}: {
  tone?: "neutral" | "warning" | "danger" | "success";
  icon?: IconType;
  title?: string;
  children?: ReactNode;
  /** Right-aligned action (a button or a link). */
  action?: ReactNode;
}) {
  const styles = {
    neutral: "border-line bg-surface-2 text-fg",
    warning: "border-warning/30 bg-warning-soft text-fg",
    danger: "border-danger/30 bg-danger-soft text-fg",
    success: "border-success/30 bg-success-soft text-fg",
  }[tone];
  const iconColor = {
    neutral: "text-fg-muted",
    warning: "text-warning",
    danger: "text-danger",
    success: "text-success",
  }[tone];
  return (
    <div role="status" className={cx("flex flex-wrap items-start gap-3 rounded-card border px-4 py-3 text-sm", styles)}>
      {Icon ? <Icon className={cx("mt-0.5 size-4 shrink-0", iconColor)} /> : null}
      <div className="min-w-0 flex-1 space-y-0.5">
        {title ? <p className="font-semibold">{title}</p> : null}
        {children ? <div className="text-fg-muted">{children}</div> : null}
      </div>
      {/* The action takes a line of its own under `sm`: a long label inline
          squeezes the body to one word per line on a phone. From `sm` up it
          goes back beside the text, vertically centred. */}
      {action ? (
        <div className="flex basis-full items-center sm:basis-auto sm:shrink-0 sm:self-center">
          {action}
        </div>
      ) : null}
    </div>
  );
}

export function EmptyState({
  icon: Icon,
  title,
  titleAs: Title = "p",
  children,
  action,
  className = "py-14",
}: {
  icon: IconType;
  title: string;
  /**
   * `h1` when the empty state IS the page — the closed player, a screen with
   * nothing else on it. A page with no heading of any level has no outline
   * for a screen reader to land on (W4). It stays a `p` by default: an empty
   * state inside a populated page must not invent a heading level.
   */
  titleAs?: "p" | "h1" | "h2";
  children?: ReactNode;
  /** The one thing to do from here. */
  action?: ReactNode;
  className?: string;
}) {
  return (
    <div className={cx("flex flex-col items-center gap-2 px-4 text-center", className)}>
      <div className="mb-1 rounded-full bg-surface-2 p-3">
        <Icon className="size-6 text-fg-muted" />
      </div>
      <Title className={cx("font-semibold", Title === "h1" && "text-lg tracking-tight")}>
        {title}
      </Title>
      {children ? <p className="max-w-sm text-sm text-fg-muted">{children}</p> : null}
      {action ? <div className="mt-3">{action}</div> : null}
    </div>
  );
}
