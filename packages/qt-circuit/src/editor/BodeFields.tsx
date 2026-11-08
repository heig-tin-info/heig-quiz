/**
 * The envelope an AC stimulus is graded by. The phase has a checkbox of its
 * own rather than an empty field meaning "off": switching a comparison off is
 * a decision, and it should read as one.
 */
import type { ReactNode } from "react";

import { CheckboxField, hint, NumberField, setting } from "@quiz/ui";

import { DEFAULT_BODE, type BodeTolerance } from "../schema.js";
import type { CircuitEditorStrings } from "../strings.js";
import { NumberFields, type NumberFieldSpec } from "./NumberFields.js";

const ENVELOPE: readonly NumberFieldSpec<BodeTolerance>[] = [
  { key: "magDb", id: "magdb", label: "bodeMagDb", min: 0.01, max: 40, step: 0.5, width: "w-24" },
  { key: "floorDb", id: "floordb", label: "bodeFloorDb", min: 1, max: 200, step: 10, width: "w-24" },
];

export function BodeFields({
  ids,
  bode,
  s,
  disabled,
  onChange,
}: {
  ids: string;
  bode: BodeTolerance;
  s: CircuitEditorStrings;
  disabled: boolean | undefined;
  onChange: (next: Partial<BodeTolerance>) => void;
}): ReactNode {
  return (
    <>
      <div className="flex flex-wrap items-end gap-3">
        <NumberFields fields={ENVELOPE} idPrefix={ids} value={bode} s={s} disabled={disabled} onChange={onChange} />
      </div>
      <CheckboxField
        className={setting}
        label={s.bodePhase}
        checked={bode.phaseDeg !== null}
        disabled={disabled}
        onChange={(on) => onChange({ phaseDeg: on ? DEFAULT_BODE.phaseDeg : null })}
      />
      {/* Explicit: it exists only while the phase is compared, and its value is nullable. */}
      {bode.phaseDeg === null ? null : (
        <NumberField
          id={`${ids}-phasedeg`}
          label={s.bodePhaseDeg}
          value={bode.phaseDeg}
          min={0.1}
          max={180}
          step={1}
          width="w-24"
          disabled={disabled}
          onChange={(phaseDeg) => onChange({ phaseDeg })}
        />
      )}
      <p className={hint}>{s.bodeHint}</p>
    </>
  );
}
