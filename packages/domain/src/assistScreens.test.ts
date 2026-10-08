import { describe, expect, it } from "vitest";

import { assistScreen, assistSystem, buildCorpus, stubTurn } from "./assist.js";
import {
  ASSIST_MAX_COMMANDS,
  AssistUiTurn,
  assistCommandList,
  assistScreenCatalogue,
  assistScreensFor,
  checkOpenScreen,
  isUuid,
  type AssistScreenCommand,
} from "./assistScreens.js";

const POOL = "6f0c3a8e-2b1d-4c5e-9f7a-1b2c3d4e5f60";
const CATEGORY = "7a1d4b9f-3c2e-4d6f-8a0b-2c3d4e5f6071";
const COMMANDS: AssistScreenCommand[] = [
  { id: "question:preview", label: "Preview", effect: "none", gesture: true },
  { id: "question:try", label: "Try it", effect: "none" },
  { id: "question:publish", label: "Publish this question", effect: "write" },
  { id: "grading:results", label: "Open the results", effect: "none" },
  { id: "grading:run", label: "Grade", effect: "none" },
];
const corpus = buildCorpus([{ id: "guide/pools", locale: "en", text: "# Pools\n\n## Sharing a pool\n\nShare it." }]);

describe("the screen catalogue (ADR-080 P2b)", () => {
  it("keeps the administration for an administrator", () => {
    expect(assistScreensFor("admin").map(([name]) => name)).toContain("admin");
    expect(assistScreensFor("teacher").map(([name]) => name)).not.toContain("admin");
  });

  it("is listed in the stable prompt with its ids and params", () => {
    const teacher = assistScreenCatalogue("teacher");
    expect(teacher).toContain(
      "- pool — /pools/:id — Question pool (help/pool); ids: id=<pool id>; params: tab=questions|tags|review, q=<the search box",
    );
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
    expect(
      checkOpenScreen({ screen: "pool", ids: { id: POOL }, params: { q: "tag:printf", category: CATEGORY } }, "teacher"),
    ).toEqual({ kind: "open_screen", screen: "pool", ids: { id: POOL }, params: { q: "tag:printf", category: CATEGORY } });
    expect(checkOpenScreen({ screen: "activities" }, "teacher")).toEqual({
      kind: "open_screen",
      screen: "activities",
      ids: {},
      params: {},
    });
  });

  it("refuses a screen off the catalogue, or off the role's", () => {
    expect(() => checkOpenScreen({ screen: "attempt", ids: { evaluationId: POOL } }, "teacher")).toThrow(/No screen "attempt"/);
    expect(() => checkOpenScreen({ screen: "constructor" }, "teacher")).toThrow(/No screen "constructor"/);
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

  it("takes another id rule where the caller gives one (the browser's path segments)", () => {
    expect(checkOpenScreen({ screen: "pool", ids: { id: "p1" } }, "teacher", (s) => /^p\d$/.test(s)).ids).toEqual({ id: "p1" });
    expect(isUuid(POOL)).toBe(true);
    expect(isUuid("p1")).toBe(false);
  });
});

describe("the screen's commands", () => {
  it("lists every one in the screen part of the prompt, saying which is a gesture and which writes (ADR-080 P3)", () => {
    const list = assistCommandList(COMMANDS);
    expect(list).toContain("  - question:try — Try it\n");
    expect(list).toContain("  - question:preview — Preview (opens a new tab: offered as a button the user clicks)");
    expect(list).toContain("  - question:publish — Publish this question (changes data: the user is shown a card and it runs only if they confirm)");
    expect(assistCommandList(undefined)).toBe("- Commands of this screen (run_screen_command): none.");
    const screen = assistScreen(corpus, "teacher", { route: "/questions/:id", helpTopic: null, locale: "en", commands: COMMANDS });
    expect(screen).toContain("Commands of this screen (run_screen_command)");
  });
});

describe("AssistUiTurn", () => {
  it("records one screen, answers the model a short 'done by the browser', and refuses a second", () => {
    const turn = new AssistUiTurn("teacher", COMMANDS);
    expect(turn.open({ screen: "pool", ids: { id: POOL } })).toMatch(/browser opens Question pool after your answer/);
    expect(() => turn.open({ screen: "pools" })).toThrow("One screen per answer: pool is already being opened.");
    expect(turn.actions).toEqual([{ kind: "open_screen", screen: "pool", ids: { id: POOL }, params: {} }]);
  });

  it("runs effect-free commands, offers a gesture as a button, never an unknown one, before any navigation", () => {
    const turn = new AssistUiTurn("teacher", COMMANDS);
    expect(turn.run({ id: "question:try" })).toBe('Done: the user\'s browser runs "Try it" after your answer.');
    expect(turn.run({ id: "question:preview" })).toMatch(/^Offered: "Preview" opens a new tab/);
    expect(() => turn.run({ id: "live:close" })).toThrow('No command "live:close"');
    expect(() => turn.run(null)).toThrow('No command "undefined"');
    turn.run({ id: "grading:results" });
    expect(() => turn.run({ id: "grading:run" })).toThrow(`At most ${ASSIST_MAX_COMMANDS} commands per answer.`);
    turn.open({ screen: "activities" });
    expect(() => turn.run({ id: "question:try" })).toThrow("A screen is being opened");
    expect(turn.actions.map((a) => a.kind)).toEqual(["run_command", "run_command", "run_command", "open_screen"]);
  });

  it("proposes a write command behind a confirmation, never as run, and opens no screen after it (ADR-080 P3)", () => {
    const turn = new AssistUiTurn("teacher", COMMANDS);
    expect(turn.run({ id: "question:publish" })).toMatch(/^Proposed: .* runs only if they confirm it\. Say so; never say it is done\.$/);
    expect(turn.actions).toEqual([{ kind: "confirm_command", id: "question:publish", label: "Publish this question" }]);
    expect(() => turn.open({ screen: "activities" })).toThrow(/proposes something on the current screen/);
    expect(turn.writing).toBe(false);
  });

  it("records one editor proposal, at most three writes, and ends the turn once a write is prepared", () => {
    const turn = new AssistUiTurn("teacher", COMMANDS);
    const edit = {
      kind: "edit_question" as const,
      questionId: POOL,
      base: { config: {}, explanation: "" },
      config: {},
      explanation: "x",
      fields: [{ path: "explanation", label: "explanation" as const, n: null, before: null, after: "x" }],
    };
    expect(turn.propose(edit)).toMatch(/^Proposed: .*1 field\(s\) with an Apply button/);
    expect(() => turn.propose(edit)).toThrow("One proposal per answer");
    const write = (id: string) => ({ kind: "pending_write" as const, id, tool: "create_category" as const, lines: [], expiresAt: "2026-10-08T10:10:00.000Z" });
    expect(turn.prepare(write("a"))).toMatch(/^Prepared, NOT done/);
    expect(turn.writing).toBe(true);
    turn.prepare(write("b"));
    turn.prepare(write("c"));
    expect(turn.mayPrepare).toBe(false);
    expect(() => turn.prepare(write("d"))).toThrow("At most 3 writes per answer.");
    const opening = new AssistUiTurn("teacher", COMMANDS);
    opening.open({ screen: "activities" });
    expect(() => opening.propose(edit)).toThrow("A screen is being opened");
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
  const ask = (question: string, locale: "en" | "fr" = "fr", read = readers) => stubTurn(corpus, "teacher", question, { ...screen, locale }, read);

  it("opens the pool a request to see names, searched by its tag:x or #x, and says so", async () => {
    const turn = await ask("Montre-moi les questions du pool sandbox, tag:printf");
    expect(turn.actions).toEqual([{ kind: "open_screen", screen: "pool", ids: { id: POOL }, params: { q: "tag:printf" } }]);
    expect(turn.text).toContain("J'ai ouvert la banque **Sandbox** avec la recherche `tag:printf`.");
    expect((await ask("open programmation c, only #pointeurs", "en")).actions).toEqual([
      { kind: "open_screen", screen: "pool", ids: { id: CATEGORY }, params: { q: "tag:pointeurs" } },
    ]);
    const plain = await ask("show the sandbox pool", "en");
    expect(plain.actions[0]).toMatchObject({ params: {} });
    expect(plain.text).toContain("I opened the pool **Sandbox**.");
  });

  it("answers from the documentation, with no action, for any other question", async () => {
    expect((await ask("How do I share a pool?")).actions).toEqual([]);
    // A name too short to match, or no pool read.
    expect((await ask("open the c pool")).actions).toEqual([]);
    const unread = await ask("Show the sandbox pool", "fr", { ...readers, pools: () => Promise.reject(new Error("refused")) });
    expect(unread.actions).toEqual([]);
  });
});
