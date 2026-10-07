/**
 * A tool docked at the bottom right (DESIGN.md: the calculator, ADR-069; the
 * help assistant, ADR-080): a 48 px round button in the neutral ink and the
 * NON-modal panel it opens above it.
 *
 * Nothing behind the panel is inert and focus is not trapped: the page stays
 * readable and usable. Escape, the button or the panel's own close (the
 * `close` handed to `children`) closes it, and focus returns to the button.
 * The wrapper is a tool dock (`data-tool-dock`): the toasts rise above it
 * (`--tool-dock-h`). `offset` is the CSS length the dock sits above (a
 * footer or a bottom bar); `keepMounted` keeps the panel's state across a
 * close, as a calculator put down on the desk.
 */
import { useEffect, useId, useRef, useState, type ComponentType, type ReactNode } from "react";

import { cx } from "@quiz/ui";

import { Z } from "./layers";

export function ToolDock({
  icon: Icon,
  openLabel,
  closeLabel,
  title,
  offset,
  panelClassName,
  keepMounted = false,
  onOpen,
  dockProps,
  children,
}: {
  icon: ComponentType<{ className?: string; "aria-hidden"?: boolean }>;
  openLabel: string;
  closeLabel: string;
  /** The panel's accessible name. */
  title: string;
  /** What the dock sits above, a CSS length (`var(--player-footer-h,0px)`). */
  offset: string;
  /** The panel's width and height. */
  panelClassName: string;
  keepMounted?: boolean;
  /** Once the panel is open: where the focus goes. */
  onOpen?: () => void;
  /** Extra attributes on the wrapper (a `data-*` a stylesheet reads). */
  dockProps?: Record<`data-${string}`, string | boolean>;
  children: (close: () => void) => ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const trigger = useRef<HTMLButtonElement>(null);
  const panelId = useId();
  const onOpenRef = useRef(onOpen);
  onOpenRef.current = onOpen;

  useEffect(() => {
    if (open) onOpenRef.current?.();
  }, [open]);

  const close = () => {
    setOpen(false);
    trigger.current?.focus();
  };

  return (
    <div data-tool-dock {...dockProps}>
      {open || keepMounted ? (
        <section
          id={panelId}
          role="dialog"
          aria-modal="false"
          aria-label={title}
          hidden={!open}
          onKeyDown={(e) => {
            if (e.key !== "Escape") return;
            e.stopPropagation();
            close();
          }}
          style={{
            bottom: `calc(${offset} + var(--tool-dock-h) + 1rem)`,
            maxHeight: `calc(100dvh - var(--banner-h) - ${offset} - var(--tool-dock-h) - 2rem)`,
          }}
          className={cx(
            "fixed right-4 max-w-[calc(100vw-2rem)] rounded-sheet border border-line bg-surface shadow-overlay sm:right-6",
            panelClassName,
            Z.tool,
          )}
        >
          {children(close)}
        </section>
      ) : null}
      <button
        ref={trigger}
        type="button"
        aria-label={open ? closeLabel : openLabel}
        aria-expanded={open}
        aria-controls={open ? panelId : undefined}
        onClick={() => (open ? close() : setOpen(true))}
        style={{ bottom: `calc(${offset} + 1rem)` }}
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
