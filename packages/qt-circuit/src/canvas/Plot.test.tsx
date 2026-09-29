import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import type { AcSeries, SeriesSet } from "../schema.js";

import { Plot, formatTick, logTicks, niceTicks, phaseTicks } from "./Plot.js";

/** One millisecond of a 1 kHz sine into a resistive load. */
function sine(points = 60, scale = 1): SeriesSet {
  const t: number[] = [];
  const vin: number[] = [];
  const vout: number[] = [];
  const iout: number[] = [];
  for (let i = 0; i < points; i += 1) {
    const time = (i / (points - 1)) * 0.005;
    t.push(time);
    vin.push(Math.sin(2 * Math.PI * 1000 * time));
    vout.push(scale * 0.5 * Math.sin(2 * Math.PI * 1000 * time - 0.4));
    iout.push(scale * 0.0005 * Math.sin(2 * Math.PI * 1000 * time - 0.4));
  }
  return { t, vin, vout, iout };
}

const paths = (container: HTMLElement): string[] =>
  [...container.querySelectorAll("path[data-series]")].map((p) => p.getAttribute("data-series") ?? "");

describe("Plot", () => {
  it("draws the two voltages of a run", () => {
    const { container } = render(<Plot series={sine()} />);
    expect(paths(container)).toEqual(["vin", "vout"]);
  });

  it("adds the reference's output, dashed, when there is one", () => {
    const { container } = render(<Plot series={sine()} expected={sine(60, 0.8)} />);
    expect(paths(container).sort()).toEqual(["expected", "vin", "vout"]);
    const expected = container.querySelector('path[data-series="expected"]');
    expect(expected?.getAttribute("stroke-dasharray")).toBe("5 4");
    expect(screen.getByText("expected v(out)")).toBeInTheDocument();
  });

  it("says what to do when nothing has been run", () => {
    const { container } = render(<Plot series={null} />);
    expect(screen.getByText("Run a simulation to see the output")).toBeInTheDocument();
    expect(paths(container)).toEqual([]);
  });

  it("labels the time axis in milliseconds", () => {
    render(<Plot series={sine()} />);
    expect(screen.getByText("ms")).toBeInTheDocument();
    expect(screen.getByText("V")).toBeInTheDocument();
    /* The series runs over 5 ms, so the ticks are read in ms, not in seconds. */
    for (const tick of ["0", "1", "2", "3", "4", "5"]) {
      expect(screen.getAllByText(tick).length).toBeGreaterThan(0);
    }
  });

  it("puts the current on a second axis, behind a toggle", () => {
    const { container } = render(<Plot series={sine()} />);
    expect(paths(container)).not.toContain("iout");
    expect(screen.queryByText("mA")).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Show current" }));
    expect(paths(container)).toContain("iout");
    expect(screen.getByText("mA")).toBeInTheDocument();
    expect(screen.getByText("i(out)")).toBeInTheDocument();
  });

  it("names its series in the legend", () => {
    render(<Plot series={sine()} title="Sine, 1 kHz" />);
    expect(screen.getByText("v(in)")).toBeInTheDocument();
    expect(screen.getByText("v(out)")).toBeInTheDocument();
    expect(screen.getByText("Sine, 1 kHz")).toBeInTheDocument();
  });

  it("survives a flat series and an empty one", () => {
    expect(() =>
      render(<Plot series={{ t: [0, 1], vin: [0, 0], vout: [0, 0], iout: [0, 0] }} />),
    ).not.toThrow();
    expect(() => render(<Plot series={{ t: [], vin: [], vout: [], iout: [] }} />)).not.toThrow();
  });

  it("takes the host's words", () => {
    render(<Plot series={null} strings={{ plotEmpty: "Lancez une simulation." }} />);
    expect(screen.getByText("Lancez une simulation.")).toBeInTheDocument();
  });
});

