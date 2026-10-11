import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { EvaluationSummary, JournalStaff } from "@quiz/contracts";

import { ClassroomView } from "./ClassroomView";
import { makeClassroomDetail, makeMe, makeRosterEntry } from "./test/fixtures";
import { fail, mockFetch, ok, renderWithProviders } from "./test/render";

/*
 * One classroom: its roster and its evaluations, one tab each. The primary
 * action follows the tab, in the same slot of the header — "Add students" on
 * the roster, which is what unblocks everything, and "New evaluation" on
 * the evaluations (#295).
 *
 * The page opens on the evaluations, whatever the roster holds: the sidebar
 * and the course page land there, the roster is one click away.
 *
 * The header keeps the name and the period; renaming, archiving and
 * deleting moved to the Settings tab (D24, `ClassroomSettings.test.tsx`).
 * Both lists count what they hold.
 */

const ROOM = "/app/api/classrooms/r1";
const EVALUATIONS = `${ROOM}/evaluations`;
const ME = "/app/api/me";
/** The roster tab, whatever the roster holds. */
const ROSTER_TAB = "/classrooms/r1?tab=roster";
const TRAINING = "/app/api/training";
const LIVE_QUIZ_ID = "11111111-1111-4111-8111-111111111105";

/** The training status (ADR-105) naming `r1` as the training classroom and its live quiz, missions as given. */
const trainingStatus = (
  states: Partial<Record<"student" | "run" | "own" | "tools", "todo" | "done" | "unavailable">> = {},
  liveEvaluationId: string | null = LIVE_QUIZ_ID,
) => ({
  installed: true,
  course: { id: "c1", classroomId: "r1", liveEvaluationId },
  missions: (["student", "run", "own", "tools"] as const).map((key) => ({ key, state: states[key] ?? "todo" })),
});
/** The staff seat of the test's teacher (`makeMe().id`). */
const MY_SEAT = makeClassroomDetail({ roster: [makeRosterEntry({ id: "e-me", userId: "u-1", staff: true })] });
/** The classes of a button, for the one accent of a screen. */
const classesOf = (button: HTMLElement) => button.className.split(" ");

/** The Activities tab of `r1` with the training's two quizzes among its evaluations. */
const trainingRoutes = (status: ReturnType<typeof trainingStatus>, detail = makeClassroomDetail()) => ({
  [`GET ${ROOM}`]: ok(detail),
  [`GET ${ME}`]: ok(makeMe()),
  [`GET ${TRAINING}`]: ok(status),
  [`GET ${EVALUATIONS}`]: ok([
    summary({ title: "Le quiz d'accueil", mode: "exercise", state: "scheduled" }),
    summary({ id: LIVE_QUIZ_ID, title: "Le quiz en direct" }),
  ]),
});

/** Only the number of these matters here; the list has its own tests. */
const summary = (over: Partial<EvaluationSummary>): EvaluationSummary => ({
  id: "11111111-1111-4111-8111-111111111111",
  classroomId: "r1",
  title: "Quiz 3",
  mode: "exam",
  state: "draft",
  itemCount: 4,
  totalPoints: 7,
  attemptCount: 0,
  deletionRole: "assistant",
  opensAt: null,
  closesAt: null,
  createdAt: new Date(0).toISOString(),
  originRevision: null,
  templateRevision: null,
  ...over,
});

