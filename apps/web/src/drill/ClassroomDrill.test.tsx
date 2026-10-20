import { screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

import type {
  DrillClassroomMastery,
  DrillClassroomRevision,
  DrillHours,
  DrillProgress,
  DrillStudentActivity,
} from "@quiz/contracts";

import { makeClassroomDetail } from "../test/fixtures";
import { fail, mockFetch, ok, renderWithProviders } from "../test/render";
import { ClassroomDrill } from "./ClassroomDrill";

/*
 * The teacher's view of a classroom's drill (ADR-041 §8, #317 slice 4):
 * the empty states (drill off; on with nothing yet), the table of students
 * — sortable, the opt-out as a badge with its date, the recall rate with
 * its trend — the per-student progression in a sheet, and the mastery per
 * concept, and the hours of the week the drill is practised at, the
 * classroom's and one student's.
 */

afterEach(() => {
  vi.unstubAllGlobals();
});

const none = { repeated: 0, recalled: 0 };
/** Enrollment ids, uuids as the server gives them. */
const SEAT: Record<string, string> = {
  Alder: "00000000-0000-4000-8000-000000000001",
  Bernard: "00000000-0000-4000-8000-000000000002",
  Cattaneo: "00000000-0000-4000-8000-000000000003",
};
const row = (over: Partial<DrillStudentActivity> & { nom: string }): DrillStudentActivity => ({
  enrollmentId: SEAT[over.nom]!,
  prenom: "Ada",
  questionsSeen: 0,
  sessions: 0,
  lastReviewAt: null,
  reviews: { last30: 0, all: 0 },
  recall: { last30: none, previous30: none, all: none },
  optedOutAt: null,
  ...over,
});

const ROWS: DrillStudentActivity[] = [
  row({
    nom: "Bernard",
    questionsSeen: 40,
    sessions: 12,
    lastReviewAt: "2026-11-19T08:00:00.000Z",
    reviews: { last30: 45, all: 120 },
    // 90 % now against 70 % before: rising.
    recall: { last30: { repeated: 30, recalled: 27 }, previous30: { repeated: 20, recalled: 14 }, all: { repeated: 60, recalled: 48 } },
  }),
  row({
    nom: "Alder",
    questionsSeen: 12,
    sessions: 4,
    lastReviewAt: "2026-10-13T08:00:00.000Z",
    reviews: { last30: 6, all: 20 },
    recall: { last30: { repeated: 6, recalled: 3 }, previous30: none, all: { repeated: 10, recalled: 6 } },
    optedOutAt: "2026-10-20T12:00:00.000Z",
  }),
  row({ nom: "Cattaneo" }),
];

const WEEKS: DrillProgress = {
  weeks: [
    { weekStart: "2026-10-05", reviews: 12, recall: none },
    { weekStart: "2026-10-12", reviews: 0, recall: none },
    { weekStart: "2026-10-19", reviews: 20, recall: { repeated: 10, recalled: 8 } },
  ],
};

const ADDRESS = { id: "00000000-0000-4000-8000-0000000000a1", label: "Adresse", qualifier: "mémoire", status: "validated" } as const;
const LOOP = { id: "00000000-0000-4000-8000-0000000000a2", label: "Boucle", qualifier: "", status: "validated" } as const;
const IDLE = { id: "00000000-0000-4000-8000-0000000000a3", label: "Récursivité", qualifier: "", status: "validated" } as const;

/** A course that lists three concepts, one exercised by nothing, and an outside bucket. */
const MASTERY: DrillClassroomMastery = {
  declared: true,
  concepts: [
    { concept: ADDRESS, cards: 40, students: 12, retrievability: 0.58 },
    { concept: LOOP, cards: 9, students: 4, retrievability: 0.9 },
    { concept: IDLE, cards: 0, students: 0, retrievability: null },
  ],
  outside: {
    cards: 5,
    students: 3,
    retrievability: 0.8,
    concepts: [{ concept: null, cards: 5, students: 3, retrievability: 0.8 }],
  },
};
const FLAT: DrillClassroomMastery = {
  declared: false,
  concepts: [{ concept: ADDRESS, cards: 40, students: 12, retrievability: 0.58 }],
  outside: null,
};
const NONE: DrillClassroomMastery = { declared: false, concepts: [], outside: null };

const base = "/app/api/classrooms/r1/drill";

/** A week's grid, Monday first, from `[weekday, hour, n]` cells. */
const hoursOf = (cells: [number, number, number][]): DrillHours => {
  const days = Array.from({ length: 7 }, () => Array<number>(24).fill(0));
  for (const [d, h, n] of cells) days[d]![h] = n;
  return { since: "2026-10-21", offHoursShare: cells.length === 0 ? null : 0.2, days };
};
/** Wednesday 09:00 (class hours) and Saturday 00:00 (outside). */
const HOURS = hoursOf([
  [2, 9, 4],
  [5, 0, 1],
]);

describe("the classroom's Drill tab", () => {
  it("says the drill is off, and leads to the switch in Settings", async () => {
    mockFetch({ [`GET ${base}/activity`]: ok([row({ nom: "Cattaneo" })]) });
    renderWithProviders(<ClassroomDrill room={makeClassroomDetail()} onSettings={vi.fn()} />);
    expect(await screen.findByText("The drill is off for this classroom")).toBeVisible();
    expect(screen.queryByRole("switch", { name: "Drill" })).toBeNull();
    expect(screen.queryByRole("table")).toBeNull();
  });

  it("says nothing happened yet when the drill is on and no one practised", async () => {
    mockFetch({ [`GET ${base}/activity`]: ok([row({ nom: "Cattaneo" })]) });
    renderWithProviders(<ClassroomDrill room={makeClassroomDetail({ drillEnabled: true })} onSettings={vi.fn()} />);
    expect(await screen.findByText("No drill activity yet")).toBeVisible();
    expect(screen.queryByRole("table")).toBeNull();
  });

  it("offers a retry when the activity cannot be read", async () => {
    mockFetch({ [`GET ${base}/activity`]: fail(500) });
    renderWithProviders(<ClassroomDrill room={makeClassroomDetail({ drillEnabled: true })} onSettings={vi.fn()} />);
    expect(await screen.findByText("Could not load the drill activity")).toBeVisible();
  });

  it("lists the students by name, with the recall rate, its trend and the opt-out's date", async () => {
    mockFetch({ [`GET ${base}/activity`]: ok(ROWS), [`GET ${base}/mastery`]: ok(MASTERY) });
    renderWithProviders(<ClassroomDrill room={makeClassroomDetail({ drillEnabled: true })} onSettings={vi.fn()} />);
    const table = await screen.findByRole("table");
    const names = () => within(table).getAllByRole("button", { name: /^Progression of/ }).map((b) => b.textContent);
    expect(names()).toEqual(["Alder Ada", "Bernard Ada", "Cattaneo Ada"]);

    const bernard = within(table).getByRole("button", { name: "Progression of Ada Bernard" }).closest("tr")!;
    expect(within(bernard).getByText("90%")).toBeInTheDocument();
    expect(within(bernard).getByText("rising compared with the 30 days before")).toBeInTheDocument();
    const alder = within(table).getByRole("button", { name: "Progression of Ada Alder" }).closest("tr")!;
    expect(within(alder).getByText(/^Opted out on 2026-10-20$/)).toBeVisible();
    // Too few reviews before: no trend drawn.
    expect(within(alder).queryByText(/compared with the 30 days before/)).toBeNull();
    const cattaneo = within(table).getByRole("button", { name: "Progression of Ada Cattaneo" }).closest("tr")!;
    expect(within(cattaneo).getAllByText("—").length).toBeGreaterThan(0);
  });

  it("sorts by the recall rate, a student without one below every rate, and flips on a second click", async () => {
    const user = userEvent.setup();
    mockFetch({ [`GET ${base}/activity`]: ok(ROWS), [`GET ${base}/mastery`]: ok(MASTERY) });
    renderWithProviders(<ClassroomDrill room={makeClassroomDetail({ drillEnabled: true })} onSettings={vi.fn()} />);
    const table = await screen.findByRole("table");
    const names = () => within(table).getAllByRole("button", { name: /^Progression of/ }).map((b) => b.textContent);

    await user.click(within(table).getByRole("button", { name: "Recall, 30 days" }));
    expect(names()).toEqual(["Cattaneo Ada", "Alder Ada", "Bernard Ada"]);
    await user.click(within(table).getByRole("button", { name: "Recall, 30 days" }));
    expect(names()).toEqual(["Bernard Ada", "Alder Ada", "Cattaneo Ada"]);
  });

  it("shows the course's concepts, a line without evidence apart, and the outside bucket folded", async () => {
    const user = userEvent.setup();
    mockFetch({ [`GET ${base}/activity`]: ok(ROWS), [`GET ${base}/mastery`]: ok(MASTERY) });
    renderWithProviders(<ClassroomDrill room={makeClassroomDetail({ drillEnabled: true })} onSettings={vi.fn()} />);
    expect(await screen.findByRole("heading", { name: "Mastery on the course's concepts" })).toBeVisible();
    expect(screen.getByText("Adresse (mémoire)")).toBeVisible();
    expect(screen.getByText("58%")).toBeVisible();
    expect(screen.getByText("40 cards · 12 students")).toBeVisible();
    // No evidence is said, not drawn as 0%.
    expect(screen.getByText("Récursivité")).toBeVisible();
    expect(screen.getByText("No evidence yet")).toBeVisible();
    expect(screen.queryByText("0%")).toBeNull();
    // Outside the list: folded until opened.
    const outside = screen.getByRole("button", { name: /Outside the course's list/ });
    expect(outside).toHaveAttribute("aria-expanded", "false");
    expect(screen.queryByText("Without a concept")).toBeNull();
    await user.click(outside);
    expect(await screen.findByText("Without a concept")).toBeVisible();
    expect(screen.queryByText(/lists no concept/)).toBeNull();
  });

  it("falls back to the flat view, with the hint to declare the course's concepts", async () => {
    mockFetch({ [`GET ${base}/activity`]: ok(ROWS), [`GET ${base}/mastery`]: ok(FLAT) });
    renderWithProviders(<ClassroomDrill room={makeClassroomDetail({ drillEnabled: true })} onSettings={vi.fn()} />);
    expect(await screen.findByRole("heading", { name: "Mastery per concept" })).toBeVisible();
    expect(screen.getByText(/lists no concept/)).toBeVisible();
    expect(screen.getByText("58%")).toBeVisible();
    expect(screen.queryByRole("button", { name: /Outside/ })).toBeNull();
  });

  it("opens a student's weekly progression in a sheet, with the opt-out said", async () => {
    const user = userEvent.setup();
    const { calls } = mockFetch({
      [`GET ${base}/activity`]: ok(ROWS),
      [`GET ${base}/mastery`]: ok(MASTERY),
      [`GET ${base}/progress?student=${SEAT.Alder}`]: ok(WEEKS),
    });
    renderWithProviders(<ClassroomDrill room={makeClassroomDetail({ drillEnabled: true })} onSettings={vi.fn()} />);
    await user.click(await screen.findByRole("button", { name: "Progression of Ada Alder" }));

    const sheet = await screen.findByRole("dialog", { name: "Ada Alder" });
    expect(within(sheet).getByText(/Opted out of practice on 2026-10-20/)).toBeVisible();
    // All time, and said so: the table's figure is the last 30 days'.
    expect(within(sheet).getByText("Recall rate, all time")).toBeVisible();
    expect(within(sheet).getByText("60%")).toBeVisible(); // 6 of 10 repeated reviews
    expect(within(sheet).getByText("over 10 repeated reviews")).toBeVisible();
    expect(await within(sheet).findByText("Reviews per week", { selector: "figcaption" })).toBeVisible();
    // The numbers behind each chart, as a table: a week without repeated reviews has no rate.
    const [reviews, recall] = within(sheet).getAllByRole("table");
    const rowsOf = (table: HTMLElement) =>
      within(table)
        .getAllByRole("row")
        .slice(1)
        .map((r) => r.textContent);
    expect(rowsOf(reviews!)).toEqual(["Oct 512", "Oct 120", "Oct 1920"]);
    expect(rowsOf(recall!)).toEqual(["Oct 5—", "Oct 12—", "Oct 1980%"]);
    expect(calls.some((c) => c.url.endsWith(`/progress?student=${SEAT.Alder}`))).toBe(true);
  });

  it("says so when a student has no review over the period", async () => {
    const user = userEvent.setup();
    mockFetch({
      [`GET ${base}/activity`]: ok(ROWS),
      [`GET ${base}/mastery`]: ok(NONE),
      [`GET ${base}/progress?student=${SEAT.Cattaneo}`]: ok({ weeks: WEEKS.weeks.map((w) => ({ ...w, reviews: 0, recall: none })) }),
    });
    renderWithProviders(<ClassroomDrill room={makeClassroomDetail({ drillEnabled: true })} onSettings={vi.fn()} />);
    await user.click(await screen.findByRole("button", { name: "Progression of Ada Cattaneo" }));
    const sheet = await screen.findByRole("dialog", { name: "Ada Cattaneo" });
    expect(await within(sheet).findByText("No review over this period.")).toBeVisible();
    // No mastery yet: no section for it.
    expect(screen.queryByRole("heading", { name: "Mastery per concept" })).toBeNull();
  });

  describe("targeted revision (ADR-115)", () => {
    const REVISION: DrillClassroomRevision = {
      students: [
        {
          enrollmentId: SEAT.Bernard!,
          rounds: 3,
          lastAt: "2026-10-14T08:00:00.000Z",
          cardsServed: 12,
          cardsCorrect: 9,
          concepts: [ADDRESS, LOOP],
        },
      ],
      concepts: [
        { concept: ADDRESS, students: 2, rounds: 4, lastAt: "2026-10-14T08:00:00.000Z" },
        { concept: LOOP, students: 1, rounds: 1, lastAt: "2026-10-12T08:00:00.000Z" },
      ],
    };
    const room = () => <ClassroomDrill room={makeClassroomDetail({ drillEnabled: true })} onSettings={vi.fn()} />;

    it("counts each student's rounds in a Targeted column, and lists who revised which concept", async () => {
      mockFetch({ [`GET ${base}/activity`]: ok(ROWS), [`GET ${base}/mastery`]: ok(NONE), [`GET ${base}/revision`]: ok(REVISION) });
      renderWithProviders(room());
      const table = await screen.findByRole("table");
      expect(within(table).getByRole("button", { name: "Targeted" })).toBeInTheDocument();
      const rowOf = (name: string) => within(table).getByRole("button", { name: `Progression of Ada ${name}` }).closest("tr")!;
      expect(within(rowOf("Bernard")).getByText("3")).toBeInTheDocument();

      expect(await screen.findByRole("heading", { name: "Targeted revision" })).toBeVisible();
      const address = screen.getByText("Adresse (mémoire)").closest("div")!.parentElement!;
      expect(within(address).getByText("2 students · 4 rounds")).toBeVisible();
      expect(within(address).getByText("last on 2026-10-14")).toBeVisible();
      expect(screen.getByText("1 student · 1 round")).toBeVisible();
    });

    it("counts a student who only revised as activity, and says when no one revised", async () => {
      const quiet = [row({ nom: "Cattaneo" })];
      const only: DrillClassroomRevision = { ...REVISION, students: [{ ...REVISION.students[0]!, enrollmentId: SEAT.Cattaneo! }] };
      mockFetch({ [`GET ${base}/activity`]: ok(quiet), [`GET ${base}/mastery`]: ok(NONE), [`GET ${base}/revision`]: ok(only) });
      const first = renderWithProviders(room());
      expect(await screen.findByRole("table")).toBeVisible();
      expect(screen.queryByText("No drill activity yet")).toBeNull();
      first.unmount();

      mockFetch({
        [`GET ${base}/activity`]: ok(ROWS),
        [`GET ${base}/mastery`]: ok(NONE),
        [`GET ${base}/revision`]: ok({ students: [], concepts: [] }),
      });
      renderWithProviders(room());
      expect(await screen.findByText("No targeted revision yet.")).toBeVisible();
    });

    it("draws no column and no sheet block when the rounds cannot be read, and says so once", async () => {
      const user = userEvent.setup();
      mockFetch({
        [`GET ${base}/activity`]: ok(ROWS),
        [`GET ${base}/mastery`]: ok(NONE),
        [`GET ${base}/revision`]: fail(500),
        [`GET ${base}/progress?student=${SEAT.Bernard}`]: ok(WEEKS),
      });
      renderWithProviders(room());
      const table = await screen.findByRole("table");
      expect(within(table).queryByRole("button", { name: "Targeted" })).toBeNull();
      expect(await screen.findByText("Could not load the targeted revisions")).toBeVisible();
      await user.click(screen.getByRole("button", { name: "Progression of Ada Bernard" }));
      const sheet = await screen.findByRole("dialog", { name: "Ada Bernard" });
      expect(within(sheet).queryByText("Targeted revision")).toBeNull();
      expect(within(sheet).queryByText("No targeted revision yet.")).toBeNull();
    });

    it("shows a student's rounds in their sheet: how many, the score, the last day and the concepts", async () => {
      const user = userEvent.setup();
      mockFetch({
        [`GET ${base}/activity`]: ok(ROWS),
        [`GET ${base}/mastery`]: ok(NONE),
        [`GET ${base}/revision`]: ok(REVISION),
        [`GET ${base}/progress?student=${SEAT.Bernard}`]: ok(WEEKS),
        [`GET ${base}/progress?student=${SEAT.Cattaneo}`]: ok(WEEKS),
      });
      renderWithProviders(room());
      await user.click(await screen.findByRole("button", { name: "Progression of Ada Bernard" }));
      const sheet = await screen.findByRole("dialog", { name: "Ada Bernard" });
      expect(within(sheet).getByText("Targeted revision")).toBeVisible();
      expect(within(sheet).getByText("3 rounds · 9 of 12 right · last on 2026-10-14")).toBeVisible();
      expect(within(sheet).getByText("Adresse (mémoire)")).toBeVisible();
      expect(within(sheet).getByText("Boucle")).toBeVisible();
      await user.keyboard("{Escape}");

      await user.click(screen.getByRole("button", { name: "Progression of Ada Cattaneo" }));
      const other = await screen.findByRole("dialog", { name: "Ada Cattaneo" });
      expect(within(other).getByText("No targeted revision yet.")).toBeVisible();
    });
  });

  describe("the hours of the week", () => {
    const room = () => <ClassroomDrill room={makeClassroomDetail({ drillEnabled: true })} onSettings={vi.fn()} />;

    it("draws the classroom's grid under the table, distinct students per slot, outside class hours hatched", async () => {
      mockFetch({ [`GET ${base}/activity`]: ok(ROWS), [`GET ${base}/mastery`]: ok(NONE), [`GET ${base}/hours`]: ok(HOURS) });
      renderWithProviders(room());
      expect(await screen.findByRole("heading", { name: "When students practise" })).toBeVisible();
      const grid = await screen.findByRole("table", { name: "When students practise" });
      const wednesday = within(grid).getByTitle("Wed, 09:00–10:00: 4 students");
      expect(wednesday).toHaveTextContent("4");
      expect(wednesday).not.toHaveAttribute("data-off");
      expect(within(grid).getByTitle("Sat, 00:00–01:00: 1 student · outside class hours")).toHaveAttribute("data-off", "true");
      expect(screen.getByText("20% of this practice falls outside class hours.")).toBeVisible();
      expect(screen.getByText(/^Distinct students who reviewed at that hour of the week/)).toHaveTextContent(/since 2026-10-21/);
      expect(screen.getByText(/Outside class hours: Mon–Fri 08:00–18:00/)).toBeVisible();
    });

    it("says no one reviewed in 30 days instead of an empty grid, and offers a retry when it cannot be read", async () => {
      mockFetch({ [`GET ${base}/activity`]: ok(ROWS), [`GET ${base}/mastery`]: ok(NONE), [`GET ${base}/hours`]: ok(hoursOf([])) });
      const first = renderWithProviders(room());
      expect(await screen.findByText("No review in the last 30 days.")).toBeVisible();
      expect(screen.queryByRole("table", { name: "When students practise" })).toBeNull();
      first.unmount();

      mockFetch({ [`GET ${base}/activity`]: ok(ROWS), [`GET ${base}/mastery`]: ok(NONE), [`GET ${base}/hours`]: fail(500) });
      renderWithProviders(room());
      expect(await screen.findByText("Could not load the hours of practice")).toBeVisible();
    });

    it("draws one student's reviews per slot in their sheet", async () => {
      const user = userEvent.setup();
      mockFetch({
        [`GET ${base}/activity`]: ok(ROWS),
        [`GET ${base}/mastery`]: ok(NONE),
        [`GET ${base}/hours`]: ok(HOURS),
        [`GET ${base}/progress?student=${SEAT.Bernard}`]: ok(WEEKS),
        [`GET ${base}/hours?student=${SEAT.Bernard}`]: ok(hoursOf([[2, 9, 2]])),
      });
      renderWithProviders(room());
      await user.click(await screen.findByRole("button", { name: "Progression of Ada Bernard" }));
      const sheet = await screen.findByRole("dialog", { name: "Ada Bernard" });
      expect(await within(sheet).findByText("Hours of practice", { selector: "figcaption" })).toBeVisible();
      const grid = await within(sheet).findByRole("table", { name: "Hours of practice" });
      expect(within(grid).getByTitle("Wed, 09:00–10:00: 2 reviews")).toHaveTextContent("2");
      expect(within(sheet).getByText(/^Reviews made in that hour/)).toBeVisible();
    });
  });
});
