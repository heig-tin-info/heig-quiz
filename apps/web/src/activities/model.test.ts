import { describe, expect, it } from "vitest";

import type { EvaluationActivitySummary } from "@quiz/contracts";

import {
  activityOrder,
  anchorOf,
  bucketOf,
  foldable,
  isoWeek,
  matches,
  mondayOf,
  weeksOf,
} from "./model";

let n = 0;
function row(over: Partial<EvaluationActivitySummary> = {}): EvaluationActivitySummary {
  n += 1;
  return {
    kind: "evaluation",
    id: `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`,
    title: `A${n}`,
    mode: "exam",
    state: "draft",
    classroom: null,
    takeHome: false,
    opensAt: null,
    closesAt: null,
    startedAt: null,
    updatedAt: "2026-09-28T08:00:00.000Z",
    ...over,
  };
}

describe("bucketOf", () => {
  it("sorts the eight states into three ages", () => {
    expect(bucketOf("draft")).toBe("upcoming");
    expect(bucketOf("scheduled")).toBe("upcoming");
    expect(bucketOf("paused")).toBe("open");
    expect(bucketOf("grading")).toBe("ended");
  });
});

describe("anchorOf", () => {
  it("takes the opening, else the start, else the closing", () => {
    expect(anchorOf(row({ opensAt: "a", startedAt: "b", closesAt: "c" }))).toBe("a");
    expect(anchorOf(row({ startedAt: "b", closesAt: "c" }))).toBe("b");
    expect(anchorOf(row({ closesAt: "c" }))).toBe("c");
    expect(anchorOf(row())).toBeNull();
  });
});

describe("activityOrder", () => {
  it("puts what is open first, then what comes next, then what is over, newest first", () => {
    const soon = row({ title: "soon", state: "scheduled", opensAt: "2026-10-01T08:00:00Z" });
    const later = row({ title: "later", state: "scheduled", opensAt: "2026-10-08T08:00:00Z" });
    const undated = row({ title: "undated", state: "draft" });
    const open = row({ title: "open", state: "running", startedAt: "2026-09-28T08:00:00Z" });
    const old = row({ title: "old", state: "released", startedAt: "2026-09-01T08:00:00Z" });
    const recent = row({ title: "recent", state: "closed", startedAt: "2026-09-21T08:00:00Z" });
    expect(activityOrder([old, undated, later, recent, soon, open]).map((a) => a.title)).toEqual([
      "open",
      "soon",
      "later",
      "undated",
      "recent",
      "old",
    ]);
  });
});

describe("matches", () => {
  const poll = row({ mode: "poll", state: "running" });
  it("filters nothing with no chip pressed", () => {
    expect(matches(poll, { modes: new Set(), buckets: new Set() })).toBe(true);
  });
  it("needs both the type and the state when both are pressed", () => {
    expect(matches(poll, { modes: new Set(["poll"]), buckets: new Set(["open"]) })).toBe(true);
    expect(matches(poll, { modes: new Set(["poll"]), buckets: new Set(["ended"]) })).toBe(false);
    expect(matches(poll, { modes: new Set(["exam"]), buckets: new Set() })).toBe(false);
  });
});

describe("weeks", () => {
  it("starts a week on Monday at midnight, local time", () => {
    const monday = new Date(mondayOf(new Date(2026, 8, 30, 15).getTime()));
    expect([monday.getFullYear(), monday.getMonth(), monday.getDate(), monday.getHours()]).toEqual([
      2026, 8, 28, 0,
    ]);
    // A Sunday belongs to the week that started six days before.
    expect(new Date(mondayOf(new Date(2026, 9, 4, 23).getTime())).getDate()).toBe(28);
  });

  it("numbers weeks the ISO way", () => {
    expect(isoWeek(new Date(2026, 8, 28).getTime())).toBe(40);
    expect(isoWeek(new Date(2026, 0, 1).getTime())).toBe(1);
    // 1 January 2027 is a Friday: it belongs to the last week of 2026.
    expect(isoWeek(new Date(2027, 0, 1).getTime())).toBe(53);
  });

  it("groups by week, oldest first, the undated last", () => {
    const a = row({ title: "a", opensAt: new Date(2026, 9, 7, 8).toISOString() });
    const b = row({ title: "b", opensAt: new Date(2026, 8, 30, 8).toISOString() });
    const c = row({ title: "c", opensAt: new Date(2026, 8, 28, 8).toISOString() });
    const d = row({ title: "d" });
    const weeks = weeksOf([a, d, b, c], new Date(2026, 8, 28, 12).getTime());
    expect(weeks.map((w) => w.rows.map((r) => r.title))).toEqual([["c", "b"], ["a"], ["d"]]);
    expect(weeks.at(-1)!.start).toBeNull();
  });

  it("files an open row under this week, whenever it opened, and never folds it", () => {
    const now = new Date(2026, 9, 7, 10).getTime(); // Wednesday of week 41
    // A two-week take-home series opened last Monday, still open.
    const series = row({
      title: "series",
      mode: "exercise",
      takeHome: true,
      state: "running",
      opensAt: new Date(2026, 8, 28, 8).toISOString(),
      startedAt: new Date(2026, 8, 28, 8).toISOString(),
      closesAt: new Date(2026, 9, 11, 23, 59).toISOString(),
    });
    // An exam in its lobby with no date: this week too, not "Not scheduled".
    const lobby = row({ title: "lobby", state: "lobby" });
    const done = row({ title: "done", state: "released", startedAt: new Date(2026, 8, 29).toISOString() });
    const weeks = weeksOf([series, lobby, done], now);
    const thisWeek = weeks.find((w) => w.start === mondayOf(now))!;
    expect(thisWeek.rows.map((r) => r.title).sort()).toEqual(["lobby", "series"]);
    expect(weeks.some((w) => w.start === null)).toBe(false);
    // Last week holds only the ended one, and folds; this week never does.
    expect(weeks.filter((w) => foldable(w, now)).flatMap((w) => w.rows.map((r) => r.title))).toEqual(["done"]);
    expect(foldable(thisWeek, now)).toBe(false);
  });

  it("never folds a past week that still holds something to come", () => {
    const now = new Date(2026, 9, 7, 10).getTime();
    // Its opening passed and the ticker has not moved it yet.
    const late = row({ title: "late", state: "scheduled", opensAt: new Date(2026, 8, 29).toISOString() });
    const [week] = weeksOf([late], now);
    expect(week!.start).toBeLessThan(mondayOf(now));
    expect(foldable(week!, now)).toBe(false);
  });
});
