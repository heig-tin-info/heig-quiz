import { describe, expect, it } from "vitest";

import {
  composeRevisionRound,
  DRILL_REVISION_REQUEUE_GAP,
  DRILL_REVISION_ROUND_SIZE,
  revisionNext,
  revisionQueue,
  revisionSummary,
  revisionTimeMs,
  type RevisionAnswer,
  type RevisionCandidate,
} from "./drillRevision.js";
import { DWELL_IDLE_CAP_MS } from "./stats.js";

const day = (n: number) => new Date(Date.UTC(2026, 9, n));
const card = (id: string, over: Partial<RevisionCandidate> = {}): RevisionCandidate => ({
  id,
  isNew: false,
  retrievability: 0.5,
  createdAt: day(1),
  practisedToday: false,
  ...over,
});

describe("composeRevisionRound", () => {
  it("holds ten cards at most", () => {
    expect(DRILL_REVISION_ROUND_SIZE).toBe(10);
    const many = Array.from({ length: 14 }, (_, i) => card(`c${String(i).padStart(2, "0")}`));
    expect(composeRevisionRound(many)).toHaveLength(10);
    expect(composeRevisionRound(many, 3)).toEqual(["c00", "c01", "c02"]);
    expect(composeRevisionRound([])).toEqual([]);
  });

  it("puts the reviewed cards first, the lowest retrievability ahead, the id breaking a tie", () => {
    const out = composeRevisionRound([card("b", { retrievability: 0.9 }), card("c", { retrievability: 0.2 }), card("a", { retrievability: 0.9 })]);
    expect(out).toEqual(["c", "a", "b"]);
  });

  it("puts the new cards after the reviewed ones, the oldest first, whatever their retrievability", () => {
    const out = composeRevisionRound([
      card("n2", { isNew: true, createdAt: day(3), retrievability: 0 }),
      card("r", { retrievability: 0.99 }),
      card("n1", { isNew: true, createdAt: day(2), retrievability: 0 }),
      card("n0", { isNew: true, createdAt: day(3), retrievability: 0 }),
    ]);
    expect(out).toEqual(["r", "n1", "n0", "n2"]);
  });

  it("puts the cards practised today last, each group in its own order", () => {
    const out = composeRevisionRound([
      card("p-low", { practisedToday: true, retrievability: 0.1 }),
      card("fresh", { isNew: true }),
      card("p-new", { practisedToday: true, isNew: true }),
      card("high", { retrievability: 0.8 }),
    ]);
    expect(out).toEqual(["high", "fresh", "p-low", "p-new"]);
  });

  it("fills the round with practised cards only when nothing else is left, and cuts them first", () => {
    const fresh = Array.from({ length: 8 }, (_, i) => card(`f${i}`));
    const practised = Array.from({ length: 5 }, (_, i) => card(`p${i}`, { practisedToday: true }));
    expect(composeRevisionRound([...practised, ...fresh])).toEqual([...fresh.map((c) => c.id), "p0", "p1"]);
  });
});

const answer = (cardId: string, correctness: RevisionAnswer["correctness"], pass: 1 | 2 = 1): RevisionAnswer => ({
  cardId,
  pass,
  correctness,
});
const order = ["a", "b", "c", "d", "e"];

describe("revisionQueue and revisionNext", () => {
  it("walks the order when every answer is right", () => {
    expect(revisionNext({ order, answers: [] })).toEqual({ cardId: "a", pass: 1 });
    expect(revisionNext({ order, answers: [answer("a", "right")] })).toEqual({ cardId: "b", pass: 1 });
    expect(revisionNext({ order, answers: order.map((id) => answer(id, "right")) })).toBeNull();
  });

  it("brings a wrong first pass back once, three places later", () => {
    expect(DRILL_REVISION_REQUEUE_GAP).toBe(3);
    const queue = revisionQueue({ order, answers: [answer("a", "wrong")] });
    expect(queue).toEqual([
      { cardId: "b", pass: 1 },
      { cardId: "c", pass: 1 },
      { cardId: "d", pass: 1 },
      { cardId: "a", pass: 2 },
      { cardId: "e", pass: 1 },
    ]);
  });

  it("clamps the requeue to the end of the round", () => {
    const answers = [answer("a", "right"), answer("b", "right"), answer("c", "right"), answer("d", "wrong")];
    expect(revisionQueue({ order, answers })).toEqual([
      { cardId: "e", pass: 1 },
      { cardId: "d", pass: 2 },
    ]);
    expect(revisionQueue({ order: ["a"], answers: [answer("a", "wrong")] })).toEqual([{ cardId: "a", pass: 2 }]);
  });

  it("never requeues a second pass, even wrong, nor a partial answer", () => {
    const answers = [answer("a", "wrong"), answer("b", "partial"), answer("c", "right"), answer("d", "right"), answer("a", "wrong", 2)];
    expect(revisionQueue({ order, answers })).toEqual([{ cardId: "e", pass: 1 }]);
    expect(revisionNext({ order, answers: [...answers, answer("e", "right")] })).toBeNull();
  });

  it("follows answers given out of order, and ignores one with no entry", () => {
    const answers = [answer("c", "wrong"), answer("z", "wrong"), answer("c", "right", 2)];
    expect(revisionQueue({ order, answers }).map((e) => e.cardId)).toEqual(["a", "b", "d", "e"]);
  });
});

describe("revisionTimeMs", () => {
  it("is the server's interval, within 0 and the idle cap", () => {
    const t = new Date("2026-10-15T10:00:00Z");
    expect(revisionTimeMs(t, new Date(t.getTime() + 12_345))).toBe(12_345);
    expect(revisionTimeMs(t, new Date(t.getTime() - 5))).toBe(0);
    expect(revisionTimeMs(t, new Date(t.getTime() + 3_600_000))).toBe(DWELL_IDLE_CAP_MS);
  });
});

describe("revisionSummary", () => {
  it("counts the distinct cards answered at their first pass, and those right", () => {
    expect(revisionSummary([])).toEqual({ cardsServed: 0, cardsCorrect: 0 });
    const answers = [answer("a", "wrong"), answer("b", "right"), answer("c", "partial"), answer("a", "right", 2)];
    expect(revisionSummary(answers)).toEqual({ cardsServed: 3, cardsCorrect: 1 });
  });
});
