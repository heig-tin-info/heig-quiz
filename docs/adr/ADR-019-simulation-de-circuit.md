# ADR-019 — Grading a schematic by simulation, not by topology

## Status

Accepted (2026-09-22, with `packages/qt-circuit` and the `spice` language of the runner).

## Context

`docs/spec/04-types-de-questions.md` §4.11 described `circuit` as a phase-3
pick-and-place question graded by an LLM with vision or by hand, and
`docs/spec/00-cadre-et-perimetre.md` §0.6 put "grading of electronic schematics
by simulation or netlist comparison" out of scope. The type is now wanted for
first-year electronics: the student wires a two-port box — an RC filter, a
divider, an inverting amplifier — and gets a grade.

Two ways to grade one exist.

**Compare the circuits.** Extract a netlist from the schematic and decide
whether it is the same graph as the teacher's. It is brittle in exactly the
place a teacher cares about: two resistors in series instead of one of twice
the value, a Y instead of a Δ, an extra node that carries no current, the two
inputs of a differential pair swapped. Each of these is a *correct* answer and
a *different* graph, so the check needs canonical forms for series and parallel
merges, for dangling nets, for symmetric pins — an open-ended list, each entry
of which is a new way for the grader to be wrong, and none of which a student
can argue with.

**Compare the behaviour.** Run both circuits and compare what comes out of
`out+`. It says nothing about how the student drew it, which is precisely what
a two-port question asks: build something that does *this*. The platform
already owns the machine that runs untrusted things — `apps/runner`, hardened,
queued, limited (invariants 10 to 14) — and ngspice is a batch simulator that
reads a netlist on the command line and writes a table on stdout.

## Decision

1. **A `circuit` in `simulation` mode is graded on its OUTPUT WAVEFORM.** The
   student's schematic and the teacher's reference are each rebuilt into a
   SPICE netlist, run under every stimulus of the question, and their `v(out)`
   series are compared sample by sample. A stimulus passes when the normalised
   RMS distance between the two is at or under `grading.tolerance` times the
   reference's peak-to-peak swing; its points are earned whole, and the grade
   is the sum. **Topology is never compared.** A circuit drawn differently that
   behaves the same is a correct answer, and `docs/spec/00` §0.6 is amended to
   say that netlist ISOMORPHISM is what stays out of scope, not simulation.

2. **The reference is simulated at grading time**, beside the student's, never
   simulated once at publication and cached. A transient of 500 points costs a
   few tens of milliseconds in a container that is already running for the
   student's; caching it would put derived data in the question's
   configuration, where an edit of a value or of a stimulus silently
   invalidates it, and would need an invalidation rule nobody would remember.
   What is stored is what the teacher wrote.

3. **The netlist is rebuilt server-side, every time** (invariant 14), from the
   stored schematic and the stimulus. No netlist is ever stored, and none ever
   comes from the browser: the `circuit` answer is `{ schematic }` and nothing
   else. Component values travel as the student's engineering notation and are
   parsed case-sensitively — `1M` is one mega, `1m` is one milli — then emitted
   as a plain exponent, because SPICE itself reads `1M` as one MILLI and would
   silently turn a 1 MΩ resistor into a milliohm.

4. **The ideal op-amp is a rail-clamped VCVS**: one `E … TABLE` line whose
   transfer saturates at the question's `vcc`/`vee` (±15 V by default), with a
   100 µV knee — an open-loop gain of 150 000, high enough for the virtual
   short an inverting amplifier needs and low enough for ngspice to converge.
   No vendor model, no `.subckt` library to ship or to keep current; a
   first-year question does not ask about slew rate.

5. **`spice` is a language of the runner**, not a service of its own:
   `apps/runner/images/spice/Containerfile` (Alpine + ngspice), one entry in
   `SPECS` (`src/languages.ts`), the same hardened container. Nothing is built,
   so `compile` is the "nothing to do" answer and a malformed netlist is a
   failed case. The netlist file travels in the case's `args`
   (`ngspice -b s0.cir`), so one request carries one schematic and all its
   stimuli, and one container serves them all. No flag was relaxed and no
   environment variable was added for it: `src/engine.test.ts` asserts the
   container's argv flag for flag and did not change.

6. **The student's Simulate button is a generic route.**
   `QuestionTypeServer.interactiveRequest(config, answer, ctx)` returns the
   `RunnerRequest` the student may run — built from the stored config, holding
   only the visible stimuli, never the reference's output — and
   `POST /app/api/attempts/:id/simulate` runs it with `priority: "interactive"`,
   against the question's `simulationsPerMinute` budget counted in the attempt
   journal, and hands the `RunnerOutcome` back raw. The live module knows
   nothing of netlists; `code` keeps its older, case-filtering `/run`.

7. **A reference that does not simulate is the teacher's problem.** When the
   reference fails, or the runner is unreachable, the grading is stored
   `proposed` with a machine reason, never `validated` (decision D14). A
   STUDENT circuit that does not simulate is an ordinary failed stimulus with
   its reason (`floating_pin`, `spice_failed`), which is information.

## Consequences

- A correct answer is accepted however it is drawn, and the grade is defended
  by a curve the teacher and the student can both look at. The details carry
  both waveforms, decimated to 250 points, so the results page shows them
  without a second simulation.
- `tolerance` is the teacher's single knob, and it is a *relative* one: 5 % of
  the reference's swing means the same thing on a 100 mV divider and on a 20 V
  square wave.
- The runner VM gains one image to build (`deploy.md`). Without it,
  `GET /health` does not list `spice` and every `simulation` grading degrades
  to a proposal — visible, not silent.
- A question whose reference is ambiguous under the chosen stimuli grades
  wrong answers as correct; that is the teacher's job to see, and the
  "View as student" path plus the Simulate button are what they see it with.
- Simulation cost is bounded by the schema: at most four stimuli, at most
  2000 points each, and the runner's own queues and wall clocks on top.

## Rejected alternatives

1. **Netlist isomorphism.** The obvious reading of "compare the circuits", and
   the one §0.6 ruled out. It needs a canonical form per equivalence a teacher
   would accept (series and parallel merges, Y↔Δ, dangling nets, symmetric
   pins), each of which is a rule to write, to test and to explain to a student
   who was marked wrong for being right. Kept out of scope, now explicitly.
2. **A SPICE engine in the browser (JS or WASM).** It would make the Simulate
   button free and the server idle. ADR-015 already settled the principle for
   `code`: the browser runs, the server grades — a result produced by a browser
   is not proof, and a grade defended by it is defended by the student's own
   machine. The same logic applies here, and a second simulator would have to
   agree with the first to the last decimal or the player and the grade would
   disagree.
3. **An LLM with vision as the primary grader**, as §4.11 originally said. It
   reads a picture of a circuit, not a circuit: it cannot tell 4.7 kΩ from
   47 kΩ reliably, it cannot be shown why it was wrong, and it costs a call per
   answer. It stays as the `llm` mode of the type, for the rubric-graded
   questions simulation cannot express (phase 2).
4. **A simulation service of its own**, beside the runner. Everything such a
   service would need — a queue, two priorities, wall clocks, memory caps, an
   image with no network, a health route the API already polls — is what
   `apps/runner` is. ngspice is one more image and one more run plan; a second
   service would be a second thing to deploy, to secure and to monitor.
5. **Compare the operating point, or a few probe values, instead of the whole
   waveform.** Cheaper and much weaker: a divider and a first-order filter have
   the same DC point, and a student who got the corner frequency wrong would
   pass. The transient is what the question is about.
