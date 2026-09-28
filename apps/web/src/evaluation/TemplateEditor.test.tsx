import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import type { TemplateDetail, TemplateItemRow } from "@quiz/contracts";

import { makeCourseSummary } from "../test/fixtures";
import { makeEvaluationDetail, makeItemRow } from "../test/live-fixtures";
import { fail, mockFetch, ok, renderWithProviders } from "../test/render";
import { TemplateEditor } from "./TemplateEditor";

/*
 * The editor of one template (F-EVAL-25): the evaluation editor's blocks on
 * the template's own routes, with nothing of a run — no dates, no access
 * code, no launch — and the three flags of a row that "Use in a classroom"
 * warns about or refuses on.
 */

const T = "11111111-1111-4111-8111-000000000001";
const BASE = `/app/api/templates/${T}`;

const row = (index: number, over: Partial<TemplateItemRow> = {}): TemplateItemRow => ({
  ...makeItemRow(index),
  poolUnlinked: false,
  ...over,
});

const stale = row(0, { internalName: "pointer-decl", versionNumber: 2, latestVersionNumber: 4 });
const deprecated = row(1, { internalName: "array-decay", deprecated: true });
const unlinked = row(2, { internalName: "rc-filter", type: "circuit", poolUnlinked: true });

function detail(over: Partial<TemplateDetail> = {}): TemplateDetail {
  const e = makeEvaluationDetail().evaluation;
  const items = over.items ?? [stale, deprecated, unlinked];
  return {
    template: {
      id: T,
      courseId: "c1",
      title: "Final exam",
      mode: "exam",
      revision: 3,
      itemCount: items.length,
      totalPoints: items.length,
      settings: e.settings,
      gradingScale: e.gradingScale,
      feedbackPolicy: e.feedbackPolicy,
      mcqPolicy: e.mcqPolicy,
      durationS: e.durationS,
    },
    items,
    totalPoints: items.length,
    staleItems: items.filter((i) => i.id === stale.id).map((i) => i.id),
    editableQuestionIds: items.map((i) => i.questionId),
    ...over,
  };
}

function world(d: TemplateDetail = detail()) {
  return {
    "GET /app/api/courses": ok([makeCourseSummary()]),
    [`GET ${BASE}`]: ok(d),
  };
}

const rowOf = (name: string) => screen.getByText(name).closest("li")!;

