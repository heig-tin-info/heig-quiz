/**
 * The calculator's place on the player (ADR-069): a round button at the
 * bottom right, and the panel it opens above it.
 *
 * The panel is a NON-modal floating layer: the student reads the statement
 * and types into the answer while it is open, so nothing behind it is inert
 * and focus is not trapped. It opens with focus inside, so the keyboard
 * drives it at once; Escape or the button closes it and gives focus back to
 * the button. Closed, it stays mounted: the number on it survives a hide, a
 * question change and a reopen, like a calculator put down on the desk. It
 * lives in the browser only — nothing of it reaches the server.
 *
 * On a phone the player's sticky footer holds the move buttons; the button
 * and the panel sit above it, through `--player-footer-h` (`PlayerShell`).
 */
import { Calculator as CalculatorIcon, X } from "lucide-react";
import { useEffect, useId, useRef, useState } from "react";

import { useT } from "../i18n";
import { cx, IconButton, Z } from "../ui";
import { Calculator, type CalculatorKind } from "./Calculator";

export function CalculatorDock({ kind }: { kind: CalculatorKind }) {
  const t = useT();
  const [open, setOpen] = useState(false);
  const trigger = useRef<HTMLButtonElement>(null);
  const keypad = useRef<HTMLDivElement>(null);
  const panelId = useId();
  const titleId = useId();

  useEffect(() => {
    if (open) keypad.current?.focus();
  }, [open]);

  const close = () => {
    setOpen(false);
    trigger.current?.focus();
  };

  return (
    <div data-tool-dock>
      <section
        id={panelId}
        role="dialog"
        aria-modal="false"
        aria-labelledby={titleId}
        hidden={!open}
        onKeyDown={(e) => {
          if (e.key !== "Escape") return;
          e.stopPropagation();
          close();
        }}
        className={cx(
          "fixed right-4 bottom-[calc(var(--player-footer-h,0px)+var(--tool-dock-h)+1rem)] max-h-[calc(100dvh-var(--banner-h)-var(--player-footer-h,0px)-var(--tool-dock-h)-2rem)] overflow-y-auto rounded-sheet border border-line bg-surface p-3 shadow-overlay sm:right-6",
          kind === "scientific" ? "w-[22rem]" : "w-[18rem]",
          "max-w-[calc(100vw-2rem)]",
          Z.tool,
        )}
      >
        <div className="mb-2 flex items-center gap-2 pl-1">
          <h2 id={titleId} className="text-[13px] font-semibold">
            {t("calc.open")}
          </h2>
          <span className="text-[12px] text-fg-faint">{t(`calc.${kind}`)}</span>
          <span className="ml-auto">
            <IconButton label={t("calc.close")} size="sm" onClick={close}>
              <X />
            </IconButton>
          </span>
        </div>
        <Calculator ref={keypad} kind={kind} />
      </section>
      <button
        ref={trigger}
        type="button"
        aria-label={open ? t("calc.close") : t("calc.open")}
        aria-expanded={open}
        aria-controls={panelId}
        onClick={() => (open ? close() : setOpen(true))}
        className={cx(
          "fixed right-4 bottom-[calc(var(--player-footer-h,0px)+1rem)] inline-flex size-12 items-center justify-center rounded-full border shadow-popover transition-[background-color,transform] duration-120 active:scale-[0.97] sm:right-6",
          // Open, the button wears the neutral ink fill of a pressed toggle
          // (`ToggleChip`'s): never the accent, which is the player's action.
          open ? "border-fg bg-fg text-surface" : "border-line bg-surface text-fg hover:bg-surface-2",
          Z.tool,
        )}
      >
        <CalculatorIcon className="size-5" aria-hidden />
      </button>
    </div>
  );
}
