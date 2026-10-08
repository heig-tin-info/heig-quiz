import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { ASSIST_SCREENS, ASSIST_ENTITY_KINDS } from "@quiz/domain";

import { en } from "../i18n/en";
import { parsePath, ROUTE_VIEWS } from "../router";
import { makeMe } from "../test/fixtures";
import { assistVisible } from "./context";
import { ASSIST_SCREEN_SPECS, assistScreenEntries, generatedSource } from "./screens";

const GENERATED = fileURLToPath(new URL("../../../../packages/domain/src/assistScreens.generated.ts", import.meta.url));
const HELP = (topic: string) => fileURLToPath(new URL(`../help/${topic}.md`, import.meta.url));

const entries = assistScreenEntries(en);

describe("the assistant's screen catalogue (ADR-080 P2b)", () => {
  it("classifies every view of the router, the router's order kept", () => {
    expect(Object.keys(ASSIST_SCREEN_SPECS)).toEqual(ROUTE_VIEWS);
  });

  it("is the one the server reads: @quiz/domain's generated file is this table's output", () => {
    const source = generatedSource(entries);
    if (process.env.UPDATE_ASSIST_SCREENS === "1") writeFileSync(GENERATED, source);
    // Run with UPDATE_ASSIST_SCREENS=1 to rewrite it, then rebuild @quiz/domain.
    expect(readFileSync(GENERATED, "utf8")).toBe(source);
    expect(ASSIST_SCREENS).toEqual(JSON.parse(JSON.stringify(entries)));
  });

  it("names each screen by a pattern that parses back to it, with ids of the closed kinds", () => {
    for (const entry of entries) {
      expect(entry.ids.every((i) => (ASSIST_ENTITY_KINDS as readonly string[]).includes(i.kind)), entry.screen).toBe(true);
      const path = entry.ids.reduce((p, i) => p.replace(`:${i.field}`, "6f0c3a8e-2b1d-4c5e-9f7a-1b2c3d4e5f60"), entry.pattern);
      expect(parsePath(path).view, entry.screen).toBe(entry.screen);
      expect(entry.title, entry.screen).not.toMatch(/^[a-z]+\.[a-z.]+$/);
      if (entry.help) expect(existsSync(HELP(entry.help)), entry.help).toBe(true);
    }
  });

  it("offers no student's, guest's, station's, projected or preview screen, and the administration to an administrator only", () => {
    const offered = entries.map((e) => e.screen);
    for (const view of [
      "studentCourses",
      "studentGrades",
      "attempt",
      "feedback",
      "drill",
      "join",
      "oauthConsent",
      "teamsLink",
      "teamsTab",
      "kiosk",
      "pair",
      "poll",
      "correction",
      "questionPreview",
      "evaluationPreview",
      "devUi",
    ]) {
      expect(offered).not.toContain(view);
    }
    // Every screen offered draws the assistant: the dock stays open across the navigation.
    for (const view of offered) {
      expect(assistVisible({ teacherUi: true, me: makeMe(), view: view as never }), view).toBe(true);
    }
    expect(entries.filter((e) => e.audience === "admin").map((e) => e.screen)).toEqual(["admin"]);
  });
});