describe("ClassroomView", () => {
  it("shows the course it belongs to, the roster and the extra time", async () => {
    mockFetch({
      [`GET ${ROOM}`]: ok(
        makeClassroomDetail({
          roster: [
            makeRosterEntry({ id: "e1", nom: "Rochat", prenom: "Léa", timeBonusPercent: 25 }),
            makeRosterEntry({ id: "e2", nom: "Bovet", prenom: "Noah", email: "n.b@heig-vd.ch" }),
          ],
        }),
      ),
    });
    renderWithProviders(<ClassroomView id="r1" navigate={vi.fn()} />, { route: ROSTER_TAB });

    expect(await screen.findByRole("heading", { name: /PRG1-2026/ })).toBeVisible();
    // The trail: Courses, the course by its code, the classroom as the current page.
    const trail = screen.getByRole("navigation", { name: "Breadcrumb" });
    expect(within(trail).getByRole("link", { name: "Courses" })).toHaveAttribute("href", "/");
    expect(within(trail).getByRole("link", { name: "PRG1" })).toHaveAttribute("href", "/courses/c1");
    expect(within(trail).getByText("PRG1-2026")).toHaveAttribute("aria-current", "page");
    expect(screen.getByText("Rochat")).toBeVisible();
    // The accommodation is a number on the row; its absence is an em dash,
    // never a "0 %" that would read as data.
    expect(screen.getByText("+25%")).toBeVisible();
  });

  it("offers Add students from the empty roster", async () => {
    mockFetch({ [`GET ${ROOM}`]: ok(makeClassroomDetail({ roster: [] })) });
    renderWithProviders(<ClassroomView id="r1" navigate={vi.fn()} />, { route: ROSTER_TAB });
    expect(await screen.findByText("Empty roster")).toBeVisible();
    expect(screen.getAllByRole("button", { name: /Add students/ })).toHaveLength(2);
  });

  it("opens on the evaluations while the roster is still empty", async () => {
    mockFetch({
      [`GET ${ROOM}`]: ok(makeClassroomDetail({ roster: [] })),
      [`GET ${EVALUATIONS}`]: ok([]),
    });
    renderWithProviders(<ClassroomView id="r1" navigate={vi.fn()} />);
    expect(await screen.findByRole("tab", { name: /Activities/ })).toHaveAttribute(
      "aria-selected",
      "true",
    );
    expect(screen.queryByText("Empty roster")).toBeNull();
  });

  it("opens on the evaluations once the classroom has students", async () => {
    mockFetch({
      [`GET ${ROOM}`]: ok(makeClassroomDetail()),
      [`GET ${EVALUATIONS}`]: ok([]),
    });
    renderWithProviders(<ClassroomView id="r1" navigate={vi.fn()} />);
    expect(await screen.findByRole("tab", { name: /Activities/ })).toHaveAttribute(
      "aria-selected",
      "true",
    );
    expect(screen.getByRole("tab", { name: /Roster/ })).toHaveTextContent("1");
    // One primary action per tab, in the header's slot: "New evaluation"
    // here, never "Add students" beside it.
    expect(screen.queryByRole("button", { name: /Add students/ })).toBeNull();
  });

  it("creates an evaluation from the header and opens its configuration (#295)", async () => {
    const navigate = vi.fn();
    const { calls } = mockFetch({
      [`GET ${ROOM}`]: ok(makeClassroomDetail()),
      [`GET ${EVALUATIONS}`]: ok([summary({ title: "Test 0" })]),
      [`GET /app/api/courses/c1/templates`]: ok([]),
      [`POST ${EVALUATIONS}`]: ok(summary({ id: "e9" })),
    });
    renderWithProviders(<ClassroomView id="r1" navigate={navigate} />);
    await screen.findByText("Test 0");
    // The list has rows, so the header's button is the only one: the plain
    // one, on a platform without Quiz's App (the GitHub read answers 404;
    // "New ▾" and its Project are `activities/NewActivity.test.tsx`).
    const buttons = await waitFor(() => {
      const found = screen.getAllByRole("button", { name: /New evaluation/ });
      expect(found).toHaveLength(1);
      return found;
    });
    expect(buttons[0]!.className).toMatch(/bg-accent/);
    await userEvent.click(buttons[0]!);

    const dialog = await screen.findByRole("dialog", { name: "New evaluation" });
    await userEvent.type(within(dialog).getByLabelText(/Title/), "Quiz 5");
    await userEvent.click(within(dialog).getByRole("button", { name: /Create evaluation/ }));
    await waitFor(() => expect(navigate).toHaveBeenCalledWith({ view: "evaluation", id: "e9" }));
    expect(calls.find((c) => c.method === "POST")?.body).toMatchObject({ title: "Quiz 5" });
  });

  it("opens the period dialog from the period beside the title (#295)", async () => {
    mockFetch({ [`GET ${ROOM}`]: ok(makeClassroomDetail()) });
    renderWithProviders(<ClassroomView id="r1" navigate={vi.fn()} />, { route: ROSTER_TAB });
    await userEvent.click(await screen.findByRole("button", { name: "Change period: 2026-A" }));
    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).getByRole("textbox", { name: "Period label" })).toHaveValue("2026-A");
  });

  it("names a dated period left without a label by its months", async () => {
    mockFetch({
      [`GET ${ROOM}`]: ok(
        makeClassroomDetail({ period: "", periodStart: "2026-09", periodEnd: "2027-01" }),
      ),
    });
    renderWithProviders(<ClassroomView id="r1" navigate={vi.fn()} />, { route: ROSTER_TAB });
    expect(
      await screen.findByRole("button", { name: "Change period: 2026-09 – 2027-01" }),
    ).toHaveTextContent("2026-09 – 2027-01");
  });

  it("offers a quiet Set period when there is none", async () => {
    mockFetch({ [`GET ${ROOM}`]: ok(makeClassroomDetail({ period: "" })) });
    renderWithProviders(<ClassroomView id="r1" navigate={vi.fn()} />, { route: ROSTER_TAB });
    await userEvent.click(await screen.findByRole("button", { name: "Set period" }));
    expect(await screen.findByRole("dialog")).toBeVisible();
  });

  it("puts the page help in the action row", async () => {
    mockFetch({ [`GET ${ROOM}`]: ok(makeClassroomDetail()) });
    renderWithProviders(<ClassroomView id="r1" navigate={vi.fn()} />, { route: ROSTER_TAB });
    const heading = await screen.findByRole("heading", { level: 1 });
    expect(within(heading).queryByRole("button", { name: "Help" })).toBeNull();
    expect(screen.getByRole("button", { name: "Help" })).toHaveAttribute("data-coach", "page.help");
  });

  it("counts every row of the table on the roster tab, staff seats included", async () => {
    mockFetch({
      [`GET ${ROOM}`]: ok(
        makeClassroomDetail({
          roster: [
            makeRosterEntry({ id: "e1", nom: "Rochat", prenom: "Léa" }),
            // The teacher's own seat: a row of the table like any other, so
            // it belongs to the number the tab promises.
            makeRosterEntry({ id: "e2", nom: "Dupuis", prenom: "Alex", staff: true }),
          ],
        }),
      ),
    });
    renderWithProviders(<ClassroomView id="r1" navigate={vi.fn()} />, { route: ROSTER_TAB });
    expect(await screen.findByText("Dupuis")).toBeVisible();
    const rows = within(screen.getByRole("table")).getAllByRole("row").length - 1; // header
    expect(rows).toBe(2);
    expect(screen.getByRole("tab", { name: /Roster/ })).toHaveTextContent("2");
  });

  it("names the tab Activities, with no count, and counts the evaluations under their heading", async () => {
    mockFetch({
      [`GET ${ROOM}`]: ok(makeClassroomDetail()),
      [`GET ${EVALUATIONS}`]: ok([summary({ title: "Test 0" }), summary({ title: "Test 1" })]),
    });
    renderWithProviders(<ClassroomView id="r1" navigate={vi.fn()} />);
    const tab = await screen.findByRole("tab", { name: /Activities/ });
    expect(tab).toHaveTextContent(/^Activities$/);
    expect(await screen.findByRole("heading", { name: /Evaluations/ })).toBeVisible();
    expect(await screen.findByText("Test 1")).toBeVisible();
    expect(screen.getByRole("region", { name: /Evaluations/ })).toHaveTextContent(/Evaluations\s*2/);
  });

  it("keeps the Evaluations heading above the empty state", async () => {
    mockFetch({ [`GET ${ROOM}`]: ok(makeClassroomDetail()), [`GET ${EVALUATIONS}`]: ok([]) });
    renderWithProviders(<ClassroomView id="r1" navigate={vi.fn()} />);
    await screen.findByRole("tab", { name: /Activities/ });
    await screen.findByText("No evaluation yet");
    expect(screen.getByRole("heading", { name: /Evaluations/ })).toBeVisible();
  });

  it("moves between the two tabs and writes the choice to the URL", async () => {
    mockFetch({
      [`GET ${ROOM}`]: ok(makeClassroomDetail()),
      [`GET ${EVALUATIONS}`]: ok([]),
    });
    renderWithProviders(<ClassroomView id="r1" navigate={vi.fn()} />);
    await userEvent.click(await screen.findByRole("tab", { name: /Roster/ }));
    expect(new URLSearchParams(window.location.search).get("tab")).toBe("roster");
    expect(screen.getByText("Rochat")).toBeVisible();
    expect(screen.getByRole("button", { name: /Add students/ })).toBeVisible();
  });

  it("opens the import sheet", async () => {
    mockFetch({ [`GET ${ROOM}`]: ok(makeClassroomDetail()) });
    renderWithProviders(<ClassroomView id="r1" navigate={vi.fn()} />, { route: ROSTER_TAB });
    await userEvent.click((await screen.findAllByRole("button", { name: /Add students/ }))[0]!);
    expect(await screen.findByRole("dialog")).toHaveAccessibleName("Add students");
  });

  it("keeps the name and the period in the header, and no overflow menu (D24)", async () => {
    mockFetch({ [`GET ${ROOM}`]: ok(makeClassroomDetail()) });
    renderWithProviders(<ClassroomView id="r1" navigate={vi.fn()} />, { route: ROSTER_TAB });
    const heading = await screen.findByRole("heading", { level: 1 });
    expect(heading).toHaveTextContent("PRG1-2026");
    expect(within(heading).queryByRole("button", { name: /Rename/ })).toBeNull();
    expect(screen.queryByRole("button", { name: "Actions" })).toBeNull();
  });

  it("edits the period from the period beside the title", async () => {
    const { calls } = mockFetch({
      [`GET ${ROOM}`]: ok(makeClassroomDetail()),
      [`PATCH ${ROOM}`]: ok(makeClassroomDetail({ period: "2027-P" })),
    });
    renderWithProviders(<ClassroomView id="r1" navigate={vi.fn()} />, { route: ROSTER_TAB });
    await userEvent.click(await screen.findByRole("button", { name: /^Change period/ }));

    const dialog = await screen.findByRole("dialog");
    const field = within(dialog).getByRole("textbox", { name: "Period label" });
    expect(field).toHaveValue("2026-A");
    await userEvent.clear(field);
    await userEvent.type(field, "2027-P");
    await userEvent.click(within(dialog).getByRole("button", { name: "Save" }));

    // The months travel with the label, both null for an undated classroom.
    expect(calls.find((c) => c.method === "PATCH" && c.url === ROOM)?.body).toEqual({
      period: "2027-P",
      periodStart: null,
      periodEnd: null,
    });
  });

  describe("the period dates (#156)", () => {
    afterEach(() => vi.useRealTimers());

    it("dates a classroom from a preset, keeping a label the teacher typed", async () => {
      vi.useFakeTimers({ toFake: ["Date"] });
      vi.setSystemTime(new Date(2026, 8, 27));
      const { calls } = mockFetch({
        [`GET ${ROOM}`]: ok(makeClassroomDetail()),
        [`PATCH ${ROOM}`]: ok(makeClassroomDetail()),
      });
      renderWithProviders(<ClassroomView id="r1" navigate={vi.fn()} />, { route: ROSTER_TAB });
      await userEvent.click(await screen.findByRole("button", { name: /^Change period/ }));
      const dialog = await screen.findByRole("dialog");

      // Undated: "No dates" is the pressed chip; the presets are the current
      // semester and the next one.
      expect(within(dialog).getByRole("button", { name: "No dates" })).toHaveAttribute(
        "aria-pressed",
        "true",
      );
      await userEvent.click(within(dialog).getByRole("button", { name: "Spring 2027" }));
      expect(within(dialog).getByLabelText("First month")).toHaveValue("2027-02");
      expect(within(dialog).getByLabelText("Last month")).toHaveValue("2027-07");
      expect(within(dialog).getByRole("textbox", { name: "Period label" })).toHaveValue("2026-A");
      await userEvent.click(within(dialog).getByRole("button", { name: "Save" }));

      expect(calls.find((c) => c.method === "PATCH" && c.url === ROOM)?.body).toEqual({
        period: "2026-A",
        periodStart: "2027-02",
        periodEnd: "2027-07",
      });
    });

    it("lets a preset replace the label another preset wrote, and refuses half a period", async () => {
      vi.useFakeTimers({ toFake: ["Date"] });
      vi.setSystemTime(new Date(2026, 8, 27));
      mockFetch({
        [`GET ${ROOM}`]: ok(
          makeClassroomDetail({ period: "Autumn 2026", periodStart: "2026-09", periodEnd: "2027-01" }),
        ),
      });
      renderWithProviders(<ClassroomView id="r1" navigate={vi.fn()} />, { route: ROSTER_TAB });
      await userEvent.click(await screen.findByRole("button", { name: /^Change period/ }));
      const dialog = await screen.findByRole("dialog");
      const label = within(dialog).getByRole("textbox", { name: "Period label" });

      expect(within(dialog).getByRole("button", { name: "Autumn 2026" })).toHaveAttribute(
        "aria-pressed",
        "true",
      );
      await userEvent.click(within(dialog).getByRole("button", { name: "Spring 2027" }));
      expect(label).toHaveValue("Spring 2027");

      await userEvent.clear(within(dialog).getByLabelText("Last month"));
      expect(within(dialog).getByText(/Give both months/)).toBeInTheDocument();
      expect(within(dialog).getByRole("button", { name: "Save" })).toBeDisabled();
    });
  });

  it("takes a seat in the classroom from a button beside Add students", async () => {
    const { calls } = mockFetch({
      [`GET ${ME}`]: ok(makeMe()),
      [`GET ${ROOM}`]: ok(makeClassroomDetail()),
      [`POST ${ROOM}/self-enroll`]: ok({ ok: true }),
    });
    renderWithProviders(<ClassroomView id="r1" navigate={vi.fn()} />, { route: ROSTER_TAB });
    const join = await screen.findByRole("button", { name: "Join as student" });
    // Secondary, and before the primary in the reading order.
    const add = screen.getAllByRole("button", { name: /Add students/ })[0]!;
    expect(join.compareDocumentPosition(add) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();

    await userEvent.click(join);
    expect(calls.some((c) => c.method === "POST" && c.url === `${ROOM}/self-enroll`)).toBe(true);
    expect(await screen.findByText(/student view/)).toBeVisible();
  });

  it("no longer offers a seat that is already taken", async () => {
    mockFetch({
      [`GET ${ME}`]: ok(makeMe()),
      [`GET ${ROOM}`]: ok(
        makeClassroomDetail({
          roster: [
            makeRosterEntry(),
            makeRosterEntry({
              id: "e-staff",
              nom: "Dupont",
              prenom: "Marie",
              email: "marie.dupont@heig-vd.ch",
              staff: true,
              userId: "u-1",
            }),
          ],
        }),
      ),
    });
    renderWithProviders(<ClassroomView id="r1" navigate={vi.fn()} />, { route: ROSTER_TAB });
    await screen.findAllByRole("button", { name: /Add students/ });
    expect(screen.queryByRole("button", { name: "Join as student" })).toBeNull();
  });

  it("says so when the classroom cannot be read", async () => {
    mockFetch({ [`GET ${ROOM}`]: fail(404, { message: "not found" }) });
    renderWithProviders(<ClassroomView id="r1" navigate={vi.fn()} />);
    expect(
      await screen.findByText(/does not exist, or you do not have access/),
    ).toBeVisible();
  });
});

