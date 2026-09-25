import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { ItemPreview } from "@quiz/contracts";

import { EVALUATION_ID, makeEvaluationDetail, makeItemRow } from "../test/live-fixtures";
import { mockFetch, ok, renderWithProviders } from "../test/render";
import { ItemsStep } from "./ItemsStep";

/*
 * The Preview and Edit buttons of a row of the question list (issue #127):
 * the preview shows the item at the version the evaluation froze, Edit opens
 * the editor with the way back to this evaluation, a reader of the pool gets
 * no Edit but is told why, and a frozen list keeps both.
 */

const frozen = makeItemRow(0, { internalName: "pointer-decl", versionNumber: 2, latestVersionNumber: 4 });
const other = makeItemRow(1, { internalName: "array-decay" });

const preview: ItemPreview = {
  itemId: frozen.id,
  type: "mcq",
  versionNumber: 2,
  points: 1,
  student: {
    prompt: "Which expression gives the address of `x`? (v2)",
    mode: "single",
    choices: [
      { id: 0, text: "&x" },
      { id: 1, text: "*x" },
    ],
  },
};

const previewUrl = `GET /app/api/evaluations/${EVALUATION_ID}/preview/items/${frozen.id}`;

afterEach(() => vi.restoreAllMocks());

function rowOf(name: string): HTMLElement {
  return screen.getByText(name).closest("li")!;
}

describe("ItemsStep — preview and edit (#127)", () => {
  it("previews the item at its frozen version, in a sheet, through the evaluation", async () => {
    const user = userEvent.setup();
    const { calls } = mockFetch({ [previewUrl]: ok(preview) });
    renderWithProviders(
      <ItemsStep
        detail={makeEvaluationDetail({ items: [frozen, other], staleItems: [frozen.id] })}
        navigate={vi.fn()}
      />,
    );

    await user.click(
      within(rowOf("pointer-decl")).getByRole("button", { name: /preview pointer-decl/i }),
    );
    const sheet = await screen.findByRole("dialog");
    expect(within(sheet).getByText(/version 2, the one this evaluation uses/i)).toBeInTheDocument();
    expect(await within(sheet).findByText(/\(v2\)/)).toBeInTheDocument();
    // The student's own player: the choices are there to be clicked.
    expect(within(sheet).getByRole("radio", { name: "&x" })).toBeInTheDocument();
    expect(calls.map((c) => `${c.method} ${c.url}`)).toContain(previewUrl);

    await user.click(within(sheet).getByRole("button", { name: /close/i }));
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
  });

  it("opens the editor with the way back to this evaluation", async () => {
    const user = userEvent.setup();
    mockFetch({});
    const navigate = vi.fn();
    renderWithProviders(
      <ItemsStep detail={makeEvaluationDetail({ items: [frozen, other] })} navigate={navigate} />,
    );

    await user.click(within(rowOf("pointer-decl")).getByRole("button", { name: "Edit pointer-decl" }));
    expect(navigate).toHaveBeenCalledWith({
      view: "question",
      id: frozen.questionId,
      from: EVALUATION_ID,
    });
  });

  it("offers no Edit on a question whose pool the teacher only reads, and says why", async () => {
    const user = userEvent.setup();
    mockFetch({});
    const navigate = vi.fn();
    renderWithProviders(
      <ItemsStep
        detail={makeEvaluationDetail({
          items: [frozen, other],
          editableQuestionIds: [other.questionId],
        })}
        navigate={navigate}
      />,
    );

    const denied = within(rowOf("pointer-decl")).getByRole("button", {
      name: /cannot edit pointer-decl: you only have read access/i,
    });
    expect(denied).toHaveAttribute("aria-disabled", "true");
    await user.click(denied);
    expect(navigate).not.toHaveBeenCalled();
    // The other row, in a pool the teacher writes, keeps its Edit.
    expect(
      within(rowOf("array-decay")).getByRole("button", { name: "Edit array-decay" }),
    ).not.toHaveAttribute("aria-disabled");
  });

  it("keeps Preview and Edit once the item list is frozen", async () => {
    const user = userEvent.setup();
    mockFetch({ [previewUrl]: ok(preview) });
    const navigate = vi.fn();
    const base = makeEvaluationDetail({ items: [frozen, other] });
    renderWithProviders(
      <ItemsStep
        detail={{ ...base, evaluation: { ...base.evaluation, state: "running" }, attemptCount: 3 }}
        navigate={navigate}
      />,
    );

    const row = rowOf("pointer-decl");
    // The structure is locked…
    expect(within(row).getByRole("button", { name: /remove pointer-decl/i })).toBeDisabled();
    // …and looking at a question, or opening it, is not a change to it.
    const edit = within(row).getByRole("button", { name: "Edit pointer-decl" });
    expect(edit).toBeEnabled();
    await user.click(edit);
    expect(navigate).toHaveBeenCalledWith(expect.objectContaining({ from: EVALUATION_ID }));
    await user.click(within(row).getByRole("button", { name: /preview pointer-decl/i }));
    expect(await screen.findByRole("dialog")).toBeInTheDocument();
  });
});
