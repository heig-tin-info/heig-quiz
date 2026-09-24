import { CircleHelp, Ellipsis, X } from "lucide-react";
import {
  cloneElement,
  createContext,
  isValidElement,
  useCallback,
  useContext,
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import type { ComponentType, ReactNode, RefCallback, RefObject } from "react";
import { createPortal } from "react-dom";

import { useI18n, useT } from "../i18n";

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

// --- Floating layers: dialog, sheet, menu ---

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
  children: ReactNode;
}) {
  useScrollLock();
  const panel = useRef<HTMLDivElement>(null);
  const titleId = useId();
  useLayer(panel, onClose);
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
  return (
    <LayerShell
      title={title}
      subtitle={subtitle}
      onClose={onClose}
      footer={footer}
      backdropClass={`layer-backdrop fixed inset-0 ${Z.modal} flex justify-end bg-fg/30 backdrop-blur-[2px]`}
      panelClass={cx(
        "sheet-panel flex h-full w-full flex-col border-l border-line bg-surface shadow-sheet focus:outline-none",
        width === "lg" ? "sm:max-w-190" : "sm:max-w-150",
      )}
      headerClass="flex items-start gap-3 border-b border-line px-6 pb-4 pt-5"
      bodyClass={cx("min-h-0 flex-1 overflow-y-auto", !flush && "px-6 py-5")}
      footerClass="flex flex-wrap items-center justify-end gap-2 border-t border-line bg-surface px-6 py-3"
    >
      {children}
    </LayerShell>
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

// --- Keyboard arithmetic shared by the lists and the strips ---

/**
 * The next highlighted row of a vertical list (a listbox, a menu, the command
 * palette) for `key`, or null when the key is not the list's. The arrows
 * wrap; with nothing highlighted yet (`active < 0`) ArrowDown lands on the
 * first row and ArrowUp on the last. An empty list keeps `active`, so the
 * caller still owns the key (the arrows must not move a caret meanwhile).
 * Home and End jump only when `ends` is set: in a text field that owns its
 * caret (a tag or teacher combobox) they belong to the field.
 *
 * Only the index: each call site keeps its own `preventDefault` and its own
 * side effects (opening the list, focusing a row), which is where the
 * components differ — DESIGN.md › Keyboard and focus.
 */
export function listboxIndex(
  key: string,
  active: number,
  count: number,
  { ends = false }: { ends?: boolean } = {},
): number | null {
  if (key === "ArrowDown" || key === "ArrowUp") {
    if (count === 0) return active;
    if (active < 0) return key === "ArrowDown" ? 0 : count - 1;
    return (active + (key === "ArrowDown" ? 1 : count - 1)) % count;
  }
  if (ends && key === "Home") return 0;
  if (ends && key === "End") return Math.max(0, count - 1);
  return null;
}

/**
 * The next stop of a horizontal roving-tabindex strip (`Tabs`,
 * `ProgressSegments`): ArrowRight / ArrowLeft with wrap, Home / End to the
 * ends. Null for any other key, and for an empty strip.
 */
export function rovingIndex(key: string, current: number, count: number): number | null {
  if (count === 0) return null;
  if (key === "ArrowRight") return (current + 1 + count) % count;
  if (key === "ArrowLeft") return (current - 1 + count) % count;
  if (key === "Home") return 0;
  if (key === "End") return count - 1;
  return null;
}

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
  label: givenLabel,
  trigger,
  align = "end",
}: {
  items: MenuItem[];
  label?: string;
  /** Custom trigger; the default is a round ellipsis button. */
  trigger?: ReactNode;
  align?: "start" | "end";
}) {
  const t = useT();
  const label = givenLabel ?? t("common.moreActions");
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
    const next = listboxIndex(e.key, reachable.indexOf(active), reachable.length, { ends: true });
    if (next === null) return;
    e.preventDefault();
    setActive(reachable[next] ?? -1);
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
                  "flex w-full items-center gap-2.5 rounded-field px-2.5 py-1.5 text-left text-sm transition-colors",
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
