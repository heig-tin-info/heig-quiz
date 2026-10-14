/**
 * A tool docked at the bottom right (DESIGN.md: the calculator, ADR-069; the
 * help assistant, ADR-080): a 48 px round button in the neutral ink and the
 * NON-modal panel it opens above it.
 *
 * Nothing behind the panel is inert and focus is not trapped: the page stays
 * readable and usable. Escape, the button or the panel's own close (the
 * `close` handed to `children`) closes it, and focus returns to the button.
 * The panel is named by its own heading: `children` get the `titleId` to
 * put on it (`aria-labelledby`).
 * The wrapper is a tool dock (`data-tool-dock`): the toasts rise above it
 * (`--tool-dock-h`). `offset` is the CSS length the dock sits above (a
 * footer or a bottom bar); `keepMounted` keeps the panel's state across a
 * close, as a calculator put down on the desk.
 *
 * Several tools on one screen (the player's calculator and notepad,
 * ADR-090) form one group: each takes a `slot`, its button stacked
 * `--tool-dock-step` (56 px) above the previous one (`data-tool-dock-slot`, which raises
 * `--tool-dock-h` for the whole stack), and the owner holds which one is
 * open through `open`/`onOpenChange`, so one panel shows at a time. Every
 * panel rises above the whole stack.
 *
 * `sheetOnPhone` (the help assistant, #450, #849): on a phone
 * (`usePhoneScreen`: held upright, or in landscape) a floating panel is the
 * window less its margins, or a few lines between the top bar and the docks,
 * so it opens instead as a full-height bottom sheet over a dimmed page —
 * MODAL there (focus trapped, the page scroll locked), the one exception to
 * the non-modal panel (DESIGN.md, "The help assistant"; ADR-080 amendments).
 * The sheet fits the part of the window the person sees (`useVisibleBox`),
 * so a soft keyboard lifts its bottom — the composer — above the keys.
 * Which one is decided when the panel opens and holds until it closes,
 * whatever a rotation does meanwhile.
 */
import {
  useCallback,
  useEffect,
  useId,
  useRef,
  useState,
  useSyncExternalStore,
  type ComponentType,
  type CSSProperties,
  type ReactNode,
} from "react";

import { cx } from "@quiz/ui";

import { useLayer, usePhoneScreen, useScrollLock, Z } from "./layers";

