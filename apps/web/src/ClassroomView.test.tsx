import { screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import { ClassroomView } from "./ClassroomView";
import { makeClassroomDetail, makeRosterEntry } from "./test/fixtures";
import { fail, mockFetch, ok, renderWithProviders } from "./test/render";

/*
 * One classroom: its roster. The ONE primary action is "Add students", and
 * an empty roster must offer it rather than leave the page blank.
 */

const ROOM = "/app/api/classrooms/r1";

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
    renderWithProviders(<ClassroomView id="r1" navigate={vi.fn()} />);

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
    expect(await screen.findByText("Empty roster")).toBeVisible();
    expect(screen.getAllByRole("button", { name: /Add students/ })).toHaveLength(2);
  });

  it("opens the import sheet", async () => {
    mockFetch({ [`GET ${ROOM}`]: ok(makeClassroomDetail()) });
    renderWithProviders(<ClassroomView id="r1" navigate={vi.fn()} />);
    await userEvent.click((await screen.findAllByRole("button", { name: /Add students/ }))[0]!);
    expect(await screen.findByRole("dialog")).toHaveAccessibleName("Add students");
  });

  it("keeps the secondary actions in the overflow menu, deletion last and dangerous", async () => {
    mockFetch({ [`GET ${ROOM}`]: ok(makeClassroomDetail()) });
    renderWithProviders(<ClassroomView id="r1" navigate={vi.fn()} />);
    await userEvent.click(await screen.findByRole("button", { name: "Actions" }));
    const menu = within(screen.getByRole("menu"));
    expect(menu.getByRole("menuitem", { name: "Rename" })).toBeVisible();
    expect(menu.getByRole("menuitem", { name: "Archive" })).toBeVisible();
    expect(menu.getByRole("menuitem", { name: "Delete classroom" })).toBeVisible();
  });

  it("says so when the classroom cannot be read", async () => {
    mockFetch({ [`GET ${ROOM}`]: fail(404, { message: "not found" }) });
    renderWithProviders(<ClassroomView id="r1" navigate={vi.fn()} />);
    expect(
      await screen.findByText(/does not exist, or you do not have access/),
    ).toBeVisible();
  });
});