/*
 * The Journal tab (F-JRN-01, F-JRN-07, M4-05): a route of its own, drawn
 * exactly while the classroom has a journal — never on a platform without
 * Quiz's App, whose journal route answers 404.
 */
describe("ClassroomView — the Journal tab", () => {
  const JOURNAL = `${ROOM}/journal`;
  const journal = (attached: boolean): JournalStaff => ({
    view: "staff",
    mode: attached ? "github" : null,
    repository: attached
      ? {
          fullName: "heig-tin-info/prg1-journal",
          ref: "main",
          rootPath: "",
          htmlUrl: "https://github.com/heig-tin-info/prg1-journal",
          syncStatus: "ok",
          syncError: null,
          lastSyncedAt: "2026-09-30T10:00:00.000Z",
          lastCommitSha: null,
        }
      : null,
    nav: [{ path: "README.md", title: "Accueil", pagePath: "README.md", children: [] }],
    homePath: attached ? "README.md" : null,
    hiddenPaths: [],
    warningCount: 0,
    pageCount: 0,
    proposedName: attached ? null : "prg1-2026-journal",
  });

  it("is a tab while the classroom has a journal, and a route the tab opens", async () => {
    mockFetch({ [`GET ${ROOM}`]: ok(makeClassroomDetail()), [`GET ${JOURNAL}`]: ok(journal(true)) });
    const navigate = vi.fn();
    renderWithProviders(<ClassroomView id="r1" navigate={navigate} />, { route: ROSTER_TAB });
    await userEvent.click(await screen.findByRole("tab", { name: /Journal/ }));
    expect(navigate).toHaveBeenCalledWith({ view: "classroomJournal", id: "r1" });
  });

  it("is no tab while the classroom has none", async () => {
    const { calls } = mockFetch({ [`GET ${ROOM}`]: ok(makeClassroomDetail()), [`GET ${JOURNAL}`]: ok(journal(false)) });
    renderWithProviders(<ClassroomView id="r1" navigate={vi.fn()} />, { route: ROSTER_TAB });
    await screen.findByRole("tab", { name: /Roster/ });
    await waitFor(() => expect(calls.some((c) => c.url === JOURNAL)).toBe(true));
    expect(screen.queryByRole("tab", { name: /Journal/ })).toBeNull();
  });

  it("is no tab on a platform without Quiz's App (the route 404s), and no error either", async () => {
    const { calls } = mockFetch({ [`GET ${ROOM}`]: ok(makeClassroomDetail()), [`GET ${JOURNAL}`]: fail(404, {}) });
    renderWithProviders(<ClassroomView id="r1" navigate={vi.fn()} />, { route: ROSTER_TAB });
    await screen.findByRole("tab", { name: /Roster/ });
    await waitFor(() => expect(calls.some((c) => c.url === JOURNAL)).toBe(true));
    expect(screen.queryByRole("tab", { name: /Journal/ })).toBeNull();
    expect(screen.queryByText(/Could not load the journal/)).toBeNull();
  });

  it("mounts the reader on its route, with no primary in the header", async () => {
    mockFetch({
      [`GET ${ROOM}`]: ok(makeClassroomDetail()),
      [`GET ${JOURNAL}`]: ok(journal(true)),
      [`GET ${JOURNAL}/pages/README.md`]: ok({
        view: "staff",
        path: "README.md",
        title: "Accueil",
        html: "<h1>Accueil</h1><p>Bienvenue.</p>",
        toc: [],
        updatedAt: "2026-09-30T10:00:00.000Z",
        draft: false,
        visibleFrom: null,
        hidden: false,
        markdown: "# Accueil",
        blobSha: "sha",
        warnings: [],
      }),
    });
    renderWithProviders(<ClassroomView id="r1" navigate={vi.fn()} routeTab="journal" journalPath="README.md" />);
    expect(await screen.findByRole("tab", { name: /Journal/ })).toHaveAttribute("aria-selected", "true");
    expect(await screen.findByText("Bienvenue.")).toBeVisible();
    expect(screen.queryByRole("button", { name: /Add students|New evaluation/ })).toBeNull();
  });

  it("sends its address back to the classroom when there is no journal", async () => {
    mockFetch({ [`GET ${ROOM}`]: ok(makeClassroomDetail()), [`GET ${JOURNAL}`]: fail(404, {}) });
    const navigate = vi.fn();
    renderWithProviders(<ClassroomView id="r1" navigate={navigate} routeTab="journal" />);
    await waitFor(() => expect(navigate).toHaveBeenCalledWith({ view: "classroom", id: "r1" }, { replace: true }));
  });
});

