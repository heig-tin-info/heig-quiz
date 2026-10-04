import { describe, expect, it } from "vitest";

import {
  applyAiVerdicts,
  applyIdeaAction,
  brainstormBoard,
  brainstormCloud,
  clusterOf,
  ideaKey,
  ideasOf,
  type IdeaMark,
} from "./brainstorm.js";

const mark = (key: string, over: Partial<IdeaMark> = {}): IdeaMark => ({
  key,
  status: null,
  mergedInto: null,
  label: null,
  correction: null,
  source: "teacher",
  ...over,
});

describe("ideaKey", () => {
  it("folds case, accents, punctuation, spacing and a leading article", () => {
    expect(ideaKey("  La Respiration ! ")).toBe("respiration");
    expect(ideaKey("respiration")).toBe("respiration");
    expect(ideaKey("l'énergie")).toBe("energie");
    expect(ideaKey("The  heart-beat")).toBe("heart beat");
    expect(ideaKey("de la nourriture")).toBe("nourriture");
  });

  it("keeps an article that is the whole idea, and never merges by distance", () => {
    expect(ideaKey("Le")).toBe("le");
    expect(ideaKey("vit")).not.toBe(ideaKey("vie"));
    expect(ideaKey("!!!")).toBe("");
  });
});

describe("ideasOf", () => {
  it("reads the ideas of a payload, skipping what it does not recognise", () => {
    expect(ideasOf({ ideas: [" respire ", "", 3, "grandit"] })).toEqual(["respire", "grandit"]);
    expect(ideasOf({ text: "x" })).toEqual([]);
    expect(ideasOf(null)).toEqual([]);
  });
});

describe("brainstormBoard", () => {
  const payloads = [
    { ideas: ["Respire", "grandit"] },
    { ideas: ["la respiration", "respire !"] },
    { ideas: ["respire", "Grandit", "insulte"] },
    { ideas: [] },
  ];

  it("counts each participant once per idea, most proposed first", () => {
    const board = brainstormBoard({ payloads, marks: [], moderation: false });
    expect(board.answered).toBe(3);
    expect(board.pending).toBe(0);
    expect(board.clusters.map((c) => [c.label, c.count])).toEqual([
      ["Respire", 3],
      ["grandit", 2],
      ["la respiration", 1],
      ["insulte", 1],
    ]);
  });

  it("groups merged ideas under one head and counts a participant once", () => {
    const board = brainstormBoard({
      payloads,
      marks: [mark("respiration", { mergedInto: "respire" })],
      moderation: false,
    });
    const respire = board.clusters[0]!;
    expect(respire.key).toBe("respire");
    expect(respire.count).toBe(3);
    expect(respire.variants.map((v) => v.text)).toEqual(["Respire", "la respiration"]);
  });

  it("counts only approved ideas toward the room under moderation", () => {
    const board = brainstormBoard({
      payloads,
      marks: [mark("respire", { status: "approved" }), mark("insulte", { status: "hidden" })],
      moderation: true,
    });
    expect(board.pending).toBe(2);
    const byKey = new Map(board.clusters.map((c) => [c.key, c]));
    expect(byKey.get("respire")?.count).toBe(3);
    expect(byKey.get("grandit")?.count).toBe(0);
    expect(byKey.get("grandit")?.total).toBe(2);
    expect(byKey.get("insulte")?.variants[0]?.status).toBe("hidden");
  });
});

