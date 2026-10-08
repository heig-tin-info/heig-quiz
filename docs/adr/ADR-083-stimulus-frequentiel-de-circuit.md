# ADR-083 — Frequency-domain stimuli for circuit

## Status

Accepted (2026-09-29, with the `ac` analysis of `packages/qt-circuit`).
Numbered ADR-040 until 2026-10-08, when it was renumbered because the
favourites record ([ADR-040](ADR-040-favoris-de-question.md)) landed first
under the same number (#342).
Extends ADR-019, which it does not replace: a transient stimulus is graded
exactly as before.

## Context

ADR-019 grades a `circuit` answer by simulating it under the teacher's stimuli
and comparing the output WAVEFORM with the reference's, stimulus by stimulus.
A first-year filter question, though, is rarely about a waveform. "Build a
low-pass with its corner at 1 kHz" is a statement about a frequency response,
and the transient can only probe it one frequency at a time: a teacher who
wants the slope checked writes four sine stimuli, the maximum, and still
checks four points of a curve. The curve itself — the Bode plot — is what the
course draws on the board.

ngspice computes it directly. An `.ac` analysis linearises the circuit around
its DC operating point and solves it at log-spaced frequencies; the magnitude
and the phase of `v(out)` against a unit source are the Bode plot, in one run
of the same container, with no settling time to skip.

What had to be decided is how such a stimulus is authored, what is measured,
and what "the same response" means, since the transient's rule — an RMS
distance as a share of the swing — has no meaning on a curve in decibels
spanning ten decades.

## Decision

1. **The analysis of a stimulus becomes a union.** `{ kind: "tran", stopMs,
   skipMs, points }` is the transient of ADR-019 and the default when `kind`
   is absent: every config written before stays valid, the tag is filled in
   before the discriminated union reads it, and the canonical file omits it for
   a transient, so an export is byte for byte what it was. `{ kind: "ac",
   fStartHz, fStopHz, pointsPerDecade }` is the sweep: 0.01 Hz to 1 GHz, 5 to
   200 points per decade (20 by default), at most 2000 points in all — the
   ceiling ADR-019 already set on one simulation. No `configVersion` bump:
   nothing stored needs rewriting.

2. **The source of a sweep is its DC bias.** An AC stimulus requires a `dc`
   source; its `volts` is the operating point the circuit is linearised
   around, and the deck drives the EMF with `DC <volts> AC 1`. A sine, a pulse
   or a step has no single operating point and is refused at publication
   (`circuit.ac_needs_dc_source`). The editor shows one "bias" field instead
   of the source picker.

3. **What is measured is `v(out)` against the source's EMF**, the unit AC
   source behind `sourceOhms`: the transfer of the whole harness, the source
   resistance and the load included. Only its magnitude (dB) and phase
   (degrees) are plotted and compared; the input is the unit source and a flat
   line, and the load current of the transient plot has no AC counterpart.

4. **The pass rule is an envelope around the reference's Bode plot**, set by
   three knobs in the grading block, `grading.bode = { magDb: 1, floorDb: 60,
   phaseDeg: 10 }`, beside `grading.tolerance` — which stays the transient's
   alone. They are in the grading block and never in the analysis because the
   analysis travels to the student (the Simulate button needs it) and the pass
   rule does not: `toStudent` strips the grading block whole (invariant 4).

   - The floor is RELATIVE: the reference's own peak minus `floorDb`, so a
     unity-gain filter and a ×100 amplifier are judged alike.
   - Where the reference is at or above the floor, the student's magnitude
     must be within `magDb` of it, and — unless `phaseDeg` is `null` — the
     phase difference, reduced modulo 360° to (−180°, 180°], within
     `phaseDeg`.
   - Where the reference is below the floor, the bound is one-sided: the
     student's output must stay under `floor + magDb`. The reference says
     "nothing gets through" there, any output small enough says the same, and
     the phase of a signal 60 dB down is numerical noise, so it is not
     compared.
   - The stimulus passes when EVERY frequency passes, and its points are
     earned whole, as for a transient.

   Both runs are built from the same `.ac` line and share one frequency grid,
   so they are compared point for point with no resampling; two tables of
   different grids are a failed stimulus (`grid_mismatch`), never a guess. The
   rule runs on the FULL ngspice table: decimation to 250 points is for the
   stored details and the plot, and a resonance peak it steps over is exactly
   what the envelope must see. Both runs use ngspice's continuous phase
   (`cph`), identically, so an inverting amplifier reads 180° across the band
   instead of jumping between +180° and −180°. The table carries the linear
   magnitude, converted to dB in the parser and floored at −300 dB, because
   `db()` of an output that is exactly 0 V is an ngspice error that prints no
   table at all.

5. **The details carry a Bode series and an envelope.** `SeriesSet` gains
   `{ kind: "ac", f, magDb, phaseDeg }`; a series without `kind` is a
   transient, so every stored grading still parses. An AC `StimulusDetail`
   has `error: null` and `envelope: { worstDb, worstDeg, outside }`, and the
   results page shows "1.8 dB · 12°" — never a dB figure dressed as a
   percentage of a swing. A hidden stimulus loses its curves for a student
   exactly as before and keeps its verdict and its envelope, which are
   verdicts like `error`; the reference's curve travels only under
   `showExpected` or a shown key.

## Consequences

- A filter question checks the whole response in one stimulus: corner, slope
  and phase at once, over as many decades as the teacher wants.
- The Player and the Review draw a Bode plot — magnitude above, phase below, a
  logarithmic frequency axis — through the same `Plot` component, which picks
  the chart by the series' kind.
- The result is a SMALL-SIGNAL linearisation. A saturated op-amp or an
  unbiased diode gives a Bode plot that means nothing, and a sharp resonance
  built with non-standard values can put a correct answer's peak a few dB
  away from the reference's; the editor says both next to the switch. The
  transient remains the right tool for anything nonlinear.
- A sweep runs in the same container, under the same limits and the same
  2000-point ceiling as a transient; the runner and its image are unchanged.

## Rejected alternatives

1. **The transient's RMS rule on the dB curve.** A share of the swing means
   nothing when the swing is 100 dB and the interesting part is the 3 dB
   around the corner; and in the stop band it would demand that a student
   match −140 dB to the decibel, which is numerical noise.
2. **An absolute floor** (say −60 dB). An amplifier with 40 dB of gain and a
   passive divider would not be judged by the same rule; relative to the
   reference's peak, they are.
3. **Comparing the phase everywhere.** Below the floor the phase of a vanishing
   output is whatever the solver's rounding makes it, and a correct answer
   would fail on it.
4. **Knobs inside the analysis.** Per-stimulus envelopes would travel to the
   student with the analysis, and would be a second tolerance model beside
   the transient's single question-level one. One envelope per question, in
   the grading block, is the transient's model applied to the sweep.
5. **Dividing by `v(in)`** instead of taking `v(out)` against the EMF. It
   would remove the source resistance from the transfer, which a teacher who
   set one wants to see, and would divide by a node the student's circuit can
   short.
6. **A fraction-of-points knob** ("pass if 95 % of the frequencies are in the
   envelope"). It hides the one frequency that is wrong — usually the one the
   question is about. The rule is binary, like the transient's.
