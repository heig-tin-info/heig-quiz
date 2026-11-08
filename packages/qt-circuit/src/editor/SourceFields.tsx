/** The parameters of one source kind; the kind itself is the segmented control above. */
import type { ReactNode } from "react";

import type { Source } from "../schema.js";
import type { CircuitEditorStrings } from "../strings.js";
import { NumberFields, type NumberFieldSpec } from "./NumberFields.js";

type Fields<K extends Source["kind"]> = readonly NumberFieldSpec<Extract<Source, { kind: K }>>[];

const DC: Fields<"dc"> = [{ key: "volts", id: "volts", label: "volts", step: "any" }];

const SINE: Fields<"sine"> = [
  { key: "amplitude", id: "amp", label: "amplitude", min: 0, step: "any" },
  { key: "frequencyHz", id: "freq", label: "frequency", min: 0.01, step: "any" },
  { key: "offset", id: "offset", label: "offset", step: "any" },
];

const PULSE: Fields<"pulse"> = [
  { key: "low", id: "low", label: "low", step: "any" },
  { key: "high", id: "high", label: "high", step: "any" },
  { key: "frequencyHz", id: "pfreq", label: "frequency", min: 0.01, step: "any" },
  { key: "dutyCycle", id: "duty", label: "dutyCycle", min: 0.01, max: 0.99, step: 0.05 },
];

const STEP: Fields<"step"> = [
  { key: "from", id: "from", label: "stepFrom", step: "any" },
  { key: "to", id: "to", label: "stepTo", step: "any" },
  { key: "atMs", id: "at", label: "stepAt", min: 0, step: "any" },
];

export function SourceFields({
  idPrefix,
  source,
  s,
  disabled,
  onChange,
}: {
  idPrefix: string;
  source: Source;
  s: CircuitEditorStrings;
  disabled: boolean | undefined;
  onChange: (source: Source) => void;
}): ReactNode {
  const common = { idPrefix, s, disabled, onChange };
  switch (source.kind) {
    case "dc":
      return <NumberFields fields={DC} value={source} {...common} />;
    case "sine":
      return <NumberFields fields={SINE} value={source} {...common} />;
    case "pulse":
      return <NumberFields fields={PULSE} value={source} {...common} />;
    case "step":
      return <NumberFields fields={STEP} value={source} {...common} />;
  }
}
