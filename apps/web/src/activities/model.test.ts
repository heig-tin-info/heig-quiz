import { describe, expect, it } from "vitest";

import type { EvaluationActivitySummary, ProjectActivitySummary } from "@quiz/contracts";

import {
  activityOrder,
  anchorOf,
  bucketOf,
  closedByHand,
  closesOf,
  dayStart,
  daysOf,
  foldable,
  inNextDays,
  isLive,
  isScheduled,
  isoWeek,
  tabOf,
  matchesType,
  mondayOf,
  projectProgress,
  classSegments,
  summaryOf,
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
    closedAt: null,
    closedBy: null,
    updatedAt: "2026-09-28T08:00:00.000Z",
    ...over,
  };
}

function project(over: Partial<ProjectActivitySummary> = {}): ProjectActivitySummary {
  n += 1;
  return {
    kind: "project",
    id: `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`,
    title: `P${n}`,
    state: "published",
    phase: over.state ?? "published",
    classroom: { id: "00000000-0000-4000-8000-0000000000aa", name: "PRG1-2026", courseCode: "PRG1" },
    startAt: "2026-09-21T08:00:00.000Z",
    deadlineAt: "2026-10-05T22:00:00.000Z",
    source: { fullName: "heig/lab-source" },
    distribution: { fullName: "heig/lab-squashed" },
    participantCount: 0,
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

describe("closesOf and closedByHand", () => {
  it("is the closing time while it runs, and the actual closing once over", () => {
    expect(closesOf(row({ state: "running", closesAt: "c", closedAt: null }))).toBe("c");
    expect(closesOf(row({ state: "closed", closesAt: "c", closedAt: "x", closedBy: "teacher" }))).toBe("x");
    // A poll ended by hand had no closing time: its end is the date.
    expect(closesOf(row({ mode: "poll", state: "closed", closedAt: "x", closedBy: "teacher" }))).toBe("x");
    expect(closesOf(row({ state: "released", closesAt: "c" }))).toBe("c");
  });

  it("marks only a run a person ended", () => {
    expect(closedByHand(row({ state: "closed", closedAt: "x", closedBy: "teacher" }))).toBe(true);
    expect(closedByHand(row({ state: "released", closedAt: "x", closedBy: "server" }))).toBe(false);
    expect(closedByHand(row({ state: "running" }))).toBe(false);
  });
});

describe("a project among the activities (M3-10)", () => {
  it("is placed by its start, closes at its deadline, and ages by its state", () => {
    const p = project();
    expect(anchorOf(p)).toBe(p.startAt);
    expect(closesOf(p)).toBe(p.deadlineAt);
    expect(bucketOf("draft")).toBe("upcoming");
    expect(bucketOf("published")).toBe("open");
    expect(bucketOf("locked")).toBe("ended");
  });

  it("is undated, ordered last and in no week, while it has no start (M3-14a)", () => {
    const now = new Date(2026, 8, 30, 12).getTime();
    const undated = project({ title: "undated", state: "draft", startAt: null, deadlineAt: null });
    const dated = project({ title: "dated", state: "draft", startAt: new Date(2026, 9, 7, 8).toISOString() });
    expect(anchorOf(undated)).toBeNull();
    expect(closesOf(undated)).toBeNull();
    expect(activityOrder([undated, dated]).map((a) => a.title)).toEqual(["dated", "undated"]);
    expect(weeksOf([undated, dated], now).at(-1)).toMatchObject({ start: null, rows: [undated] });
  });

  it("is never live, even published and in its span", () => {
    const now = new Date("2026-09-28T10:00:00Z").getTime();
    expect(isLive(project(), now)).toBe(false);
    expect(isLive(row({ state: "running", startedAt: "2026-09-28T09:00:00Z", updatedAt: "2026-09-28T09:59:00Z" }), now)).toBe(true);
  });

  it("passes the type filter with no chip pressed or the Project chip on, and only then", () => {
    const p = project();
    expect(matchesType(p, new Set())).toBe(true);
    expect(matchesType(p, new Set(["project"]))).toBe(true);
    expect(matchesType(p, new Set(["exam", "poll"]))).toBe(false);
    // The Project chip alone hides every evaluation.
    expect(matchesType(row(), new Set(["project"]))).toBe(false);
  });

  it("is ordered and filed in weeks beside the evaluations", () => {
    const now = new Date(2026, 8, 30, 12).getTime();
    const draft = project({ title: "draft", state: "draft", startAt: new Date(2026, 9, 7, 8).toISOString() });
    const locked = project({ title: "locked", state: "locked", startAt: new Date(2026, 8, 1, 8).toISOString() });
    const published = project({ title: "published", startAt: new Date(2026, 8, 14, 8).toISOString() });
    const exam = row({ title: "exam", state: "scheduled", opensAt: new Date(2026, 9, 2, 8).toISOString() });
    expect(activityOrder([locked, draft, exam, published]).map((a) => a.title)).toEqual([
      "published",
      "exam",
      "draft",
      "locked",
    ]);
    // Published, it is this week's business, like an open series.
    const weeks = weeksOf([draft, published, exam], now);
    expect(weeks.find((w) => w.start === mondayOf(now))!.rows.map((r) => r.title).sort()).toEqual([
      "exam",
      "published",
    ]);
  });
});

describe("activityOrder", () => {
  it("puts what is open first, then what comes next, then what is over, last closed first", () => {
    const soon = row({ title: "soon", state: "scheduled", opensAt: "2026-10-01T08:00:00Z" });
    const later = row({ title: "later", state: "scheduled", opensAt: "2026-10-08T08:00:00Z" });
    const undated = row({ title: "undated", state: "draft" });
    const open = row({ title: "open", state: "running", startedAt: "2026-09-28T08:00:00Z" });
    const old = row({ title: "old", state: "released", startedAt: "2026-09-01T08:00:00Z" });
    const recent = row({ title: "recent", state: "closed", startedAt: "2026-09-21T08:00:00Z" });
    // Opened first, closed last: its end is what ranks it among the ended.
    const long = row({
      title: "long",
      state: "closed",
      startedAt: "2026-08-01T08:00:00Z",
      closedAt: "2026-09-25T08:00:00Z",
      closedBy: "server",
    });
    expect(activityOrder([old, undated, later, recent, long, soon, open]).map((a) => a.title)).toEqual([
      "open",
      "soon",
      "later",
      "undated",
      "long",
      "recent",
      "old",
    ]);
  });
});

describe("matchesType", () => {
  const poll = row({ mode: "poll", state: "running" });
  it("filters nothing with no chip pressed, and keeps only the pressed types", () => {
    expect(matchesType(poll, new Set())).toBe(true);
    expect(matchesType(poll, new Set(["poll", "exam"]))).toBe(true);
    expect(matchesType(poll, new Set(["exam"]))).toBe(false);
  });
});

describe("tabOf", () => {
  it("files the drafts apart from what is planned, of either kind", () => {
    expect(tabOf(row({ state: "draft" }))).toBe("drafts");
    expect(tabOf(project({ state: "draft" }))).toBe("drafts");
    expect(tabOf(row({ state: "scheduled" }))).toBe("current");
    expect(tabOf(row({ state: "lobby" }))).toBe("current");
    expect(tabOf(project())).toBe("current");
    expect(tabOf(row({ state: "grading" }))).toBe("ended");
    expect(tabOf(project({ state: "locked" }))).toBe("ended");
  });
});

describe("isScheduled (#787)", () => {
  it("keeps a scheduled evaluation and a project in its scheduled phase", () => {
    expect(isScheduled(row({ state: "scheduled" }))).toBe(true);
    expect(isScheduled(project({ state: "draft", phase: "scheduled" }))).toBe(true);
  });

  it("leaves a draft in preparation and whatever already runs", () => {
    expect(isScheduled(row({ state: "draft" }))).toBe(false);
    expect(isScheduled(row({ state: "running" }))).toBe(false);
    expect(isScheduled(project({ state: "draft" }))).toBe(false);
    expect(isScheduled(project())).toBe(false);
  });

  it("reads a classroom's evaluation row, which has no kind", () => {
    expect(isScheduled({ state: "scheduled" })).toBe(true);
  });

  it("files a scheduled project under the current tab, not under Drafts", () => {
    expect(tabOf(project({ state: "draft", phase: "scheduled" }))).toBe("current");
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

describe("summaryOf", () => {
  const now = new Date("2026-10-02T10:00:00Z").getTime();
  const at = (days: number) => new Date(now + days * 86_400_000).toISOString();

  it("counts what runs, what waits for its results (never a poll), and the week ahead", () => {
    const rows = [
      row({ title: "running", state: "running", startedAt: at(-1), closesAt: at(2) }),
      row({ title: "soon", state: "scheduled", opensAt: at(1), closesAt: at(1.1) }),
      row({ title: "later", state: "scheduled", opensAt: at(9) }),
      row({ title: "draft", state: "draft", opensAt: at(3) }),
      row({ title: "closed", state: "closed", closedAt: at(-1), closedBy: "server" }),
      row({ title: "grading", state: "grading" }),
      row({ title: "released", state: "released" }),
      row({ title: "poll", mode: "poll", state: "closed" }),
    ];
    const summary = summaryOf(rows, now);
    expect(summary.open).toBe(1);
    expect(summary.toRelease).toBe(2);
    // Events, not rows: "running" closes, "soon" opens and closes — three, its opening first.
    expect(summary.week.count).toBe(3);
    expect(summary.week.days.map((d) => d.events.length)).toEqual([0, 2, 1, 0, 0, 0, 0]);
    expect(summary.week.next).toMatchObject({ what: "opens", at: at(1) });
    expect(summary.week.next!.row.title).toBe("soon");
    expect(summary.projects).toBeNull();
  });

  it("gives the projects' nearest deadline still ahead, and none past it", () => {
    const summary = summaryOf(
      [
        project({ title: "late", startAt: at(-20), deadlineAt: at(-1) }),
        project({ title: "next", startAt: at(-3), deadlineAt: at(4) }),
        project({ title: "far", startAt: at(-3), deadlineAt: at(20) }),
        project({ title: "draft", state: "draft", startAt: at(5), deadlineAt: at(6) }),
      ],
      now,
    );
    expect(summary.projects!.count).toBe(3);
    expect(summary.projects!.next!.row.title).toBe("next");
  });
});

describe("the summary's results waiting on the staff", () => {
  const now = new Date("2026-10-02T10:00:00Z").getTime();
  const at = (days: number) => new Date(now + days * 86_400_000).toISOString();

  it("names the closed exams and the runs in grading, the longest waiting first, never a closed exercise", () => {
    const summary = summaryOf(
      [
        row({ title: "recent exam", state: "closed", closedAt: at(-1) }),
        row({ title: "old exam", state: "closed", closedAt: at(-6), closesAt: at(-5) }),
        row({ title: "undated grading", mode: "exercise", state: "grading" }),
        row({ title: "series", mode: "exercise", state: "closed", closesAt: at(-9) }),
        row({ title: "by deadline", state: "grading", closesAt: at(-3) }),
        project({ title: "graded lab", state: "locked", phase: "graded" }),
      ],
      now,
    );
    // The figure counts every run whose results are not out; the list, what waits on the staff.
    expect(summary.toRelease).toBe(5);
    expect(summary.waiting.map((w) => w.row.title)).toEqual(["old exam", "by deadline", "recent exam", "undated grading"]);
    // Since it actually closed, else since its closing time, else nothing to say.
    expect(summary.waiting.map((w) => w.since)).toEqual([at(-6), at(-3), at(-1), null]);
  });
});

describe("the next seven calendar days", () => {
  // Wednesday 14 October 2026, 22:00 local time.
  const now = new Date(2026, 9, 14, 22, 0).getTime();
  const local = (day: number, hour = 12) => new Date(2026, 9, day, hour).toISOString();

  it("runs from today to the end of the sixth day after, by calendar day, not 168 hours", () => {
    const rows = [
      row({ title: "tomorrow", state: "scheduled", opensAt: local(15, 8) }),
      // Day 7 after today, at 01:00: inside a rolling week (now + 168 h), outside the seven days.
      row({ title: "day seven", state: "scheduled", opensAt: local(21, 23), closesAt: local(22, 1) }),
      row({ title: "last day", state: "scheduled", opensAt: local(20, 23) }),
      row({ title: "past today", state: "running", closesAt: local(14, 9) }),
    ];
    const summary = summaryOf(rows, now);
    expect(summary.week.days.map((d) => d.events.map((e) => e.row.title))).toEqual([
      [],
      ["tomorrow"],
      [],
      [],
      [],
      [],
      ["last day"],
    ]);
    // "day seven" opens on the 21st: outside; "past today" closed this morning: already behind.
    expect(summary.week.count).toBe(2);
    expect(inNextDays(rows[0]!, now)).toBe(true);
    expect(inNextDays(rows[1]!, now)).toBe(false);
    expect(inNextDays(rows[3]!, now)).toBe(false);
  });

  it("counts an opening as an event, like a closing", () => {
    const rows = [
      row({ title: "opens and closes", state: "scheduled", opensAt: local(16, 8), closesAt: local(18, 23) }),
      row({ title: "opens only", state: "scheduled", opensAt: local(17, 8), closesAt: local(30, 23) }),
    ];
    const summary = summaryOf(rows, now);
    expect(summary.week.count).toBe(3);
    expect(summary.week.days.map((d) => d.events.map((e) => e.what))).toEqual([
      [],
      [],
      ["opens"],
      ["opens"],
      ["closes"],
      [],
      [],
    ]);
    expect(summary.week.next).toMatchObject({ what: "opens", at: local(16, 8) });
  });

  it("starts each day at local midnight across a daylight-saving change", () => {
    // Europe's change of 25 October 2026 makes one day 25 hours long where it applies;
    // a day built from the calendar date always starts at 00:00.
    const start = new Date(2026, 9, 22, 12).getTime();
    const starts = Array.from({ length: 7 }, (_, i) => new Date(dayStart(start, i)));
    expect(starts.map((d) => [d.getDate(), d.getHours(), d.getMinutes()])).toEqual(
      [22, 23, 24, 25, 26, 27, 28].map((day) => [day, 0, 0]),
    );
    const late = { row: row(), at: new Date(2026, 9, 26, 23, 30).toISOString(), what: "closes" as const };
    expect(daysOf([late], start).map((d) => d.events.length)).toEqual([0, 0, 0, 0, 1, 0, 0]);
  });
});

describe("projectProgress", () => {
  const now = new Date(2026, 9, 14, 12).getTime();

  it("gives the elapsed share, the calendar days left and the last 48 hours", () => {
    expect(projectProgress(new Date(2026, 9, 7, 12).toISOString(), new Date(2026, 9, 18, 23, 59).toISOString(), now)).toEqual({
      elapsed: expect.closeTo(7 / 11.5, 2) as unknown as number,
      daysLeft: 4,
      soon: false,
    });
    const tomorrow = projectProgress(new Date(2026, 9, 1).toISOString(), new Date(2026, 9, 15, 23, 59).toISOString(), now)!;
    expect(tomorrow).toMatchObject({ daysLeft: 1, soon: true });
  });

  it("is bounded, and absent without both dates", () => {
    expect(projectProgress(new Date(2026, 9, 20).toISOString(), new Date(2026, 9, 30).toISOString(), now)!.elapsed).toBe(0);
    expect(projectProgress(new Date(2026, 9, 1).toISOString(), new Date(2026, 9, 10).toISOString(), now)).toMatchObject({
      elapsed: 1,
      daysLeft: 0,
      soon: true,
    });
    expect(projectProgress(null, new Date(2026, 9, 30).toISOString(), now)).toBeNull();
    expect(projectProgress(new Date(2026, 9, 1).toISOString(), null, now)).toBeNull();
  });
});

describe("classSegments", () => {
  it("keeps one segment per class, largest first, and drops an empty class", () => {
    expect(classSegments([12, 24, 0, 18])).toEqual([24, 18, 12]);
  });

  it("sums the smallest past six in one last segment", () => {
    expect(classSegments([1, 2, 3, 4, 5, 6, 7])).toEqual([7, 6, 5, 4, 3, 2, 1]);
    expect(classSegments([9, 1, 2, 3, 4, 5, 6, 7])).toEqual([9, 7, 6, 5, 4, 3, 3]);
  });
});
