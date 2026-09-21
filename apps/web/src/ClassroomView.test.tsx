import { screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

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
 */

const ROOM = "/app/api/classrooms/r1";
const EVALUATIONS = `${ROOM}/evaluations`;
const ME = "/app/api/me";
/** The roster tab, whatever the roster holds. */
const ROSTER_TAB = "/classrooms/r1?tab=roster";

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
    // The roster tab counts the students, and only the students.
    expect(screen.getByRole("tab", { name: /Roster/ })).toHaveTextContent("1");
    // One primary action per screen: the evaluation list carries its own, so
    // the header does not offer "Add students" here.
    expect(screen.queryByRole("button", { name: /Add students/ })).toBeNull();
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

  it("keeps the secondary actions in the overflow menu, deletion last and dangerous", async () => {
    mockFetch({ [`GET ${ROOM}`]: ok(makeClassroomDetail()) });
    renderWithProviders(<ClassroomView id="r1" navigate={vi.fn()} />, { route: ROSTER_TAB });
    await userEvent.click(await screen.findByRole("button", { name: "Actions" }));
    const menu = within(screen.getByRole("menu"));
    expect(menu.getByRole("menuitem", { name: "Join as student" })).toBeVisible();
    expect(menu.getByRole("menuitem", { name: "Rename" })).toBeVisible();
    expect(menu.getByRole("menuitem", { name: "Archive" })).toBeVisible();
    expect(menu.getByRole("menuitem", { name: "Delete classroom" })).toBeVisible();
  });

  it("takes a seat in the classroom from the overflow menu", async () => {
    const { calls } = mockFetch({
      [`GET ${ME}`]: ok(makeMe()),
      [`GET ${ROOM}`]: ok(makeClassroomDetail()),
      [`POST ${ROOM}/self-enroll`]: ok({ ok: true }),
    });
    renderWithProviders(<ClassroomView id="r1" navigate={vi.fn()} />, { route: ROSTER_TAB });
    await userEvent.click(await screen.findByRole("button", { name: "Actions" }));
    await userEvent.click(screen.getByRole("menuitem", { name: "Join as student" }));
    expect(calls.some((c) => c.method === "POST" && c.url === `${ROOM}/self-enroll`)).toBe(true);
    // The menu is closed by then, so the report is a toast.
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
    await userEvent.click(await screen.findByRole("button", { name: "Actions" }));
    const item = screen.getByRole("menuitem", { name: "You have a seat in this classroom" });
    expect(item).toHaveAttribute("aria-disabled", "true");
  });

  it("says so when the classroom cannot be read", async () => {
    mockFetch({ [`GET ${ROOM}`]: fail(404, { message: "not found" }) });
    renderWithProviders(<ClassroomView id="r1" navigate={vi.fn()} />);
    expect(
      await screen.findByText(/does not exist, or you do not have access/),
    ).toBeVisible();
  });
});
