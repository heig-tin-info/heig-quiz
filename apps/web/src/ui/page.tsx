import { ArrowDown, ArrowUp, ArrowUpDown, Loader2, PenLine } from "lucide-react";
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { ReactNode, RefObject } from "react";

import type { DateFormat, Me } from "@quiz/contracts";

import { useI18n, useT } from "../i18n";
import { cx, HelpIcon, rovingIndex, Tip, type IconType, useNow } from "./layers";

// --- Sortable tables (one motif for every hand-rolled table) ---

export interface SortState<K extends string> {
  key: K;
  dir: 1 | -1;
}

const defaultCompare = (x: string | number, y: string | number) =>
  typeof x === "number" && typeof y === "number" ? x - y : String(x).localeCompare(String(y));

/**
 * Sort state + sorted rows for a client-side table: clicking the active
 * column flips the direction, clicking another selects it ascending.
 *
 * `initial` may be `null`, and that is not the same thing as "sorted by the
 * first column": it means THE ORDER THE ROWS ARRIVED IN, until the reader
 * asks for another one. A list the server already ordered — evaluations by
 * state and date, versions newest first — carries a meaning in that order,
 * and reshuffling it on mount throws it away before anybody clicked anything.
 */
export function useSortableTable<T, K extends string>(
  rows: readonly T[],
  rank: (row: T, key: K) => string | number,
  initial: SortState<NoInfer<K>> | null,
  compare: (x: string | number, y: string | number) => number = defaultCompare,
) {
  const [sort, setSort] = useState<SortState<K> | null>(initial);
  const toggle = (k: K) =>
    setSort((s) => (s?.key === k ? { key: k, dir: s.dir === 1 ? -1 : 1 } : { key: k, dir: 1 }));
  const sorted = useMemo(
    () =>
      sort === null
        ? rows
        : [...rows].sort((a, b) => compare(rank(a, sort.key), rank(b, sort.key)) * sort.dir),
    // eslint-disable-next-line react-hooks/exhaustive-deps -- rank/compare are stable per table
    [rows, sort],
  );
  return { sorted, sort, toggle };
}

/**
 * Table styles (DESIGN.md › Components and › Tables): dense 13 px rows,
 * hairline dividers, and the column priority that lets a seven-column table
 * survive a narrow column.
 *
 * `container` goes on the element that scrolls the table, so `colLow`,
 * `colMid` and `colHigh` measure the SPACE THE TABLE HAS and not the
 * viewport: the same table sits in a 1120 px page, in a 720 px page beside
 * the sidebar and in a 480 px sheet, and only the first of those is a
 * viewport question. Thresholds and the order columns leave in are in
 * DESIGN.md › Tables.
 */
export const T = {
  table: "w-full text-[13px]",
  head: "text-left text-xs text-fg-muted",
  th: "px-3 py-2 font-medium",
  td: "px-3 py-2.5 align-middle",
  row: "border-t border-line transition-colors",
  rowHover: "group hover:bg-surface-2/70",
  /** On the wrapper that scrolls: turns it into the query container. */
  container: "@container",
  /** Lowest priority — the first column to go (container under 64rem). */
  colLow: "hidden @5xl:table-cell",
  /** Goes second (container under 56rem). */
  colMid: "hidden @4xl:table-cell",
  /** Goes last (container under 42rem). */
  colHigh: "hidden @2xl:table-cell",
  /**
   * On an `sr-only` span inside a cell: gives the word back once the table
   * has room for it. A badge that keeps its icon and drops its label is a
   * column that costs 20 px instead of 110, and the label is still in the
   * accessible name the whole time.
   */
  wordFrom: "@lg:not-sr-only",
  /**
   * The actions cell, pinned to the right edge. Past the last threshold the
   * table still scrolls sideways, and a row whose actions are off screen is
   * a row you cannot act on. The fill is the one the row wears, hover
   * included, or the pinned cell reads as a seam.
   */
  stickyEnd: "sticky right-0 bg-surface group-hover:bg-surface-2/70",
} as const;

