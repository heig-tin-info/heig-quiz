import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import type { EvaluationSummary } from "@quiz/contracts";

import { ClassroomView } from "./ClassroomView";
import { makeClassroomDetail, makeMe, makeRosterEntry } from "./test/fixtures";
import { fail, mockFetch, ok, renderWithProviders } from "./test/render";

/*
 * One classroom: its roster and its evaluations, one tab each. The primary
 * action follows the tab — "Add students" on the roster, which is what
 * unblocks everything, and the evaluation list's own button on the other.
 *
 * The page opens on the tab that holds the work: the evaluations once there
 * are students, the roster while it is empty.
 *
 * The title renames in place, so the classroom name is a button, and both
 * tabs count what they hold.
 */

const ROOM = "/app/api/classrooms/r1";
const EVALUATIONS = `${ROOM}/evaluations`;
const ME = "/app/api/me";
/** The roster tab, whatever the roster holds. */
const ROSTER_TAB = "/classrooms/r1?tab=roster";
/** The classroom name as a control: the accessible name carries it. */
const RENAME = /Rename classroom/;

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
  opensAt: null,
  closesAt: null,
  createdAt: new Date(0).toISOString(),
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
    expect(screen.getByRole("button", { name: /PRG1 — Programmation C/ })).toBeVisible();
    expect(screen.getByText("Rochat")).toBeVisible();
    // The accommodation is a number on the row; its absence is an em dash,
    // never a "0 %" that would read as data.
    expect(screen.getByText("+25%")).toBeVisible();
  });

  it("offers Add students from the empty roster", async () => {
    mockFetch({ [`GET ${ROOM}`]: ok(makeClassroomDetail({ roster: [] })) });
    renderWithProviders(<ClassroomView id="r1" navigate={vi.fn()} />);
    // No tab in the URL and no student: the roster is what blocks everything,
    // so that is the tab the page opens on.
    expect(await screen.findByText("Empty roster")).toBeVisible();
    expect(screen.getAllByRole("button", { name: /Add students/ })).toHaveLength(2);
  });

  it("opens on the evaluations once the classroom has students", async () => {
    mockFetch({
      [`GET ${ROOM}`]: ok(makeClassroomDetail()),
      [`GET ${EVALUATIONS}`]: ok([]),
    });
    renderWithProviders(<ClassroomView id="r1" navigate={vi.fn()} />);
    expect(await screen.findByRole("tab", { name: /Evaluations/ })).toHaveAttribute(
      "aria-selected",
      "true",
    );
    expect(screen.getByRole("tab", { name: /Roster/ })).toHaveTextContent("1");
    // One primary action per screen: the evaluation list carries its own, so
    // the header does not offer "Add students" here.
    expect(screen.queryByRole("button", { name: /Add students/ })).toBeNull();
  });

  it("counts every row of the table on the roster tab, staff seats included", async () => {
    mockFetch({
      [`GET ${ROOM}`]: ok(
        makeClassroomDetail({
          roster: [
            makeRosterEntry({ id: "e1", nom: "Rochat", prenom: "Léa" }),
            // The teacher's own seat: a row of the table like any other, so
            // it belongs to the number the tab promises.
            makeRosterEntry({ id: "e2", nom: "Bressy", prenom: "Pierre", staff: true }),
          ],
        }),
      ),
    });
    renderWithProviders(<ClassroomView id="r1" navigate={vi.fn()} />, { route: ROSTER_TAB });
    expect(await screen.findByText("Bressy")).toBeVisible();
    const rows = within(screen.getByRole("table")).getAllByRole("row").length - 1; // header
    expect(rows).toBe(2);
    expect(screen.getByRole("tab", { name: /Roster/ })).toHaveTextContent("2");
  });

  it("counts the evaluations on their tab", async () => {
    mockFetch({
      [`GET ${ROOM}`]: ok(makeClassroomDetail()),
      [`GET ${EVALUATIONS}`]: ok([summary({ title: "Test 0" }), summary({ title: "Test 1" })]),
    });
    renderWithProviders(<ClassroomView id="r1" navigate={vi.fn()} />, { route: ROSTER_TAB });
    // The roster tab is the one on screen: the count comes from the list's
    // own query, not from the panel being mounted.
    const tab = await screen.findByRole("tab", { name: /Evaluations/ });
    await waitFor(() => expect(tab).toHaveTextContent("2"));
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

  it("keeps only archiving and deletion in the overflow menu", async () => {
    mockFetch({ [`GET ${ROOM}`]: ok(makeClassroomDetail()) });
    renderWithProviders(<ClassroomView id="r1" navigate={vi.fn()} />, { route: ROSTER_TAB });
    await userEvent.click(await screen.findByRole("button", { name: "Actions" }));
    const menu = within(screen.getByRole("menu"));
    const items = menu.getAllByRole("menuitem").map((el) => el.textContent);
    expect(items).toEqual(["Archive", "Delete classroom"]);
    // The two that left it are on the header itself now.
    expect(menu.queryByRole("menuitem", { name: "Join as student" })).toBeNull();
    expect(menu.queryByRole("menuitem", { name: RENAME })).toBeNull();
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

  it("says the seat is already taken instead of offering it again", async () => {
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
    expect(await screen.findByRole("button", { name: "Join as student" })).toBeDisabled();
  });

  describe("renaming in place", () => {
    const detail = () => makeClassroomDetail();

    it("turns the title into a field and saves on Enter", async () => {
      // Stateful, so the refetch that follows the save answers with the new
      // name the way the server would.
      let name = "PRG1-2026";
      const { calls } = mockFetch({
        [`GET ${ROOM}`]: () => ok(makeClassroomDetail({ name })),
        [`PATCH ${ROOM}`]: (call) => {
          name = (call.body as { name: string }).name;
          return ok(makeClassroomDetail({ name }));
        },
      });
      renderWithProviders(<ClassroomView id="r1" navigate={vi.fn()} />, { route: ROSTER_TAB });
      await userEvent.click(await screen.findByRole("button", { name: RENAME }));

      const input = screen.getByRole("textbox", { name: "Name" }) as HTMLInputElement;
      expect(input).toHaveFocus();
      expect(input).toHaveValue("PRG1-2026");
      // Selected, so a new name is one keystroke away.
      expect([input.selectionStart, input.selectionEnd]).toEqual([0, "PRG1-2026".length]);
      await userEvent.clear(input);
      await userEvent.type(input, "PRG1-2027{Enter}");

      expect(
        calls.find((c) => c.method === "PATCH" && c.url === ROOM)?.body,
      ).toEqual({ name: "PRG1-2027" });
      // The field is gone at once and already shows what was typed.
      expect(screen.queryByRole("textbox", { name: "Name" })).toBeNull();
      expect(await screen.findByRole("heading", { name: /PRG1-2027/ })).toBeVisible();
    });

    it("saves when the field loses the focus", async () => {
      const { calls } = mockFetch({
        [`GET ${ROOM}`]: ok(detail()),
        [`PATCH ${ROOM}`]: ok(makeClassroomDetail({ name: "PRG1-2027" })),
      });
      renderWithProviders(<ClassroomView id="r1" navigate={vi.fn()} />, { route: ROSTER_TAB });
      await userEvent.click(await screen.findByRole("button", { name: RENAME }));
      const input = screen.getByRole("textbox", { name: "Name" });
      await userEvent.clear(input);
      await userEvent.type(input, "PRG1-2027");
      await userEvent.tab();

      expect(calls.some((c) => c.method === "PATCH" && c.url === ROOM)).toBe(true);
    });

    it("cancels on Escape", async () => {
      const { calls } = mockFetch({ [`GET ${ROOM}`]: ok(detail()) });
      renderWithProviders(<ClassroomView id="r1" navigate={vi.fn()} />, { route: ROSTER_TAB });
      await userEvent.click(await screen.findByRole("button", { name: RENAME }));
      await userEvent.type(screen.getByRole("textbox", { name: "Name" }), "nonsense{Escape}");

      expect(calls.some((c) => c.method === "PATCH")).toBe(false);
      expect(screen.getByRole("heading", { name: /PRG1-2026/ })).toBeVisible();
      // And the next edit starts from the stored name, not from the abandoned
      // one.
      await userEvent.click(screen.getByRole("button", { name: RENAME }));
      expect(screen.getByRole("textbox", { name: "Name" })).toHaveValue("PRG1-2026");
    });

    it("refuses to save an empty name", async () => {
      const { calls } = mockFetch({ [`GET ${ROOM}`]: ok(detail()) });
      renderWithProviders(<ClassroomView id="r1" navigate={vi.fn()} />, { route: ROSTER_TAB });
      await userEvent.click(await screen.findByRole("button", { name: RENAME }));
      const input = screen.getByRole("textbox", { name: "Name" });
      await userEvent.clear(input);
      await userEvent.type(input, "   {Enter}");

      expect(calls.some((c) => c.method === "PATCH")).toBe(false);
      expect(screen.getByRole("heading", { name: /PRG1-2026/ })).toBeVisible();
    });

    it("reports a failed rename in a toast", async () => {
      mockFetch({
        [`GET ${ROOM}`]: ok(detail()),
        [`PATCH ${ROOM}`]: fail(500, {}),
      });
      renderWithProviders(<ClassroomView id="r1" navigate={vi.fn()} />, { route: ROSTER_TAB });
      await userEvent.click(await screen.findByRole("button", { name: RENAME }));
      const input = screen.getByRole("textbox", { name: "Name" });
      await userEvent.clear(input);
      await userEvent.type(input, "PRG1-2027{Enter}");

      expect(await screen.findByText(/Could not rename this classroom/)).toBeVisible();
    });
  });

  it("says so when the classroom cannot be read", async () => {
    mockFetch({ [`GET ${ROOM}`]: fail(404, { message: "not found" }) });
    renderWithProviders(<ClassroomView id="r1" navigate={vi.fn()} />);
    expect(
      await screen.findByText(/does not exist, or you do not have access/),
    ).toBeVisible();
  });
});
