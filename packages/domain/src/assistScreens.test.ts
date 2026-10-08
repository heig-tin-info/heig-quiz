import { describe, expect, it } from "vitest";

import { assistScreen, assistSystem, buildCorpus, poolNamed, searchOf, stubTurn, wantsScreen } from "./assist.js";
import {
  ASSIST_MAX_COMMANDS,
  ASSIST_SCREENS,
  AssistUiTurn,
  assistCommandList,
  assistScreenCatalogue,
  assistScreensFor,
  checkOpenScreen,
  isUuid,
  runnableCommands,
  type AssistScreenCommand,
} from "./assistScreens.js";

const POOL = "6f0c3a8e-2b1d-4c5e-9f7a-1b2c3d4e5f60";
const CATEGORY = "7a1d4b9f-3c2e-4d6f-8a0b-2c3d4e5f6071";
const COMMANDS: AssistScreenCommand[] = [
  { id: "question:preview", label: "Preview", effect: "none" },
  { id: "question:try", label: "Try it", effect: "none" },
  { id: "question:publish", label: "Publish this question", effect: "write" },
  { id: "grading:results", label: "Open the results", effect: "none" },
  { id: "grading:run", label: "Grade", effect: "none" },
];
const corpus = buildCorpus([{ id: "guide/pools", locale: "en", text: "# Pools\n\n## Sharing a pool\n\nShare it." }]);

describe("the screen catalogue (ADR-080 P2b)", () => {
  it("is the router's, generated, and keeps the administration for an administrator", () => {
    expect(ASSIST_SCREENS.map((s) => s.screen)).toContain("pool");
    expect(assistScreensFor("admin").map((s) => s.screen)).toContain("admin");
    expect(assistScreensFor("teacher").map((s) => s.screen)).not.toContain("admin");
  });

  it("is listed in the stable prompt with its ids and params, the administration for an administrator only", () => {
    const teacher = assistScreenCatalogue("teacher");
    expect(teacher).toContain("- pool — /pools/:id — Question pool (help/pool); ids: id=<pool id>; params: tab=questions|tags|review, q=<the search box");
    expect(teacher).toContain("category=<category id>");
    expect(teacher).toContain("- activities — /activities — Activities\n");
    expect(teacher).not.toContain("- admin —");
    expect(assistScreenCatalogue("admin")).toContain("- admin — /admin — Administration; params: tab=");
    const system = assistSystem(corpus, "teacher");
    expect(system).toContain("Prefer showing over listing");
    expect(system).toContain(teacher);
  });
});

describe("checkOpenScreen", () => {
  it("returns the action for a screen of the catalogue with its ids and params", () => {
    expect(checkOpenScreen({ screen: "pool", ids: { id: POOL }, params: { q: "tag:printf", category: CATEGORY } }, "teacher")).toEqual({
      kind: "open_screen",
      screen: "pool",
      ids: { id: POOL },
      params: { q: "tag:printf", category: CATEGORY },
    });
    expect(checkOpenScreen({ screen: "activities" }, "teacher")).toEqual({ kind: "open_screen", screen: "activities", ids: {}, params: {} });
    expect(checkOpenScreen({ screen: "classroom", ids: { id: POOL }, params: { tab: "roster" }, }, "teacher").params).toEqual({ tab: "roster" });
  });

  it("refuses a screen off the catalogue, or the role's", () => {
    expect(() => checkOpenScreen({ screen: "attempt", ids: { evaluationId: POOL } }, "teacher")).toThrow(/No screen "attempt"/);
    expect(() => checkOpenScreen({ screen: "admin" }, "teacher")).toThrow(/No screen "admin"/);
    expect(() => checkOpenScreen("pool", "teacher")).toThrow(/No screen "undefined"/);
    expect(checkOpenScreen({ screen: "admin", params: { tab: "llm" } }, "admin").screen).toBe("admin");
  });

  it("refuses missing, extra or malformed ids", () => {
    expect(() => checkOpenScreen({ screen: "pool" }, "teacher")).toThrow("The screen pool takes the ids id.");
    expect(() => checkOpenScreen({ screen: "pools", ids: { id: POOL } }, "teacher")).toThrow("The screen pools takes no id.");
    expect(() => checkOpenScreen({ screen: "pool", ids: { id: "../admin" } }, "teacher")).toThrow("`ids.id` must be the id of a pool");
    expect(() => checkOpenScreen({ screen: "pool", ids: { id: 3 } }, "teacher")).toThrow("`ids.id` must be a string.");
    expect(() => checkOpenScreen({ screen: "pool", ids: "x" }, "teacher")).toThrow("`ids` must be an object of strings.");
    expect(() => checkOpenScreen({ screen: "pool", ids: [POOL] }, "teacher")).toThrow("`ids` must be an object of strings.");
  });

  it("refuses an unknown param, a value off its list, a bad search or a bad id", () => {
    const pool = (params: unknown) => checkOpenScreen({ screen: "pool", ids: { id: POOL }, params }, "teacher");
    expect(() => pool({ step: "x" })).toThrow("The screen pool takes the params tab, q, category.");
    expect(() => checkOpenScreen({ screen: "pools", params: { q: "x" } }, "teacher")).toThrow("The screen pools takes no param.");
    expect(() => pool({ tab: "admin" })).toThrow("`tab` must be one of questions, tags, review.");
    expect(() => pool({ q: " " })).toThrow("`q` must be a non-empty line");
    expect(() => pool({ q: "a\nb" })).toThrow("`q` must be a non-empty line");
    expect(() => pool({ q: "x".repeat(201) })).toThrow("`q` must be a non-empty line");
    expect(() => pool({ category: "k1" })).toThrow("`category` must be the id of a category");
    expect(pool(null).params).toEqual({});
  });

  it("takes another id rule where the caller gives one (the browser mock's ids)", () => {
    expect(checkOpenScreen({ screen: "pool", ids: { id: "p1" } }, "teacher", (s) => /^p\d$/.test(s)).ids).toEqual({ id: "p1" });
    expect(isUuid(POOL)).toBe(true);
    expect(isUuid("p1")).toBe(false);
  });
});

