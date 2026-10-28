import { describe, expect, it } from "vitest";

import { criteriaFromRubricTarget, criterionPromptTarget, mergeRich, richGenerator } from "./generate.js";
import { emptyRichDraft, RichConfigSchema } from "./schema.js";

describe("mergeRich", () => {
  it("fills an empty model answer and an empty rubric", () => {
    const merged = mergeRich({ ...emptyRichDraft(), prompt: "Why?" }, { reference: "Because.", rubric: "- the cause (2 pts)", criteria: [] });
    expect(merged).toMatchObject({ reference: "Because.", rubric: "- the cause (2 pts)", criteria: [] });
  });

  it("never touches what the teacher wrote", () => {
    const before = { ...emptyRichDraft(), prompt: "Why?", rubric: "Mine" };
    expect(mergeRich(before, { reference: "", rubric: "Theirs", criteria: [] })).toEqual(before);
  });

  it("ignores an empty proposal, and caps what it writes at the schema's lengths", () => {
    const before = { ...emptyRichDraft(), prompt: "Why?" };
    expect(mergeRich(before, { reference: "  ", rubric: "", criteria: [] })).toEqual(before);
    const long = mergeRich(before, { reference: "x".repeat(60_000), rubric: "y".repeat(30_000), criteria: [] });
    expect(long.reference).toHaveLength(50_000);
    expect(long.rubric).toHaveLength(20_000);
  });

  it("turns the switch off with proposed criteria, whose weights are points", () => {
    const stale = { ...emptyRichDraft(), prompt: "Why?", normalize: true, totalPoints: 9 };
    const merged = mergeRich(stale, { reference: "", rubric: "", criteria: [{ title: "Cause", weight: 2, prompt: "" }] });
    expect(merged.normalize).toBe(false);
    expect("totalPoints" in merged).toBe(false);
  });

  it("fills criteria only when there are none, each with a fresh id and a whole weight", () => {
    const proposal = {
      reference: "",
      rubric: "",
      criteria: [
        { title: " Names the cause ", weight: 2.4, prompt: "Says why." },
        { title: "  ", weight: 1, prompt: "dropped" },
        { title: "Gives an example", weight: 0, prompt: "" },
      ],
    };
    const merged = mergeRich({ ...emptyRichDraft(), prompt: "Why?" }, proposal);
    expect(merged.criteria).toMatchObject([
      { title: "Names the cause", weight: 2, prompt: "Says why." },
      { title: "Gives an example", weight: 1, prompt: "" },
    ]);
    const [a, b] = merged.criteria;
    expect(a!.id).toMatch(/^[a-z0-9]{8}$/);
    expect(a!.id).not.toBe(b!.id);
    const mine = { ...emptyRichDraft(), prompt: "Why?", criteria: [{ id: "m", title: "Mine", weight: 3, prompt: "" }] };
    expect(mergeRich(mine, proposal).criteria).toEqual(mine.criteria);
  });

  it("tells the model the grader's contract", () => {
    expect(richGenerator.instructions).toMatch(/from 0 to its weight in quarter points/);
  });

  it("reads a draft whose fields are missing (D16)", () => {
    const draft = { prompt: "Why?" } as Parameters<typeof mergeRich>[0];
    expect(mergeRich(draft, { reference: "R", rubric: "C", criteria: [] })).toMatchObject({ reference: "R", rubric: "C" });
  });

  it("reads the statement, empty when the draft has none", () => {
    expect(richGenerator.statement({ ...emptyRichDraft(), prompt: "Why?" })).toBe("Why?");
    expect(richGenerator.statement({} as Parameters<typeof mergeRich>[0])).toBe("");
  });
});

