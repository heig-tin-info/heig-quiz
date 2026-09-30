import { screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { DrillProgress, DrillStudentActivity, DrillTagMastery } from "@quiz/contracts";

import { makeClassroomDetail } from "../test/fixtures";
import { fail, mockFetch, ok, renderWithProviders } from "../test/render";
import { ClassroomDrill } from "./ClassroomDrill";

/*
 * The teacher's view of a classroom's drill (ADR-041 §8, #317 slice 4):
 * the empty states (drill off; on with nothing yet), the table of students
 * — sortable, the opt-out as a badge with its date, the recall rate with
 * its trend — the per-student progression in a sheet, and the mastery per
 * tag.
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

const MASTERY: DrillTagMastery[] = [
  { tag: "pointeurs", cards: 40, students: 12, retrievability: 0.58 },
  { tag: null, cards: 5, students: 3, retrievability: 0.8 },
];

const base = "/app/api/classrooms/r1/drill";

describe("the classroom's Drill tab", () => {
  it("says the drill is off, above the switch that turns it on", async () => {
    mockFetch({ [`GET ${base}/activity`]: ok([row({ nom: "Cattaneo" })]) });
    renderWithProviders(<ClassroomDrill room={makeClassroomDetail()} />);
    expect(await screen.findByText("The drill is off for this classroom")).toBeVisible();
    expect(screen.getByRole("switch", { name: "Drill" })).toHaveAttribute("aria-checked", "false");
    expect(screen.queryByRole("table")).toBeNull();
  });

  it("says nothing happened yet when the drill is on and no one practised", async () => {
    mockFetch({ [`GET ${base}/activity`]: ok([row({ nom: "Cattaneo" })]) });
    renderWithProviders(<ClassroomDrill room={makeClassroomDetail({ drillEnabled: true })} />);
    expect(await screen.findByText("No drill activity yet")).toBeVisible();
    expect(screen.queryByRole("table")).toBeNull();
  });

  it("offers a retry when the activity cannot be read", async () => {
    mockFetch({ [`GET ${base}/activity`]: fail(500) });
    renderWithProviders(<ClassroomDrill room={makeClassroomDetail({ drillEnabled: true })} />);
    expect(await screen.findByText("Could not load the drill activity")).toBeVisible();
  });

  it("lists the students by name, with the recall rate, its trend and the opt-out's date", async () => {
    mockFetch({ [`GET ${base}/activity`]: ok(ROWS), [`GET ${base}/mastery`]: ok(MASTERY) });
    renderWithProviders(<ClassroomDrill room={makeClassroomDetail({ drillEnabled: true })} />);
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
    renderWithProviders(<ClassroomDrill room={makeClassroomDetail({ drillEnabled: true })} />);
    const table = await screen.findByRole("table");
    const names = () => within(table).getAllByRole("button", { name: /^Progression of/ }).map((b) => b.textContent);

    await user.click(within(table).getByRole("button", { name: "Recall, 30 days" }));
    expect(names()).toEqual(["Cattaneo Ada", "Alder Ada", "Bernard Ada"]);
    await user.click(within(table).getByRole("button", { name: "Recall, 30 days" }));
    expect(names()).toEqual(["Bernard Ada", "Alder Ada", "Cattaneo Ada"]);
  });

  it("shows the mastery per tag, weakest first, the untagged questions named as such", async () => {
    mockFetch({ [`GET ${base}/activity`]: ok(ROWS), [`GET ${base}/mastery`]: ok(MASTERY) });
    renderWithProviders(<ClassroomDrill room={makeClassroomDetail({ drillEnabled: true })} />);
    expect(await screen.findByRole("heading", { name: "Mastery per tag" })).toBeVisible();
    expect(screen.getByText("pointeurs")).toBeVisible();
    expect(screen.getByText("58%")).toBeVisible();
    expect(screen.getByText("Without a tag")).toBeVisible();
    expect(screen.getByText("40 cards · 12 students")).toBeVisible();
  });

  it("opens a student's weekly progression in a sheet, with the opt-out said", async () => {
    const user = userEvent.setup();
    const { calls } = mockFetch({
      [`GET ${base}/activity`]: ok(ROWS),
      [`GET ${base}/mastery`]: ok(MASTERY),
      [`GET ${base}/progress?student=${SEAT.Alder}`]: ok(WEEKS),
    });
    renderWithProviders(<ClassroomDrill room={makeClassroomDetail({ drillEnabled: true })} />);
    await user.click(await screen.findByRole("button", { name: "Progression of Ada Alder" }));

    const sheet = await screen.findByRole("dialog", { name: "Ada Alder" });
    expect(within(sheet).getByText(/Opted out of the drill on 2026-10-20/)).toBeVisible();
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
      [`GET ${base}/mastery`]: ok([]),
      [`GET ${base}/progress?student=${SEAT.Cattaneo}`]: ok({ weeks: WEEKS.weeks.map((w) => ({ ...w, reviews: 0, recall: none })) }),
    });
    renderWithProviders(<ClassroomDrill room={makeClassroomDetail({ drillEnabled: true })} />);
    await user.click(await screen.findByRole("button", { name: "Progression of Ada Cattaneo" }));
    const sheet = await screen.findByRole("dialog", { name: "Ada Cattaneo" });
    expect(await within(sheet).findByText("No review over this period.")).toBeVisible();
    // No mastery yet: no section for it.
    expect(screen.queryByRole("heading", { name: "Mastery per tag" })).toBeNull();
  });
});