describe("the screen's commands", () => {
  it("offers the effect-free ones only, in the screen part of the prompt", () => {
    expect(runnableCommands(COMMANDS).map((c) => c.id)).not.toContain("question:publish");
    expect(runnableCommands(undefined)).toEqual([]);
    expect(assistCommandList(COMMANDS)).toContain("  - question:preview — Preview");
    expect(assistCommandList(COMMANDS)).not.toContain("publish");
    expect(assistCommandList([])).toBe("- Commands you may run here: none.");
    const screen = assistScreen(corpus, "teacher", { route: "/questions/:id", helpTopic: null, locale: "en", commands: COMMANDS });
    expect(screen).toContain("Commands you may run here (run_screen_command)");
  });
});

describe("AssistUiTurn", () => {
  it("records one screen, answers the model a short 'done by the browser', and refuses a second", () => {
    const turn = new AssistUiTurn("teacher", COMMANDS);
    expect(turn.open({ screen: "pool", ids: { id: POOL } })).toMatch(/browser opens Question pool after your answer/);
    expect(() => turn.open({ screen: "pools" })).toThrow("One screen per answer: pool is already being opened.");
    expect(turn.actions).toEqual([{ kind: "open_screen", screen: "pool", ids: { id: POOL }, params: {} }]);
  });

  it("runs effect-free commands of the screen, never one that writes nor an unknown one, before any navigation", () => {
    const turn = new AssistUiTurn("teacher", COMMANDS);
    expect(turn.run({ id: "question:preview" })).toBe('Done: the user\'s browser runs "Preview" after your answer.');
    expect(() => turn.run({ id: "question:publish" })).toThrow('No command "question:publish" you may run');
    expect(() => turn.run({ id: "live:close" })).toThrow('No command "live:close"');
    expect(() => turn.run(null)).toThrow('No command "undefined"');
    turn.run({ id: "question:try" });
    turn.run({ id: "grading:results" });
    expect(() => turn.run({ id: "grading:run" })).toThrow(`At most ${ASSIST_MAX_COMMANDS} commands per answer.`);
    turn.open({ screen: "activities" });
    expect(() => turn.run({ id: "question:preview" })).toThrow("A screen is being opened");
    expect(turn.actions.map((a) => a.kind)).toEqual(["run_command", "run_command", "run_command", "open_screen"]);
  });

  it("knows no command when the screen sent none", () => {
    expect(() => new AssistUiTurn("teacher", undefined).run({ id: "question:preview" })).toThrow(/No command/);
  });
});

describe("the stub drives the interface (ADR-080 P2b)", () => {
  const pools = [
    { id: POOL, name: "Sandbox" },
    { id: CATEGORY, name: "Programmation C" },
    { id: "x", name: "C" },
  ];
  const screen = { route: "/", helpTopic: null, locale: "fr" as const };
  const readers = { results: () => Promise.reject(new Error("no")), pools: () => Promise.resolve(pools) };

  it("recognizes a request to see something, the pool it names and its tag", () => {
    expect(wantsScreen("Montre-moi les questions du pool sandbox")).toBe(true);
    expect(wantsScreen("How do I share a pool?")).toBe(false);
    expect(poolNamed("Montre-moi les questions du pool sandbox", pools)?.id).toBe(POOL);
    expect(poolNamed("open programmation c", pools)?.id).toBe(CATEGORY);
    expect(poolNamed("open the c pool", pools)).toBeNull();
    expect(searchOf("seulement tag:printf")).toBe("tag:printf");
    expect(searchOf("only #pointeurs")).toBe("tag:pointeurs");
    expect(searchOf("only the printf ones")).toBeNull();
  });

  it("opens the pool, searched, and says so", async () => {
    const turn = await stubTurn(corpus, "teacher", "Montre-moi les questions du pool sandbox, tag:printf", screen, readers);
    expect(turn.actions).toEqual([{ kind: "open_screen", screen: "pool", ids: { id: POOL }, params: { q: "tag:printf" } }]);
    expect(turn.text).toContain("J'ai ouvert la banque **Sandbox** avec la recherche `tag:printf`.");
    const plain = await stubTurn(corpus, "teacher", "show the sandbox pool", { ...screen, locale: "en" }, readers);
    expect(plain.actions[0]).toMatchObject({ params: {} });
    expect(plain.text).toContain("I opened the pool **Sandbox**.");
  });

  it("answers from the documentation otherwise, with no action", async () => {
    const asked = await stubTurn(corpus, "teacher", "How do I share a pool?", screen, readers);
    expect(asked.actions).toEqual([]);
    const unread = await stubTurn(corpus, "teacher", "Show the sandbox pool", screen, {
      ...readers,
      pools: () => Promise.reject(new Error("refused")),
    });
    expect(unread.actions).toEqual([]);
  });
});
