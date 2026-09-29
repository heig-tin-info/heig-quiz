/**
 * The `circuit` column of the grading table (ADR-040): what the schematic
 * holds and how its simulation went — never the drawing, which stays in the
 * answer panel.
 */
import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { circuitGrading } from "./grading.js";
import type { CircuitDetails, CircuitStudent, StimulusDetail } from "./schema.js";
import { rcLowPass } from "./test/fixtures.js";

const student = {} as CircuitStudent;
const { schematic } = rcLowPass();
const [column] = circuitGrading.columns(student, { reference: schematic });
const answer = { schematic };

function stimulus(name: string, ok: boolean): StimulusDetail {
  return { name, visible: true, points: 1, ok, error: ok ? 0.01 : 0.4, series: null, expected: null };
}

function details(stimuli: StimulusDetail[], runner: CircuitDetails["runner"] = "ok"): CircuitDetails {
  return {
    mode: "simulation",
    runner,
    netlist: { components: 3, nets: 3, issues: [] },
    stimuli,
    earned: 0,
    total: 1,
  };
}

const html = (node: unknown) => render(<>{node}</>).container;

describe("circuit grading column", () => {
  it("is one column that summarises the schematic", () => {
    expect(column!.label).toBe("Schematic");
    expect(html(column!.cell({ answer, details: null })).textContent).toContain("2 parts · 4 wires");
  });

  it("counts the stimuli passed, and names the failed ones in the tooltip", () => {
    const partial = html(
      column!.cell({ answer, details: details([stimulus("step", true), stimulus("sine 1 kHz", false)]) }),
    ).querySelector("span[title]")!;
    expect(partial.textContent).toBe("1/2 stimuli");
    expect(partial.className).toContain("outline-dashed");
    expect(partial.getAttribute("title")).toBe("Failed: sine 1 kHz");
    const all = html(column!.cell({ answer, details: details([stimulus("step", true)]) }));
    expect(all.textContent).toContain("1/1 stimulus");
  });

  it("says when the simulator still owes the verdict", () => {
    expect(html(column!.cell({ answer, details: null })).textContent).toContain("simulator…");
    expect(html(column!.cell({ answer, details: details([], "busy") })).textContent).toContain("simulator…");
    expect(html(column!.cell({ answer, details: details([], "error") })).textContent).toContain("Not simulated");
  });

  it("names the wiring problems of a circuit that was not simulated", () => {
    const refused = { ...details([], "none"), netlist: { components: 2, nets: 2, issues: ["floating:C1.2"] } };
    const chip = html(column!.cell({ answer, details: refused })).querySelector("span > span")!;
    expect(chip.textContent).toBe("1 wiring problem");
    expect(chip.className).toContain("bg-danger-soft");
  });

  it("reads a marker the grading pass left instead of a breakdown", () => {
    const marker = (reason: string) => ({ reason }) as unknown as CircuitDetails;
    expect(html(column!.cell({ answer, details: marker("runner_unavailable") })).textContent).toContain(
      "simulator…",
    );
    expect(html(column!.cell({ answer, details: marker("runner_busy") })).textContent).toContain(
      "simulator…",
    );
    expect(html(column!.cell({ answer, details: marker("runner_request_invalid") })).textContent).toContain(
      "Not simulated",
    );
  });

  it("says nothing of a simulation on a teacher's override", () => {
    const manual = { manual: true } as unknown as CircuitDetails;
    expect(html(column!.cell({ answer, details: manual })).textContent).toBe("2 parts · 4 wires");
  });

  it("draws an empty box as an em dash", () => {
    const empty = { schematic: { components: [], wires: [] } };
    expect(html(column!.cell({ answer: empty, details: details([], "none") })).textContent).toBe("—");
  });

  it("describes the reference on the expected row, or an em dash without one", () => {
    const expected = html(column!.expected()).querySelector("span")!;
    expect(expected.textContent).toBe("2 parts · 4 wires");
    expect(expected.className).toContain("text-info");
    expect(html(circuitGrading.columns(student, null)[0]!.expected()).textContent).toBe("—");
  });

  it("sorts by the counts, ten parts after nine", () => {
    expect(column!.sortKey(answer)).toBe("0002 0004");
    expect(column!.sortKey(null)).toBe("");
  });
});