/**
 * Clickable column header bound to `useSortableTable`.
 *
 * A column that sorts and does not say so is a feature nobody finds. The
 * affordance is an arrow and it stays inside the hairline aesthetic: the
 * active column keeps its solid `ArrowUp`/`ArrowDown` in `fg`, an inactive
 * one holds a faint `ArrowUpDown` that is drawn at `opacity-0` and fades in
 * on hover and on keyboard focus. It is in the DOM the whole time, so it
 * RESERVES its width — a label that jumps 16 px when the pointer arrives is
 * worse than no affordance at all.
 *
 * `aria-sort` on the `<th>` is the same answer for a screen reader, which
 * cannot see the arrow at all.
 */
export function SortHeader<K extends string>({
  k,
  sort,
  onToggle,
  children,
  className = "",
  right,
}: {
  k: K;
  /** `null` while the table stands in the order its rows arrived in. */
  sort: SortState<K> | null;
  onToggle: (k: K) => void;
  children: ReactNode;
  className?: string;
  right?: boolean;
}) {
  const active = sort !== null && sort.key === k;
  return (
    <th
      scope="col"
      aria-sort={active ? (sort.dir === 1 ? "ascending" : "descending") : undefined}
      className={cx(T.th, right && "text-right", className)}
    >
      <button
        type="button"
        className={cx(
          "group inline-flex items-center gap-1 rounded-sm transition-colors hover:text-fg",
          // A right-aligned column keeps its LABEL flush with the figures
          // under it, so the arrow hangs on the label's left instead of
          // pushing the word out of line with its own numbers.
          right && "flex-row-reverse",
          active && "text-fg",
        )}
        onClick={() => onToggle(k)}
      >
        {children}
        {active ? (
          sort.dir === 1 ? (
            <ArrowUp aria-hidden className="size-3 shrink-0" />
          ) : (
            <ArrowDown aria-hidden className="size-3 shrink-0" />
          )
        ) : (
          <ArrowUpDown
            aria-hidden
            className="size-3 shrink-0 text-fg-faint opacity-0 transition-opacity group-hover:opacity-100 group-focus-visible:opacity-100"
          />
        )}
      </button>
    </th>
  );
}

/**
 * One column of a table, as data: its sort key, its label, and the classes
 * that decide where it goes when the table narrows.
 *
 * A column that does not sort (`sortable: false`) is a tick box or an actions
 * cell: its `key` is then only a name, never handed to `onToggle`.
 */
export type Column<K extends string> = {
  label: ReactNode;
  /** The label is for screen readers only (the actions column). */
  srOnly?: boolean;
  right?: boolean;
  /** Extra classes: a `T.col*` priority, a width, `T.stickyEnd`. */
  className?: string;
} & ({ key: K; sortable?: true } | { key: string; sortable: false });

/**
 * The whole `<thead>` of a table, from its columns as data.
 *
 * Every table used to hand-roll its head, and the two things a head carries —
 * what the columns ARE and what happens to them on a narrow page — were
 * written twice, once in the `<th>` and once in the `<td>`. Declared here,
 * a table says its columns ONCE, the head and the priority classes can no
 * longer disagree, and every table of the app sorts the same way: click the
 * label, click it again to flip it.
 */
export function TableHead<K extends string>({
  columns,
  sort,
  onToggle,
}: {
  columns: Column<K>[];
  /** `null`: the rows stand in the order they arrived in. */
  sort: SortState<K> | null;
  onToggle: (k: K) => void;
}) {
  return (
    <thead className={T.head}>
      <tr>
        {columns.map((c) =>
          c.sortable === false ? (
            <th
              key={c.key}
              scope="col"
              className={cx(T.th, c.right && "text-right", c.className)}
            >
              {c.srOnly ? <span className="sr-only">{c.label}</span> : c.label}
            </th>
          ) : (
            <SortHeader
              key={c.key}
              k={c.key}
              sort={sort}
              onToggle={onToggle}
              right={c.right}
              className={c.className}
            >
              {c.srOnly ? <span className="sr-only">{c.label}</span> : c.label}
            </SortHeader>
          ),
        )}
      </tr>
    </thead>
  );
}

// --- Identity ---

/**
 * A person: their picture, or their initials when there is none OR when it
 * fails to load — an IdP picture URL goes stale, and the browser's
 * broken-image glyph is not a face. `label` is the full name, for an avatar
 * standing alone (a row of colleagues): it names the picture and shows as a
 * `Tip`, never as a native `title`. Leave it out when the name is written
 * beside the avatar, where a bubble would only repeat it.
 */
