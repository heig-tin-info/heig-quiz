/**
 * A run of number fields that each read and write one numeric property of
 * the same object. The editor's source, analysis and Bode fields are tables
 * of this shape; a field that does anything else (clamps, clears, switches a
 * kind) stays an explicit `NumberField` where it is used.
 */
import type { ReactNode } from "react";

import { NumberField } from "@quiz/ui";

import type { CircuitEditorStrings } from "../strings.js";

type NumericKey<T> = { [K in keyof T]-?: T[K] extends number ? K : never }[keyof T];

export interface NumberFieldSpec<T> {
  /** The property the field reads and writes. */
  readonly key: NumericKey<T>;
  /** Appended to the id prefix: `${idPrefix}-${id}`. */
  readonly id: string;
  readonly label: keyof CircuitEditorStrings;
  readonly min?: number;
  readonly max?: number;
  readonly step: number | "any";
  /** Absent, the field keeps `NumberField`'s own width. */
  readonly width?: string;
}

export function NumberFields<T extends object>({
  fields,
  idPrefix,
  value,
  s,
  disabled,
  onChange,
}: {
  fields: readonly NumberFieldSpec<T>[];
  idPrefix: string;
  value: T;
  s: CircuitEditorStrings;
  disabled: boolean | undefined;
  onChange: (next: T) => void;
}): ReactNode {
  return fields.map((field) => (
    <NumberField
      key={field.id}
      id={`${idPrefix}-${field.id}`}
      label={s[field.label]}
      value={value[field.key] as number}
      min={field.min}
      max={field.max}
      step={field.step}
      {...(field.width === undefined ? {} : { width: field.width })}
      disabled={disabled}
      onChange={(n) => onChange({ ...value, [field.key]: n })}
    />
  ));
}
