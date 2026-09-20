import { describe, expect, it } from "vitest";

import { parsePath, routeToPath, type Route } from "./router";

describe("routeToPath / parsePath", () => {
  const routes: Route[] = [
    { view: "home" },
    { view: "settings" },
    { view: "admin" },
    { view: "classroom", id: "c-1" },
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

  it("parses the development gallery; App.tsx is what refuses it in production", () => {
    expect(parsePath("/dev/ui")).toEqual({ view: "devUi" });
    expect(parsePath("/dev")).toEqual({ view: "home" });
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