export function PersonAvatar({
  name,
  src,
  label,
  tone = "muted",
  className = "size-7 text-xs",
}: {
  /** Given name, family name. */
  name: [string, string];
  src: string | null | undefined;
  label?: string;
  /** `accent` is the signed-in user's own disc; everyone else is `muted`. */
  tone?: "muted" | "accent";
  className?: string;
}) {
  const [failed, setFailed] = useState(false);
  return (
    <Tip label={label}>
      {src && !failed ? (
        <img
          src={src}
          alt={label ?? ""}
          referrerPolicy="no-referrer"
          onError={() => setFailed(true)}
          className={cx("shrink-0 rounded-full object-cover", className)}
        />
      ) : (
        <Initials name={name} tone={tone} label={label} className={className} />
      )}
    </Tip>
  );
}

/** The signed-in user's avatar: initials on the accent colour as fallback. */
export function Avatar({ me, className = "size-16 text-xl" }: { me: Me; className?: string }) {
  return (
    <PersonAvatar
      name={[me.givenName, me.familyName]}
      src={me.avatarUrl}
      tone="accent"
      className={className}
    />
  );
}

/** Initials disc (no account picture, or one that failed). */
export function Initials({
  name,
  tone = "muted",
  label,
  className = "size-7 text-xs",
}: {
  name: [string, string];
  tone?: "muted" | "accent";
  /** The full name, when the disc stands alone and must be announced. */
  label?: string;
  className?: string;
}) {
  const initials = `${name[0].charAt(0)}${name[1].charAt(0)}`.toUpperCase() || "?";
  const colors =
    tone === "accent"
      ? "bg-accent font-semibold text-on-fill"
      : "bg-surface-3 font-semibold text-fg-muted";
  return (
    <span
      role={label ? "img" : undefined}
      aria-label={label}
      className={`inline-flex shrink-0 items-center justify-center rounded-full ${colors} ${className}`}
    >
      {initials}
    </span>
  );
}

// --- Dates ---

/** Account preference adopted in App.tsx; module-level on purpose — date
    formatting is plain string work, every view re-renders through the `me`
    query when the preference changes. */
let dateFormat: DateFormat = "iso";
export function setDateFormat(f: DateFormat | null | undefined) {
  dateFormat = f ?? "iso";
}

/** A date-time in an explicit format (used by the settings preview). */
export function formatDateTimeAs(iso: string, f: DateFormat): string {
  const d = new Date(iso);
  const p = (n: number) => String(n).padStart(2, "0");
  const [Y, M, D] = [d.getFullYear(), p(d.getMonth() + 1), p(d.getDate())];
  const hm = `${p(d.getHours())}:${p(d.getMinutes())}`;
  switch (f) {
    case "eu":
      return `${D}.${M}.${Y} ${hm}`;
    case "uk":
      return `${D}/${M}/${Y} ${hm}`;
    case "us":
      return `${M}/${D}/${Y} ${d.getHours() % 12 || 12}:${p(d.getMinutes())} ${d.getHours() < 12 ? "AM" : "PM"}`;
    default:
      return `${Y}-${M}-${D} ${hm}`;
  }
}

/** Local date-time in the user's preferred format; ISO `2026-09-01 08:00` by default. */
export function isoDateTime(iso: string): string {
  return formatDateTimeAs(iso, dateFormat);
}

/**
 * "30 minutes ago", "il y a 2 jours", "in 3 hours" — `Intl.RelativeTimeFormat`
 * in the interface language, with the largest unit that is not zero. Under a
 * minute it is "just now" (a key, since Intl has no word for it). Pure, so
 * it is testable; the component below feeds it the clock.
 */
