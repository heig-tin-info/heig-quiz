import {
  AlertTriangle,
  ArrowDown,
  ArrowUp,
  Building2,
  ChartPie,
  Check,
  ChevronDown,
  Circle,
  CircleCheck,
  Clock,
  Ellipsis,
  Hourglass,
  Loader2,
  Lock,
  Pause,
  PenLine,
  RefreshCw,
  Search,
  WifiOff,
  X,
} from "lucide-react";
import {
  cloneElement,
  isValidElement,
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import { createPortal } from "react-dom";
import type { ComponentType, ReactNode, RefCallback, RefObject } from "react";

import type { DateFormat, Me } from "@quiz/contracts";

import { apiErrorMessage } from "./api";
import { HelpIcon } from "./help";
import { useI18n, useT } from "./i18n";

/*
 * Shared primitives. Every visual value here comes from DESIGN.md (tokens in
 * style.css): semantic colors (`surface`, `fg-muted`, `line`…) swap in dark
 * mode by themselves, so components carry no `dark:` variants.
 */

/** Joins class names, skipping falsy entries. */
export const cx = (...parts: (string | false | null | undefined)[]) =>
  parts.filter(Boolean).join(" ");

export type IconType = ComponentType<{ className?: string }>;

/**
 * Stacking scale (SSOT): sheet = dialog = toasts < popovers < busy overlay <
 * help drawer < tooltips. Literal Tailwind tokens live here so the JIT
 * scanner picks them up; compose with template strings.
 *
 * A popover sits ABOVE the dialog layer, not below it: menus are opened from
 * inside sheets, dialogs and the mobile drawer (the account menu), and a
 * panel portalled to <body> under those layers is simply invisible. It stays
 * below `overlay`, which greys out everything on purpose.
 */
export const Z = {
  popover: "z-55",
  modal: "z-50",
  toast: "z-50",
  /** Above the dialog: CreatingOverlay greys the whole dialog out. */
  overlay: "z-60",
  /** Help must be able to slide over a dialog that summoned it. */
  helpBackdrop: "z-75",
  help: "z-80",
  tooltip: "z-90",
} as const;

/**
 * Keyboard contract for an element made clickable without being a <button>
 * (a card, a table row): Enter and Space activate it, and Space does not
 * scroll the page underneath. Spread it next to the element's own `onClick`.
 *
 * `role` is a parameter because a clickable <tr> must stay a row: announcing
 * it as a button would cost the reader the table structure around it. Cards
 * take the default.
 *
 * A key press that started on a nested control (a link, a menu trigger) is
 * that control's business, so only the element itself answers.
 */
export function pressable(onActivate: () => void, role: string = "button") {
  return {
    role,
    tabIndex: 0,
    onKeyDown: (e: React.KeyboardEvent) => {
      if (e.key !== "Enter" && e.key !== " ") return;
      if (e.target !== e.currentTarget) return;
      e.preventDefault();
      onActivate();
    },
  };
}

/** Ticking clock for countdowns; re-renders every `intervalMs`. */
/**
 * True from `px` wide up, following the window as it resizes. False where
 * `matchMedia` does not exist (a test), so a component defaults to its
 * phone layout there — the one that also renders inside a narrow window.
 */
export function useMinWidth(px: number): boolean {
  const query = `(min-width: ${px}px)`;
  const supported = typeof window !== "undefined" && typeof window.matchMedia === "function";
  return useSyncExternalStore(
    (onChange) => {
      if (!supported) return () => {};
      const media = window.matchMedia(query);
      media.addEventListener("change", onChange);
      return () => media.removeEventListener("change", onChange);
    },
    () => (supported ? window.matchMedia(query).matches : false),
    () => false,
  );
}

export function useNow(intervalMs = 30_000): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), intervalMs);
    return () => clearInterval(timer);
  }, [intervalMs]);
  return now;
}

/*
 * Floating layers keep a stack. Only the topmost one answers Escape and traps
 * Tab, so the help drawer opened from a dialog (or a menu opened inside a
 * sheet) closes on its own instead of taking everything underneath with it.
 */
const layers: object[] = [];

const FOCUSABLE =
  'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

/** Tabbable descendants of `root`, in document order, skipping hidden ones. */
export function focusableIn(root: HTMLElement): HTMLElement[] {
  return Array.from(root.querySelectorAll<HTMLElement>(FOCUSABLE)).filter(
    (el) => el.offsetWidth > 0 || el.offsetHeight > 0 || el === document.activeElement,
  );
}

/**
 * Registers one open floating layer (dialog, sheet, drawer, menu):
 * - Escape calls `onClose`, but only while this layer is the topmost one;
 * - with `trap` (the default), focus moves into `panel` on open, Tab and
 *   Shift+Tab cycle inside it, and the element that opened the layer gets the
 *   focus back on close.
 * `panel` must carry `tabIndex={-1}` so it can hold the focus by itself when
 * it has no focusable child.
 */
export function useLayer(
  panel: RefObject<HTMLElement | null>,
  onClose: () => void,
  { trap = true, enabled = true }: { trap?: boolean; enabled?: boolean } = {},
) {
  // Latest callback without re-arming the listener on every render.
  const close = useRef(onClose);
  close.current = onClose;
  // Element to give the focus back to, captured during the render that opens
  // the layer: an `autoFocus` inside the panel lands during the commit, before
  // effects run, so reading it from the effect would capture a node the layer
  // is about to unmount.
  const opener = useRef<HTMLElement | null>(null);
  if (!enabled) opener.current = null;
  else opener.current ??= document.activeElement as HTMLElement | null;
  // Giving the focus back is deferred by one frame and cancelled if the layer
  // mounts again right away: that is exactly the mount/cleanup/mount StrictMode
  // replays in development, and restoring there would undo an `autoFocus`
  // inside the panel.
  const restore = useRef<number | null>(null);
  useEffect(() => {
    if (!enabled) return;
    const token = {};
    layers.push(token);
    const onTop = () => layers[layers.length - 1] === token;
    if (restore.current != null) {
      cancelAnimationFrame(restore.current);
      restore.current = null;
    }
    const restoreTo = opener.current;
    if (trap && panel.current && !panel.current.contains(document.activeElement)) {
      (focusableIn(panel.current)[0] ?? panel.current).focus();
    }
    const onKey = (e: KeyboardEvent) => {
      if (!onTop()) return;
      if (e.key === "Escape") {
        e.stopPropagation();
        close.current();
        return;
      }
      if (!trap || e.key !== "Tab" || !panel.current) return;
      const items = focusableIn(panel.current);
      const first = items[0];
      const last = items[items.length - 1];
      if (!first || !last) {
        e.preventDefault();
        panel.current.focus();
        return;
      }
      const active = document.activeElement as HTMLElement | null;
      if (!active || !panel.current.contains(active)) {
        e.preventDefault();
        (e.shiftKey ? last : first).focus();
      } else if (e.shiftKey && active === first) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && active === last) {
        e.preventDefault();
        first.focus();
      }
    };
    document.addEventListener("keydown", onKey, true);
    return () => {
      document.removeEventListener("keydown", onKey, true);
      const i = layers.lastIndexOf(token);
      if (i >= 0) layers.splice(i, 1);
      if (trap && restoreTo) {
        restore.current = requestAnimationFrame(() => {
          restore.current = null;
          const active = document.activeElement;
          // Another layer opened in the same tick and has taken the focus (a
          // help topic run from the command palette): it owns the focus now,
          // and pulling it back to our own trigger would strand the reader
          // behind the new panel. The question can only be answered here, one
          // frame later: at cleanup time the focused node has just been
          // unmounted, so the focus is on <body> either way.
          if (active && active !== document.body) return;
          if (restoreTo.isConnected) restoreTo.focus();
        });
      }
    };
  }, [enabled, trap, panel]);
}

/** Escape-only layer, for a floating element with no panel to trap. */
export function useEscape(onEscape: () => void, enabled = true) {
  const none = useRef<HTMLElement>(null);
  useLayer(none, onEscape, { trap: false, enabled });
}

/** Locks the page scroll while a floating layer is open. */
export function useScrollLock() {
  useLayoutEffect(() => {
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = prev;
    };
  }, []);
}

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
 */
