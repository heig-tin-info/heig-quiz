import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";

import { GradebookColumnSettings, GradebookStaff } from "@quiz/contracts";

import { makeClassroomDetail } from "../test/fixtures";
import { fail, makeQueryClient, mockFetch, ok, renderWithProviders, type RouteHandler } from "../test/render";
import { GradebookSettingRow } from "./GradebookSettingRow";

/*
 * An activity's Gradebook row (ADR-131 §13, §14): its column's settings in
 * words, from the draft on, edited in the matrix's dialog and written by the
 * matrix's write — the same question before a published mean moves, the
 * same refusals in words — and text only on an archived classroom. Its
 * placement is the configuration's and the project's tests'.
 */

const ROOM = "0190d3c4-0000-7000-8000-0000000000a1";
const ACTIVITY = "0190d3c4-0000-7000-8000-0000000000c1";
const COURS = "0190d3c4-0000-7000-8000-0000000000d1";
const LABO = "0190d3c4-0000-7000-8000-0000000000d2";
const URL_COLUMN = `/app/api/classrooms/${ROOM}/gradebook/columns/evaluation/${ACTIVITY}`;

const settings = (over: Partial<GradebookColumnSettings> = {}) =>
  GradebookColumnSettings.parse({
    weight: 100,
    counts: true,
    componentId: null,
    released: false,
    meanPublished: false,
    components: [],
    ...over,
  });

const withComponents = (over: Partial<GradebookColumnSettings> = {}) =>
  settings({
    components: [
      { id: COURS, name: "Cours", weight: 50, inUse: true },
      { id: LABO, name: "Labo", weight: 50, inUse: false },
    ],
    componentId: COURS,
    ...over,
  });

const table = GradebookStaff.parse({
  classroomId: ROOM,
  archived: false,
  meanPublished: false,
  components: [],
  columns: [],
  rows: [],
  classMean: null,
});

function renderRow(read: GradebookColumnSettings | RouteHandler, extra: Record<string, RouteHandler> = {}, archived = false) {
  const fetched = mockFetch({
    [`GET ${URL_COLUMN}`]: "weight" in read ? ok(read) : read,
    [`GET /app/api/classrooms/${ROOM}`]: ok(makeClassroomDetail({ id: ROOM, archivedAt: archived ? "2026-01-01T00:00:00.000Z" : null })),
    ...extra,
  });
  renderWithProviders(<GradebookSettingRow classroomId={ROOM} kind="evaluation" activityId={ACTIVITY} title="Test 1" />, {
    queryClient: makeQueryClient(),
  });
  return fetched;
}

const edit = async () => {
  await userEvent.click(await screen.findByRole("button", { name: "Edit" }));
  return screen.findByRole("dialog", { name: "Settings of Test 1" });
};