export function relativeTime(
  iso: string,
  now: number,
  locale: "en" | "fr",
  t: (key: "time.now") => string,
): string {
  const diff = new Date(iso).getTime() - now;
  const abs = Math.abs(diff);
  if (abs < 45_000) return t("time.now");
  const rtf = new Intl.RelativeTimeFormat(locale, { numeric: "auto" });
  const units: [Intl.RelativeTimeFormatUnit, number][] = [
    ["year", 365 * 86_400_000],
    ["month", 30 * 86_400_000],
    ["week", 7 * 86_400_000],
    ["day", 86_400_000],
    ["hour", 3_600_000],
    ["minute", 60_000],
  ];
  for (const [unit, ms] of units) {
    if (abs >= ms || unit === "minute") {
      return rtf.format(Math.round(diff / ms), unit);
    }
  }
  return t("time.now");
}

/**
 * A date as a distance ("an hour ago"), the full local date-time in a `Tip`
 * on hover and focus, and the machine-readable value in `<time>`. This is
 * how a date is written anywhere a teacher scans a list: the distance is
 * what they compare, the exact stamp is one hover away. Re-renders once a
 * minute so "just now" ages without a reload.
 */
export function RelativeTime({ iso, className = "" }: { iso: string; className?: string }) {
  const t = useT();
  const { locale } = useI18n();
  const now = useNow(60_000);
  return (
    <Tip label={isoDateTime(iso)}>
      <time dateTime={iso} tabIndex={0} className={cx("tabular-nums", className)}>
        {relativeTime(iso, now, locale, t)}
      </time>
    </Tip>
  );
}

/** "labo-02-quadratic" → "Labo 02 Quadratic" (default assignment/classroom name). */
export function humanize(slug: string): string {
  return slug
    .split(/[-_]+/)
    .filter(Boolean)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(" ");
}

// --- Feedback ---

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

