/** One stimulus's panel: its head line, its source, its load and its analysis window. */
import type { ReactNode } from "react";

import { fmt } from "@quiz/core/client";
import type { ConfigIssue } from "@quiz/core/client";
import { FieldCell, hint, IssueList, label, NumberField, RowHead, Segmented, Select } from "@quiz/ui";

import {
  DEFAULT_AC_ANALYSIS,
  DEFAULT_ANALYSIS,
  biasOf,
  type Analysis,
  type Load,
  type Source,
  type Stimulus,
} from "../schema.js";
import type { CircuitEditorStrings } from "../strings.js";
import { AnalysisFields } from "./AnalysisFields.js";
import { SourceFields } from "./SourceFields.js";

/** A fresh source of each kind, so switching kinds never lands on an invalid one. */
function defaultSource(kind: Source["kind"]): Source {
  switch (kind) {
    case "dc":
      return { kind: "dc", volts: 5 };
    case "sine":
      return { kind: "sine", amplitude: 1, frequencyHz: 1000, offset: 0 };
    case "pulse":
      return { kind: "pulse", low: 0, high: 5, frequencyHz: 1000, dutyCycle: 0.5 };
    case "step":
      return { kind: "step", from: 0, to: 5, atMs: 1 };
  }
}

function defaultLoad(kind: Load["kind"]): Load {
  switch (kind) {
    case "open":
      return { kind: "open" };
    case "resistor":
      return { kind: "resistor", ohms: 10_000 };
    case "capacitor":
      return { kind: "capacitor", farads: 1e-7 };
  }
}

export function StimulusFields({
  ids,
  index: i,
  stimulus,
  s,
  disabled,
  patch,
  onRemove,
  issues,
}: {
  ids: string;
  index: number;
  stimulus: Stimulus;
  s: CircuitEditorStrings;
  disabled: boolean | undefined;
  patch: (next: Partial<Stimulus>) => void;
  onRemove: () => void;
  issues: readonly ConfigIssue[];
}): ReactNode {
  const { analysis, source } = stimulus;
  /*
   * Switching to AC keeps a DC source (its volts become the bias) and turns
   * anything else into a 0 V bias: a sine or a pulse has no operating point,
   * and a stimulus the schema refuses is not a state to switch into.
   */
  const switchAnalysis = (kind: Analysis["kind"]) =>
    kind === "ac"
      ? patch({
          analysis: { ...DEFAULT_AC_ANALYSIS },
          source: source.kind === "dc" ? source : { kind: "dc", volts: 0 },
        })
      : patch({ analysis: { ...DEFAULT_ANALYSIS } });
  return (
    <>
      <RowHead
        disabled={disabled}
        nameId={`${ids}-sname-${i}`}
        nameLabel={fmt(s.stimulus, { n: i + 1 })}
        nameAriaLabel={`${s.stimulusName} ${i + 1}`}
        name={stimulus.name}
        onNameChange={(name) => patch({ name })}
        pointsId={`${ids}-spoints-${i}`}
        pointsLabel={s.points}
        points={stimulus.points}
        onPointsChange={(points) => patch({ points })}
        hiddenLabel={s.hidden}
        hiddenAriaLabel={`${s.hidden} ${i + 1}`}
        visible={stimulus.visible}
        onVisibleChange={(visible) => patch({ visible })}
        removeLabel={fmt(s.removeStimulus, { name: stimulus.name })}
        removeDisabled={disabled}
        onRemove={onRemove}
      />

      {/* First, because it decides what the source below may be. */}
      <div className="mt-3 flex flex-col gap-2">
        <span className={label} id={`${ids}-ank-${i}`}>
          {s.analysisKind}
        </span>
        <Segmented
          name={`${ids}-ank-${i}`}
          labelledBy={`${ids}-ank-${i}`}
          value={analysis.kind === "ac" ? "ac" : "tran"}
          disabled={disabled}
          options={[
            { value: "tran", label: s.analysisTran },
            { value: "ac", label: s.analysisAc },
          ]}
          onChange={switchAnalysis}
        />
        {analysis.kind === "ac" ? <p className={hint}>{s.acHint}</p> : null}
      </div>

      <div className="mt-3 flex flex-col gap-2">
        <span className={label} id={`${ids}-src-${i}`}>
          {s.source}
        </span>
        {/* Under AC the source is its bias alone: one field, no kind to pick. */}
        {analysis.kind === "ac" ? null : (
          <Segmented
            name={`${ids}-srck-${i}`}
            labelledBy={`${ids}-src-${i}`}
            value={source.kind}
            disabled={disabled}
            options={[
              { value: "dc", label: s.sourceDc },
              { value: "sine", label: s.sourceSine },
              { value: "pulse", label: s.sourcePulse },
              { value: "step", label: s.sourceStep },
            ]}
            onChange={(kind) => patch({ source: defaultSource(kind) })}
          />
        )}
        <div className="flex flex-wrap items-end gap-3">
          {analysis.kind === "ac" ? (
            <NumberField
              id={`${ids}-bias-${i}`}
              label={s.bias}
              value={biasOf(source)}
              step="any"
              disabled={disabled}
              onChange={(volts) => patch({ source: { kind: "dc", volts } })}
            />
          ) : (
            <SourceFields
              idPrefix={`${ids}-s${i}`}
              source={source}
              s={s}
              disabled={disabled}
              onChange={(next) => patch({ source: next })}
            />
          )}
          <NumberField
            id={`${ids}-sohms-${i}`}
            label={s.sourceOhms}
            value={stimulus.sourceOhms}
            min={0}
            step="any"
            disabled={disabled}
            onChange={(sourceOhms) => patch({ sourceOhms })}
          />
        </div>
      </div>

      <div className="mt-3 flex flex-wrap items-end gap-3">
        <FieldCell label={s.load} htmlFor={`${ids}-load-${i}`}>
          <Select
            id={`${ids}-load-${i}`}
            size="sm"
            width="w-32"
            disabled={disabled}
            value={stimulus.load.kind}
            onChange={(e) => patch({ load: defaultLoad(e.target.value as Load["kind"]) })}
          >
            <option value="open">{s.loadOpen}</option>
            <option value="resistor">{s.loadResistor}</option>
            <option value="capacitor">{s.loadCapacitor}</option>
          </Select>
        </FieldCell>
        {stimulus.load.kind === "resistor" ? (
          <NumberField
            id={`${ids}-lohms-${i}`}
            label={s.loadOhms}
            value={stimulus.load.ohms}
            min={0.001}
            step="any"
            disabled={disabled}
            onChange={(ohms) => patch({ load: { kind: "resistor", ohms } })}
          />
        ) : null}
        {stimulus.load.kind === "capacitor" ? (
          <NumberField
            id={`${ids}-lfarads-${i}`}
            label={s.loadFarads}
            value={stimulus.load.farads}
            min={1e-15}
            step="any"
            disabled={disabled}
            onChange={(farads) => patch({ load: { kind: "capacitor", farads } })}
          />
        ) : null}
      </div>

      {/* A heading over its three fields, like "Source" and "Load"
          above: a group label parked on the baseline of the inputs
          reads as a fourth field with no box. */}
      <div className="mt-3 flex flex-col gap-2">
        <span className={label}>{analysis.kind === "ac" ? s.sweep : s.analysis}</span>
        <div className="flex flex-wrap items-end gap-3">
          <AnalysisFields
            idPrefix={`${ids}-a${i}`}
            analysis={analysis}
            s={s}
            disabled={disabled}
            onChange={(next) => patch({ analysis: next })}
          />
        </div>
      </div>
      <IssueList issues={issues} />
    </>
  );
}