export function useSortableTable<T, K extends string>(
  rows: T[],
  rank: (row: T, key: K) => string | number,
  initial: SortState<NoInfer<K>>,
  compare: (x: string | number, y: string | number) => number = defaultCompare,
) {
  const [sort, setSort] = useState<SortState<K>>(initial);
  const toggle = (k: K) =>
    setSort((s) => (s.key === k ? { key: k, dir: s.dir === 1 ? -1 : 1 } : { key: k, dir: 1 }));
  const sorted = useMemo(
    () => [...rows].sort((a, b) => compare(rank(a, sort.key), rank(b, sort.key)) * sort.dir),
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

/** Clickable column header bound to useSortableTable. */
export function SortHeader<K extends string>({
  k,
  sort,
  onToggle,
  children,
  className = "",
  right,
}: {
  k: K;
  sort: SortState<K>;
  onToggle: (k: K) => void;
  children: ReactNode;
  className?: string;
  right?: boolean;
}) {
  const active = sort.key === k;
  return (
    <th className={cx(T.th, right && "text-right", className)}>
      <button
        type="button"
        className={cx(
          "inline-flex items-center gap-1 rounded-sm transition-colors hover:text-fg",
          active && "text-fg",
        )}
        onClick={() => onToggle(k)}
      >
        {children}
        {active ? (
          sort.dir === 1 ? <ArrowUp className="size-3" /> : <ArrowDown className="size-3" />
        ) : null}
      </button>
    </th>
  );
}

/**
 * Instant tooltip (replaces the laggy native `title`): inverted bubble with an
 * arrow, rendered in a portal on hover/focus after 120 ms, flipped below the
 * anchor near the top edge and clamped to the viewport. Wraps any element;
 * keep the accessible name (`aria-label`) on the control itself — the bubble
 * is aria-hidden. A nullish label renders the child untouched.
 * The bubble never takes the focus (portal, `pointer-events-none`, no
 * tabindex) and Escape dismisses it (WCAG 1.4.13).
 */
export function Tip({
  label,
  children,
  className = "inline-flex",
}: {
  label: string | null | undefined;
  children: ReactNode;
  className?: string;
}) {
  const [tip, setTip] = useState<{ x: number; y: number; below: boolean } | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Escape hides the bubble without moving the hover or the focus. Deliberately
  // not part of the layer stack: a tooltip never owns the Escape key.
  useEffect(() => {
    if (!tip) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setTip(null);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [tip]);
  useEffect(
    () => () => {
      if (timer.current) clearTimeout(timer.current);
    },
    [],
  );
  if (!label) return <>{children}</>;
  const arm = (el: HTMLElement) => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => {
      const r = el.getBoundingClientRect();
      const below = r.top < 44;
      setTip({
        x: Math.min(Math.max(r.left + r.width / 2, 16), window.innerWidth - 16),
        y: below ? r.bottom + 7 : r.top - 7,
        below,
      });
    }, 120);
  };
  const disarm = () => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = null;
    setTip(null);
  };
  return (
    <span
      className={className}
      onMouseEnter={(e) => arm(e.currentTarget)}
      onMouseLeave={disarm}
      onFocus={(e) => arm(e.currentTarget)}
      onBlur={disarm}
      onClick={disarm}
    >
      {children}
      {tip
        ? createPortal(
            <span
              aria-hidden
              className={`pointer-events-none fixed ${Z.tooltip}`}
              style={{
                left: tip.x,
                top: tip.y,
                transform: `translate(-50%, ${tip.below ? "0" : "-100%"})`,
              }}
            >
              <span
                className={cx(
                  "tip-bubble relative block rounded-lg bg-fg px-2.5 py-1.5 text-xs font-medium leading-snug text-canvas",
                  tip.below ? "origin-top" : "origin-bottom",
                  label.length > 60 ? "max-w-xs whitespace-normal" : "whitespace-nowrap",
                )}
              >
                {label}
                <span
                  className={cx(
                    "absolute left-1/2 size-2 -translate-x-1/2 rotate-45 bg-fg",
                    tip.below ? "-top-1" : "-bottom-1",
                  )}
                />
              </span>
            </span>,
            document.body,
          )
        : null}
    </span>
  );
}

/**
 * Is this element's text really cut by its ellipsis? A `truncate` label drops
 * what it cannot fit and the reader needs the rest — but ONLY then: a tooltip
 * that repeats a label already fully readable is noise on every row. Pair it
 * with `Tip` and pass the full text as the label only when this says `true`.
 *
 * The answer changes with the width of the frame, so the element is measured
 * again whenever it resizes. The ref is a callback ref rather than a
 * `useRef`: the node may be replaced (wrapping the row in a `Tip` re-parents
 * it), and the measurement has to follow the node that is actually on screen.
 */
export function useTruncated<T extends HTMLElement>(): [RefCallback<T>, boolean] {
  const [node, setNode] = useState<T | null>(null);
  const [truncated, setTruncated] = useState(false);
  useEffect(() => {
    if (!node) return;
    // One pixel of slack: a fractional text width rounds scrollWidth up by
    // itself, and a row that is not clipped must not claim it is.
    const measure = () => setTruncated(node.scrollWidth > node.clientWidth + 1);
    measure();
    // jsdom has no ResizeObserver; the one measurement above still stands.
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(measure);
    observer.observe(node);
    return () => observer.disconnect();
  }, [node]);
  return [setNode, truncated];
}

// --- Buttons ---

export type ButtonVariant = "primary" | "secondary" | "subtle" | "ghost" | "danger";
export type ButtonSize = "sm" | "md" | "lg";

const BUTTON_VARIANTS: Record<ButtonVariant, string> = {
  primary: "bg-accent text-on-fill hover:bg-accent-hover",
  secondary: "border border-line-strong bg-surface text-fg hover:bg-surface-2",
  subtle: "bg-surface-3 text-fg hover:bg-line-strong/70",
  ghost: "text-fg-muted hover:bg-surface-2 hover:text-fg",
  danger: "bg-danger text-on-fill hover:opacity-90",
};
const BUTTON_SIZES: Record<ButtonSize, string> = {
  sm: "h-7 px-3 text-[13px] [&_svg]:size-3.5",
  md: "h-8.5 px-4 text-sm [&_svg]:size-4",
  lg: "h-10 px-5 text-sm [&_svg]:size-4",
};

/** Class list of a button; shared by <Button>, <LinkButton> and raw anchors. */
export function buttonClass(variant: ButtonVariant = "primary", size: ButtonSize = "md", extra = "") {
  return cx(
    // disabled:pointer-events-none: hovering a disabled button must hit the
    // wrapping Tip span (disabled controls swallow mouse events).
    "inline-flex shrink-0 select-none items-center justify-center gap-1.5 whitespace-nowrap rounded-full font-medium transition-[background-color,color,border-color,opacity,transform] duration-150 ease-out-emphasized active:scale-97 disabled:pointer-events-none disabled:opacity-50",
    BUTTON_VARIANTS[variant],
    BUTTON_SIZES[size],
    extra,
  );
}

export function Button({
  children,
  variant = "primary",
  size = "md",
  loading,
  className = "",
  ...props
}: React.ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: ButtonVariant;
  size?: ButtonSize;
  /** Shows a spinner in place of the leading icon and disables the button. */
  loading?: boolean;
}) {
  return (
    <button
      type="button"
      {...props}
      disabled={props.disabled || loading}
      className={buttonClass(variant, size, className)}
    >
      {loading ? <Loader2 className="animate-spin" /> : null}
      {children}
    </button>
  );
}

/** Anchor styled as a button (external links, downloads, plain navigations). */
export function LinkButton({
  children,
  variant = "secondary",
  size = "md",
  className = "",
  ...props
}: React.AnchorHTMLAttributes<HTMLAnchorElement> & {
  variant?: ButtonVariant;
  size?: ButtonSize;
}) {
  return (
    <a {...props} className={buttonClass(variant, size, className)}>
      {children}
    </a>
  );
}

/** Icon-only round button on the shared Tip tooltip (label = accessible name too). */
export function IconButton({
  label,
  danger,
  active,
  size = "md",
  className = "",
  ...props
}: React.ButtonHTMLAttributes<HTMLButtonElement> & {
  label: string;
  danger?: boolean;
  /** Pressed state (view toggles, filters): accent-soft chip. */
  active?: boolean;
  size?: "sm" | "md";
}) {
  return (
    <Tip label={label}>
      <button
        type="button"
        {...props}
        aria-label={label}
        aria-pressed={active}
        className={cx(
          "inline-flex shrink-0 items-center justify-center rounded-full transition-colors duration-150 disabled:pointer-events-none disabled:opacity-40",
          size === "sm" ? "size-7 [&_svg]:size-3.5" : "size-8 [&_svg]:size-4",
          active
            ? "bg-accent-soft text-accent"
            : danger
              ? "text-fg-faint hover:bg-danger-soft hover:text-danger"
              : "text-fg-faint hover:bg-surface-2 hover:text-fg",
          className,
        )}
      />
    </Tip>
  );
}

// --- Identity ---

/** User avatar: uploaded/IdP picture, or initials on the accent color. */
export function Avatar({ me, className = "size-16 text-xl" }: { me: Me; className?: string }) {
  if (me.avatarUrl) {
    return (
      <img
        src={me.avatarUrl}
        alt=""
        className={`rounded-full object-cover ${className}`}
        referrerPolicy="no-referrer"
      />
    );
  }
  const initials =
    `${me.givenName.charAt(0)}${me.familyName.charAt(0)}`.toUpperCase() || "?";
  return (
    <span
      className={`inline-flex shrink-0 items-center justify-center rounded-full bg-accent font-semibold text-on-fill ${className}`}
    >
      {initials}
    </span>
  );
}