/** Indeterminate progress bar (unknown duration work). */
export function Progress({ label }: { label: string }) {
  return (
    <div className="space-y-1.5" role="status" aria-label={label}>
      <p className="text-sm text-fg-muted">{label}</p>
      <div className="h-1 overflow-hidden rounded-full bg-surface-3">
        <div className="progress-bar h-full w-1/3 rounded-full bg-accent" />
      </div>
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

// --- Surfaces and page structure ---

export function Card({
  children,
  className = "",
  interactive,
  onClick,
  ...rest
}: Omit<React.HTMLAttributes<HTMLDivElement>, "onClick"> & {
  children: ReactNode;
  className?: string;
  /** Clickable surface: hairline darkens on hover, no movement. */
  interactive?: boolean;
  onClick?: () => void;
}) {
  return (
    <div
      {...rest}
      onClick={onClick}
      className={cx(
        "rounded-card border border-line bg-surface",
        interactive && "cursor-pointer transition-colors duration-150 hover:border-line-strong hover:bg-surface-2/40",
        className,
      )}
    >
      {children}
    </div>
  );
}

/**
 * A note set inside a card: a 12 px uppercase eyebrow naming it ("Explanation",
 * "Comment", "Reference solution") over its body, in a field-radius panel
 * with 12 px of padding and 4 px between the eyebrow and the body.
 *
 * `soft` (a `surface-2` recess) is for what the product says — an
 * explanation, a key; `outlined` (a `line-strong` hairline on `surface`) is
 * for what a person wrote to this reader — a teacher's comment. DESIGN.md ›
 * Components › NotePanel.
 */
export function NotePanel({
  eyebrow,
  tone = "soft",
  children,
}: {
  eyebrow: ReactNode;
  tone?: "soft" | "outlined";
  children: ReactNode;
}) {
  return (
    <div
      className={cx(
        "rounded-field p-3",
        tone === "soft" ? "bg-surface-2" : "border border-line-strong bg-surface",
      )}
    >
      <p className="text-xs font-semibold uppercase tracking-wide text-fg-faint">{eyebrow}</p>
      <div className="mt-1">{children}</div>
    </div>
  );
}

/** Title row of a page: one h1, an optional line under it, the actions right. */
export function PageHeader({
  eyebrow,
  title,
  description,
  help,
  actions,
  className = "",
}: {
  eyebrow?: ReactNode;
  title: ReactNode;
  description?: ReactNode;
  /** Help topic (`src/help/<topic>.md`) opened by a "?" beside the title. */
  help?: string;
  actions?: ReactNode;
  className?: string;
}) {
  return (
    <header className={cx("flex flex-wrap items-end justify-between gap-x-6 gap-y-3", className)}>
      <div className="min-w-0">
        {eyebrow ? <div className="mb-1.5 text-[13px] text-fg-muted">{eyebrow}</div> : null}
        <h1 className="flex items-center gap-2 text-[28px] font-bold leading-tight tracking-[-0.02em]">
          <span className="min-w-0">{title}</span>
          {/* `HelpIcon` carries its own `shrink-0` and its own placement on
              the line: a title says WHICH topic, never where the "?" goes. */}
          {help ? <HelpIcon topic={help} coach="page.help" /> : null}
        </h1>
        {description ? <div className="mt-1.5 text-sm text-fg-muted">{description}</div> : null}
      </div>
      {actions ? <div className="flex flex-wrap items-center gap-2">{actions}</div> : null}
    </header>
  );
}

/**
 * The way back up, in a `PageHeader` eyebrow: the parent's name as a quiet
 * link. The eyebrow already sets the 13 px `fg-muted` text, so the link adds
 * only what a link needs — `fg` and an underline on hover, reached in the
 * 120–150 ms colour transition every hover uses. `tip` explains a name that
 * does not say what it leads to (the results page shows the evaluation's
 * title and leads to its classroom).
 */
export function ParentLink({
  onClick,
  tip,
  children,
}: {
  onClick: () => void;
  tip?: string;
  children: ReactNode;
}) {
  return (
    <Tip label={tip}>
      <button
        type="button"
        onClick={onClick}
        className="transition-colors hover:text-fg hover:underline"
      >
        {children}
      </button>
    </Tip>
  );
}

/**
 * A heading that renames itself where it stands.
 *
 * Renaming used to be a line in an overflow menu that opened a modal holding
 * ONE field — three clicks and a layer for a word. Here the title IS the
 * control: a real `<button>` (so Enter, Space and F2 all reach it, and it has
 * an accessible name that says what pressing it does) which swaps itself for
 * an `<input>` drawn at the heading's own size and weight, so nothing on the
 * line moves. Enter or blur saves, Escape cancels, and a title trimmed to
 * nothing is refused — the old one comes back, because an untitled evaluation
 * is not a thing the product has.
 *
 * The pencil is the discovery: it fades in on hover and on keyboard focus,
 * and it is `aria-hidden` — the button already says "rename" out loud. The
 * button keeps a transparent border so that the swap to the input, which has
 * a real one, does not shift the text by a pixel.
 *
 * It is not a primary action and never takes the accent (DESIGN.md): the
 * primary of the screen it sits on stays what it is.
 */
export function InlineTitle({
  value,
  onSave,
  editLabel,
  inputLabel,
  className = "",
}: {
  value: string;
  /** Called with the trimmed new title, only when it is non-empty and different. */
  onSave: (next: string) => void;
  /** Accessible name of the button, e.g. `Rename evaluation: Test 0`. */
  editLabel: string;
  /** Accessible name of the input, e.g. `Title`. */
  inputLabel: string;
  className?: string;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(value);
  // Enter and blur both land on `finish`, and Escape unmounts an input whose
  // blur may still be on its way. One latch per edit, so the second call is a
  // no-op instead of a second save.
  const done = useRef(true);

  const open = () => {
    setDraft(value);
    done.current = false;
    setEditing(true);
  };
  const finish = (save: boolean) => {
    if (done.current) return;
    done.current = true;
    setEditing(false);
    const next = draft.trim();
    if (save && next !== "" && next !== value) onSave(next);
  };

  const type = "text-[28px] font-bold leading-tight tracking-[-0.02em]";

  if (editing) {
    /*
     * The field grows with what is typed instead of taking the whole line: a
     * `w-full` input pushed the state badge onto a second row the moment the
     * editor opened, which is the jump this component exists to avoid. The
     * mirror span sets the grid column to the text's own width, the input
     * lies on top of it, and `max-w-full` keeps a long title inside the
     * header on a phone.
     */
    return (
      <span className={cx("-mx-1.5 inline-grid max-w-full min-w-0 align-baseline", className)}>
        <span
          aria-hidden
          className={cx(
            "invisible col-start-1 row-start-1 min-w-24 overflow-hidden whitespace-pre px-1.5",
            type,
          )}
        >
          {draft}
        </span>
        <input
          aria-label={inputLabel}
          autoFocus
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onFocus={(e) => e.currentTarget.select()}
          onBlur={() => finish(true)}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              finish(true);
            } else if (e.key === "Escape") {
              e.preventDefault();
              finish(false);
            }
          }}
          className={cx(
            "col-start-1 row-start-1 w-full min-w-0 rounded-field border border-accent bg-surface px-1.5 text-fg outline-none ring-3 ring-accent/20",
            type,
          )}
        />
      </span>
    );
  }
  return (
    <button
      type="button"
      aria-label={editLabel}
      onClick={open}
      onKeyDown={(e) => {
        if (e.key === "F2") {
          e.preventDefault();
          open();
        }
      }}
      className={cx(
        // Not a flex row: a long title WRAPS on a phone rather than being cut
        // short, and an inline pencil then trails its last line instead of
        // floating beside the block.
        "group -mx-1.5 max-w-full rounded-field border border-transparent px-1.5 text-left break-words transition-colors hover:border-line hover:bg-surface-2 focus-visible:border-accent focus-visible:outline-none focus-visible:ring-3 focus-visible:ring-accent/20",
        type,
        className,
      )}
    >
      {value}
      <PenLine
        aria-hidden
        className="ml-2 inline-block size-4 -translate-y-0.5 align-middle text-fg-faint opacity-0 transition-opacity group-hover:opacity-100 group-focus-visible:opacity-100"
      />
    </button>
  );
}