describe("the Grades tab (F-GBOOK-01, F-GBOOK-04, M5-04)", () => {
  const BOOK = `${ROOM}/gradebook`;
  const table = { classroomId: "r1", archived: false, meanPublished: false, columns: [], rows: [], classMean: null };

  it("is a route of its own whose one primary is Export CSV, a plain download of the table", async () => {
    mockFetch({ [`GET ${ROOM}`]: ok(makeClassroomDetail()), [`GET ${BOOK}`]: ok(table) });
    renderWithProviders(<ClassroomView id="r1" navigate={vi.fn()} routeTab="grades" />);
    expect(await screen.findByRole("tab", { name: /Grades/ })).toHaveAttribute("aria-selected", "true");
    const exportLink = await screen.findByRole("link", { name: /Export CSV/ });
    expect(exportLink).toHaveAttribute("href", `${BOOK}.csv`);
    expect(exportLink).toHaveAttribute("download");
    expect(exportLink.className).toContain("bg-accent");
    // Neither of the other tabs' primaries.
    expect(screen.queryByRole("button", { name: /Add students|New evaluation|New group set/ })).toBeNull();
    expect(await screen.findByText("Nothing graded yet")).toBeVisible();
  });

  it("opens from the tabs on /classrooms/:id/grades", async () => {
    mockFetch({ [`GET ${ROOM}`]: ok(makeClassroomDetail()), [`GET ${EVALUATIONS}`]: ok([]) });
    const navigate = vi.fn();
    renderWithProviders(<ClassroomView id="r1" navigate={navigate} />);
    await userEvent.click(await screen.findByRole("tab", { name: /Grades/ }));
    expect(navigate).toHaveBeenCalledWith({ view: "classroomGrades", id: "r1" });
  });
});

