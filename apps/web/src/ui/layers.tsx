import { CircleHelp, X } from "lucide-react";
import {
  createContext,
  useContext,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import type { ComponentType, ReactNode, RefCallback, RefObject } from "react";
import { createPortal } from "react-dom";

import { cx } from "@quiz/ui";

import { useI18n, useT } from "../i18n";

/*
 * Shared primitives. Every visual value here comes from DESIGN.md (tokens in
 * style.css): semantic colors (`surface`, `fg-muted`, `line`…) swap in dark
 * mode by themselves, so components carry no `dark:` variants.
 */

/**
 * Joins class names, skipping falsy entries. Written once, in `@quiz/ui`,
 * which the question-type packages use too: the app and the `qt-*` surfaces
 * it hosts compose their classes with the same function.
 */
export { cx };

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
  /** Coach marks: over the page and its sticky bars, under every dialog. */
  coach: "z-45",
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

/** One shared timer per interval, and who listens to it. */
const tickers = new Map<number, { timer: ReturnType<typeof setInterval>; listeners: Set<() => void> }>();

function onTick(intervalMs: number, listener: () => void): () => void {
  let ticker = tickers.get(intervalMs);
  if (!ticker) {
    const listeners = new Set<() => void>();
    const timer = setInterval(() => {
      for (const l of listeners) l();
    }, intervalMs);
    ticker = { timer, listeners };
    tickers.set(intervalMs, ticker);
  }
  ticker.listeners.add(listener);
  return () => {
    ticker.listeners.delete(listener);
    if (ticker.listeners.size > 0) return;
    clearInterval(ticker.timer);
    tickers.delete(intervalMs);
  };
}

/**
 * The app's one ticking clock: re-renders the caller every `intervalMs` with
 * `read()` — the browser's time by default, the SERVER's on the live path
 * (`useServerClock().now`, which must be stable). Every caller of an interval
 * shares one timer and moves in the same tick, so two countdowns on a screen
 * never disagree by a second. Call it in the LEAF that shows the time: the
 * component that calls it re-renders with every tick, and so does everything
 * under it.
 */
export function useNow(intervalMs = 30_000, read: () => number = Date.now): number {
  const [now, setNow] = useState(read);
  useEffect(() => {
    // A new clock is read at once, not a tick later.
    setNow(read());
    return onTick(intervalMs, () => setNow(read()));
  }, [intervalMs, read]);
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
function focusableIn(root: HTMLElement): HTMLElement[] {
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

/**
 * The opener of the help drawer. `HelpProvider` (help.tsx) fills it; outside
 * a provider a "?" is a no-op.
 */
export const HelpContext = createContext<{ open: (key: string) => void }>({ open: () => {} });

/**
 * The "?" beside a title, a label or a section heading. It sits on the text
 * line, and both of its dimensions are decided HERE, once, for every call
 * site — a "?" placed by hand next to one title and not the next is exactly
 * the sloppiness this replaces.
 *
 * Size: 16 px. The icon is read as a mark next to a word, not as an action of
 * its own; at 14 px it disappeared under a 28 px page title, and one step up
 * is enough — a bigger circle beside a 13 px label would outweigh the label.
 *
 * Vertical placement: the icon belongs to ONE LINE of text — the first one of
 * the title it follows, even when that title wraps. Two things put it there:
 *
 *  - the STRUT below, an empty line of the surrounding text inside the
 *    wrapper. It makes the wrapper exactly one line tall, whatever the
 *    line-height around it, so `self-start` lands the icon on the first line
 *    of a wrapped title instead of leaving it floating between the two — and
 *    in a plain text flow (no flex row) it gives the wrapper the text's own
 *    baseline, which is the same alignment by another road;
 *  - the em NUDGE. Centered in that line, the icon still reads as lifted: the
 *    line box is taller than the letters and hangs below them (it carries the
 *    descender space and the leading), so its middle sits above the middle of
 *    what the eye reads. The nudge puts the icon back on the letters, between
 *    the cap-height middle and the x-height middle. In `em` on purpose: the
 *    error it corrects is a fraction of the font size, so the one value holds
 *    at 13 px and at 28 px and no call site has to re-tune it.
 */
export function HelpIcon({
  topic,
  className = "",
  coach,
}: {
  topic: string;
  className?: string;
  /** A coach mark's anchor (`coach/catalog.ts`). */
  coach?: string;
}) {
  const { t } = useI18n();
  const { open } = useContext(HelpContext);
  return (
    <Tip label={t("help.title")} className="inline-flex shrink-0 items-center self-start">
      <span aria-hidden className="w-0 overflow-hidden">
        {"\u200b"}
      </span>
      <button
        type="button"
        aria-label={t("help.title")}
        data-coach={coach}
        onClick={(e) => {
          e.stopPropagation();
          open(topic);
        }}
        className={`inline-flex translate-y-[0.0625em] items-center justify-center rounded-full p-0.5 text-fg-faint transition-colors hover:text-accent ${className}`}
      >
        <CircleHelp className="size-4" />
      </button>
    </Tip>
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

// --- Floating layers: dialog, sheet (the menu is in menu.tsx) ---

function LayerClose({ onClose }: { onClose: () => void }) {
  const t = useT();
  return (
    <IconButton label={t("common.close")} onClick={onClose} className="-mr-1.5">
      <X />
    </IconButton>
  );
}

/**
 * The shell `Modal` and `Sheet` share: a portalled backdrop, the dialog panel
 * registered on the layer stack, the title row with its close button, the
 * body and the optional footer. The two callers supply every class string, so
 * each keeps its own geometry. A form layer: the backdrop never closes it.
 */
function LayerShell({
  title,
  subtitle,
  onClose,
  footer,
  backdropClass,
  panelClass,
  headerClass,
  bodyClass,
  footerClass,
  aside,
  children,
}: {
  title: string;
  subtitle?: ReactNode;
  onClose: () => void;
  footer?: ReactNode;
  backdropClass: string;
  panelClass: string;
  headerClass: string;
  bodyClass: string;
  footerClass: string;
  /**
   * A pane docked BEFORE the header/body/footer column, inside the same
   * dialog: it shares the focus trap and the Escape, and a click in it stays
   * in the layer. `panelClass` then lays the two out in a row. The column is
   * wrapped whether or not the pane is there, so the pane coming and going
   * never remounts the column — and never drops the focus held inside it.
   */
  aside?: { node: ReactNode; className: string; columnClass: string };
  children: ReactNode;
}) {
  useScrollLock();
  const panel = useRef<HTMLDivElement>(null);
  const titleId = useId();
  useLayer(panel, onClose);
  const column = (
    <>
      <div className={headerClass}>
        <div className="min-w-0 flex-1">
          <h2 id={titleId} className="text-lg font-bold tracking-tight">
            {title}
          </h2>
          {subtitle ? <p className="mt-0.5 text-sm text-fg-muted">{subtitle}</p> : null}
        </div>
        <LayerClose onClose={onClose} />
      </div>
      <div className={bodyClass}>{children}</div>
      {footer ? <div className={footerClass}>{footer}</div> : null}
    </>
  );
  return createPortal(
    <div
      // The portal escapes the DOM but not the React tree: without this, a
      // click inside the dialog bubbles up to the <tr onClick> that rendered
      // it and toggles the row behind the user's back.
      onClick={(e) => e.stopPropagation()}
      className={backdropClass}
    >
      <div
        ref={panel}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        tabIndex={-1}
        className={panelClass}
      >
        {aside ? (
          <>
            {aside.node ? <aside className={aside.className}>{aside.node}</aside> : null}
            <div className={aside.columnClass}>{column}</div>
          </>
        ) : (
          column
        )}
      </div>
    </div>,
    document.body,
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
  const width = { sm: "max-w-105", md: "max-w-130", lg: "max-w-190", xl: "max-w-230" }[size];
  return (
    <LayerShell
      title={title}
      subtitle={subtitle}
      onClose={onClose}
      footer={footer}
      backdropClass={`layer-backdrop fixed inset-0 ${Z.modal} flex items-start justify-center overflow-y-auto bg-fg/30 p-4 backdrop-blur-[2px] sm:items-center`}
      panelClass={cx(
        "dialog-panel mt-8 w-full rounded-sheet border border-line bg-surface shadow-overlay focus:outline-none sm:mt-0",
        width,
        scroll && "flex max-h-[calc(100dvh-4rem)] flex-col",
      )}
      headerClass={cx("flex items-start gap-3 px-5 pt-5", scroll && "shrink-0")}
      bodyClass={cx("px-5 py-4", scroll && "min-h-0 flex-1 overflow-y-auto")}
      footerClass={cx(
        "flex flex-wrap items-center justify-end gap-2 border-t border-line px-5 py-3",
        scroll && "shrink-0",
      )}
    >
      {children}
    </LayerShell>
  );
}

/** The narrowest window that holds a docked `Sheet` aside beside a `lg` drawer. */
export const ASIDE_MIN_WIDTH = 1280;

/**
 * Right-hand drawer for anything longer than three fields (assignment form,
 * imports, histories). Header and footer stay put, the body scrolls.
 * Same closing rule as the dialog: Escape or the X, never the backdrop.
 *
 * `aside` docks a READING pane on the drawer's left edge, over the page the
 * drawer would otherwise leave blurred and unused: the question picker shows
 * the question last clicked there. It is part of the same dialog, never
 * a second layer (a sheet never opens another sheet). The drawer keeps its
 * width, so the caller passes an aside only when the window has room for
 * both (`useMinWidth(ASIDE_MIN_WIDTH)`), and does without it otherwise.
 */
export function Sheet({
  title,
  subtitle,
  onClose,
  children,
  footer,
  width = "md",
  flush,
  aside,
}: {
  title: string;
  subtitle?: ReactNode;
  onClose: () => void;
  children: ReactNode;
  footer?: ReactNode;
  width?: "md" | "lg";
  /** Children own the padding (full-bleed sections separated by hairlines). */
  flush?: boolean;
  /** The docked reading pane; it scrolls on its own and owns its padding. */
  aside?: ReactNode;
}) {
  const docked = aside != null;
  return (
    <LayerShell
      title={title}
      subtitle={subtitle}
      onClose={onClose}
      footer={footer}
      backdropClass={`layer-backdrop fixed inset-0 ${Z.modal} flex justify-end bg-fg/30 backdrop-blur-[2px]`}
      panelClass={cx(
        "sheet-panel flex h-full border-l border-line bg-surface shadow-sheet focus:outline-none",
        docked ? "max-w-full" : cx("w-full", width === "lg" ? "sm:max-w-190" : "sm:max-w-150"),
      )}
      aside={{
        node: aside,
        className: "min-h-0 w-120 overflow-y-auto border-r border-line bg-surface-2 2xl:w-160",
        columnClass: cx(
          "flex min-w-0 flex-col",
          docked ? cx("shrink-0", width === "lg" ? "w-190" : "w-150") : "flex-1",
        ),
      }}
      headerClass="flex items-start gap-3 border-b border-line px-6 pb-4 pt-5"
      bodyClass={cx("min-h-0 flex-1 overflow-y-auto", !flush && "px-6 py-5")}
      footerClass="flex flex-wrap items-center justify-end gap-2 border-t border-line bg-surface px-6 py-3"
    >
      {children}
    </LayerShell>
  );
}