/** Heading of a section inside a page or a card (h2 at 16 px). */
export function SectionHeading({
  icon: Icon,
  title,
  count,
  description,
  help,
  actions,
  className = "",
}: {
  icon?: IconType;
  title: ReactNode;
  count?: number;
  description?: ReactNode;
  help?: string;
  actions?: ReactNode;
  className?: string;
}) {
  return (
    <div className={cx("flex flex-wrap items-center gap-x-3 gap-y-2", className)}>
      <div className="flex min-w-0 items-center gap-2">
        {Icon ? <Icon className="size-4 text-fg-faint" /> : null}
        <h2 className="text-base font-bold tracking-tight">{title}</h2>
        {count != null ? <span className="text-sm tabular-nums text-fg-faint">{count}</span> : null}
        {help ? <HelpIcon topic={help} /> : null}
      </div>
      {description ? <p className="basis-full text-sm text-fg-muted sm:basis-auto">{description}</p> : null}
      {actions ? <div className="ml-auto flex items-center gap-2">{actions}</div> : null}
    </div>
  );
}

/** Key figure: a small label over a large tabular number. */
export function Stat({
  label,
  value,
  hint,
  icon: Icon,
}: {
  label: ReactNode;
  value: ReactNode;
  hint?: ReactNode;
  icon?: IconType;
}) {
  return (
    <div className="rounded-card border border-line bg-surface px-4 py-3">
      <p className="flex items-center gap-1.5 text-xs font-medium text-fg-muted">
        {Icon ? <Icon className="size-3.5 text-fg-faint" /> : null}
        {label}
      </p>
      <p className="mt-1 text-[22px] font-bold leading-none tabular-nums tracking-tight">{value}</p>
      {hint ? <p className="mt-1.5 text-xs text-fg-faint">{hint}</p> : null}
    </div>
  );
}

/** Width of the fade drawn over a scrollable edge of a tab strip. */
const TAB_FADE = "36px";

/**
 * Which edges of a horizontal scroller still hide content. One pixel of
 * tolerance absorbs the fractional scroll positions a zoomed or
 * high-density viewport produces. Pure: this is the part worth testing.
 */
export function scrollEdges(
  scrollLeft: number,
  scrollWidth: number,
  clientWidth: number,
): { left: boolean; right: boolean } {
  return {
    left: scrollLeft > 1,
    right: scrollLeft + clientWidth < scrollWidth - 1,
  };
}