describe("ClassroomView: the training classroom's card (ADR-105 §4)", () => {
  it("accents the next required mission on the training classroom, and steps New down", async () => {
    mockFetch(trainingRoutes(trainingStatus({ tools: "unavailable" })));
    renderWithProviders(<ClassroomView id="r1" navigate={vi.fn()} />);
    expect(await screen.findByRole("heading", { name: "Your four missions" })).toBeVisible();
    // One button on the card, the next mission's; the three others carry none.
    expect(classesOf(screen.getByRole("button", { name: "Show me the button" }))).toContain("bg-accent");
    expect(screen.queryByRole("button", { name: "Open the live quiz" })).toBeNull();
    await waitFor(() =>
      expect(classesOf(screen.getByRole("button", { name: /New evaluation/ }))).not.toContain("bg-accent"),
    );
    // The fourth mission reads as unavailable, in words.
    expect(screen.getByText("Not available on this server")).toBeVisible();
  });

  it("leads mission 1 to the page's own Join as student, under focus, and never clicks it", async () => {
    const { calls } = mockFetch(trainingRoutes(trainingStatus()));
    renderWithProviders(<ClassroomView id="r1" navigate={vi.fn()} />);
    await userEvent.click(await screen.findByRole("button", { name: "Show me the button" }));
    expect(screen.getByRole("button", { name: /Join as student/ })).toHaveFocus();
    expect(calls.some((c) => c.url.endsWith("/self-enroll"))).toBe(false);
  });

  it("steps the empty list's New evaluation down too, so the tab has exactly one accent (invariant 2)", async () => {
    mockFetch({ ...trainingRoutes(trainingStatus()), [`GET ${EVALUATIONS}`]: ok([]) });
    renderWithProviders(<ClassroomView id="r1" navigate={vi.fn()} />);
    expect(await screen.findByRole("button", { name: "Show me the button" })).toBeVisible();
    await screen.findByText("No evaluation yet");
    await waitFor(() => {
      const accented = screen.getAllByRole("button").filter((b) => classesOf(b).includes("bg-accent"));
      expect(accented.map((b) => b.textContent)).toEqual(["Show me the button"]);
    });
  });

  it("shows no card on another classroom", async () => {
    mockFetch({
      [`GET ${ROOM}`]: ok(makeClassroomDetail()),
      [`GET ${ME}`]: ok(makeMe()),
      [`GET ${EVALUATIONS}`]: ok([]),
      [`GET ${TRAINING}`]: ok({ ...trainingStatus(), course: { id: "c9", classroomId: "r9", liveEvaluationId: null } }),
    });
    renderWithProviders(<ClassroomView id="r1" navigate={vi.fn()} />);
    await screen.findByRole("tab", { name: /Activities/ });
    await waitFor(() => expect(classesOf(screen.getByRole("button", { name: /New evaluation/ }))).toContain("bg-accent"));
    expect(screen.queryByRole("heading", { name: "Your four missions" })).toBeNull();
  });

  it("leads mission 2 to the live quiz the status names, and offers no door once it is deleted", async () => {
    const navigate = vi.fn();
    mockFetch(trainingRoutes(trainingStatus({ student: "done" }), MY_SEAT));
    const first = renderWithProviders(<ClassroomView id="r1" navigate={navigate} />);
    await userEvent.click(await screen.findByRole("button", { name: "Open the live quiz" }));
    expect(navigate).toHaveBeenCalledWith({ view: "evaluation", id: LIVE_QUIZ_ID });
    first.unmount();

    mockFetch(trainingRoutes(trainingStatus({ student: "done" }, null), MY_SEAT));
    renderWithProviders(<ClassroomView id="r1" navigate={vi.fn()} />);
    expect(await screen.findByText("Run a class")).toBeVisible();
    expect(screen.queryByRole("button", { name: "Open the live quiz" })).toBeNull();
    // The row keeps its text; the page keeps its accent, since no button carries it.
    expect(screen.getByText(/Open the live quiz's waiting room/)).toBeVisible();
    await waitFor(() => expect(classesOf(screen.getByRole("button", { name: /New evaluation/ }))).toContain("bg-accent"));
  });

  it("names the account menu's switch once the seat exists, and leaves New its accent", async () => {
    mockFetch(trainingRoutes(trainingStatus(), MY_SEAT));
    renderWithProviders(<ClassroomView id="r1" navigate={vi.fn()} />);
    expect(await screen.findByText(/switch to the student view from your account menu/)).toBeVisible();
    expect(screen.queryByRole("button", { name: "Show me the button" })).toBeNull();
    // A hint in words is no accent: the screen never has zero.
    await waitFor(() => expect(classesOf(screen.getByRole("button", { name: /New evaluation/ }))).toContain("bg-accent"));
  });

  it("says the training is complete once the required missions are done, links the guide, and gives New its accent back", async () => {
    mockFetch(trainingRoutes(trainingStatus({ student: "done", run: "done", own: "done" })));
    renderWithProviders(<ClassroomView id="r1" navigate={vi.fn()} />);
    expect(await screen.findByText(/Training complete/)).toBeVisible();
    expect(screen.getByRole("link", { name: /Read the guide chapter/ })).toHaveAttribute(
      "href",
      "https://heig-tin-info.github.io/heig-quiz/guide/training/",
    );
    // The optional fourth mission keeps its door, secondary: the page's
    // primary is back, and the screen has one accent.
    expect(classesOf(screen.getByRole("button", { name: "Open Settings" }))).not.toContain("bg-accent");
    await waitFor(() => expect(classesOf(screen.getByRole("button", { name: /New evaluation/ }))).toContain("bg-accent"));
  });
});
