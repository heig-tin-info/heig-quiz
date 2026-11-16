import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";

import { fail, mockFetch, ok, renderWithProviders } from "../test/render";
import { CourseComponents } from "./CourseComponents";

/*
 * The components of the mean of a course (F-GBOOK-07, ADR-131), a section of
 * its Settings tab: what a component is for when there is none; the list,
 * each with its weight; the owner's Add, Edit and Delete — Delete only for a
 * component no column is in, which says why — and the three questions asked
 * before a write that moves every classroom's means: the first component, a
 * new weight, a deletion. A rename asks nothing. An assistant reads the list
 * with no control at all.
 */

const COURSE = "0190d3c4-0000-7000-8000-0000000000b1";
const COURS = "0190d3c4-0000-7000-8000-0000000000d1";
const LABO = "0190d3c4-0000-7000-8000-0000000000d2";
const URL_LIST = `/app/api/courses/${COURSE}/gradebook/components`;

const cours = { id: COURS, name: "Cours", weight: 50, inUse: true };
const labo = { id: LABO, name: "Labo", weight: 50, inUse: false };

type Reply = ReturnType<typeof ok>;

/** The section on `list`; a write that succeeds answers the list the next GET reads, as the server's does. */
function renderSection(list: unknown[], canManage = true, extra: Record<string, Reply> = {}) {
  let current = list;
  const answered = Object.fromEntries(
    Object.entries(extra).map(([route, reply]) => [
      route,
      () => {
        if (reply.status === 200) current = reply.body as unknown[];
        return reply;
      },
    ]),
  );
  const fetched = mockFetch({ [`GET ${URL_LIST}`]: () => ok(current), ...answered });
  renderWithProviders(<CourseComponents courseId={COURSE} canManage={canManage} />);
  return fetched;
}

const writes = <T extends { method: string }>(calls: T[]) => calls.filter((c) => c.method !== "GET");