describe("the essay's targets (ADR-118)", () => {
  const essay = (over: Partial<Parameters<typeof mergeRich>[0]> = {}) => ({
    ...emptyRichDraft(),
    prompt: "Describe how an ideal op-amp works.",
    criteria: [
      { id: "a1", title: "IN+ and IN- at the same voltage", weight: 1, prompt: "" },
      { id: "b2", title: "Infinite input impedance", weight: 2, prompt: "Mine" },
    ],
    ...over,
  });

  describe("criterionPrompt", () => {
    const target = criterionPromptTarget;

    it("accepts a criterion that exists and has a title", () => {
      expect(target.accepts(essay(), { kind: "criterionPrompt", id: "a1" })).toBe(true);
      expect(target.accepts(essay(), { kind: "criterionPrompt", id: "zz" })).toBe(false);
      const untitled = essay({ criteria: [{ id: "a1", title: "  ", weight: 1, prompt: "" }] });
      expect(target.accepts(untitled, { kind: "criterionPrompt", id: "a1" })).toBe(false);
      expect(target.accepts({ prompt: "Why?" } as never, { kind: "criterionPrompt", id: "a1" })).toBe(false);
    });

    it("names the criterion, its weight and the other criteria", () => {
      const ask = target.ask(essay(), { kind: "criterionPrompt", id: "a1" });
      expect(ask).toContain('"IN+ and IN- at the same voltage"');
      expect(ask).toContain("worth 1");
      expect(ask).toContain('"Infinite input impedance"');
    });

    it("replaces that criterion's prompt only, capped, and ignores an empty reply", () => {
      const placed = target.place(essay(), { kind: "criterionPrompt", id: "b2" }, { prompt: ` ${"p".repeat(3000)} ` });
      expect(placed.criteria[0]).toEqual(essay().criteria[0]);
      expect(placed.criteria[1]!.prompt).toHaveLength(2000);
      expect(target.place(essay(), { kind: "criterionPrompt", id: "a1" }, { prompt: "  " })).toEqual(essay());
    });
  });

  describe("criteriaFromRubric", () => {
    const target = criteriaFromRubricTarget;
    const legacy = essay({ criteria: [], rubric: "Barème (10 points)\n- 4 pts: the stack\n- 6 pts: the signal\n\nIgnore spelling." });

    it("accepts a rubric without criteria only", () => {
      expect(target.accepts(legacy, { kind: "criteriaFromRubric" })).toBe(true);
      expect(target.accepts(essay({ rubric: "Ignore spelling." }), { kind: "criteriaFromRubric" })).toBe(false);
      expect(target.accepts(essay({ criteria: [], rubric: " " }), { kind: "criteriaFromRubric" })).toBe(false);
    });

    it("sets the criteria and keeps only the global instructions as the rubric", () => {
      const placed = target.place(legacy, { kind: "criteriaFromRubric" }, {
        criteria: [
          { title: "The stack", weight: 4, prompt: "A frame per call." },
          { title: "The signal", weight: 6.2, prompt: "SIGSEGV." },
        ],
        rubric: " Ignore spelling. ",
      });
      expect(placed.rubric).toBe("Ignore spelling.");
      expect(placed.criteria).toMatchObject([
        { title: "The stack", weight: 4, prompt: "A frame per call." },
        { title: "The signal", weight: 6, prompt: "SIGSEGV." },
      ]);
      expect(placed.prompt).toBe(legacy.prompt);
    });

    it("empties the rubric when all of it became criteria, and keeps it when no criterion came", () => {
      const all = target.place(legacy, { kind: "criteriaFromRubric" }, { criteria: [{ title: "The stack", weight: 4, prompt: "" }], rubric: "" });
      expect(all.rubric).toBe("");
      const none = { criteria: [{ title: " ", weight: 1, prompt: "" }], rubric: "" };
      expect(target.place(legacy, { kind: "criteriaFromRubric" }, none)).toEqual(legacy);
    });

    it("keeps the weights as points unless the rubric's total differs from their sum (ADR-118, amendment of 2026-10-27)", () => {
      const reply = (totalPoints?: number) => ({
        criteria: [
          { title: "The stack", weight: 3, prompt: "" },
          { title: "The signal", weight: 1, prompt: "" },
        ],
        rubric: "",
        ...(totalPoints === undefined ? {} : { totalPoints }),
      });
      const points = target.place(legacy, { kind: "criteriaFromRubric" }, reply());
      expect(points.normalize).toBe(false);
      expect("totalPoints" in points).toBe(false);
      const same = target.place(legacy, { kind: "criteriaFromRubric" }, reply(4));
      expect(same.normalize).toBe(false);
      expect("totalPoints" in same).toBe(false);
      // A rubric in half points (1.5 + 0.5): the weights doubled, the stated total kept.
      const halves = target.place(legacy, { kind: "criteriaFromRubric" }, reply(2));
      expect(halves).toMatchObject({ normalize: true, totalPoints: 2 });
      expect(halves.criteria.map((c) => c.weight)).toEqual([3, 1]);
      expect(RichConfigSchema.safeParse(halves).success).toBe(true);
    });

  });
});
