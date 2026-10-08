import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { ASSIST_SCREENS, type AssistScreenSpec } from "@quiz/domain";

import { en } from "../i18n/en";
import { parsePath, ROUTE_VIEWS, type Route } from "../router";
import { makeMe } from "../test/fixtures";
import { assistVisible, routeEntities, routePattern } from "./context";
import { ASSIST_SCREEN_LABELS } from "./screens";

const HELP = (topic: string) => fileURLToPath(new URL(`../help/${topic}.md`, import.meta.url));
const catalogue = Object.entries(ASSIST_SCREENS as Record<string, AssistScreenSpec>);
const sample = (i: number) => `00000000-0000-4000-8000-${String(i).padStart(12, "0")}`;
const routeOf = (view: string, ids: Record<string, string>) => ({ view, ...ids }) as Route;

describe("the assistant's screen catalogue (ADR-080 P2b)", () => {
  it("classifies every view of the router, and offers exactly the domain catalogue's screens", () => {
    expect(Object.keys(ASSIST_SCREEN_LABELS).sort()).toEqual([...ROUTE_VIEWS].sort());
    const offered = Object.entries(ASSIST_SCREEN_LABELS).flatMap(([view, label]) => (label ? [view] : []));
    expect(offered.sort()).toEqual(catalogue.map(([name]) => name).sort());
  });

  it("matches the router: each pattern is the router's, each id of the router's kind, each title the English label", () => {
    for (const [view, screen] of catalogue) {
      const fields = Object.keys(screen.ids ?? {});
      const placeholder = routeOf(view, Object.fromEntries(fields.map((f) => [f, `:${f}`])));
      expect(routePattern(placeholder), view).toBe(screen.pattern);
      const entities = routeEntities(routeOf(view, Object.fromEntries(fields.map((f, i) => [f, sample(i)]))));
      const kinds = Object.fromEntries(fields.map((f, i) => [f, Object.entries(entities).find(([, id]) => id === sample(i))?.[0]]));
      expect(kinds, view).toEqual(screen.ids ?? {});
      const path = fields.reduce((p, f, i) => p.replace(`:${f}`, sample(i)), screen.pattern);
      expect(parsePath(path).view, view).toBe(view);
      expect(en[ASSIST_SCREEN_LABELS[view as Route["view"]]!], view).toBe(screen.title);
      if (screen.help) expect(existsSync(HELP(screen.help)), screen.help).toBe(true);
    }
  });

  it("offers no screen where the assistant is not drawn: the dock stays open across the navigation", () => {
    for (const [view] of catalogue) {
      expect(assistVisible({ teacherUi: true, me: makeMe(), view: view as Route["view"] }), view).toBe(true);
    }
  });
});
