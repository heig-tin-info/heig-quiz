/**
 * Shared fixtures: one schematic and one config per shape the tests need.
 *
 * The schematics are built from the library's own pin geometry rather than
 * from literal coordinates, so a symbol whose pins move takes the fixtures
 * with it instead of silently unwiring them.
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import type { RunnerOutcome } from "@quiz/core/server";

import {
  type CircuitAnswer,
  type CircuitConfig,
  type AcSeries,
  type TranSeries,
} from "../schema.js";
import { circuitConfig, rcSchematic } from "../testing.js";

/** The full fixture of the leak test (`../testing.ts`), shared with the registry's contract test. */
export * from "../testing.js";

const HERE = dirname(fileURLToPath(import.meta.url));

/** The exact stdout of `ngspice -b` on `rc-lowpass.cir`, captured on ngspice 42. */
export const readStdoutFixture = (): string =>
  readFileSync(join(HERE, "ngspice-rc-lowpass.stdout.txt"), "utf8");

/**
 * The exact stdout of `ngspice -b` on the same RC low-pass under an AC sweep
 * (`.ac dec 5 1e+2 1e+4`, the deck `buildNetlist` emits), captured on ngspice 42.
 */
export const readAcStdoutFixture = (): string =>
  readFileSync(join(HERE, "ngspice-rc-lowpass-ac.stdout.txt"), "utf8");

// ---------------------------------------------------------------------------
// The RC low-pass of `rc-lowpass.cir`
// ---------------------------------------------------------------------------

/**
 * {@link rcSchematic} with the verified deck's values: 1.59 kΩ and 100 nF,
 * i.e. a corner at one kilohertz, which is what `spice.int.test.ts` measures.
 */
export const rcLowPass = (values: { r?: string; c?: string } = {}): ReturnType<typeof rcSchematic> =>
  rcSchematic({ name: "R1", value: values.r ?? "1.59k" }, { name: "C1", value: values.c ?? "100n" });

export const rcAnswer = (): CircuitAnswer => ({ schematic: rcLowPass().schematic });

/**
 * {@link circuitConfig} as its bytes were stored before the AC sweep: no
 * `analysis.kind`, no `grading.bode`. The server never hands this to anyone
 * — every read parses — but an invalid draft reaches the editor as stored.
 */
export function storedBeforeAc(): CircuitConfig {
  const config = structuredClone(circuitConfig()) as unknown as {
    stimuli: { analysis: Record<string, unknown> }[];
    grading: Record<string, unknown>;
  };
  for (const s of config.stimuli) delete s.analysis["kind"];
  delete config.grading["bode"];
  return config as unknown as CircuitConfig;
}

// ---------------------------------------------------------------------------
// Runner outcomes
// ---------------------------------------------------------------------------

/** A `wrdata` table, as ngspice would print it. */
export function spiceTable(series: TranSeries): string {
  const header = " time            v(in)           v(out)          i(Vmeas)       ";
  const rows = series.t.map((t, i) =>
    [t, series.vin[i] ?? 0, series.vout[i] ?? 0, series.iout[i] ?? 0]
      .map((v) => v.toExponential(8))
      .join("  "),
  );
  return ["\nNote: No compatibility mode selected!\n", header, ...rows, "", "No. of Data Rows : 8"].join(
    "\n",
  );
}

/** `n` samples of a sine of the given amplitude and frequency, on `vout` and `vin` alike. */
export function sineSeries(
  options: { n?: number; amplitude?: number; frequencyHz?: number; phase?: number; stopS?: number } = {},
): TranSeries {
  const n = options.n ?? 64;
  const amplitude = options.amplitude ?? 1;
  const frequencyHz = options.frequencyHz ?? 1000;
  const phase = options.phase ?? 0;
  const stopS = options.stopS ?? 5e-3;
  const t: number[] = [];
  const v: number[] = [];
  for (let i = 0; i < n; i += 1) {
    const time = (i * stopS) / (n - 1);
    t.push(time);
    v.push(amplitude * Math.sin(2 * Math.PI * frequencyHz * time + phase));
  }
  return { t, vin: [...v], vout: [...v], iout: v.map(() => 0) };
}

/**
 * An AC sweep's `wrdata` table, as the AC control block prints it: the
 * MAGNITUDE, linear, rebuilt from the series' dB.
 */
export function acSpiceTable(series: AcSeries): string {
  const header = " frequency       vmag            vph            ";
  const rows = series.f.map((f, i) =>
    [f, 10 ** ((series.magDb[i] ?? 0) / 20), series.phaseDeg[i] ?? 0]
      .map((v) => v.toExponential(8))
      .join("  "),
  );
  return ["", header, ...rows, "Note: No compatibility mode selected!"].join("\n");
}

/**
 * The Bode plot of a first-order low-pass with its corner at `cornerHz`,
 * times `gain` (a negative gain turns the phase by 180°), on the grid of
 * `.ac dec perDecade fStart fStop`.
 */
export function lowPassBode(
  options: { cornerHz?: number; gain?: number; fStart?: number; fStop?: number; perDecade?: number } = {},
): AcSeries {
  const corner = options.cornerHz ?? 1000;
  const gain = options.gain ?? 1;
  const fStart = options.fStart ?? 10;
  const decades = Math.log10((options.fStop ?? 1e5) / fStart);
  const perDecade = options.perDecade ?? 10;
  const n = Math.floor(decades * perDecade + 1e-9) + 1;
  const f: number[] = [];
  const magDb: number[] = [];
  const phaseDeg: number[] = [];
  for (let i = 0; i < n; i += 1) {
    const freq = fStart * 10 ** (i / perDecade);
    const ratio = freq / corner;
    f.push(freq);
    magDb.push(20 * Math.log10(Math.abs(gain) / Math.sqrt(1 + ratio * ratio)));
    phaseDeg.push((gain < 0 ? 180 : 0) - (Math.atan(ratio) * 180) / Math.PI);
  }
  return { kind: "ac", f, magDb, phaseDeg };
}

export type CaseOutcome = RunnerOutcome["cases"][number];

export function okCase(series: TranSeries | AcSeries): CaseOutcome {
  return {
    exitCode: 0,
    stdout: series.kind === "ac" ? acSpiceTable(series) : spiceTable(series),
    stderr: "",
    ms: 40,
    timedOut: false,
    oom: false,
    truncated: false,
  };
}

export function failedCase(stderr = "Error on line 3 : R1 in out\n"): CaseOutcome {
  return {
    exitCode: 1,
    stdout: "",
    stderr,
    ms: 12,
    timedOut: false,
    oom: false,
    truncated: false,
  };
}

export function outcome(cases: CaseOutcome[]): RunnerOutcome {
  return { compile: { ok: true, stdout: "", stderr: "", ms: 0 }, cases };
}