/** A dock's place in a group (ADR-090): what the group's owner hands each tool. */
export interface ToolDockSeat {
  slot: number;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

export function ToolDock({
  icon: Icon,
  openLabel,
  closeLabel,
  offset,
  panelClassName,
  keepMounted = false,
  slot = 0,
  open: controlled,
  onOpenChange,
  onOpen,
  dockProps,
  sheetOnPhone = false,
  children,
}: {
  icon: ComponentType<{ className?: string; "aria-hidden"?: boolean }>;
  openLabel: string;
  closeLabel: string;
  /** What the dock sits above, a CSS length (`var(--player-footer-h,0px)`). */
  offset: string;
  /** The panel's width and height. */
  panelClassName: string;
  keepMounted?: boolean;
  /** Its place in a stack of docks, 0 at the bottom. */
  slot?: number;
  /** Controlled: whether the panel is open (one of a group at a time). Uncontrolled when absent. */
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  /** Once the panel is open: where the focus goes. */
  onOpen?: () => void;
  /** Extra attributes on the wrapper (a `data-*` a stylesheet reads). */
  dockProps?: Record<`data-${string}`, string | boolean>;
  /** On a phone, open as a modal full-height bottom sheet (above). */
  sheetOnPhone?: boolean;
  /** The panel's content; the element with id `titleId` names it. */
  children: (close: () => void, titleId: string) => ReactNode;
}) {
  const [own, setOwn] = useState(false);
  const open = controlled ?? own;
  const setOpen = (next: boolean) => {
    if (controlled === undefined) setOwn(next);
    onOpenChange?.(next);
  };
  const trigger = useRef<HTMLButtonElement>(null);
  const panelId = useId();
  const panel = useRef<HTMLElement>(null);
  const phone = usePhoneScreen();
  // Decided once, when the panel opens, and kept until it closes: a phone
  // rotated with the panel open must neither drop the sheet's layer (and its
  // focus) under the teacher's typing, nor trap the focus mid-sentence.
  const latched = useRef<boolean | null>(null);
  if (!open) latched.current = null;
  else latched.current ??= phone && sheetOnPhone;
  const sheet = latched.current === true;
  const visible = useVisibleBox(sheet);
  // The sheet traps the focus and gives it back; the panel's own Escape closes it.
  useLayer(panel, () => close(), { enabled: sheet, escape: false });
  const titleId = useId();
  // The latest `onOpen`, kept outside render; the effect below runs after this one.
  const onOpenRef = useRef(onOpen);
  useEffect(() => {
    onOpenRef.current = onOpen;
  });

  useEffect(() => {
    if (open) onOpenRef.current?.();
  }, [open]);

  const close = () => {
    setOpen(false);
    trigger.current?.focus();
  };

  return (
    <div data-tool-dock data-tool-dock-slot={slot} {...dockProps}>
      {sheet ? <SheetBackdrop /> : null}
      {open || keepMounted ? (
        <section
          ref={panel}
          id={panelId}
          role="dialog"
          aria-modal={sheet}
          aria-labelledby={titleId}
          hidden={!open}
          onKeyDown={(e) => {
            if (e.key !== "Escape") return;
            e.stopPropagation();
            close();
          }}
          style={
            sheet
              ? visible
              : {
                  bottom: `calc(${offset} + var(--tool-dock-h) + 1rem)`,
                  maxHeight: `calc(100dvh - var(--banner-h) - ${offset} - var(--tool-dock-h) - 2rem)`,
                }
          }
          className={cx(
            "fixed border-line bg-surface shadow-overlay",
            sheet
              ? // A bottom sheet as under `lg` (`Sheet`): full width, the window
                // less a strip of the page, top corners rounded, the
                // home-indicator inset kept clear; `visible` fits it into what
                // a soft keyboard leaves of the window.
                cx(
                  "inset-x-0 bottom-0 flex h-[calc(100dvh-var(--banner-h)-0.75rem)] flex-col rounded-t-sheet border-t pb-[env(safe-area-inset-bottom)]",
                  Z.modal,
                )
              : cx(
                  "right-4 max-w-[calc(100vw-2rem)] rounded-sheet border sm:right-6",
                  panelClassName,
                  Z.tool,
                ),
          )}
        >
          {children(close, titleId)}
        </section>
      ) : null}
      <button
        ref={trigger}
        type="button"
        aria-label={open ? closeLabel : openLabel}
        aria-expanded={open}
        aria-controls={open ? panelId : undefined}
        onClick={() => (open ? close() : setOpen(true))}
        style={{ bottom: `calc(${offset} + 1rem + ${slot} * var(--tool-dock-step))` }}
        className={cx(
          "fixed right-4 inline-flex size-12 items-center justify-center rounded-full border shadow-popover transition-[background-color,transform] duration-120 active:scale-[0.97] sm:right-6",
          // Open, the neutral ink fill of a pressed toggle (`ToggleChip`'s): never the accent.
          open ? "border-fg bg-fg text-surface" : "border-line bg-surface text-fg hover:bg-surface-2",
          Z.tool,
        )}
      >
        <Icon className="size-5" aria-hidden />
      </button>
    </div>
  );
}

/**
 * While `enabled`, the part of the window the person sees (`visualViewport`)
 * as the top and the height of a sheet (#849). A soft keyboard on iOS
 * shrinks neither `100dvh` nor the layout viewport: it covers the bottom of
 * the window and pans what is seen, so a sheet sized to the window keeps its
 * composer under the keys. Fitted to the visible part, the composer sits
 * above them and the header stays in view. Undefined where the API does not exist (the sheet's classes size it to the
 * window) and while the page is pinch-zoomed (the sheet stays where it is).
 */
function useVisibleBox(enabled: boolean): CSSProperties | undefined {
  const subscribe = useCallback(
    (onChange: () => void) => {
      const vv = enabled ? window.visualViewport : null;
      if (!vv) return () => {};
      vv.addEventListener("resize", onChange);
      vv.addEventListener("scroll", onChange);
      return () => {
        vv.removeEventListener("resize", onChange);
        vv.removeEventListener("scroll", onChange);
      };
    },
    [enabled],
  );
  // A string, so two reads of the same box are the same snapshot.
  const box = useSyncExternalStore(
    subscribe,
    () => {
      const vv = enabled ? window.visualViewport : null;
      if (!vv || Math.abs(vv.scale - 1) > 0.01) return "";
      return `${vv.offsetTop} ${vv.height}`;
    },
    () => "",
  );
  if (box === "") return undefined;
  const [top, height] = box.split(" ").map(Number) as [number, number];
  return {
    top: `calc(${top}px + var(--banner-h) + 0.75rem)`,
    height: `calc(${height}px - var(--banner-h) - 0.75rem)`,
  };
}

/** Under the phone's sheet: the page dimmed, its scroll locked. No click closes it: the draft would go. */
function SheetBackdrop() {
  useScrollLock();
  return <div aria-hidden className={cx("layer-backdrop fixed inset-0 bg-fg/30 backdrop-blur-[2px]", Z.modal)} />;
}
