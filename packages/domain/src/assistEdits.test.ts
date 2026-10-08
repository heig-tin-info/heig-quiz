import { describe, expect, it } from "vitest";

import type { AssistTextSpec } from "@quiz/core/server";

import { assistScreen, buildCorpus, stubRewrite, stubTurn } from "./assist.js";
import {
  assistTextFields,
  cardExcerpt,
  DEFAULT_ASSIST_TEXT,
  preservedTokens,
  proposeQuestionEdit,
  sameDraft,
} from "./index.js";

const Q = "11111111-1111-4111-8111-111111111111";
const MCQ: AssistTextSpec = {
  fields: [
    { path: "prompt", label: "statement" },
    { path: "choices.*.text", label: "choice" },
  ],
  append: { list: "choices", field: "text", item: { correct: false }, max: 4 },
};
const CATEGORIZE: AssistTextSpec = {
  fields: [
    { path: "prompt", label: "statement" },
    { path: "columns.*.label", label: "column" },
    { path: "cards.*.text", label: "card" },
  ],
};

const mcq = () => ({
  config: {
    configVersion: 2,
    prompt: "quelle est la valeur de [[x]] ? ![](asset:abc-1)",
    choices: [
      { text: "[[x]]", correct: true },
      { text: "", correct: false },
    ],
    mode: "single",
    policy: "inherit",
    shuffleChoices: true,
  },
  explanation: "",
});

describe("assistTextFields — the free texts a type lends the assistant (ADR-080 P3)", () => {
  it("expands each declared path over the draft, strings only", () => {
    expect(assistTextFields(mcq().config, MCQ)).toEqual([
      { path: "prompt", label: "statement", n: null, text: "quelle est la valeur de [[x]] ? ![](asset:abc-1)" },
      { path: "choices.0.text", label: "choice", n: 1, text: "[[x]]" },
      { path: "choices.1.text", label: "choice", n: 2, text: "" },
    ]);
    expect(assistTextFields({ prompt: 3 }, DEFAULT_ASSIST_TEXT)).toEqual([]);
    expect(assistTextFields(null, MCQ)).toEqual([]);
    expect(assistTextFields({ choices: { 0: { text: "x" } } }, MCQ)).toEqual([]);
  });
});

