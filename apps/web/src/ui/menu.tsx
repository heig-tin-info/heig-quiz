import { Ellipsis } from "lucide-react";
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
} from "react";
import type { ReactNode } from "react";
import { createPortal } from "react-dom";

import { useT } from "../i18n";
import { isPlainClick } from "./controls";
import { cx, IconButton, useLayer, Z, type IconType } from "./layers";

/*
 * The overflow menu (`Menu`) and the keyboard arithmetic every list and strip
 * of the app shares: `listboxIndex` for a vertical list (a listbox, a menu,
 * the command palette), `rovingIndex` for a horizontal roving-tabindex strip,
 * and `menuPosition`, the pure placement a popover reuses. On layers.
 */

export interface MenuItem {
  label: string;
  /** Second, muted line under the label: what the item produces, in one go. */
  description?: string;
  icon?: IconType;
  onSelect?: () => void;
  /**
   * Link item (external URLs, downloads, a page of the app). With `onSelect`
   * too, a plain click calls it instead of following the link (the app
   * routes it) and a middle click still opens a tab.
   */
  href?: string;
  /** Tooltip on hover: what the label abbreviates. */
  title?: string;
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
  /** Indentation level, for the deeper levels of a tree (the journal's pages). */
  depth?: number;
  /** The item is the page on view: `aria-current="page"` and the `accent-soft` chip. */
  current?: boolean;
  /** A faint icon after the label, with its accessible name (a page hidden from students). */
  mark?: { icon: IconType; label: string };
  /** Not an item: the label of the items under it (a folder that does not navigate). */
  heading?: boolean;
}

/** A `MenuItem`'s mark: a 14 px icon that a screen reader reads by its label. */
export function ItemMark({ mark, className = "" }: { mark: MenuItem["mark"]; className?: string }) {
  if (!mark) return null;
  const Icon = mark.icon;
  return (
    <span role="img" aria-label={mark.label} className={cx("inline-flex shrink-0", className)}>
      <Icon className="size-3.5" />
    </span>
  );
}

/** The left padding of an item at `depth`: the item's own 10 px, then 12 px a level. */
const indent = (depth = 0) => (depth > 0 ? { paddingLeft: `calc(0.625rem + ${depth * 0.75}rem)` } : undefined);

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
 * caret (a tag or teacher combobox) they belong to the field. `wrap: false`
 * stops the arrows at both ends instead (the pool's rows: the last row is the
 * last LOADED one, and wrapping to the top would hide that more exist).
 *
 * Only the index: each call site keeps its own `preventDefault` and its own
 * side effects (opening the list, focusing a row), which is where the
 * components differ — DESIGN.md › Keyboard and focus.
 */
export function listboxIndex(
  key: string,
  active: number,
  count: number,
  { ends = false, wrap = true }: { ends?: boolean; wrap?: boolean } = {},
): number | null {
  if (key === "ArrowDown" || key === "ArrowUp") {
    if (count === 0) return active;
    if (active < 0) return key === "ArrowDown" ? 0 : count - 1;
    if (!wrap) return Math.min(Math.max(active + (key === "ArrowDown" ? 1 : -1), 0), count - 1);
    return (active + (key === "ArrowDown" ? 1 : count - 1)) % count;
  }
  if (ends && key === "Home") return 0;
  if (ends && key === "End") return Math.max(0, count - 1);
  return null;
}

/**
 * The next stop of a horizontal roving-tabindex strip (`Tabs`,
 * `ProgressSegments`): ArrowRight / ArrowLeft with wrap, Home / End to the
 * ends. Null for any other key, and for an empty strip. A grid (the question
 * type tiles) passes its `columns`: ArrowDown / ArrowUp then move a row, and
 * stay put at the first or last one.
 */
export function rovingIndex(
  key: string,
  current: number,
  count: number,
  columns?: number,
): number | null {
  if (count === 0) return null;
  if (columns !== undefined && (key === "ArrowDown" || key === "ArrowUp")) {
    const next = current + (key === "ArrowDown" ? columns : -columns);
    return next >= 0 && next < count ? next : current;
  }
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
    () => items.map((it, i) => (it.disabled || it.heading ? -1 : i)).filter((i) => i >= 0),
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
                // A list longer than the room left scrolls inside the panel
                // (every group of a set to move a student into, M3-16a).
                "menu-panel fixed min-w-44 overflow-y-auto rounded-menu border border-line bg-surface p-1 shadow-popover focus:outline-none",
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
                  maxHeight: `calc(100dvh - ${(pos.top ?? pos.bottom ?? 0) + 8}px)`,
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
                      : it.current
                        ? "bg-accent-soft font-medium text-accent"
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
                    <ItemMark mark={it.mark} className="ml-auto text-fg-faint" />
                  </>
                );
                return (
                  <div key={i} role="none">
                    {it.separator ? <div className="my-1 border-t border-line" role="none" /> : null}
                    {it.heading ? (
                      <div aria-hidden className="px-2.5 pb-0.5 pt-1.5 text-xs font-medium text-fg-faint" style={indent(it.depth)}>
                        {it.label}
                      </div>
                    ) : it.href ? (
                      <a
                        ref={(el) => {
                          itemRefs.current[i] = el;
                        }}
                        role="menuitem"
                        tabIndex={-1}
                        href={it.href}
                        target={it.href.startsWith("http") ? "_blank" : undefined}
                        rel="noreferrer"
                        title={it.title}
                        aria-current={it.current ? "page" : undefined}
                        className={cls}
                        style={indent(it.depth)}
                        onClick={(e) => {
                          close(true);
                          if (!it.onSelect || !isPlainClick(e)) return;
                          e.preventDefault();
                          it.onSelect();
                        }}
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
                        title={it.title}
                        className={cls}
                        style={indent(it.depth)}
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