describe("TemplateEditor", () => {
  it("shows the items with their flags, the mode and the revision, under its course", async () => {
    mockFetch(world());
    const navigate = vi.fn();
    renderWithProviders(<TemplateEditor id={T} navigate={navigate} />);

    expect(await screen.findByRole("heading", { level: 1, name: /Final exam/ })).toBeVisible();
    expect(screen.getByText("rev. 3")).toBeVisible();
    expect(screen.getByText("Exam")).toBeVisible();

    // A newer version, with its one-click update; a deprecated one; a pool gone.
    expect(
      within(rowOf("pointer-decl")).getByRole("button", {
        name: "Use the latest version of pointer-decl",
      }),
    ).toBeVisible();
    expect(within(rowOf("array-decay")).getByText("deprecated")).toBeVisible();
    expect(within(rowOf("rc-filter")).getByText("Pool not linked")).toBeVisible();
    expect(
      screen.getByText("1 question is in a pool no longer linked to the course"),
    ).toBeVisible();
    expect(screen.getByText(/Using this template in a classroom is refused/)).toBeVisible();

    // The fix of the unlinked pool, and the way back up, are the course page.
    await userEvent.click(screen.getByRole("button", { name: "Open the course" }));
    expect(navigate).toHaveBeenCalledWith({ view: "course", id: "c1" });
    await userEvent.click(screen.getByRole("button", { name: "PRG1 — Programmation C" }));
    expect(navigate).toHaveBeenLastCalledWith({ view: "course", id: "c1" });

    // Nothing of a run: no launch step, no dates, no access code.
    expect(screen.queryByRole("tab", { name: /Launch/ })).toBeNull();
    await userEvent.click(screen.getByRole("tab", { name: "Settings" }));
    expect(screen.queryByLabelText("Opens at")).toBeNull();
    expect(screen.queryByLabelText("Closes at")).toBeNull();
    expect(screen.getByText(/Dates and the access code are set in each evaluation/)).toBeVisible();
    await userEvent.click(screen.getByRole("button", { name: "Advanced options" }));
    expect(screen.queryByLabelText("Access code")).toBeNull();
  });

  it("has one primary action, Use in a classroom, which opens the instantiate dialog", async () => {
    mockFetch(world());
    renderWithProviders(<TemplateEditor id={T} navigate={vi.fn()} />);

    const use = await screen.findByRole("button", { name: "Use in a classroom" });
    expect(use.className).toMatch(/bg-accent/);
    // Adding questions steps down to the section's own action.
    expect(screen.getByRole("button", { name: "Add questions" }).className).not.toMatch(
      /bg-accent/,
    );
    await userEvent.click(use);
    expect(
      await screen.findByRole("dialog", { name: "New evaluation from “Final exam”" }),
    ).toBeVisible();
  });

  it("offers no Use in a classroom while empty: adding questions is the primary", async () => {
    mockFetch(world(detail({ items: [], staleItems: [] })));
    renderWithProviders(<TemplateEditor id={T} navigate={vi.fn()} />);

    const add = await screen.findByRole("button", { name: "Add questions" });
    expect(add.className).toMatch(/bg-accent/);
    expect(screen.queryByRole("button", { name: "Use in a classroom" })).toBeNull();
  });

  it("writes through the template's own routes: an item update, and a preset without dates", async () => {
    const { calls } = mockFetch({
      ...world(),
      [`POST ${BASE}/items/update-versions`]: ok(detail({ staleItems: [] })),
      [`PATCH ${BASE}`]: ok(detail()),
    });
    renderWithProviders(<TemplateEditor id={T} navigate={vi.fn()} />);

    await userEvent.click(
      await screen.findByRole("button", { name: "Use the latest version of pointer-decl" }),
    );
    await waitFor(() =>
      expect(calls.find((c) => c.url.endsWith("/update-versions"))?.body).toEqual({
        itemIds: [stale.id],
      }),
    );

    await userEvent.click(screen.getByRole("tab", { name: "Settings" }));
    await userEvent.click(screen.getByRole("button", { name: /Homework exercise/ }));
    await waitFor(() => expect(calls.some((c) => c.method === "PATCH")).toBe(true));
    const body = calls.find((c) => c.method === "PATCH")!.body as Record<string, unknown>;
    expect(body).toHaveProperty("settings.timing", "deadline");
    for (const key of ["opensAt", "closesAt", "accessCode"]) expect(body).not.toHaveProperty(key);
  });

  it("renames the template in place, with the title alone", async () => {
    const { calls } = mockFetch({
      ...world(),
      [`PATCH ${BASE}`]: ok(detail({ template: { ...detail().template, title: "Exam 2027" } })),
    });
    renderWithProviders(<TemplateEditor id={T} navigate={vi.fn()} />);

    await userEvent.click(await screen.findByRole("button", { name: "Rename template: Final exam" }));
    const input = screen.getByRole("textbox", { name: "Title" });
    await userEvent.clear(input);
    await userEvent.type(input, "Exam 2027{Enter}");

    await waitFor(() =>
      expect(calls.filter((c) => c.method === "PATCH").map((c) => c.body)).toEqual([
        { title: "Exam 2027" },
      ]),
    );
    expect(await screen.findByRole("heading", { level: 1, name: /Exam 2027/ })).toBeVisible();
  });

  it("says a template it cannot reach does not exist, like a missing one", async () => {
    mockFetch({
      "GET /app/api/courses": ok([]),
      [`GET ${BASE}`]: fail(404, { error: "not_found", message: "Template not found" }),
    });
    const navigate = vi.fn();
    renderWithProviders(<TemplateEditor id={T} navigate={navigate} />);

    expect(
      await screen.findByRole("heading", {
        level: 1,
        name: "This template does not exist, or you do not have access to it.",
      }),
    ).toBeVisible();
    await userEvent.click(screen.getByRole("button", { name: "Back to the courses" }));
    expect(navigate).toHaveBeenCalledWith({ view: "home" });
  });

  it("says so when the template cannot be read, and offers a retry", async () => {
    mockFetch({ [`GET ${BASE}`]: fail(500, { message: "Boom" }) });
    renderWithProviders(<TemplateEditor id={T} navigate={vi.fn()} />);

    expect(await screen.findByText("Boom")).toBeVisible();
    expect(screen.getByRole("button", { name: "Retry" })).toBeVisible();
  });
});
