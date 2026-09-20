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

  it("ignores anything past the classroom id", () => {
    expect(parsePath("/classrooms/c-1/whatever")).toEqual({ view: "classroom", id: "c-1" });
    expect(parsePath("/classrooms/c-1/")).toEqual({ view: "classroom", id: "c-1" });
  });
});