/** Three decades of a first-order low-pass, corner at 1 kHz. */
function bode(): AcSeries {
  const f: number[] = [];
  const magDb: number[] = [];
  const phaseDeg: number[] = [];
  for (let i = 0; i <= 30; i += 1) {
    const freq = 10 ** (1 + i / 10);
    f.push(freq);
    magDb.push(-10 * Math.log10(1 + (freq / 1000) ** 2));
    phaseDeg.push((-Math.atan(freq / 1000) * 180) / Math.PI);
  }
  return { kind: "ac", f, magDb, phaseDeg };
}

describe("Plot, Bode", () => {
  it("draws the magnitude and the phase of v(out), and no input", () => {
    const { container } = render(<Plot series={bode()} />);
    expect(paths(container)).toEqual(["vout", "vout-phase"]);
    expect(screen.queryByText("v(in)")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Show current" })).not.toBeInTheDocument();
    expect(screen.getByRole("img", { name: "Bode plot of the output" })).toBeInTheDocument();
  });

  it("overlays the reference on both panels", () => {
    const { container } = render(<Plot series={bode()} expected={bode()} />);
    expect(paths(container).sort()).toEqual(["expected", "expected-phase", "vout", "vout-phase"]);
    expect(screen.getByText("expected v(out)")).toBeInTheDocument();
  });

  it("labels a logarithmic frequency axis, once, in engineering notation", () => {
    render(<Plot series={bode()} />);
    expect(screen.getByText("Hz")).toBeInTheDocument();
    expect(screen.getByText("dB")).toBeInTheDocument();
    expect(screen.getByText("°")).toBeInTheDocument();
    for (const tick of ["10", "100", "1k", "10k"]) expect(screen.getAllByText(tick)).toHaveLength(1);
  });

  it("ignores a transient offered as the reference of a sweep", () => {
    const { container } = render(<Plot series={bode()} expected={sine()} />);
    expect(paths(container)).toEqual(["vout", "vout-phase"]);
  });
});

describe("logTicks", () => {
  it("ticks every decade of a wide sweep", () => {
    expect(logTicks(10, 1e5)).toEqual([10, 100, 1000, 1e4, 1e5]);
  });

  it("adds 2 and 5 on a narrow one", () => {
    expect(logTicks(100, 1e4)).toEqual([100, 200, 500, 1000, 2000, 5000, 1e4]);
  });

  it("does not loop on a degenerate band", () => {
    expect(logTicks(0, 10)).toEqual([0]);
  });
});

describe("phaseTicks", () => {
  it("steps by 15, 30, 45 or 90 degrees", () => {
    expect(phaseTicks(-90, 0)).toEqual([-90, -75, -60, -45, -30, -15, 0]);
    expect(phaseTicks(-200, 10)).toEqual([-180, -135, -90, -45, 0]);
  });
});

describe("niceTicks", () => {
  it("steps by 1, 2 or 5 times a power of ten", () => {
    expect(niceTicks(0, 5, 5)).toEqual([0, 1, 2, 3, 4, 5]);
    expect(niceTicks(0, 10, 5)).toEqual([0, 2, 4, 6, 8, 10]);
    expect(niceTicks(-1, 1, 4)).toEqual([-1, -0.5, 0, 0.5, 1]);
  });

  it("stays inside the domain it was given", () => {
    const ticks = niceTicks(0.37, 4.11, 5);
    for (const v of ticks) {
      expect(v).toBeGreaterThanOrEqual(0.37);
      expect(v).toBeLessThanOrEqual(4.11);
    }
  });

  it("does not loop forever on a degenerate domain", () => {
    expect(niceTicks(3, 3)).toEqual([3]);
    expect(niceTicks(Number.NaN, 1)).toEqual([Number.NaN]);
  });
});

describe("formatTick", () => {
  it("writes as many decimals as the step needs", () => {
    expect(formatTick(0, 1)).toBe("0");
    expect(formatTick(2, 1)).toBe("2");
    expect(formatTick(0.5, 0.5)).toBe("0.5");
    expect(formatTick(1.25, 0.25)).toBe("1.25");
  });

  it("falls back to an exponent rather than print twelve zeros", () => {
    expect(formatTick(1e-6, 1e-6)).toBe("1.0e-6");
    expect(formatTick(1e6, 1e5)).toBe("1.0e+6");
  });
});
