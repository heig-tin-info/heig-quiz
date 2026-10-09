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
import type { ComponentProps, ComponentType, ReactNode, RefCallback, RefObject } from "react";
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
  /** A mode banner (`ModeBanner`): over the sticky bars (z-20), under the coach. */
  banner: "z-30",
  /**
   * A tool docked on the player (the calculator, ADR-069): over the page and
   * its sticky bars, under the pause overlay, the coach marks and every dialog.
   */
  tool: "z-35",
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
 *
 * Not for an element whose click and Enter do different things: the pool's
 * rows look on a click and edit on Enter, and answer their own keys
 * (`pool/useQuestionBrowse.ts`).
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
 * True when `query` matches, following the window as it changes. False
 * where `matchMedia` does not exist (a test).
 */
function useMediaQuery(query: string): boolean {
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

/**
 * Tailwind's `lg`, the frame's breakpoint: under it the phone layout (top
 * bar, bottom bar, floating action button), from it the sidebar.
 */
export const LG_PX = 1024;

/**
 * True from `px` wide up, following the window as it resizes. False where
 * `matchMedia` does not exist (a test), so a component defaults to its
 * phone layout there — the one that also renders inside a narrow window.
 */
export function useMinWidth(px: number): boolean {
  return useMediaQuery(`(min-width: ${px}px)`);
}

/**
 * True on a coarse pointer (touch, no hover) — a phone or tablet, where the
 * soft keyboard has to fight the on-screen content for space. False where
 * `matchMedia` does not exist (a test) or the pointer is fine (mouse,
 * trackpad).
 */
export function useCoarsePointer(): boolean {
  return useMediaQuery("(pointer: coarse)");
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
 *
 * `escape: false` leaves Escape to the layer itself: the expand layer
 * (`ui/expand.tsx`) holds a canvas that cancels a tool or a
 * selection on Escape first, and closes only on a key the canvas left alone
 * — which a listener in the capture phase, as here, would never see.
 */
export function useLayer(
  panel: RefObject<HTMLElement | null>,
  onClose: () => void,
  {
    trap = true,
    enabled = true,
    escape = true,
  }: { trap?: boolean; enabled?: boolean; escape?: boolean } = {},
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
      if (e.key === "Escape" && escape) {
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
  }, [enabled, trap, escape, panel]);
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

/** Where a `Tip` opens: above its anchor (flipped below near the top), or at its right. */
export type TipSide = "top" | "right";

/**
 * Instant tooltip (replaces the laggy native `title`): inverted bubble with an
 * arrow, rendered in a portal on hover/focus after 120 ms, flipped below the
 * anchor when it would leave the top edge and clamped to the viewport. Wraps
 * any element; keep the accessible name (`aria-label`) on the control itself —
 * the bubble is aria-hidden. A nullish label and no `media` render the child
 * untouched, and no bubble shows while both are empty.
 * `media` is a picture shown in the SAME bubble, over the label (an avatar
 * enlarged): one bubble, never two stacked ones. `null` means "a picture may
 * come": the wrapper is there already, so the child is not remounted when
 * it arrives.
 * The bubble never takes the focus (portal, `pointer-events-none`, no
 * tabindex) and Escape dismisses it (WCAG 1.4.13). A Tip INSIDE a popup
 * trigger whose panel is open (an ancestor with `aria-haspopup` and
 * `aria-expanded="true"`, a `Popover` or `Menu` trigger) stays shut: the
 * panel says more, and the two would overlap. A plain disclosure row does not
 * silence it. A Tip wrapped AROUND its trigger (`IconButton`, the folded
 * sidebar's avatar) is dismissed by the click that opens the panel, caught
 * on the way down since the trigger keeps its click to itself.
 * `side="right"` opens the bubble beside the anchor, vertically centred: the
 * folded sidebar's icons, where a bubble above would cover the row above.
 */
export function Tip({
  label,
  media,
  children,
  className = "inline-flex",
  side = "top",
}: {
  label: string | null | undefined;
  media?: ReactNode;
  children: ReactNode;
  className?: string;
  side?: TipSide;
}) {
  const [tip, setTip] = useState<{
    x: number;
    top: number;
    bottom: number;
    below: boolean;
  } | null>(null);
  const right = side === "right";
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const bubble = useRef<HTMLSpanElement>(null);
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
  // A bubble taller than the room above its anchor (a picture, a wrapped
  // label) goes below instead, when there is more room there. Measured before
  // the paint, so it never shows in the wrong place first.
  useLayoutEffect(() => {
    const el = bubble.current;
    if (!tip || tip.below || right || !el) return;
    if (tip.top - 7 - el.offsetHeight < 8 && window.innerHeight - tip.bottom > tip.top) {
      setTip({ ...tip, below: true });
    }
  }, [tip, right]);
  if (!label && media === undefined) return <>{children}</>;
  const arm = (el: HTMLElement) => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => {
      if ((!label && !media) || el.closest('[aria-haspopup][aria-expanded="true"]')) return;
      const r = el.getBoundingClientRect();
      setTip({
        x: right ? r.right : Math.min(Math.max(r.left + r.width / 2, 16), window.innerWidth - 16),
        top: r.top,
        bottom: r.bottom,
        below: !right && r.top < 44,
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
      // Capture: a `Menu` trigger inside stops its click from bubbling, and
      // the bubble must still give way to the panel that click opens.
      onClickCapture={disarm}
    >
      {children}
      {tip
        ? createPortal(
            <span
              aria-hidden
              className={`pointer-events-none fixed ${Z.tooltip}`}
              style={
                right
                  ? { left: tip.x + 7, top: (tip.top + tip.bottom) / 2, transform: "translateY(-50%)" }
                  : {
                      left: tip.x,
                      top: tip.below ? tip.bottom + 7 : tip.top - 7,
                      transform: `translate(-50%, ${tip.below ? "0" : "-100%"})`,
                    }
              }
            >
              <span
                ref={bubble}
                className={cx(
                  "tip-bubble relative block rounded-lg bg-fg text-xs font-medium leading-snug text-canvas",
                  media ? "p-1.5 text-center" : "px-2.5 py-1.5",
                  right ? "origin-left" : tip.below ? "origin-top" : "origin-bottom",
                  label && label.length > 60 ? "max-w-xs whitespace-normal" : "whitespace-nowrap",
                )}
              >
                {media}
                {label && media ? <span className="block px-1 pb-0.5 pt-1.5">{label}</span> : label}
                <span
                  className={cx(
                    "absolute size-2 rotate-45 bg-fg",
                    right
                      ? "-left-1 top-1/2 -translate-y-1/2"
                      : cx("left-1/2 -translate-x-1/2", tip.below ? "-top-1" : "-bottom-1"),
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

/**
 * The help topic of the mounted screen: the ONE slot its `PageHelpButton`
 * fills while it is mounted, as `screenCommands.ts` does for the palette's
 * commands. The teacher assistant reads it when a question leaves
 * (ADR-080 §2), so the screen's topic is the one its "?" opens, never a
 * second list beside it. One slot: one page header is mounted at a time.
 */
let currentTopic: string | null = null;

export function useCurrentHelpTopic(topic: string): void {
  useEffect(() => {
    currentTopic = topic;
    return () => {
      if (currentTopic === topic) currentTopic = null;
    };
  }, [topic]);
}

/** The mounted screen's help topic, or null when it has none. */
export const currentHelpTopic = (): string | null => currentTopic;

/**
 * The help of a whole page: a round button in the header's action row, as
 * tall as the secondary buttons beside it (34 px) and outlined like them, so
 * it lines up with them instead of with the title. The title changes — it is
 * renamed in place, carries a badge, wraps on a phone — and a "?" riding it
 * never sat right; the action row does not move. `HelpIcon` stays the mark of
 * a section, a field or a dialog, where the help is about the words beside it.
 */
export function PageHelpButton({ topic }: { topic: string }) {
  const { t } = useI18n();
  const { open } = useContext(HelpContext);
  useCurrentHelpTopic(topic);
  return (
    <Tip label={t("help.title")}>
      <button
        type="button"
        aria-label={t("help.title")}
        data-coach="page.help"
        onClick={() => open(topic)}
        // The outline and height of a secondary button, written out: `buttonClass`
        // carries a horizontal padding that a square button cannot override
        // (two paddings are settled by stylesheet order, not by writing order).
        className="touch-hit inline-flex size-8.5 shrink-0 items-center justify-center rounded-full border border-line-strong bg-surface text-fg-muted transition-colors duration-150 hover:bg-surface-2 hover:text-fg active:scale-97 [&_svg]:size-4"
      >
        <CircleHelp />
      </button>
    </Tip>
  );
}

/**
 * The round ghost disc of an icon button and an icon link. Drawn at 28 or
 * 32 px; under a coarse pointer its hit area is 44 px (`touch-hit`).
 */
const iconDisc = (size: "sm" | "md") =>
  cx(
    "touch-hit inline-flex shrink-0 items-center justify-center rounded-full transition-colors duration-150",
    size === "sm" ? "size-7 [&_svg]:size-3.5" : "size-8 [&_svg]:size-4",
  );

/**
 * {@link IconButton}'s disc as a link to a page OUTSIDE the app, in a new
 * tab (a repository on GitHub, M3-14h): an address one may also copy or
 * open with a modified click, which a button is not. The label is its
 * tooltip and its accessible name; a click on it never opens the row or
 * the card it sits in.
 */
export function IconLink({ label, href, children }: { label: string; href: string; children: React.ReactNode }) {
  return (
    <Tip label={label}>
      <a
        href={href}
        target="_blank"
        rel="noreferrer"
        aria-label={label}
        onClick={(e) => e.stopPropagation()}
        className={cx(iconDisc("md"), "text-fg-faint hover:bg-surface-2 hover:text-fg")}
      >
        {children}
      </a>
    </Tip>
  );
}

/** Icon-only round button on the shared Tip tooltip (label = accessible name too). */
export function IconButton({
  label,
  danger,
  active,
  shortcut,
  size = "md",
  tipSide,
  className = "",
  ...props
}: React.ButtonHTMLAttributes<HTMLButtonElement> & {
  label: string;
  danger?: boolean;
  /** Pressed state (view toggles, filters): accent-soft chip. */
  active?: boolean;
  /**
   * The key that does the same thing, as `aria-keyshortcuts` spells it: a
   * letter ("F") or "Space". The tooltip names it in parentheses ("Full
   * screen (F)", "… (Espace)" in French), and assistive technology reads it
   * from the attribute rather than from the name.
   */
  shortcut?: string;
  size?: "sm" | "md";
  /** Where the tooltip opens (`Tip`'s `side`). */
  tipSide?: TipSide;
}) {
  const t = useT();
  const key = shortcut === "Space" ? t("key.space") : shortcut;
  return (
    <Tip label={key ? `${label} (${key})` : label} side={tipSide}>
      <button
        type="button"
        {...props}
        aria-label={label}
        aria-keyshortcuts={shortcut}
        aria-pressed={active ?? props["aria-pressed"]}
        className={cx(
          iconDisc(size),
          "disabled:pointer-events-none disabled:opacity-40",
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
 * A layer's header (mark, title, subtitle, moves, close), its body and its
 * footer: the one column a dialog, a sheet and a docked `Pane` share.
 */
function LayerColumn({
  title,
  subtitle,
  onClose,
  footer,
  leading,
  actions,
  titleId,
  headerClass,
  bodyClass,
  footerClass,
  children,
}: {
  title: string;
  subtitle?: ReactNode;
  onClose: () => void;
  footer?: ReactNode;
  leading?: ReactNode;
  actions?: ReactNode;
  titleId: string;
  headerClass: string;
  bodyClass: string;
  footerClass: string;
  children: ReactNode;
}) {
  return (
    <>
      <div className={headerClass}>
        {leading ? <div className="mt-1 shrink-0">{leading}</div> : null}
        <div className="min-w-0 flex-1">
          <h2 id={titleId} className="text-lg font-bold tracking-tight">
            {title}
          </h2>
          {subtitle ? <p className="mt-0.5 text-sm text-fg-muted">{subtitle}</p> : null}
        </div>
        {actions ? <div className="flex shrink-0 items-center gap-0.5">{actions}</div> : null}
        <LayerClose onClose={onClose} />
      </div>
      <div className={bodyClass}>{children}</div>
      {footer ? <div className={footerClass}>{footer}</div> : null}
    </>
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
  leading,
  actions,
  children,
}: {
  title: string;
  subtitle?: ReactNode;
  onClose: () => void;
  footer?: ReactNode;
  /** Drawn before the title: what the layer is about, as a mark. */
  leading?: ReactNode;
  /** Drawn before the close button: the layer's own moves (previous, next). */
  actions?: ReactNode;
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
    <LayerColumn
      {...{ title, subtitle, onClose, footer, leading, actions, titleId }}
      {...{ headerClass, bodyClass, footerClass }}
    >
      {children}
    </LayerColumn>
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
 * `xl` + `scroll` is the READING variant, the one exception to the rule
 * above: not a form, a document whose body scrolls under a title and a
 * footer that stay put — one student's answers opened from the live grid,
 * the Safe Exam Browser launch of an exam (its steps beside its conditions).
 * Its users and their reasons: `apps/web/DESIGN.md`, Dialog.
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

/** A sheet's column, shared with the `Pane` that docks the same content. */
const SHEET_HEADER = "flex items-start gap-3 border-b border-line px-6 pb-4 pt-5";
const SHEET_BODY = "min-h-0 flex-1 overflow-y-auto";
const SHEET_FOOTER =
  "flex flex-wrap items-center justify-end gap-2 border-t border-line bg-surface px-6 py-3";

/** The narrowest window that holds a docked `Sheet` aside beside a `lg` drawer. */
export const ASIDE_MIN_WIDTH = 1280;

/**
 * Right-hand drawer for anything longer than three fields (assignment form,
 * imports, histories). Header and footer stay put, the body scrolls. Under
 * `lg` the same dialog is a BOTTOM sheet (DESIGN.md › Sheet): full width,
 * rising from the bottom edge, as tall as its content up to the window less
 * a strip of the page behind it.
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
  leading,
  actions,
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
  /**
   * A mark before the title — the verdict of the answer a reading sheet
   * shows (the grading panel) — and the sheet's own moves before its close
   * button (previous, next). Both optional; a form sheet has neither.
   */
  leading?: ReactNode;
  actions?: ReactNode;
}) {
  const docked = aside != null;
  return (
    <LayerShell
      title={title}
      subtitle={subtitle}
      onClose={onClose}
      footer={footer}
      leading={leading}
      actions={actions}
      backdropClass={`layer-backdrop fixed inset-0 ${Z.modal} flex flex-col justify-end bg-fg/30 backdrop-blur-[2px] lg:flex-row`}
      panelClass={cx(
        "sheet-panel flex bg-surface focus:outline-none",
        // Under `lg`, a bottom sheet: full width, as tall as its content up to
        // the window less a strip of the page, its top corners rounded, the
        // home-indicator inset kept clear. From `lg`, the right-hand drawer.
        "max-lg:max-h-[calc(100dvh-2.5rem)] max-lg:flex-col max-lg:rounded-t-sheet max-lg:border-t max-lg:border-line max-lg:pb-[env(safe-area-inset-bottom)] max-lg:shadow-overlay",
        "lg:h-full lg:border-l lg:border-line lg:shadow-sheet",
        docked ? "max-w-full" : cx("w-full", width === "lg" ? "lg:max-w-190" : "lg:max-w-150"),
      )}
      aside={{
        node: aside,
        className: "min-h-0 w-120 overflow-y-auto border-r border-line bg-surface-2 2xl:w-160",
        columnClass: cx(
          "flex min-h-0 min-w-0 flex-col",
          docked ? cx("shrink-0", width === "lg" ? "w-190" : "w-150") : "flex-1",
        ),
      }}
      headerClass={SHEET_HEADER}
      bodyClass={cx(SHEET_BODY, !flush && "px-6 py-5")}
      footerClass={SHEET_FOOTER}
    >
      {children}
    </LayerShell>
  );
}

/**
 * A `Sheet` that does not cover the page: the same header, body and footer,
 * docked in the page's flow beside what opened it, which stays readable and
 * clickable. Sticky under the top of the window, as tall as it at most, its
 * body scrolling on its own. Not a dialog — no focus trap, no Escape of its
 * own: the screen that docks it closes it, and a sheet may open over it.
 *
 * The screen docks it only when the window has room (`ASIDE_MIN_WIDTH`),
 * widens its box by `width` (`pageBox`), and falls back to the `Sheet`
 * otherwise.
 */
export function Pane({
  width,
  title,
  subtitle,
  onClose,
  children,
  footer,
  leading,
  actions,
}: {
  /** A CSS width, the one the screen widens its box by. */
  width: string;
  title: string;
  subtitle?: ReactNode;
  onClose: () => void;
  children: ReactNode;
  footer?: ReactNode;
  leading?: ReactNode;
  actions?: ReactNode;
}) {
  const titleId = useId();
  return (
    <aside
      aria-labelledby={titleId}
      style={{ width }}
      className="sticky top-8 flex max-h-[calc(100dvh-4rem)] shrink-0 flex-col overflow-hidden rounded-card border border-line bg-surface"
    >
      <LayerColumn
        {...{ title, subtitle, onClose, footer, leading, actions, titleId }}
        headerClass={SHEET_HEADER}
        bodyClass={cx(SHEET_BODY, "px-6 py-5")}
        footerClass={SHEET_FOOTER}
      >
        {children}
      </LayerColumn>
    </aside>
  );
}

/**
 * A `Pane` beside the list when the screen docks one (`pane`, its CSS width),
 * a `Sheet` over it otherwise: the same content either way.
 */
export function PaneOrSheet({
  pane,
  width,
  ...props
}: Omit<ComponentProps<typeof Sheet>, "flush" | "aside"> & { pane: string | null }) {
  return pane ? <Pane width={pane} {...props} /> : <Sheet width={width} {...props} />;
}