describe("GradebookSettingRow", () => {
  it("says where the column counts and its weight, on a course without components", async () => {
    renderRow(settings({ weight: 40 }));
    expect(await screen.findByText("In the mean · weight 40 %")).toBeInTheDocument();
    expect(screen.getByText("Gradebook")).toBeInTheDocument();
  });

  it("says Out of the mean for a column left out, an exercise's default", async () => {
    renderRow(settings({ counts: false }));
    expect(await screen.findByText("Out of the mean")).toBeInTheDocument();
  });

  it("names the component the column counts in", async () => {
    renderRow(withComponents({ weight: 60 }));
    expect(await screen.findByText("Cours · weight 60 %")).toBeInTheDocument();
  });

  it("warns on a counted column in no component of a course that has some", async () => {
    renderRow(withComponents({ componentId: null }));
    expect(await screen.findByText("In no component: counts in no mean.")).toBeInTheDocument();
  });

  it("skeletons while it loads, then fails readably with a retry", async () => {
    let reads = 0;
    renderRow(() => {
      reads += 1;
      return reads === 1 ? fail(500, { message: "boom" }) : ok(settings());
    });
    expect(screen.getByRole("status", { name: "Loading…" })).toBeInTheDocument();
    expect(await screen.findByText("Could not load the gradebook settings.")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Retry" }));
    expect(await screen.findByText("In the mean · weight 100 %")).toBeInTheDocument();
  });

  it("edits in the matrix's dialog: the write is the column's PATCH, then the row reads its settings again", async () => {
    let read = settings();
    const { calls } = renderRow(() => ok(read), {
      [`PATCH ${URL_COLUMN}`]: () => {
        read = settings({ weight: 40, componentId: null });
        return ok(table);
      },
    });
    const dialog = await edit();
    const weight = within(dialog).getByLabelText("Weight (%)");
    await userEvent.clear(weight);
    await userEvent.type(weight, "40");
    await userEvent.click(within(dialog).getByRole("button", { name: "Save" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(calls.find((c) => c.method === "PATCH")!.body).toEqual({ weight: 40 });
    expect(await screen.findByText("In the mean · weight 40 %")).toBeInTheDocument();
    // Not released: nothing to ask.
    expect(screen.queryByRole("dialog", { name: "Change the students' means?" })).toBeNull();
  });

  it("puts the column in a component with its one control", async () => {
    const { calls } = renderRow(withComponents(), { [`PATCH ${URL_COLUMN}`]: ok(table) });
    const dialog = await edit();
    await userEvent.selectOptions(within(dialog).getByLabelText("Component"), "Labo");
    await userEvent.click(within(dialog).getByRole("button", { name: "Save" }));
    await waitFor(() => expect(calls.find((c) => c.method === "PATCH")?.body).toEqual({ counts: true, componentId: LABO }));
  });

  it("asks before it moves a published mean, and sends nothing on Cancel", async () => {
    const { calls } = renderRow(settings({ released: true, meanPublished: true }), { [`PATCH ${URL_COLUMN}`]: ok(table) });
    const dialog = await edit();
    await userEvent.selectOptions(within(dialog).getByLabelText("Mean"), "Out of the mean");
    await userEvent.click(within(dialog).getByRole("button", { name: "Save" }));
    const question = await screen.findByRole("dialog", { name: "Change the students' means?" });
    expect(within(question).getByText(/The results of Test 1 are released/)).toBeInTheDocument();
    await userEvent.click(within(question).getByRole("button", { name: "Cancel" }));
    expect(calls.filter((c) => c.method === "PATCH")).toEqual([]);

    await userEvent.click(within(screen.getByRole("dialog", { name: "Settings of Test 1" })).getByRole("button", { name: "Save" }));
    await userEvent.click(within(await screen.findByRole("dialog", { name: "Change the students' means?" })).getByRole("button", { name: "Change now" }));
    await waitFor(() => expect(calls.find((c) => c.method === "PATCH")?.body).toEqual({ counts: false }));
  });

  it("words a refusal as the matrix does, and keeps the dialog open", async () => {
    renderRow(settings(), {
      [`PATCH ${URL_COLUMN}`]: fail(409, { error: "classroom_archived", message: "The classroom is archived" }),
    });
    const dialog = await edit();
    await userEvent.selectOptions(within(dialog).getByLabelText("Mean"), "Out of the mean");
    await userEvent.click(within(dialog).getByRole("button", { name: "Save" }));
    expect(await screen.findByText("This classroom is archived: its gradebook is read-only.")).toBeInTheDocument();
    expect(screen.getByRole("dialog", { name: "Settings of Test 1" })).toBeInTheDocument();
  });

  it("is text only on an archived classroom", async () => {
    renderRow(settings({ weight: 40 }), {}, true);
    expect(await screen.findByText("In the mean · weight 40 %")).toBeInTheDocument();
    await waitFor(() => expect(screen.queryByRole("button", { name: "Edit" })).toBeNull());
  });
});