/**
 * Text tabs with an ink underline; counts sit in `fg-faint`.
 * Roving tabindex: only the selected tab is in the Tab order, ArrowLeft and
 * ArrowRight move and select with wrap, Home and End jump to the ends.
 * Give `idPrefix` ONLY when the panels are rendered through `TabPanel` with
 * the same prefix: each tab then carries `id="<prefix>-tab-<value>"` and
 * `aria-controls="<prefix>-panel-<value>"`, and `TabPanel` is what makes those
 * ids resolve. Without panels, leave `idPrefix` out — an `aria-controls`
 * pointing at nothing is worse than no `aria-controls` at all (W2).
 *
 * On a narrow viewport the strip scrolls: the hidden side is faded out so the
 * fourth tab announces itself instead of just ending at the screen edge, and
 * scroll snapping stops a drag between two tabs.
 */
export function Tabs<V extends string>({
  value,
  onChange,
  items,
  className = "",
  idPrefix,
  label,
}: {
  value: V;
  onChange: (v: V) => void;
  /** `coach` names the tab as a coach mark's anchor (`coach/catalog.ts`). */
  items: { value: V; label: string; count?: number; icon?: IconType; coach?: string }[];
  className?: string;
  idPrefix?: string;
  /** Accessible name of the tablist when the surrounding heading is not enough. */
  label?: string;
}) {
  const refs = useRef<Partial<Record<V, HTMLButtonElement | null>>>({});
  const strip = useRef<HTMLDivElement>(null);
  const [edges, setEdges] = useState({ left: false, right: false });
  const selected = items.findIndex((it) => it.value === value);
  /**
   * Which tab holds the roving tabindex. A `value` matching no item (a hand
   * edited `?tab=` in the URL) used to leave every tab at `tabIndex={-1}`,
   * which took the whole strip out of the Tab order; the first tab stands in.
   */
  const roving = selected >= 0 ? selected : 0;
  // The fade is measured from the rendered strip, so it has to be recomputed
  // whenever the labels or the counts change, not only their number.
  const shape = items.map((it) => `${it.value}\u0000${it.label}\u0000${it.count ?? ""}`).join("|");
  // Layout effect: measuring after paint would show one unfaded frame.
  useLayoutEffect(() => {
    const el = strip.current;
    if (!el) return;
    const update = () =>
      setEdges((prev) => {
        const next = scrollEdges(el.scrollLeft, el.scrollWidth, el.clientWidth);
        // Same edges, same object: a fresh one would re-render on every scroll.
        return prev.left === next.left && prev.right === next.right ? prev : next;
      });
    update();
    el.addEventListener("scroll", update, { passive: true });
    const observer = new ResizeObserver(update);
    observer.observe(el);
    return () => {
      el.removeEventListener("scroll", update);
      observer.disconnect();
    };
  }, [shape]);
  // A mask, not an overlay: it fades whatever the strip holds without laying a
  // canvas-coloured rectangle over it, which would be wrong in dark mode.
  const mask =
    edges.left || edges.right
      ? `linear-gradient(to right, transparent 0, #000 ${edges.left ? TAB_FADE : "0px"}, #000 calc(100% - ${edges.right ? TAB_FADE : "0px"}), transparent 100%)`
      : undefined;
  const onKeyDown = (e: React.KeyboardEvent) => {
    const next = rovingIndex(e.key, roving, items.length);
    if (next === null) return;
    e.preventDefault();
    const target = items[next];
    if (!target) return;
    onChange(target.value);
    refs.current[target.value]?.focus();
  };
  return (
    // The hairline lives on the wrapper, so the mask fades the tabs without
    // eating the border that separates them from the panel below.
    <div className={cx("border-b border-line", className)}>
      <div
        ref={strip}
        role="tablist"
        aria-label={label}
        onKeyDown={onKeyDown}
        // `overflow-y-hidden` on top of the horizontal scroll: the active tab
        // hangs one pixel below the strip (`-mb-px`, so its indicator covers
        // the hairline), and an `overflow-x-auto` strip alone answers that
        // pixel with a vertical scrollbar on hosts that draw them.
        className="flex snap-x snap-proximity gap-1 overflow-x-auto overflow-y-hidden"
        style={mask ? { maskImage: mask, WebkitMaskImage: mask } : undefined}
      >
        {items.map((it, i) => {
          const Icon = it.icon;
          const active = it.value === value;
          return (
            <button
              key={it.value}
              ref={(el) => {
                refs.current[it.value] = el;
              }}
              type="button"
              role="tab"
              id={idPrefix ? `${idPrefix}-tab-${it.value}` : undefined}
              // Only the selected tab points at a panel: the consumers render
              // one panel at a time, and `aria-controls` on the other three
              // would name ids no element carries (W2).
              aria-controls={idPrefix && active ? `${idPrefix}-panel-${it.value}` : undefined}
              aria-selected={active}
              data-coach={it.coach}
              tabIndex={i === roving ? 0 : -1}
              onClick={() => onChange(it.value)}
              className={cx(
                "relative -mb-px inline-flex h-10 shrink-0 snap-start items-center gap-1.5 px-3 text-sm font-medium transition-colors",
                active ? "text-fg" : "text-fg-muted hover:text-fg",
                active && "after:absolute after:inset-x-2 after:bottom-0 after:h-0.5 after:rounded-full after:bg-fg",
              )}
            >
              {Icon ? <Icon className="size-4" /> : null}
              {it.label}
              {it.count != null ? (
                <span className={cx("text-xs tabular-nums", active ? "text-fg-muted" : "text-fg-faint")}>
                  {it.count}
                </span>
              ) : null}
            </button>
          );
        })}
      </div>
    </div>
  );
}