/** Initials disc for a roster entry (no account picture, or one that failed). */
export function Initials({
  name,
  className = "size-7 text-xs",
}: {
  name: [string, string];
  className?: string;
}) {
  const initials = `${name[0].charAt(0)}${name[1].charAt(0)}`.toUpperCase() || "?";
  return (
    <span
      className={`inline-flex shrink-0 items-center justify-center rounded-full bg-surface-3 font-semibold text-fg-muted ${className}`}
    >
      {initials}
    </span>
  );
}

/** Public GitHub avatar of an organization, with an icon fallback. */
export function OrgAvatar({ login, className = "size-5" }: { login: string; className?: string }) {
  const [failed, setFailed] = useState(false);
  if (failed) return <Building2 className={`${className} text-fg-faint`} />;
  return (
    <img
      src={`https://github.com/${login}.png?size=64`}
      alt=""
      referrerPolicy="no-referrer"
      onError={() => setFailed(true)}
      className={`shrink-0 rounded-md ${className}`}
    />
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

/** Current local time formatted for a datetime-local input. */
export function localDateTimeInputValue(date = new Date()): string {
  const d = new Date(date);
  d.setMinutes(d.getMinutes() - d.getTimezoneOffset());
  return d.toISOString().slice(0, 16);
}

// --- Floating layers: dialog, sheet, menu ---

function LayerClose({ onClose }: { onClose: () => void }) {
  return (
    <IconButton label="Close" onClick={onClose} className="-mr-1.5">
      <X />
    </IconButton>
  );
}

/**
 * Centered dialog for confirmations and one-field forms (≤ 480 px by
 * default). Long forms belong in a <Sheet>. Deliberately no close on
 * backdrop click: a stray click must not discard what the user typed.
 *
 * `xl` + `scroll` is the READING variant, and the one exception to the rule
 * above: not a form, a document — the whole of one student's answers, opened
 * from the live grid. It is as wide as a question needs (920 px, the width
 * the student read it at) and its body scrolls under a title and a footer
 * that stay put, because the footer is how the teacher walks to the next
 * student and it must not be at the bottom of a hundred lines of code.
 */
export function Modal({
  title,
  subtitle,
  size = "md",
  scroll = false,
  onClose,
  children,
  footer,
}: {
  title: string;
  /** Muted state line under the title. */
  subtitle?: ReactNode;
  size?: "sm" | "md" | "lg" | "xl";
  /** Cap the panel at the viewport and scroll the BODY, not the backdrop. */
  scroll?: boolean;
  onClose: () => void;
  children: ReactNode;
  /** Actions row, right-aligned, on its own hairline. */
  footer?: ReactNode;
}) {
  useScrollLock();
  const panel = useRef<HTMLDivElement>(null);
  const titleId = useId();
  useLayer(panel, onClose);
  const width = { sm: "max-w-105", md: "max-w-130", lg: "max-w-190", xl: "max-w-230" }[size];
  return createPortal(
    <div
      // The portal escapes the DOM but not the React tree: without this, a
      // click inside the dialog bubbles up to the <tr onClick> that rendered
      // it and toggles the row behind the user's back.
      onClick={(e) => e.stopPropagation()}
      className={`layer-backdrop fixed inset-0 ${Z.modal} flex items-start justify-center overflow-y-auto bg-fg/30 p-4 backdrop-blur-[2px] sm:items-center`}
    >
      <div
        ref={panel}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        tabIndex={-1}
        className={cx(
          "dialog-panel mt-8 w-full rounded-sheet border border-line bg-surface shadow-overlay focus:outline-none sm:mt-0",
          width,
          scroll && "flex max-h-[calc(100dvh-4rem)] flex-col",
        )}
      >
        <div className={cx("flex items-start gap-3 px-5 pt-5", scroll && "shrink-0")}>
          <div className="min-w-0 flex-1">
            <h2 id={titleId} className="text-lg font-bold tracking-tight">
              {title}
            </h2>
            {subtitle ? <p className="mt-0.5 text-sm text-fg-muted">{subtitle}</p> : null}
          </div>
          <LayerClose onClose={onClose} />
        </div>
        <div className={cx("px-5 py-4", scroll && "min-h-0 flex-1 overflow-y-auto")}>
          {children}
        </div>
        {footer ? (
          <div
            className={cx(
              "flex flex-wrap items-center justify-end gap-2 border-t border-line px-5 py-3",
              scroll && "shrink-0",
            )}
          >
            {footer}
          </div>
        ) : null}
      </div>
    </div>,
    document.body,
  );
}

/**
 * Right-hand drawer for anything longer than three fields (assignment form,
 * imports, histories). Header and footer stay put, the body scrolls.
 * Same closing rule as the dialog: Escape or the X, never the backdrop.
 */
export function Sheet({
  title,
  subtitle,
  onClose,
  children,
  footer,
  width = "md",
  flush,
}: {
  title: string;
  subtitle?: ReactNode;
  onClose: () => void;
  children: ReactNode;
  footer?: ReactNode;
  width?: "md" | "lg";
  /** Children own the padding (full-bleed sections separated by hairlines). */
  flush?: boolean;
}) {
  useScrollLock();
  const panel = useRef<HTMLDivElement>(null);
  const titleId = useId();
  useLayer(panel, onClose);
  return createPortal(
    <div
      // Same as Modal: a click in the panel must not reach the row, card or
      // cell whose onClick opened the sheet.
      onClick={(e) => e.stopPropagation()}
      className={`layer-backdrop fixed inset-0 ${Z.modal} flex justify-end bg-fg/30 backdrop-blur-[2px]`}
    >
      <div
        ref={panel}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        tabIndex={-1}
        className={cx(
          "sheet-panel flex h-full w-full flex-col border-l border-line bg-surface shadow-sheet focus:outline-none",
          width === "lg" ? "sm:max-w-190" : "sm:max-w-150",
        )}
      >
        <div className="flex items-start gap-3 border-b border-line px-6 pb-4 pt-5">
          <div className="min-w-0 flex-1">
            <h2 id={titleId} className="text-lg font-bold tracking-tight">
              {title}
            </h2>
            {subtitle ? <p className="mt-0.5 text-sm text-fg-muted">{subtitle}</p> : null}
          </div>
          <LayerClose onClose={onClose} />
        </div>
        <div className={cx("min-h-0 flex-1 overflow-y-auto", !flush && "px-6 py-5")}>
          {children}
        </div>
        {footer ? (
          <div className="flex flex-wrap items-center justify-end gap-2 border-t border-line bg-surface px-6 py-3">
            {footer}
          </div>
        ) : null}
      </div>
    </div>,
    document.body,
  );
}

export interface MenuItem {
  label: string;
  /** Second, muted line under the label: what the item produces, in one go. */
  description?: string;
  icon?: IconType;
  onSelect?: () => void;
  /** Plain link item (external URLs, downloads). */
  href?: string;
  danger?: boolean;
  /**
   * Greys the item out and takes it out of the arrow order. It reflects the
   * state WHEN THE MENU WAS OPENED, not a busy state: selecting an item
   * closes the menu, so a `disabled` bound to a mutation's `isPending` can
   * never be seen. Report progress with a toast instead.
   */
  disabled?: boolean;
  /** Draws a hairline above this item. */
  separator?: boolean;
}

/** Height assumed for the panel when deciding to flip it upward. */
const MENU_FLIP_MARGIN = 280;

/** How long after opening a scroll is treated as the opening, not a dismissal. */
const MENU_SCROLL_GRACE = 200;

export interface MenuPlacement {
  top?: number;
  bottom?: number;
  left: number;
  /** The panel opens above the trigger. */
  up: boolean;
}

/**
 * Fixed coordinates of the menu panel from the trigger rectangle. The panel
 * drops under the trigger, and flips above it when the trigger sits low on a
 * short viewport (the sidebar account row). `align="end"` anchors the panel's
 * right edge on the trigger's right; the caller applies the translation.
 * Pure on purpose: this is the part worth unit-testing.
 */
export function menuPosition(
  rect: { top: number; bottom: number; left: number; right: number },
  viewport: { width: number; height: number },
  align: "start" | "end",
  panelHeight = MENU_FLIP_MARGIN,
): MenuPlacement {
  const up = rect.bottom + panelHeight > viewport.height && rect.top > viewport.height / 2;
  return {
    ...(up ? { bottom: viewport.height - rect.top + 6 } : { top: rect.bottom + 6 }),
    left: align === "end" ? rect.right : rect.left,
    up,
  };
}

/**
 * Overflow menu for tertiary actions. Positioned in a portal from the
 * trigger's rectangle (so it escapes overflow-hidden cards and tables) and
 * closes on outside click, Escape, page scroll or selection. A scroll inside
 * the panel, or within `MENU_SCROLL_GRACE` of the opening, is not a dismissal.
 *
 * Keyboard (WAI-ARIA menu button): Enter, Space or ArrowDown on the trigger
 * opens the menu on its first item, ArrowUp opens it on the last; arrows move
 * with wrap, Home/End jump to the ends, Escape closes and hands the focus back
 * to the trigger, Tab closes and lets the browser carry on from the trigger.
 */
export function Menu({
  items,
  label = "More actions",
  trigger,
  align = "end",
}: {
  items: MenuItem[];
  label?: string;
  /** Custom trigger; the default is a round ellipsis button. */
  trigger?: ReactNode;
  align?: "start" | "end";
}) {
  const [open, setOpen] = useState(false);
  const [pos, setPos] = useState<MenuPlacement | null>(null);
  /** Index of the focused item in `items`; -1 when the menu was opened by mouse. */
  const [active, setActive] = useState(-1);
  const anchor = useRef<HTMLSpanElement>(null);
  const panel = useRef<HTMLDivElement>(null);
  const itemRefs = useRef<(HTMLElement | null)[]>([]);
  const menuId = useId();
  /**
   * When the menu opened, in ms. The opening click itself can make the page
   * scroll (the browser bringing the focused trigger into view on a tall
   * phone layout), and that scroll used to close the menu in the same frame.
   * Scrolls inside this grace period are the opening, not the user leaving.
   */
  const openedAt = useRef(0);

  /** Indexes of the items the keyboard may land on (disabled ones are skipped). */
  const reachable = useMemo(
    () => items.map((it, i) => (it.disabled ? -1 : i)).filter((i) => i >= 0),
    [items],
  );

  const close = useCallback((restoreFocus: boolean) => {
    setOpen(false);
    setActive(-1);
    if (restoreFocus) anchor.current?.querySelector<HTMLElement>("button, a")?.focus();
  }, []);

  useLayer(panel, () => close(true), { trap: false, enabled: open });

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      const t = e.target as Node;
      if (anchor.current?.contains(t) || panel.current?.contains(t)) return;
      close(false);
    };
    const onScroll = (e: Event) => {
      // A scroll inside the panel is the user reading a long menu, and one in
      // the first MENU_SCROLL_GRACE ms is the opening click's own scroll.
      if (panel.current?.contains(e.target as Node)) return;
      if (Date.now() - openedAt.current < MENU_SCROLL_GRACE) return;
      close(false);
    };
    const onResize = () => close(false);
    document.addEventListener("mousedown", onDown);
    window.addEventListener("scroll", onScroll, true);
    window.addEventListener("resize", onResize);
    return () => {
      document.removeEventListener("mousedown", onDown);
      window.removeEventListener("scroll", onScroll, true);
      window.removeEventListener("resize", onResize);
    };
  }, [open, close]);

  // The panel is portalled, so the focus can only move once it is on screen.
  useEffect(() => {
    if (open && active >= 0) itemRefs.current[active]?.focus();
  }, [open, active]);

  /*
   * `menuPosition` anchors the panel on the trigger and knows nothing of the
   * panel's own width, so a right-aligned trigger near the left edge (the
   * overflow button of a page header on a phone) put half the panel off
   * screen. Measure once it is laid out and nudge it back inside. A layout
   * effect: doing it after paint would show the panel in the wrong place for
   * one frame.
   */
  useLayoutEffect(() => {
    const el = panel.current;
    if (!open || !el) return;
    const margin = 8;
    const clamp = () => {
      if (!pos) return;
      el.style.marginLeft = "";
      // Computed from `pos` and the panel's width, never from its rectangle:
      // the opening animation owns `transform` for 160 ms and drops the
      // `translateX(-100%)` of a right-aligned panel while it plays, so a
      // measured rectangle is wrong exactly when this effect runs.
      const width = el.offsetWidth;
      const left = align === "end" ? pos.left - width : pos.left;
      const shift =
        left < margin
          ? margin - left
          : left + width > window.innerWidth - margin
            ? window.innerWidth - margin - (left + width)
            : 0;
      if (shift) el.style.marginLeft = `${shift}px`;
    };
    clamp();
    // The panel's width can land after the first measurement (a font, an icon
    // or, in dev, a class the stylesheet has not generated yet), and a stale
    // measurement is worse than none: re-clamp whenever it changes.
    const observer = new ResizeObserver(clamp);
    observer.observe(el);
    return () => observer.disconnect();
  }, [open, pos, align]);

  const openAt = (index: number) => {
    if (!anchor.current) return;
    const r = anchor.current.getBoundingClientRect();
    setPos(menuPosition(r, { width: window.innerWidth, height: window.innerHeight }, align));
    setActive(index);
    openedAt.current = Date.now();
    setOpen(true);
  };

  const onTriggerKeyDown = (e: React.KeyboardEvent) => {
    if (open) return;
    if (e.key === "Enter" || e.key === " " || e.key === "ArrowDown") {
      // preventDefault also swallows the click the browser would synthesize.
      e.preventDefault();
      openAt(reachable[0] ?? -1);
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      openAt(reachable[reachable.length - 1] ?? -1);
    }
  };

  const onPanelKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Tab") {
      // Hand the focus back to the trigger first: the browser's own Tab then
      // continues from there instead of restarting at the top of the document.
      close(true);
      return;
    }
    if (reachable.length === 0) return;
    const at = reachable.indexOf(active);
    const go = (next: number) => {
      e.preventDefault();
      setActive(reachable[(next + reachable.length) % reachable.length] ?? -1);
    };
    if (e.key === "ArrowDown") go(at + 1);
    else if (e.key === "ArrowUp") go(at < 0 ? reachable.length - 1 : at - 1);
    else if (e.key === "Home") go(0);
    else if (e.key === "End") go(reachable.length - 1);
  };

  const triggerProps = {
    "aria-haspopup": "menu" as const,
    "aria-expanded": open,
    "aria-controls": open ? menuId : undefined,
  };
  const triggerNode = trigger ? (
    // Clone so the ARIA state lands on the caller's real button.
    isValidElement<Record<string, unknown>>(trigger) ? (
      cloneElement(trigger, triggerProps)
    ) : (
      trigger
    )
  ) : (
    <IconButton label={label} {...triggerProps}>
      <Ellipsis />
    </IconButton>
  );

  return (
    <>
      <span
        ref={anchor}
        className="inline-flex"
        onKeyDown={onTriggerKeyDown}
        onClick={(e) => {
          e.stopPropagation();
          if (open) close(false);
          else openAt(-1);
        }}
      >
        {triggerNode}
      </span>
      {open && pos
        ? createPortal(
            <div
              ref={panel}
              id={menuId}
              role="menu"
              aria-label={label}
              tabIndex={-1}
              onKeyDown={onPanelKeyDown}
              className={cx(
                "menu-panel fixed min-w-44 rounded-menu border border-line bg-surface p-1 shadow-popover focus:outline-none",
                Z.popover,
                // A fixed width, not a max: the panel is `position: fixed` with
                // only `left` set, so shrink-to-fit gives it whatever is left
                // of the viewport — about nothing for a trigger on the right
                // edge, which squeezed a description into one word per line.
                items.some((it) => it.description) && "w-80 max-w-[calc(100vw-2rem)]",
              )}
              style={
                {
                  top: pos.top,
                  bottom: pos.bottom,
                  left: pos.left,
                  // Not `transform`: `.menu-panel` animates that property on
                  // open, and an animation owns it entirely while it plays.
                  // The alignment offset travels as a custom property the
                  // keyframes compose in (style.css).
                  "--menu-x": align === "end" ? "-100%" : "0",
                  transformOrigin: `${pos.up ? "bottom" : "top"} ${align === "end" ? "right" : "left"}`,
                } as React.CSSProperties
              }
              onClick={(e) => e.stopPropagation()}
            >
              {items.map((it, i) => {
                const Icon = it.icon;
                const cls = cx(
                  "flex w-full items-center gap-2.5 rounded-[10px] px-2.5 py-1.5 text-left text-sm transition-colors",
                  it.disabled
                    ? "pointer-events-none opacity-40"
                    : it.danger
                      ? "text-danger hover:bg-danger-soft"
                      : "text-fg hover:bg-surface-2",
                );
                const body = (
                  <>
                    {Icon ? (
                      <Icon
                        className={cx(
                          "size-4 shrink-0",
                          it.danger ? "" : "text-fg-faint",
                          // Two-line item: the icon aligns with the label, not
                          // with the middle of the block.
                          it.description && "mt-0.5 self-start",
                        )}
                      />
                    ) : null}
                    <span className="min-w-0">
                      {it.label}
                      {it.description ? (
                        <span className="mt-0.5 block text-xs font-normal text-fg-muted">
                          {it.description}
                        </span>
                      ) : null}
                    </span>
                  </>
                );
                return (
                  <div key={i} role="none">
                    {it.separator ? <div className="my-1 border-t border-line" role="none" /> : null}
                    {it.href ? (
                      <a
                        ref={(el) => {
                          itemRefs.current[i] = el;
                        }}
                        role="menuitem"
                        tabIndex={-1}
                        href={it.href}
                        target={it.href.startsWith("http") ? "_blank" : undefined}
                        rel="noreferrer"
                        className={cls}
                        onClick={() => close(true)}
                      >
                        {body}
                      </a>
                    ) : (
                      <button
                        ref={(el) => {
                          itemRefs.current[i] = el;
                        }}
                        type="button"
                        role="menuitem"
                        tabIndex={-1}
                        className={cls}
                        disabled={it.disabled}
                        aria-disabled={it.disabled}
                        onClick={() => {
                          // Focus first, so a layer opened by the item captures
                          // the trigger as the element to come back to.
                          close(true);
                          it.onSelect?.();
                        }}
                      >
                        {body}
                      </button>
                    )}
                  </div>
                );
              })}
            </div>,
            document.body,
          )
        : null}
    </>
  );
}

