/**
 * The calculator's place on the player (ADR-069): a `ToolDock` — the round
 * button at the bottom right and the non-modal panel above it.
 *
 * The student reads the statement and types into the answer while it is
 * open. It opens with focus on the keypad, so the keyboard drives it at
 * once. Closed, it stays mounted: the number on it survives a hide, a
 * question change and a reopen, like a calculator put down on the desk. It
 * lives in the browser only — nothing of it reaches the server.
 *
 * On a phone the player's sticky footer holds the move buttons; the button
 * and the panel sit above it, through `--player-footer-h` (`PlayerShell`).
 */
import { Calculator as CalculatorIcon, X } from "lucide-react";
import { useRef } from "react";

import { useMe } from "../api";
import { useT } from "../i18n";
import { IconButton, ToolDock } from "../ui";
import { Calculator, type CalculatorKind } from "./Calculator";

export function CalculatorDock({ kind }: { kind: CalculatorKind }) {
  const t = useT();
  // The user's setting: reverse Polish notation, on the same keys.
  const rpn = useMe().data?.rpnCalculator === true;
  const keypad = useRef<HTMLDivElement>(null);

  return (
    <ToolDock
      icon={CalculatorIcon}
      openLabel={t("calc.open")}
      closeLabel={t("calc.close")}
      offset="var(--player-footer-h,0px)"
      panelClassName={`overflow-y-auto p-3 ${kind === "scientific" ? "w-[22rem]" : "w-[18rem]"}`}
      keepMounted
      onOpen={() => keypad.current?.focus()}
    >
      {(close, titleId) => (
        <>
          <div className="mb-2 flex items-center gap-2 pl-1">
            <h2 id={titleId} className="text-[13px] font-semibold">
              {t("calc.open")}
            </h2>
            <span className="text-[12px] text-fg-faint">
              {t(`calc.${kind}`)}
              {rpn ? ` · ${t("calc.rpn")}` : ""}
            </span>
            <span className="ml-auto">
              <IconButton label={t("calc.close")} size="sm" onClick={close}>
                <X />
              </IconButton>
            </span>
          </div>
          <Calculator ref={keypad} kind={kind} rpn={rpn} />
        </>
      )}
    </ToolDock>
  );
}
