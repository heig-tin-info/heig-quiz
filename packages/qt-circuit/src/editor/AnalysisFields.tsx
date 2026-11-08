/** The window of a transient, or the band of an AC sweep. */
import type { ReactNode } from "react";

import { MAX_ANALYSIS_POINTS, type AcAnalysis, type Analysis, type TranAnalysis } from "../schema.js";
import type { CircuitEditorStrings } from "../strings.js";
import { NumberFields, type NumberFieldSpec } from "./NumberFields.js";

const AC: readonly NumberFieldSpec<AcAnalysis>[] = [
  { key: "fStartHz", id: "fstart", label: "fStartHz", min: 0.01, step: "any", width: "w-28" },
  { key: "fStopHz", id: "fstop", label: "fStopHz", max: 1e9, step: "any", width: "w-28" },
  { key: "pointsPerDecade", id: "ppd", label: "pointsPerDecade", min: 5, max: 200, step: 5, width: "w-24" },
];

const TRAN: readonly NumberFieldSpec<TranAnalysis>[] = [
  { key: "stopMs", id: "stop", label: "stopMs", min: 0.001, step: "any", width: "w-24" },
  { key: "skipMs", id: "skip", label: "skipMs", min: 0, step: "any", width: "w-24" },
  { key: "points", id: "pts", label: "samples", min: 50, max: MAX_ANALYSIS_POINTS, step: 50, width: "w-24" },
];

export function AnalysisFields({
  idPrefix,
  analysis,
  s,
  disabled,
  onChange,
}: {
  idPrefix: string;
  analysis: Analysis;
  s: CircuitEditorStrings;
  disabled: boolean | undefined;
  onChange: (analysis: Analysis) => void;
}): ReactNode {
  const common = { idPrefix, s, disabled, onChange };
  return analysis.kind === "ac" ? (
    <NumberFields fields={AC} value={analysis} {...common} />
  ) : (
    <NumberFields fields={TRAN} value={analysis} {...common} />
  );
}