describe("the course's components of the mean", () => {
  it("lists each component with its weight, says the weights are relative, and offers Delete only where no column is", async () => {
    renderSection([cours, labo]);
    expect(await screen.findByText("Cours")).toBeInTheDocument();
    expect(screen.getAllByText(/Weight 50 %/)).toHaveLength(2);
    expect(screen.getByText(/The weights are relative/)).toBeInTheDocument();
    // In use: kept, and says why.
    expect(screen.getByText(/Holds activities: move them out to delete it/)).toBeInTheDocument();
    const coursActions = screen.getByRole("group", { name: "Actions on Cours" });
    expect(within(coursActions).queryByRole("button", { name: "Delete" })).toBeNull();
    expect(within(coursActions).getByRole("button", { name: "Edit" })).toBeInTheDocument();
    expect(within(screen.getByRole("group", { name: "Actions on Labo" })).getByRole("button", { name: "Delete" })).toBeInTheDocument();
  });

  it("says what a component is for when there is none", async () => {
    renderSection([]);
    expect(await screen.findByText(/Split the mean into weighted parts/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Add component/ })).toBeInTheDocument();
  });

  it("is read without controls by an assistant, who is told whose it is", async () => {
    renderSection([cours, labo], false);
    expect(await screen.findByText("Labo")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Add component/ })).toBeNull();
    expect(screen.queryByRole("button", { name: "Edit" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Delete" })).toBeNull();
    expect(screen.queryByText(/Holds activities/)).toBeNull();
    expect(screen.getByText(/The components are the course teachers' to change/)).toBeInTheDocument();
  });

  it("asks before the first component, then creates it", async () => {
    const { calls } = renderSection([], true, { [`POST ${URL_LIST}`]: ok([{ ...labo, weight: 100 }]) });
    await userEvent.click(await screen.findByRole("button", { name: /Add component/ }));
    const dialog = await screen.findByRole("dialog", { name: "Add component" });
    await userEvent.type(within(dialog).getByLabelText(/^Name/), "  Labo ");
    await userEvent.click(within(dialog).getByRole("button", { name: "Create" }));

    const question = await screen.findByRole("dialog", { name: "Use components of the mean?" });
    expect(within(question).getByText(/archived ones included/)).toBeInTheDocument();
    expect(writes(calls)).toEqual([]);
    await userEvent.click(within(question).getByRole("button", { name: "Add component" }));
    await waitFor(() => expect(writes(calls)).toHaveLength(1));
    expect(writes(calls)[0]).toMatchObject({ method: "POST", body: { name: "Labo", weight: 100 } });
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  });

  it("sends nothing when the first component's question is declined", async () => {
    const { calls } = renderSection([]);
    await userEvent.click(await screen.findByRole("button", { name: /Add component/ }));
    await userEvent.type(within(await screen.findByRole("dialog")).getByLabelText(/^Name/), "Labo");
    await userEvent.click(screen.getByRole("button", { name: "Create" }));
    const question = await screen.findByRole("dialog", { name: "Use components of the mean?" });
    await userEvent.click(within(question).getByRole("button", { name: "Cancel" }));
    expect(writes(calls)).toEqual([]);
    // The form stays, with what was typed.
    expect(screen.getByRole("dialog", { name: "Add component" })).toBeInTheDocument();
  });

  it("adds a second component without asking, and words a name taken under the fields", async () => {
    const { calls } = renderSection([cours], true, {
      [`POST ${URL_LIST}`]: fail(409, { error: "component_name_taken", message: "Taken" }),
    });
    await userEvent.click(await screen.findByRole("button", { name: /Add component/ }));
    const dialog = await screen.findByRole("dialog", { name: "Add component" });
    await userEvent.type(within(dialog).getByLabelText(/^Name/), "cours");
    await userEvent.click(within(dialog).getByRole("button", { name: "Create" }));
    expect(await within(dialog).findByText("Another component of the course has this name.")).toBeInTheDocument();
    expect(writes(calls)).toHaveLength(1);
  });

  it("renames without asking, and asks before a new weight", async () => {
    const { calls } = renderSection([cours, labo], true, {
      [`PATCH ${URL_LIST}/${LABO}`]: ok([cours, { ...labo, name: "Labos" }]),
    });
    await userEvent.click(within(await screen.findByRole("group", { name: "Actions on Labo" })).getByRole("button", { name: "Edit" }));
    let dialog = await screen.findByRole("dialog", { name: "Edit “Labo”" });
    await userEvent.type(within(dialog).getByLabelText(/^Name/), "s");
    await userEvent.click(within(dialog).getByRole("button", { name: "Save" }));
    await waitFor(() => expect(writes(calls)).toHaveLength(1));
    expect(writes(calls)[0]!.body).toEqual({ name: "Labos" });
    expect(screen.queryByRole("dialog", { name: "Change the weight?" })).toBeNull();

    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    await userEvent.click(within(screen.getByRole("group", { name: "Actions on Labos" })).getByRole("button", { name: "Edit" }));
    dialog = await screen.findByRole("dialog", { name: "Edit “Labos”" });
    const weight = within(dialog).getByLabelText("Weight (%)");
    await userEvent.clear(weight);
    await userEvent.type(weight, "40");
    await userEvent.click(within(dialog).getByRole("button", { name: "Save" }));
    const question = await screen.findByRole("dialog", { name: "Change the weight?" });
    expect(within(question).getByText(/every classroom of the course/)).toBeInTheDocument();
    await userEvent.click(within(question).getByRole("button", { name: "Change the weight" }));
    await waitFor(() => expect(writes(calls)).toHaveLength(2));
    expect(writes(calls)[1]!.body).toEqual({ weight: 40 });
  });

  it("closes without a write when nothing changed", async () => {
    const { calls } = renderSection([cours]);
    await userEvent.click(within(await screen.findByRole("group", { name: "Actions on Cours" })).getByRole("button", { name: "Edit" }));
    await userEvent.click(within(await screen.findByRole("dialog")).getByRole("button", { name: "Save" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(writes(calls)).toEqual([]);
  });

  it("asks before deleting, and says when it is the last one", async () => {
    const { calls } = renderSection([labo], true, { [`DELETE ${URL_LIST}/${LABO}`]: ok([]) });
    await userEvent.click(within(await screen.findByRole("group", { name: "Actions on Labo" })).getByRole("button", { name: "Delete" }));
    const question = await screen.findByRole("dialog", { name: "Delete “Labo”?" });
    expect(within(question).getByText(/It is the last component/)).toBeInTheDocument();
    await userEvent.click(within(question).getByRole("button", { name: "Delete" }));
    await waitFor(() => expect(writes(calls)).toEqual([{ url: `${URL_LIST}/${LABO}`, method: "DELETE", body: null }]));
    expect(await screen.findByText(/Split the mean into weighted parts/)).toBeInTheDocument();
  });

  it("words a refused deletion (409 component_in_use) in a toast", async () => {
    renderSection([cours, labo], true, { [`DELETE ${URL_LIST}/${LABO}`]: fail(409, { error: "component_in_use", message: "In use" }) });
    await userEvent.click(within(await screen.findByRole("group", { name: "Actions on Labo" })).getByRole("button", { name: "Delete" }));
    const question = await screen.findByRole("dialog", { name: "Delete “Labo”?" });
    expect(within(question).queryByText(/It is the last component/)).toBeNull();
    await userEvent.click(within(question).getByRole("button", { name: "Delete" }));
    expect(await screen.findByText("Columns are still in this component. Move them out first.")).toBeInTheDocument();
  });

  it("asks for a retry when the list does not load", async () => {
    mockFetch({ [`GET ${URL_LIST}`]: fail(500, { message: "boom" }) });
    renderWithProviders(<CourseComponents courseId={COURSE} canManage />);
    expect(await screen.findByText("Could not load the components")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Retry/ })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Add component/ })).toBeNull();
  });
});