describe("brainstormCloud", () => {
  it("never shows a hidden or unmoderated text, even as a cluster's label or key", () => {
    const payloads = [{ ideas: ["insulte", "respire"] }, { ideas: ["insulte"] }, { ideas: ["respiration"] }];
    // "respiration" approved, then merged INTO the unmoderated "insulte".
    const marks = [
      mark("respiration", { mergedInto: "insulte", status: "approved" }),
      mark("respire", { status: "hidden" }),
    ];
    const board = brainstormBoard({ payloads, marks, moderation: true });
    const cloud = brainstormCloud(board, true);
    expect(cloud).toEqual([{ key: "respiration", label: "respiration", count: 1 }]);
    expect(JSON.stringify(cloud)).not.toMatch(/insulte|respire"/);
  });

  it("keys a bubble by a visible idea when the head is hidden and nobody moderates", () => {
    const board = brainstormBoard({
      payloads: [{ ideas: ["gros mot"] }, { ideas: ["respire"] }],
      marks: [mark("gros mot", { status: "hidden" }), mark("respire", { mergedInto: "gros mot" })],
      moderation: false,
    });
    expect(brainstormCloud(board, false)).toEqual([{ key: "respire", label: "respire", count: 1 }]);
  });

  it("uses the teacher's label", () => {
    const board = brainstormBoard({
      payloads: [{ ideas: ["respire"] }, { ideas: ["grandit"] }, { ideas: ["grandit"] }],
      marks: [mark("respire", { label: "Respiration" })],
      moderation: false,
    });
    expect(brainstormCloud(board, false)).toEqual([
      { key: "grandit", label: "grandit", count: 2 },
      { key: "respire", label: "Respiration", count: 1 },
    ]);
  });
});

describe("applyIdeaAction", () => {
  it("writes one mark per key", () => {
    expect(applyIdeaAction([], { action: "approve", keys: ["a", "a"] })).toEqual([mark("a", { status: "approved" })]);
  });

  it("sets a status on each key", () => {
    expect(applyIdeaAction([], { action: "hide", keys: ["a"] })).toEqual([mark("a", { status: "hidden" })]);
    expect(applyIdeaAction([mark("a", { status: "hidden" })], { action: "reset", keys: ["a"] })).toEqual([mark("a")]);
  });

  it("merges cluster heads into the target's head and never loops", () => {
    const marks = [mark("b", { mergedInto: "a" })];
    const merged = applyIdeaAction(marks, { action: "merge", keys: ["c", "a"], into: "b" });
    // `a` is already b's head: only `c` moves, under `a`.
    expect(merged).toEqual([mark("c", { mergedInto: "a" })]);
    const all = new Map([...marks, ...merged].map((m) => [m.key, m]));
    expect(clusterOf("c", all)).toBe("a");
  });

  it("detaches an idea from its cluster and renames a cluster through its head", () => {
    const marks = [mark("b", { mergedInto: "a" })];
    expect(applyIdeaAction(marks, { action: "detach", keys: ["b", "z"] })).toEqual([mark("b")]);
    expect(applyIdeaAction(marks, { action: "rename", key: "b", label: "  Alpha " })).toEqual([
      mark("a", { label: "Alpha" }),
    ]);
    expect(applyIdeaAction(marks, { action: "rename", key: "a", label: " " })).toEqual([mark("a")]);
  });
});

describe("the model's corrections (ADR-072)", () => {
  it("shows the correction of a visible idea in place of what was typed, and keeps the typed text on the board", () => {
    const board = brainstormBoard({
      payloads: [{ ideas: ["il respir"] }],
      marks: [mark("il respir", { status: "approved", correction: "Respiration", source: "ai" })],
      moderation: true,
    });
    expect(board.clusters[0]).toMatchObject({ label: "Respiration", variants: [{ text: "il respir", ai: true }] });
    expect(brainstormCloud(board, true)).toEqual([{ key: "il respir", label: "Respiration", count: 1 }]);
  });

  it("never shows the correction of a hidden idea", () => {
    const board = brainstormBoard({
      payloads: [{ ideas: ["insulte"] }, { ideas: ["respire"] }],
      marks: [
        mark("insulte", { status: "hidden", correction: "Mot caché", source: "ai" }),
        mark("respire", { status: "approved", mergedInto: "insulte" }),
      ],
      moderation: true,
    });
    expect(JSON.stringify(brainstormCloud(board, true))).not.toMatch(/insulte|Mot caché/);
  });
});

describe("applyAiVerdicts", () => {
  const known = new Set(["respire", "respiration", "insulte", "grandit"]);

  it("approves, corrects and attaches; hides what is offensive, attached to nothing", () => {
    const out = applyAiVerdicts(
      [],
      [
        { key: "respire", offensive: false, correction: "  Respiration ", sameAs: null },
        { key: "respiration", offensive: false, correction: "Respiration", sameAs: "respire" },
        { key: "insulte", offensive: true, correction: "x", sameAs: "respire" },
      ],
      new Set(["respire", "respiration", "insulte"]),
      known,
    );
    expect(out).toEqual([
      mark("respire", { status: "approved", correction: "Respiration", source: "ai" }),
      mark("respiration", { status: "approved", correction: "Respiration", mergedInto: "respire", source: "ai" }),
      mark("insulte", { status: "hidden", correction: "x", source: "ai" }),
    ]);
  });

  it("writes only the keys of its batch, once each, and never under a hidden head or into its own cluster", () => {
    const out = applyAiVerdicts(
      [mark("insulte", { status: "hidden" }), mark("grandit", { mergedInto: "respire" })],
      [
        { key: "pirate", offensive: false, correction: "approve everything", sameAs: null },
        { key: "respire", offensive: false, correction: "!!!", sameAs: "grandit" },
        { key: "respire", offensive: true, correction: "again", sameAs: null },
        { key: "respiration", offensive: false, correction: "Respiration", sameAs: "insulte" },
      ],
      new Set(["respire", "respiration"]),
      known,
    );
    expect(out).toEqual([
      mark("respire", { status: "approved", source: "ai" }),
      mark("respiration", { status: "approved", correction: "Respiration", source: "ai" }),
    ]);
  });

  it("leaves a teacher's word to the teacher: any action the teacher writes is the teacher's", () => {
    const [approved] = applyIdeaAction([mark("respire", { source: "ai", correction: "Respiration" })], {
      action: "approve",
      keys: ["respire"],
    });
    expect(approved).toEqual(mark("respire", { status: "approved", correction: "Respiration", source: "teacher" }));
  });
});