describe("proposeQuestionEdit — texts only, everything else the draft's", () => {
  it("rewrites a text, keeping the settings, the key and the variables' expressions and assets", () => {
    const base = mcq();
    const edit = proposeQuestionEdit(Q, base, MCQ, {
      edits: [{ path: "prompt", text: "Quelle est la valeur de [[x]] ?\n\n![](asset:abc-1)" }],
    });
    expect(edit.kind).toBe("edit_question");
    expect(edit.fields).toEqual([
      { path: "prompt", label: "statement", n: null, before: base.config.prompt, after: "Quelle est la valeur de [[x]] ?\n\n![](asset:abc-1)" },
    ]);
    const config = edit.config as ReturnType<typeof mcq>["config"];
    expect({ ...config, prompt: base.config.prompt }).toEqual(base.config);
    // The base is never mutated: the proposal is a copy.
    expect(base.config.prompt).toBe("quelle est la valeur de [[x]] ? ![](asset:abc-1)");
    expect(edit.base).toBe(base);
  });

  it("refuses a lost or added [[…]], {{…}} or asset: reference", () => {
    const base = mcq();
    expect(() => proposeQuestionEdit(Q, base, MCQ, { edits: [{ path: "prompt", text: "Quelle est la valeur de x ?" }] })).toThrow(
      /must keep exactly these, verbatim and as many times: \[\[x\]\] asset:abc-1/,
    );
    expect(() => proposeQuestionEdit(Q, base, MCQ, { edits: [{ path: "choices.0.text", text: "[[x]] ou [[y]]" }] })).toThrow(
      /choices.0.text/,
    );
    expect(() =>
      proposeQuestionEdit(Q, { config: { text: "Le {{chat|chien}} dort." }, explanation: "" }, { fields: [{ path: "text", label: "statement" }] }, {
        edits: [{ path: "text", text: "Le {{chien}} dort." }],
      }),
    ).toThrow(/\{\{chat\|chien\}\}/);
    expect(() => proposeQuestionEdit(Q, base, MCQ, { explanation: "Voir ![](asset:zzz)" })).toThrow(/explanation/);
  });

  it("refuses every non-text field: a setting, the key, an id, an unknown path", () => {
    const base = mcq();
    for (const path of ["mode", "policy", "choices.0.correct", "configVersion", "choices.9.text", "choices", "x"]) {
      expect(() => proposeQuestionEdit(Q, base, MCQ, { edits: [{ path, text: "single" }] })).toThrow(/is not a text you may rewrite/);
    }
    const categorize = {
      config: {
        prompt: "Trier",
        columns: [{ id: "col1", label: "Pairs", cards: ["card1"] }],
        cards: [{ id: "card1", text: "2" }],
      },
      explanation: "",
    };
    expect(() => proposeQuestionEdit(Q, categorize, CATEGORIZE, { edits: [{ path: "columns.0.id", text: "x" }] })).toThrow(
      /not a text you may rewrite/,
    );
    const renamed = proposeQuestionEdit(Q, categorize, CATEGORIZE, { edits: [{ path: "columns.0.label", text: "Nombres pairs" }] });
    expect(renamed.config).toEqual({ ...categorize.config, columns: [{ id: "col1", label: "Nombres pairs", cards: ["card1"] }] });
  });

  it("fills the empty choice first, then appends unticked ones, never a duplicate nor past the maximum", () => {
    const edit = proposeQuestionEdit(Q, mcq(), MCQ, { add: ["12", "13"] });
    expect((edit.config as { choices: unknown[] }).choices).toEqual([
      { text: "[[x]]", correct: true },
      { text: "12", correct: false },
      { text: "13", correct: false },
    ]);
    expect(edit.fields).toEqual([
      { path: "choices.1.text", label: "choice", n: 2, before: null, after: "12" },
      { path: "choices.2.text", label: "choice", n: 3, before: null, after: "13" },
    ]);
    expect(() => proposeQuestionEdit(Q, mcq(), MCQ, { add: ["12", "12"] })).toThrow(/already in `choices`/);
    // The wand's rule of "the same choice" (`sameItemText`): case and spaces aside.
    const held = { ...mcq(), config: { ...mcq().config, choices: [{ text: "Une  Valeur", correct: true }] } };
    expect(() => proposeQuestionEdit(Q, held, MCQ, { add: [" une valeur "] })).toThrow(/already in `choices`/);
    // A new item brings no expression of its own: the variables are the teacher's.
    expect(() => proposeQuestionEdit(Q, mcq(), MCQ, { add: ["[[x+1]]"] })).toThrow(/must keep exactly these/);
    expect(() => proposeQuestionEdit(Q, mcq(), MCQ, { add: ["1", "2", "3", "4"] })).toThrow("`choices` holds at most 4 items.");
    expect(() => proposeQuestionEdit(Q, mcq(), DEFAULT_ASSIST_TEXT, { add: ["1"] })).toThrow(/takes no new items/);
  });

  it("writes the explanation beside the config, and refuses an empty, a twice-edited or a no-op proposal", () => {
    const edit = proposeQuestionEdit(Q, mcq(), MCQ, { explanation: "La valeur est celle tirée." });
    expect(edit.explanation).toBe("La valeur est celle tirée.");
    expect(edit.fields).toEqual([{ path: "explanation", label: "explanation", n: null, before: null, after: "La valeur est celle tirée." }]);
    expect(() => proposeQuestionEdit(Q, mcq(), MCQ, { explanation: "Car [[x]] vaut x." })).toThrow(/explanation/);
    expect(() => proposeQuestionEdit(Q, mcq(), MCQ, { edits: [{ path: "choices.1.text", text: "  " }] })).toThrow(/non-empty/);
    expect(() =>
      proposeQuestionEdit(Q, mcq(), MCQ, {
        edits: [
          { path: "choices.0.text", text: "[[x]] " },
          { path: "choices.0.text", text: "[[x]]" },
        ],
      }),
    ).toThrow(/edited twice/);
    expect(() => proposeQuestionEdit(Q, mcq(), MCQ, { edits: [{ path: "choices.0.text", text: "[[x]]" }] })).toThrow(/changes nothing/);
    expect(() => proposeQuestionEdit(Q, mcq(), MCQ, {})).toThrow(/changes nothing/);
    expect(() => proposeQuestionEdit(Q, mcq(), MCQ, { edits: [{ path: "prompt", text: "x".repeat(20_001) }] })).toThrow(/at most/);
    expect(() => proposeQuestionEdit(Q, mcq(), MCQ, { edits: Array.from({ length: 41 }, () => ({ path: "prompt", text: "a" })) })).toThrow(
      /At most 40/,
    );
  });
});

