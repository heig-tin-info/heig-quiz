import { screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import { makeSummary, ROOM_ID, SET_ID } from "../test/group-fixtures";
import { fail, mockFetch, ok, renderWithProviders } from "../test/render";
import { GroupSetList } from "./GroupSetList";

/*
 * The classroom's Groups tab (ADR-070, M3-16a): empty with its one action,
 * the sets with their counts and the projects that name them, a failure
 * with a retry, a row that opens its set.
 */

const LIST = `GET /app/api/classrooms/${ROOM_ID}/group-sets`;

function renderList(readOnly = false) {
  const navigate = vi.fn();
  const onNew = vi.fn();
  renderWithProviders(
    <GroupSetList classroomId={ROOM_ID} navigate={navigate} onNew={onNew} creating={false} readOnly={readOnly} />,
  );
  return { navigate, onNew };
}

describe("the Groups tab", () => {
  it("offers New group set when the classroom has none", async () => {
    mockFetch({ [LIST]: ok([]) });
    const { onNew } = renderList();
    expect(await screen.findByText("No group set yet")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "New group set" }));
    expect(onNew).toHaveBeenCalled();
  });

  it("offers nothing to create on an archived classroom", async () => {
    mockFetch({ [LIST]: ok([]) });
    renderList(true);
    await screen.findByText("No group set yet");
    expect(screen.queryByRole("button", { name: "New group set" })).toBeNull();
  });

  it("lists the sets with their counts and the projects that follow them; a row opens its set", async () => {
    mockFetch({
      [LIST]: ok([
        makeSummary({
          usedBy: [
            { id: "p-1", name: "Labo 4", archived: false, follows: true },
            { id: "p-2", name: "Labo 1", archived: false, follows: false },
          ],
        }),
      ]),
    });
    const { navigate } = renderList();
    expect(await screen.findByText("Projet final")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Labo 4" })).toBeInTheDocument();
    expect(screen.getByText("stopped following")).toBeInTheDocument();
    await userEvent.click(screen.getByText("Projet final"));
    expect(navigate).toHaveBeenCalledWith({ view: "groupSet", classroomId: ROOM_ID, id: SET_ID });
    // A project's link opens the project, not the row's set.
    navigate.mockClear();
    await userEvent.click(screen.getByRole("link", { name: "Labo 4" }));
    expect(navigate).toHaveBeenCalledWith({ view: "project", id: "p-1" });
    expect(navigate).toHaveBeenCalledTimes(1);
  });

  it("says a failure, with a retry", async () => {
    mockFetch({ [LIST]: fail(500, { message: "boom" }) });
    renderList();
    expect(await screen.findByText("The group sets could not be loaded.")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Retry/ })).toBeInTheDocument();
  });
});