/**
 * The panel a `Tabs` strip points at. It exists because `aria-controls` is a
 * promise: a tab announcing `question-panel-edit` to a document that holds no
 * such element tells a screen reader to go somewhere that is not there (W2).
 *
 * `idPrefix` and `value` are the same two strings the strip was given, so the
 * ids line up by construction. `tabIndex={-1}` makes it a focus target
 * without putting it in the Tab order: a shortcut that switches tabs
 * (`Ctrl+Enter` in the question editor) moves the reader into the panel it
 * just opened, which is the whole point of switching.
 */
export function TabPanel({
  idPrefix,
  value,
  children,
  className = "",
  ref,
}: {
  idPrefix: string;
  value: string;
  children: ReactNode;
  className?: string;
  ref?: RefObject<HTMLDivElement | null>;
}) {
  return (
    <div
      ref={ref}
      id={`${idPrefix}-panel-${value}`}
      role="tabpanel"
      aria-labelledby={`${idPrefix}-tab-${value}`}
      tabIndex={-1}
      className={cx("focus:outline-none", className)}
    >
      {children}
    </div>
  );
}

/**
 * Makes every `<pre>` rendered inside it reachable with the keyboard (W10).
 *
 * A code block that scrolls sideways and holds nothing focusable is invisible
 * to a keyboard: at 390 px a student cannot read past the fold. The blocks in
 * question are emitted by the question-type packages (`qt-code`'s review and
 * player), which this app hosts rather than owns, so the fix is applied here,
 * on the rendered DOM, instead of being duplicated in every package.
 *
 * A MutationObserver and not a plain effect: the packages load lazily behind
 * a `Suspense` INSIDE this subtree, so the tree fills long after this
 * component's last render and an effect here would have run against an empty
 * div. Anything that scrolls sideways gets the `tabindex` axe asks for; a
 * `<pre>` also gets a named group, because a code block is worth announcing
 * and a table wrapper is not.
 */
export function ScrollableCode({
  label,
  children,
  className = "",
}: {
  /** Accessible name of each block, e.g. `t("markdown.codeBlock")`. */
  label: string;
  children: ReactNode;
  className?: string;
}) {
  const host = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const root = host.current;
    if (!root) return;
    const mark = () => {
      for (const el of Array.from(
        root.querySelectorAll<HTMLElement>("pre, .overflow-x-auto"),
      )) {
        if (el.getAttribute("tabindex") !== null) continue;
        el.setAttribute("tabindex", "0");
        if (el.tagName !== "PRE") continue;
        // `group`, not `region`: see `markdown/render.ts` — two identically
        // named landmarks on one page are worse than none.
        el.setAttribute("role", "group");
        // A block the package already named keeps its name: "Locked —
        // provided code" says more than "Code block" ever will.
        if (!el.hasAttribute("aria-label")) el.setAttribute("aria-label", label);
      }
    };
    mark();
    const observer = new MutationObserver(mark);
    observer.observe(root, { childList: true, subtree: true });
    return () => observer.disconnect();
  }, [label]);
  return (
    <div ref={host} className={className}>
      {children}
    </div>
  );
}
