# Grading a circuit

A circuit question is marked in one of three ways. The choice is not about
how strict you are; it is about what the question asks for.

## You

You open the answer and give the marks yourself. The screen still shows what
the netlist read — what was left floating, which value could not be parsed —
and the waveforms, if the question has stimuli and a simulator was available.
This is the right mode for a question about a topology, a drawing convention
or an explanation, and it is the only one that costs nothing to publish.

## Simulation

Every stimulus is simulated twice, once on the student's circuit and once on
your reference, and the two output waveforms are compared. A stimulus passes
when the distance between them stays under the **tolerance**, expressed as a
share of the reference's peak-to-peak swing: 5 % is forgiving, 1 % asks for
the exact component values.

A stimulus set to **Bode plot** sweeps a band of frequencies instead, around
the DC bias you give, and compares the gain and the phase of the output. It
passes when the student's curve stays within the **gain tolerance** (1 dB by
default) and the **phase tolerance** (10°, or none) of yours at every
frequency. Where your curve falls more than the **floor** (60 dB) under its
own peak, the student's output only has to stay as low. A Bode plot is a
small-signal view: keep it for filters and amplifiers working in their linear
range.

This mode needs a reference circuit and at least one stimulus, and the
question will not publish without them. A student whose circuit cannot be
turned into a netlist — a floating pin, a value out of range — scores nothing
on that stimulus, and the reason is shown to them.

## Assistant

Phase 2: the netlist and your criteria go to the language model. It is
listed here so the choice is visible, and it does not run yet.

## Hidden stimuli

A hidden stimulus is graded like any other, but a student does not see its
name, its parameters or its waveform: they are told how many there are and
what they are worth, exactly as for the hidden test cases of a code question.
The one exception is an evaluation that shows the expected answer: its
feedback then shows every stimulus, hidden ones included.