// --- Feedback ---

/** Centered spinner for a panel whose data is still loading. */
export function Spinner({ label, className = "py-12" }: { label?: string; className?: string }) {
  return (
    <div
      role="status"
      aria-live="polite"
      aria-label={label ?? "Loading"}
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

/** GitHub brand mark (brand icons were removed from lucide). */
export function GithubIcon({ className = "size-4" }: { className?: string }) {
  return (
    <svg viewBox="0 0 16 16" fill="currentColor" className={className} aria-hidden>
      <path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27s1.36.09 2 .27c1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.01 8.01 0 0 0 16 8c0-4.42-3.58-8-8-8Z" />
    </svg>
  );
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

/**
 * A query that failed: what could not be loaded, what the server said, and
 * the one thing that helps — asking again. `onRetry` is optional: some
 * failures (a one-shot list inside a form) have nothing to retry from here.
 */
export function QueryError({
  title,
  error,
  onRetry,
  retrying,
  fallback,
}: {
  title: string;
  error: unknown;
  onRetry?: () => void;
  retrying?: boolean;
  /**
   * Shown when the server sent no message of its own. It defaults to the
   * translated `error.server`: an English literal here was a French screen
   * one forgotten prop away (W9).
   */
  fallback?: string;
}) {
  const t = useT();
  return (
    <Alert
      tone="danger"
      icon={AlertTriangle}
      title={title}
      action={
        onRetry ? (
          <Button size="sm" variant="secondary" onClick={onRetry} loading={retrying}>
            <RefreshCw /> {t("common.retry")}
          </Button>
        ) : undefined
      }
    >
      {apiErrorMessage(error, fallback ?? t("error.server"))}
    </Alert>
  );
}

/**
 * A query that failed and took the WHOLE page with it. `QueryError` on its own
 * is an alert in a page frame; returned instead of the frame, it leaves the
 * document with no `<h1>` at all, and a screen reader with no way in (W3).
 * So the page keeps a heading — what could not be loaded — and the alert
 * underneath says what went wrong and offers the retry.
 */
export function PageError({
  title,
  ...rest
}: {
  /** The `<h1>`: what the page was, not what the server said. */
  title: string;
  error: unknown;
  onRetry?: () => void;
  retrying?: boolean;
  fallback?: string;
}) {
  const t = useT();
  return (
    <div className="space-y-6">
      <PageHeader title={title} />
      <QueryError title={t("error.title")} {...rest} />
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
          {help ? <HelpIcon topic={help} /> : null}
        </h1>
        {description ? <div className="mt-1.5 text-sm text-fg-muted">{description}</div> : null}
      </div>
      {actions ? <div className="flex flex-wrap items-center gap-2">{actions}</div> : null}
    </header>
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
  items: { value: V; label: string; count?: number; icon?: IconType }[];
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
    const keys = ["ArrowRight", "ArrowLeft", "Home", "End"];
    if (!keys.includes(e.key) || items.length === 0) return;
    e.preventDefault();
    const i = roving;
    const next =
      e.key === "ArrowRight" ? i + 1 : e.key === "ArrowLeft" ? i - 1 : e.key === "Home" ? 0 : items.length - 1;
    const target = items[(next + items.length) % items.length];
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

// --- Form controls ---

/**
 * Field chrome, with no width and no height of its own. Tailwind resolves
 * conflicting utilities by their order in the generated stylesheet, not by
 * their order in the class attribute, so a `w-16` or an `h-8` written next to
 * this string was never guaranteed to win. Size comes from `inputSize` and
 * width from the caller, which both compose instead of fighting.
 */
export const inputClass =
  "rounded-field border border-line-strong bg-surface px-3 text-sm text-fg transition-colors placeholder:text-fg-faint hover:border-fg-faint focus:border-accent focus:outline-none focus:ring-3 focus:ring-accent/20 disabled:opacity-50 disabled:hover:border-line-strong";

/** Control heights, aligned on the button scale of DESIGN.md (sm 28, md 34). */
export type InputSize = "sm" | "md";
export const inputSize: Record<InputSize, string> = {
  sm: "h-7",
  md: "h-8.5",
};

/**
 * Label above a control; used by Field, Select and Textarea.
 *
 * The <label> covers the text only. A <label> wrapping the help "?" button
 * makes that BUTTON its labelled control, which leaves the real input with no
 * accessible name and turns a click on the label into a click on help; so the
 * row is a div and the label points at the control through `htmlFor`.
 */
export function FieldLabel({
  children,
  htmlFor,
  help,
  hint,
}: {
  children: ReactNode;
  /** Id of the control this labels; omit for a label with no control. */
  htmlFor?: string;
  help?: string;
  hint?: ReactNode;
}) {
  return (
    <div className="flex items-center gap-1 text-[13px] font-medium text-fg">
      <label htmlFor={htmlFor}>{children}</label>
      {help ? <HelpIcon topic={help} /> : null}
      {hint ? <span className="ml-auto font-normal text-fg-faint">{hint}</span> : null}
    </div>
  );
}

export function Field({
  label,
  help,
  hint,
  fullWidth,
  size = "md",
  width = "w-52",
  className = "",
  ...props
}: Omit<React.InputHTMLAttributes<HTMLInputElement>, "size"> & {
  label: string;
  help?: string;
  /** Right-aligned note on the label line. */
  hint?: ReactNode;
  /** Stretch label and input to the parent width (grid cells). */
  fullWidth?: boolean;
  /** Control height: `sm` 28 px for dense rows, `md` 34 px by default. */
  size?: InputSize;
  /**
   * Width utility, on the wrapper so the label shares it. It lives here and
   * not in `className` because two width utilities on the same element are
   * resolved by the stylesheet order, not by the caller's intent.
   */
  width?: string;
}) {
  const auto = useId();
  const id = props.id ?? auto;
  return (
    <div className={cx("flex flex-col gap-1.5", fullWidth ? "w-full" : width)}>
      <FieldLabel htmlFor={id} help={help} hint={hint}>
        {label}
      </FieldLabel>
      <input {...props} id={id} className={cx(inputClass, inputSize[size], "w-full", className)} />
    </div>
  );
}

/** Native select with the field chrome and a chevron. */
export function Select({
  label,
  help,
  size = "md",
  width,
  className = "",
  children,
  ...props
}: Omit<React.SelectHTMLAttributes<HTMLSelectElement>, "size"> & {
  label?: string;
  help?: string;
  /** Control height: `sm` 28 px for dense rows, `md` 34 px by default. */
  size?: InputSize;
  /** Width utility on the wrapper; without it the select sizes to its parent. */
  width?: string;
}) {
  const auto = useId();
  const id = props.id ?? auto;
  const control = (
    <span className={cx("relative block", width)}>
      <select
        {...props}
        id={id}
        className={cx(inputClass, inputSize[size], "w-full appearance-none pr-8", className)}
      >
        {children}
      </select>
      <ChevronDown className="pointer-events-none absolute right-2.5 top-1/2 size-4 -translate-y-1/2 text-fg-faint" />
    </span>
  );
  if (!label) return control;
  // The width sits on the control; the label column takes it from there.
  return (
    <div className="flex flex-col gap-1.5">
      <FieldLabel htmlFor={id} help={help}>
        {label}
      </FieldLabel>
      {control}
    </div>
  );
}

export function Textarea({
  label,
  help,
  className = "",
  ...props
}: React.TextareaHTMLAttributes<HTMLTextAreaElement> & { label?: string; help?: string }) {
  // No `size` prop here on purpose: a textarea's height is its content, not
  // one of the two control heights.
  const auto = useId();
  const id = props.id ?? auto;
  const control = (
    <textarea
      {...props}
      id={id}
      className={cx(inputClass, "min-h-24 w-full py-2 leading-relaxed", className)}
    />
  );
  if (!label) return control;
  return (
    <div className="flex flex-col gap-1.5">
      <FieldLabel htmlFor={id} help={help}>
        {label}
      </FieldLabel>
      {control}
    </div>
  );
}

/** Pill search box; keeps its own width so toolbars stay aligned. */
export function SearchInput({
  className = "w-56",
  ...props
}: React.ComponentPropsWithRef<"input">) {
  return (
    <label className={cx("relative block", className)}>
      <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-fg-faint" />
      <input
        type="search"
        {...props}
        className={cx(inputClass, inputSize.md, "w-full rounded-full pl-9 pr-3")}
      />
    </label>
  );
}

/**
 * A value you switch on, drawn as a pill rather than as a box with a label
 * beside it (DESIGN.md › Components).
 *
 * A column of checkboxes is the right shape for a list of independent
 * settings; it is the wrong shape for a SET of values — the type of a
 * question, a difficulty, a tag — where the reader wants to see what is on
 * at a glance and where the labels are two words long. Ticked boxes laid out
 * in rows collide as soon as one label is long; pills carry their own
 * bounds, wrap cleanly and say "pressed" with a fill instead of a glyph.
 *
 * It is a real `aria-pressed` button, so a screen reader hears the state and
 * the label without the two ever getting separated. Containers lay them out
 * with `flex flex-wrap gap-2`.
 */
export function ToggleChip({
  label,
  icon: Icon,
  pressed,
  onToggle,
  className = "",
  "aria-label": ariaLabel,
}: {
  label: ReactNode;
  icon?: IconType;
  /**
   * On or off. `undefined` drops `aria-pressed` altogether, for the one pill
   * in a row that is an ACTION and not a value ("Show all (37)"): announcing
   * it as an unpressed toggle would promise a state it does not have.
   */
  pressed?: boolean;
  onToggle: () => void;
  className?: string;
  /** For a chip whose visible label is a bare number ("3" is not a name). */
  "aria-label"?: string;
}) {
  return (
    <button
      type="button"
      aria-pressed={pressed}
      aria-label={ariaLabel}
      onClick={onToggle}
      className={cx(
        "inline-flex h-7 shrink-0 items-center gap-1.5 whitespace-nowrap rounded-full border px-3 text-[13px] font-medium transition-colors duration-150",
        pressed
          ? "border-accent bg-accent-soft text-accent"
          : "border-line-strong bg-surface text-fg-muted hover:border-fg-faint hover:text-fg",
        className,
      )}
    >
      {Icon ? <Icon className="size-3.5 shrink-0" /> : null}
      {label}
    </button>
  );
}

/** Checkbox with the accent tick, label on the right. */
export function Checkbox({
  label,
  className = "",
  ...props
}: React.InputHTMLAttributes<HTMLInputElement> & { label: ReactNode }) {
  return (
    <label className={cx("inline-flex cursor-pointer items-center gap-2.5 text-sm", props.disabled && "opacity-50", className)}>
      <span className="relative inline-flex size-4 shrink-0">
        <input type="checkbox" {...props} className="peer size-4 appearance-none rounded-[5px] border border-line-strong bg-surface transition-colors checked:border-accent checked:bg-accent" />
        <Check className="pointer-events-none absolute inset-0 m-auto size-3 text-on-fill opacity-0 peer-checked:opacity-100" strokeWidth={3} />
      </span>
      {label}
    </label>
  );
}

/** On/off switch (settings rows). Accent when on: it is a state, not an action. */
export function Switch({
  checked,
  onChange,
  disabled,
  label,
}: {
  checked: boolean;
  onChange: (v: boolean) => void;
  disabled?: boolean;
  label: string;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      disabled={disabled}
      onClick={() => onChange(!checked)}
      className={cx(
        "relative inline-flex h-6 w-10 shrink-0 items-center rounded-full transition-colors duration-150 disabled:opacity-50",
        checked ? "bg-success" : "bg-line-strong",
      )}
    >
      <span
        className={cx(
          "absolute left-0.5 size-5 rounded-full bg-white shadow-[0_1px_2px_rgb(0_0_0/0.2)] transition-transform duration-150 ease-out-emphasized",
          checked ? "translate-x-4" : "translate-x-0",
        )}
      />
    </button>
  );
}

/**
 * Segmented control for a small set of mutually exclusive choices: the
 * selected chip is raised (surface + hairline) — selection is structure,
 * never color, the accent stays reserved for primary actions. Native radios
 * underneath (sr-only) keep it a keyboard-accessible radiogroup.
 */
export function Segmented<T extends string>({
  name,
  value,
  options,
  onChange,
  disabled,
  size = "md",
  label,
}: {
  /** Groups the native radios (one form can hold several groups). */
  name: string;
  value: T;
  options: { value: T; label: ReactNode }[];
  onChange: (value: T) => void;
  disabled?: boolean;
  size?: "sm" | "md";
  /**
   * The name of the GROUP, for a radiogroup that has no visible caption of
   * its own — two segmented controls side by side ("Group by", "Sort by")
   * are otherwise two anonymous rows of pills to a screen reader.
   */
  label?: string;
}) {
  return (
    <div
      role="radiogroup"
      {...(label === undefined ? {} : { "aria-label": label })}
      className={cx(
        "inline-flex shrink-0 gap-0.5 rounded-full bg-surface-3 p-0.75",
        disabled && "opacity-60",
      )}
    >
      {options.map((o) => (
        <label
          key={o.value}
          className={cx(
            "inline-flex items-center justify-center rounded-full px-3 font-medium transition-colors has-focus-visible:ring-2 has-focus-visible:ring-accent/50",
            size === "sm" ? "h-6 text-xs" : "h-7 text-[13px]",
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
            onChange={() => onChange(o.value)}
            disabled={disabled}
          />
          {o.label}
        </label>
      ))}
    </div>
  );
}

/**
 * Settings row: label + a description of the CURRENT choice on the left
 * (one dynamic line, not one per option), the control on the right.
 */
export function SettingRow({
  title,
  desc,
  help,
  children,
  className = "",
}: {
  title: ReactNode;
  desc?: ReactNode;
  help?: string;
  children?: ReactNode;
  className?: string;
}) {
  const id = useId();
  return (
    // The row wraps rather than squeezing: the text keeps a 14 rem floor, so a
    // wide control (segmented, select) drops to its own line on a phone while a
    // switch, which costs 40 px, stays on the label's line at any width.
    <div
      className={cx(
        "flex flex-wrap items-center justify-between gap-x-6 gap-y-2 py-3",
        className,
      )}
    >
      <div className="min-w-0 flex-1 basis-56">
        <span id={id} className="flex items-center gap-1 text-sm font-medium text-fg">
          {title}
          {help ? <HelpIcon topic={help} /> : null}
        </span>
        {desc ? <p className="mt-0.5 text-[13px] text-fg-muted">{desc}</p> : null}
      </div>
      {children ? <div className="flex shrink-0 items-center gap-2">{children}</div> : null}
    </div>
  );
}

// --- Live primitives (PLAN-MVP §6.4) ---
//
// The five shapes the live path needs: the countdown of the player, the ring
// of the lobby, the progress segments of the zen bar, the verdict cell of the
// dashboard grid and the save state that sits next to the countdown. They
// share three rules. Time is tabular, always, or the last digit dances.
// Nothing is carried by colour alone (N-A11Y): every state also has an icon
// and a word, visible or in the accessible name. And none of them owns a
// clock: the caller passes `now`, because on the live path that `now` is the
// SERVER's (`useServerClock`), never the browser's.

/**
 * "12:47", or "1:05:00" past an hour. Tabular digits are applied by the
 * component; the zero-padding is here so a minute never shifts the layout.
 * Past the deadline it is "0:00", never a negative: the server closes the
 * attempt, and a client counting into the red would be inventing a rule.
 */
export function formatRemaining(ms: number): string {
  const total = Math.max(0, Math.ceil(ms / 1000));
  const seconds = total % 60;
  const minutes = Math.floor(total / 60) % 60;
  const hours = Math.floor(total / 3600);
  const mm = hours > 0 ? String(minutes).padStart(2, "0") : String(minutes);
  return `${hours > 0 ? `${hours}:` : ""}${mm}:${String(seconds).padStart(2, "0")}`;
}

/** Under a minute everything is urgent, whatever the evaluation's own threshold. */
export const COUNTDOWN_DANGER_S = 60;

export type CountdownPhase = "normal" | "warning" | "danger" | "over";

/** Which of the four phases `remaining` ms falls in, given the warn threshold. */
export function countdownPhase(remainingMs: number, warnUnderS: number): CountdownPhase {
  if (remainingMs <= 0) return "over";
  const s = remainingMs / 1000;
  if (s <= COUNTDOWN_DANGER_S) return "danger";
  if (s <= warnUnderS) return "warning";
  return "normal";
}

const COUNTDOWN_TONE: Record<CountdownPhase, string> = {
  normal: "text-fg",
  warning: "text-warning",
  danger: "text-danger",
  over: "text-danger",
};

/**
 * Time left on a deadline the SERVER owns. `now` is passed in (from
 * `useServerClock`) rather than read here: two countdowns on one screen must
 * agree, and a component that calls `Date.now()` on its own would drift from
 * the attempt it belongs to.
 *
 * It turns `warning` under `warnUnderS` and `danger` under a minute, and it
 * says so out loud: the colour change is invisible to a screen reader and to
 * a third of the men in a lecture hall, so the phase is announced once, when
 * it is crossed, through a polite live region. Once, not every tick — a timer
 * that speaks every second is a timer nobody can work next to.
 *
 * `paused` freezes it. A paused evaluation is not consuming its window, so a
 * display that keeps falling is telling a room full of students something
 * false (W16); it holds the time it was paused at and says "paused" beside
 * it, because a frozen number and a slow one look the same for a second.
 */
export function Countdown({
  deadlineAt,
  now,
  warnUnderS = 300,
  paused = false,
  icon = true,
  className = "",
}: {
  /** Epoch ms, the server's. */
  deadlineAt: number;
  /** Epoch ms on the server's clock, ticked by the caller. */
  now: number;
  /** Seconds under which the countdown turns `warning`. */
  warnUnderS?: number;
  /** The evaluation is paused: freeze the digits and say so. */
  paused?: boolean;
  icon?: boolean;
  className?: string;
}) {
  const t = useT();
  // The last tick seen while running. Written during render on purpose: it is
  // a cache of a prop, not state — `paused` flipping must freeze the number
  // that is on screen in that very commit, not one tick later.
  const lastRunning = useRef(now);
  if (!paused) lastRunning.current = now;
  const remaining = deadlineAt - (paused ? lastRunning.current : now);
  const label = formatRemaining(remaining);
  const phase = paused ? "normal" : countdownPhase(remaining, warnUnderS);
  const [announced, setAnnounced] = useState("");
  useEffect(() => {
    if (phase === "normal") {
      setAnnounced("");
      return;
    }
    setAnnounced(
      phase === "over" ? t("countdown.over") : t("countdown.announce", { time: label }),
    );
    // `label` on purpose out of the deps: the announcement is made when the
    // phase is CROSSED, with the time it was crossed at, and not again at the
    // next tick.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [phase, t]);
  return (
    <>
      <span
        role="timer"
        aria-label={
          paused
            ? t("countdown.remainingPaused", { time: label })
            : phase === "over"
              ? t("countdown.over")
              : t("countdown.remaining", { time: label })
        }
        className={cx(
          "inline-flex items-center gap-1.5 text-[15px] font-medium tabular-nums",
          paused ? "text-fg-muted" : COUNTDOWN_TONE[phase],
          className,
        )}
      >
        {icon ? (paused ? <Pause className="size-4" aria-hidden /> : <Clock className="size-4" aria-hidden />) : null}
        <span>{label}</span>
        {/* The word rides with the icon: both belong to the full
            presentation. A dense countdown (`icon={false}`, one per row of
            the live grid) would otherwise print "paused" twenty-four times
            under a badge that already says it once. The accessible name
            carries it in every variant. */}
        {paused && icon ? (
          <span aria-hidden className="text-[13px] font-normal">
            {t("countdown.paused")}
          </span>
        ) : null}
      </span>
      <span className="sr-only" aria-live="polite">
        {announced}
      </span>
    </>
  );
}

/**
 * Progress ring: the lobby's "present / enrolled" and the dashboard's
 * completion. `fg` and not the accent — on the waiting screen it is the only
 * living element, and a red disc would read as an alarm on a page whose whole
 * message is "there is nothing to do".
 *
 * The label is the accessible name of the whole figure; `children` is what is
 * drawn in the middle (a big number and a caption) and is hidden from the
 * reader, which would otherwise hear "18 present of 24 18 24".
 */
export function Ring({
  value,
  max,
  size = 208,
  thickness = 10,
  label,
  children,
  className = "",
}: {
  value: number;
  max: number;
  size?: number;
  thickness?: number;
  /** Accessible name; the ring is a figure, so it needs one. */
  label: string;
  children?: ReactNode;
  className?: string;
}) {
  const safeMax = max > 0 ? max : 1;
  const ratio = Math.min(1, Math.max(0, value / safeMax));
  const radius = (size - thickness) / 2;
  const circumference = 2 * Math.PI * radius;
  return (
    <div
      className={cx("relative shrink-0", className)}
      style={{ width: size, height: size }}
      role="img"
      aria-label={label}
    >
      <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} className="-rotate-90" aria-hidden>
        <circle
          cx={size / 2}
          cy={size / 2}
          r={radius}
          fill="none"
          strokeWidth={thickness}
          className="stroke-surface-3"
        />
        <circle
          cx={size / 2}
          cy={size / 2}
          r={radius}
          fill="none"
          strokeWidth={thickness}
          strokeLinecap="round"
          strokeDasharray={`${circumference * ratio} ${circumference}`}
          className="stroke-fg transition-[stroke-dasharray] duration-200 ease-out-emphasized"
        />
      </svg>
      {children ? (
        <div className="absolute inset-0 flex flex-col items-center justify-center" aria-hidden>
          {children}
        </div>
      ) : null}
    </div>
  );
}

export type SegmentState = "empty" | "answered" | "done" | "current";

const SEGMENT_BAR: Record<SegmentState, string> = {
  empty: "h-1.5 bg-surface-3",
  answered: "h-1.5 bg-line-strong",
  done: "h-1.5 bg-fg",
  current: "h-2 bg-accent",
};

const SEGMENT_LABEL: Record<SegmentState, "segments.empty" | "segments.answered" | "segments.done" | "segments.current"> = {
  empty: "segments.empty",
  answered: "segments.answered",
  done: "segments.done",
  current: "segments.current",
};

export interface Segment {
  /** Stable key, and what the caller gets back from `onSelect`. */
  id: string;
  state: SegmentState;
}

/** The `gap-1` between two bars, in px: part of what the numbers compete for. */
const SEGMENT_GAP = 4;

/**
 * How often a number is shown, from the strip's measured width. `1` is "every
 * one of them"; `5` and `10` are the compressed modes. A width of 0 is "not
 * measured yet" (first paint, or a test with no layout) and shows everything:
 * the strip must never come up thinned out on a screen that had the room.
 */
export function segmentLabelStep(width: number, count: number): 1 | 5 | 10 {
  if (width <= 0 || count <= 1) return 1;
  const per = (width - SEGMENT_GAP * (count - 1)) / count;
  if (per >= 22) return 1;
  return per >= 11 ? 5 : 10;
}

/**
 * One bar per question in the zen player (mockup 07): where the student is,
 * what is done, what was opened and left, what was never opened. Four states
 * and not five, because "seen but empty" and "answered" are the same decision
 * for the reader: there is something left to do there.
 *
 * Roving tabindex like `Tabs`: twenty questions must not be twenty stops on
 * the way to the answer field. Arrows move with wrap, Home and End jump, and
 * the accessible name of each bar carries its state in words — the height and
 * the tone are the same information for everyone else.
 *
 * It spans the WHOLE width it is given and the bars share it equally
 * (`flex-1 basis-0`, no cap): three questions are three wide bars over the
 * question column, not a stub at its left edge — the strip is a map of the
 * paper, and a map that covers a tenth of the page maps nothing.
 *
 * Every bar carries its number, so the student can aim at "question 7"
 * without counting. When there are enough questions for the numbers to stop
 * fitting, the strip COMPRESSES rather than wraps or scrolls: the bars stay,
 * the numbers thin out to anchors. The rule, from the measured width of the
 * strip (`segmentLabelStep`, gaps included):
 *
 *   - a segment at least 22 px wide holds two digits and its breathing room:
 *     every number is shown (up to ~30 questions over the player's 760 px);
 *   - at least 11 px: the first, the last, the current and every 5th;
 *   - under that: the first, the last, the current and every 10th.
 *
 * A multiple that lands within two slots of the last one is dropped, so "30"
 * and "32" never collide. Nothing is lost for a screen reader: the number and
 * the state live in each bar's accessible name, which never thins out.
 */
export function ProgressSegments({
  segments,
  onSelect,
  label,
  className = "",
}: {
  segments: Segment[];
  /** Absent = the strip is a read-only indicator (navigation is locked). */
  onSelect?: (id: string, index: number) => void;
  /** Accessible name of the strip, e.g. "Progress: question 4 of 8". */
  label: string;
  className?: string;
}) {
  const t = useT();
  const strip = useRef<HTMLElement>(null);
  const current = Math.max(0, segments.findIndex((s) => s.state === "current"));
  // The strip's own width, not the viewport's: it sits in a 760 px column on
  // a laptop and in a 358 px one on a phone, and only its own width says how
  // much room a number has.
  const [width, setWidth] = useState(0);
  useLayoutEffect(() => {
    const el = strip.current;
    if (!el) return;
    const measure = () => setWidth(el.clientWidth);
    measure();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    return () => observer.disconnect();
  }, []);
  const step = segmentLabelStep(width, segments.length);

  const onKeyDown = (e: React.KeyboardEvent) => {
    const keys = ["ArrowRight", "ArrowLeft", "Home", "End"];
    if (!keys.includes(e.key)) return;
    const buttons = Array.from(strip.current?.querySelectorAll("button") ?? []);
    if (buttons.length === 0) return;
    const from = buttons.indexOf(document.activeElement as HTMLButtonElement);
    const at = from === -1 ? current : from;
    const next =
      e.key === "Home"
        ? 0
        : e.key === "End"
          ? buttons.length - 1
          : (at + (e.key === "ArrowRight" ? 1 : -1) + buttons.length) % buttons.length;
    e.preventDefault();
    buttons[next]?.focus();
  };

  return (
    <nav
      ref={strip}
      aria-label={label}
      onKeyDown={onKeyDown}
      className={cx(
        "flex w-full items-start",
        // Compressed, the 4 px gaps are what the bars are losing: forty of
        // them spend 156 px on air. Halving the gap is measured against the
        // wider one, so the bars only ever come out wider than the rule
        // assumed, never thinner.
        step === 1 ? "gap-1" : "gap-0.5",
        className,
      )}
    >
      {segments.map((segment, i) => {
        const name = t("segments.item", { n: i + 1, state: t(SEGMENT_LABEL[segment.state]) });
        const last = segments.length - 1;
        const numbered =
          step === 1 ||
          i === 0 ||
          i === last ||
          i === current ||
          ((i + 1) % step === 0 && last - i >= 2);
        return (
          <button
            key={segment.id}
            type="button"
            disabled={!onSelect}
            tabIndex={i === current ? 0 : -1}
            aria-label={name}
            aria-current={segment.state === "current" ? "true" : undefined}
            onClick={() => onSelect?.(segment.id, i)}
            className="min-w-0.5 flex-1 basis-0 rounded-full px-0 py-1.5 disabled:cursor-default"
          >
            <span className={cx("block rounded-full transition-colors duration-150", SEGMENT_BAR[segment.state])} />
            {/* The row keeps its height whether or not it holds a number, so
                the bars stay on one line. The number overflows its own bar
                when compressed — its neighbours are empty, so there is room. */}
            <span
              className={cx(
                "mt-0.5 block h-2.75 overflow-visible whitespace-nowrap text-center text-[11px] leading-none tabular-nums",
                segment.state === "current"
                  ? "font-semibold text-accent"
                  : "font-medium text-fg-faint",
              )}
              aria-hidden
            >
              {numbered ? i + 1 : null}
            </span>
          </button>
        );
      })}
    </nav>
  );
}

export type VerdictState =
  | "blank"
  | "inProgress"
  | "answered"
  | "done"
  | "correct"
  | "partial"
  | "wrong"
  | "pending";

type VerdictKey =
  | "verdict.blank"
  | "verdict.inProgress"
  | "verdict.answered"
  | "live.verdict.done"
  | "verdict.correct"
  | "verdict.partial"
  | "verdict.wrong"
  | "verdict.pending";

/**
 * The PROGRESS half of the scale (`inProgress`, `answered`, `done`) is blue
 * and the VERDICT half (`correct`, `partial`, `wrong`) keeps the semantic
 * green / amber / red, so a teacher scanning a grid never mistakes "they
 * wrote something" for "it is right". The two blues are the same hue at two
 * strengths — `info-soft` for an answer that is still being written,
 * `info` filled for one the student has marked done — because the progression
 * is a progression: a column darkening from left to right is a class moving
 * through the quiz, readable at squinting distance and on a projector.
 *
 * `done` is the one state the grading list cannot show, which is why its word
 * lives with the live dictionary and not with the six shared `verdict.*` ones.
 */
const VERDICTS: Record<VerdictState, { icon: IconType; tint: string; key: VerdictKey }> = {
  blank: { icon: Circle, tint: "text-line-strong", key: "verdict.blank" },
  inProgress: { icon: Ellipsis, tint: "bg-surface-2 text-fg-faint", key: "verdict.inProgress" },
  answered: { icon: PenLine, tint: "bg-info-soft text-info", key: "verdict.answered" },
  done: { icon: CircleCheck, tint: "bg-info text-on-fill", key: "live.verdict.done" },
  correct: { icon: Check, tint: "bg-success-soft text-success", key: "verdict.correct" },
  partial: { icon: ChartPie, tint: "bg-warning-soft text-warning", key: "verdict.partial" },
  wrong: { icon: X, tint: "bg-danger-soft text-danger", key: "verdict.wrong" },
  pending: { icon: Hourglass, tint: "bg-surface-2 text-fg-faint", key: "verdict.pending" },
};

/**
 * One cell of the live grid and of the grading list (mockup 03). Shape, icon
 * and tint together, never the tint alone: a dashboard projected on a lecture
 * hall wall loses half its saturation, and one teacher in twelve cannot tell
 * the green from the amber at all. The word is in the accessible name, and
 * `value` — the student's answer in one glyph, "B", "NULL", "3/3" — sits next
 * to the icon for everyone else.
 */
export function VerdictCell({
  state,
  value,
  onClick,
  label,
  className = "",
}: {
  state: VerdictState;
  /** The answer in a glyph or two; `—` and the like belong in the caller. */
  value?: ReactNode;
  onClick?: () => void;
  /** Overrides the accessible name (to add the student and the question). */
  label?: string;
  className?: string;
}) {
  const t = useT();
  const { icon: Icon, tint, key } = VERDICTS[state];
  const name = label ?? t(key);
  // The answer carries no colour of its own: it INHERITS the state's ink,
  // which is the only way it stays legible on every tint. `text-fg` on the
  // filled `done` blue measured 2.9:1, under half of what a teacher three
  // rows back needs; on the state's own ink every pair is 4.7:1 or better.
  const content = (
    <>
      <Icon className="size-3.5 shrink-0" aria-hidden />
      {value != null && value !== "" ? (
        <span className="max-w-11.5 truncate text-xs font-medium">{value}</span>
      ) : null}
    </>
  );
  const chrome = cx(
    "inline-flex h-7 w-full items-center justify-center gap-1 rounded-[7px] px-1",
    tint,
    className,
  );
  if (!onClick) {
    return (
      <span className={chrome} title={name}>
        {content}
        <span className="sr-only">{name}</span>
      </span>
    );
  }
  return (
    <button type="button" onClick={onClick} aria-label={name} className={cx(chrome, "transition-opacity hover:opacity-80")}>
      {content}
    </button>
  );
}

export type SyncState = "saved" | "saving" | "offline" | "closed";

type SyncKey = "sync.saved" | "sync.saving" | "sync.offline" | "sync.closed";

const SYNC: Record<SyncState, { icon: IconType; tone: string; key: SyncKey; spin?: boolean }> = {
  saved: { icon: Check, tone: "text-fg-muted [&_svg]:text-success", key: "sync.saved" },
  saving: { icon: Loader2, tone: "text-fg-muted [&_svg]:text-fg-faint", key: "sync.saving", spin: true },
  offline: { icon: WifiOff, tone: "text-warning", key: "sync.offline" },
  closed: { icon: Lock, tone: "text-fg-faint", key: "sync.closed" },
};

/**
 * Whether the student's work is safe, in the zen bar (mockup 07). Icon AND
 * word, and the word is what survives: "hors ligne" in amber next to a
 * countdown in red is two reds to anyone who cannot separate them. The word
 * hides under `sm` where the bar has no room, and the accessible name keeps
 * it. A polite live region, because this one genuinely must be heard when it
 * changes — it is the answer to "did that save?".
 */
export function SyncBadge({ state, className = "" }: { state: SyncState; className?: string }) {
  const t = useT();
  const { icon: Icon, tone, key, spin } = SYNC[state];
  const word = t(key);
  return (
    <span
      role="status"
      aria-live="polite"
      className={cx("inline-flex items-center gap-1.5 whitespace-nowrap text-[13px]", tone, className)}
    >
      <Icon className={cx("size-3.5 shrink-0", spin && "animate-spin")} aria-hidden />
      <span className="hidden sm:inline">{word}</span>
      <span className="sr-only sm:hidden">{word}</span>
    </span>
  );
}
