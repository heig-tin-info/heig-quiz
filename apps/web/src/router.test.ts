import { describe, expect, it } from "vitest";

import { parsePath, routeToPath, type Route } from "./router";

describe("routeToPath / parsePath", () => {
  const routes: Route[] = [
    { view: "home" },
    { view: "settings" },
    { view: "admin" },
    { view: "classroom", id: "c-1" },
    { view: "pools" },
    { view: "pool", id: "p-1" },
    { view: "question", id: "q-1" },
    // WP9: student player
    { view: "attempt", evaluationId: "e-1" },
    { view: "studentResults", attemptId: "a-1" },
    { view: "devUi" },
  ];

  it("round-trips every route", () => {
    for (const r of routes) {
      expect(parsePath(routeToPath(r))).toEqual(r);
    }
  });

  it("falls back to home on unknown or partial paths", () => {
    expect(parsePath("/")).toEqual({ view: "home" });
    expect(parsePath("/nope")).toEqual({ view: "home" });
    expect(parsePath("/classrooms")).toEqual({ view: "home" });
  });

  it("parses the pool routes, and /pools alone is the list", () => {
    expect(parsePath("/pools")).toEqual({ view: "pools" });
    expect(parsePath("/pools/p-1")).toEqual({ view: "pool", id: "p-1" });
    expect(parsePath("/questions/q-1")).toEqual({ view: "question", id: "q-1" });
    // The editor tab lives in the query string, not in the path.
    expect(parsePath("/questions/q-1/edit")).toEqual({ view: "question", id: "q-1" });
    expect(parsePath("/questions")).toEqual({ view: "home" });
  });

  it("parses the development gallery; App.tsx is what refuses it in production", () => {
    expect(parsePath("/dev/ui")).toEqual({ view: "devUi" });
    expect(parsePath("/dev")).toEqual({ view: "home" });
  });

  // WP9: student player
  it("parses the two student paths", () => {
    expect(parsePath("/take/e-1")).toEqual({ view: "attempt", evaluationId: "e-1" });
    expect(parsePath("/results/a-1")).toEqual({ view: "studentResults", attemptId: "a-1" });
    expect(routeToPath({ view: "attempt", evaluationId: "e-1" })).toBe("/take/e-1");
    expect(routeToPath({ view: "studentResults", attemptId: "a-1" })).toBe("/results/a-1");
  });

  // WP9: student player
  it("falls back to home when a student path has no id", () => {
    expect(parsePath("/take")).toEqual({ view: "home" });
    expect(parsePath("/results")).toEqual({ view: "home" });
  });

  it("ignores anything past the classroom id", () => {
    expect(parsePath("/classrooms/c-1/whatever")).toEqual({ view: "classroom", id: "c-1" });
    expect(parsePath("/classrooms/c-1/")).toEqual({ view: "classroom", id: "c-1" });
  });

  // WP8: evaluation + dashboard
  it("parses the configuration screen and the live dashboard", () => {
    expect(parsePath("/evaluations/e-1")).toEqual({ view: "evaluation", id: "e-1" });
    expect(parsePath("/evaluations/e-1/live")).toEqual({ view: "live", id: "e-1" });
  });

  it("round-trips both evaluation routes", () => {
    for (const r of [
      { view: "evaluation", id: "e-1" },
      { view: "live", id: "e-1" },
    ] as const) {
      expect(parsePath(routeToPath(r))).toEqual(r);
    }
  });

  it("falls back to the configuration screen for an unknown sub-path", () => {
    expect(parsePath("/evaluations/e-1/nope")).toEqual({ view: "evaluation", id: "e-1" });
    expect(parsePath("/evaluations")).toEqual({ view: "home" });
  });
});