describe("the helpers", () => {
  it("compares drafts by content, key order aside", () => {
    expect(sameDraft({ config: { a: 1, b: [1, { c: 2, d: 3 }] }, explanation: "" }, { config: { b: [1, { d: 3, c: 2 }], a: 1 }, explanation: "" })).toBe(
      true,
    );
    expect(sameDraft({ config: { a: 1 }, explanation: "" }, { config: { a: 1 }, explanation: "x" })).toBe(false);
    expect(sameDraft({ config: { a: 1 }, explanation: "" }, { config: { a: 2 }, explanation: "" })).toBe(false);
  });

  it("lists the preserved tokens sorted, and cuts a card's excerpt", () => {
    expect(preservedTokens("[[b]] {{x}} asset:k [[a]]")).toEqual(["[[a]]", "[[b]]", "asset:k", "{{x}}"]);
    expect(cardExcerpt("  a \n b ")).toBe("a b");
    expect(cardExcerpt("x".repeat(400))).toHaveLength(300);
  });
});

describe("the screen part of the prompt in the editor (ADR-080 P3, decision 2)", () => {
  it("lists the open draft's texts by path, and its explanation, as JSON strings", () => {
    const corpus = buildCorpus([{ id: "guide/pools", locale: "en", text: "# Pools\n\n## Sharing\n\nShare it." }]);
    const editor = { texts: assistTextFields(mcq().config, MCQ), explanation: "Because." };
    const text = assistScreen(corpus, "teacher", { route: "/questions/:id", helpTopic: null, locale: "fr", editor });
    expect(text).toContain("- The open question draft, its texts you may rewrite with propose_question_edit");
    expect(text).toContain('  - prompt: "quelle est la valeur de [[x]] ? ![](asset:abc-1)"');
    expect(text).toContain('  - choices.1.text: ""');
    expect(text).toContain('  - explanation: "Because."');
    expect(assistScreen(corpus, "teacher", { route: "/", helpTopic: null, locale: "fr" })).not.toContain("open question draft");
  });
});

describe("the stub proposes and prepares (ADR-080 P3)", () => {
  const corpus = buildCorpus([{ id: "guide/pools", locale: "en", text: "# Pools\n\n## Sharing a pool\n\nShare it." }]);
  const readers = { results: () => Promise.reject(new Error("no")), pools: () => Promise.resolve([]) };

  it("tidies a statement deterministically", () => {
    expect(stubRewrite("  quelle  est la valeur ")).toBe("Quelle est la valeur.");
    expect(stubRewrite("Déjà propre ?")).toBe("Déjà propre ?");
  });

  it("proposes the statement tidied in the editor, and prepares a quoted category on a pool", async () => {
    const editor = { texts: [{ path: "prompt", text: "quelle valeur" }], explanation: "" };
    const rewrite = await stubTurn(corpus, "teacher", "Reformule l'énoncé", { route: "/questions/:id", helpTopic: null, locale: "fr", editor }, readers);
    expect(rewrite.calls).toEqual([{ tool: "propose_question_edit", input: { edits: [{ path: "prompt", text: "Quelle valeur." }] } }]);
    expect(rewrite.text).toContain("Rien ne change tant que vous ne l'appliquez pas.");
    const screen = { route: "/pools/:id", helpTopic: null, locale: "en" as const, entities: { pool: Q } };
    const category = await stubTurn(corpus, "teacher", 'Create the category "Pointers"', screen, readers);
    expect(category.calls).toEqual([{ tool: "create_category", input: { poolId: Q, name: "Pointers" } }]);
    expect(category.text).toContain("Nothing is created until you confirm it.");
    // Without a pool on screen, or a quoted name, nothing is prepared.
    expect((await stubTurn(corpus, "teacher", "Create a category", screen, readers)).calls).toBeUndefined();
    expect((await stubTurn(corpus, "teacher", "rewrite it", { ...screen, editor: undefined }, readers)).calls).toBeUndefined();
  });
});
