import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ComponentProps } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { ItemPreview } from "@quiz/contracts";
import { itemListLock } from "@quiz/domain";

import { EVALUATION_ID, makeEvaluationDetail, makeItemRow } from "../test/live-fixtures";
import { mockFetch, ok, renderWithProviders } from "../test/render";
import { viewport } from "../test/viewport";
import { evaluationTarget } from "./editTarget";
import { useItemPane } from "./ItemPreview";
import { ItemsStep as Step } from "./ItemsStep";

/** The list with its preview state, which a page holds (`useItemPane`). */
function ItemsStep(props: Omit<ComponentProps<typeof Step>, "pane">) {
  return <Step {...props} pane={useItemPane()} />;
}

const target = evaluationTarget(EVALUATION_ID);

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

/** The row of the list, not the docked preview's title of the same name. */
function rowOf(name: string): HTMLElement {
  return screen.getAllByText(name).map((e) => e.closest("li")).find(Boolean)!;
}

describe("ItemsStep — preview and edit (#127)", () => {
  it("previews the item at its frozen version, in a sheet, through the evaluation", async () => {
    const user = userEvent.setup();
    const { calls } = mockFetch({ [previewUrl]: ok(preview) });
    renderWithProviders(
      <ItemsStep
        target={target}
        lock={null}
        detail={makeEvaluationDetail({ items: [frozen, other], staleItems: [frozen.id] })}
        navigate={vi.fn()}
      />,
    );

    await user.click(
      within(rowOf("pointer-decl")).getByRole("button", { name: /preview pointer-decl/i }),
    );
    const sheet = await screen.findByRole("dialog");
    expect(within(sheet).getByText(/version 2, the one frozen in this list/i)).toBeInTheDocument();
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
      <ItemsStep
        target={target}
        lock={null}
        detail={makeEvaluationDetail({ items: [frozen, other] })}
        navigate={navigate}
      />,
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
        target={target}
        lock={null}
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
    renderWithProviders(
      <ItemsStep
        target={target}
        // A running evaluation with attempts (issue #79).
        lock={itemListLock("running", 3)}
        detail={makeEvaluationDetail({ items: [frozen, other] })}
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

describe("ItemsStep — the docked preview and the question's columns", () => {
  const narrow = window.matchMedia;
  afterEach(() => vi.stubGlobal("matchMedia", narrow));
  const otherUrl = `GET /app/api/evaluations/${EVALUATION_ID}/preview/items/${other.id}`;
  const detail = makeEvaluationDetail({
    items: [frozen, { ...other, difficulty: 4 }],
    concepts: {
      [frozen.questionId]: [
        { id: "00000000-0000-4000-8000-0000000000c1", label: "Pointers", qualifier: "", status: "validated" },
      ],
    },
  });

  it("docks beside the list on a click on the row, walks it with ↑/↓ and closes on Escape", async () => {
    viewport(1600);
    const user = userEvent.setup();
    mockFetch({
      [previewUrl]: ok(preview),
      [otherUrl]: ok({ ...preview, itemId: other.id, versionNumber: 1 }),
    });
    renderWithProviders(<ItemsStep target={target} lock={null} detail={detail} navigate={vi.fn()} />);

    await user.click(screen.getByText("pointer-decl"));
    const pane = await screen.findByRole("complementary", { name: "pointer-decl" });
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(rowOf("pointer-decl")).toHaveAttribute("aria-current", "true");
    expect(within(pane).getByRole("button", { name: /previous question/i })).toBeDisabled();

    await user.click(within(pane).getByRole("button", { name: /next question/i }));
    expect(await screen.findByRole("complementary", { name: "array-decay" })).toBeInTheDocument();
    expect(rowOf("array-decay")).toHaveAttribute("aria-current", "true");

    // A control of the row keeps its own click: the points field is no look.
    await user.click(within(rowOf("pointer-decl")).getByRole("spinbutton"));
    expect(screen.getByRole("complementary", { name: "array-decay" })).toBeInTheDocument();

    await user.keyboard("{Escape}");
    await waitFor(() => expect(screen.queryByRole("complementary")).not.toBeInTheDocument());
  });

  it("shows the question's concepts and difficulty on its row", () => {
    mockFetch({});
    renderWithProviders(<ItemsStep target={target} lock={null} detail={detail} navigate={vi.fn()} />);
    expect(within(rowOf("pointer-decl")).getByText("Pointers")).toBeInTheDocument();
    expect(within(rowOf("array-decay")).getByText("—")).toBeInTheDocument();
    expect(within(rowOf("array-decay")).getByText(/difficulty 4/i)).toBeInTheDocument();
  });
});

describe("ItemsStep — bonus questions (ADR-052)", () => {
  it("toggles a row's bonus flag, and names it beside the question", async () => {
    const user = userEvent.setup();
    const bonus = makeItemRow(1, { internalName: "array-decay", bonus: true, points: 2 });
    const { calls } = mockFetch({
      [`PATCH /app/api/evaluations/${EVALUATION_ID}/items/${frozen.id}`]: ok([]),
    });
    renderWithProviders(
      <ItemsStep
        target={target}
        lock={null}
        detail={makeEvaluationDetail({ items: [frozen, bonus], totalPoints: 1 })}
        navigate={vi.fn()}
      />,
    );
    const toggle = within(rowOf("array-decay")).getByRole("button", { name: /^bonus$/i });
    expect(toggle).toHaveAttribute("aria-pressed", "true");
    expect(within(rowOf("array-decay")).getByText("bonus")).toBeInTheDocument();
    expect(screen.getByText(/\+2 bonus points/)).toBeInTheDocument();

    await user.click(within(rowOf("pointer-decl")).getByRole("button", { name: /^bonus$/i }));
    await waitFor(() =>
      expect(calls.find((c) => c.method === "PATCH")?.body).toEqual({ bonus: true }),
    );
  });

  it("locks the flag with the points", () => {
    mockFetch({});
    renderWithProviders(
      <ItemsStep
        target={target}
        lock={itemListLock("draft", 1)}
        detail={makeEvaluationDetail({ items: [frozen] })}
        navigate={vi.fn()}
      />,
    );
    expect(within(rowOf("pointer-decl")).getByRole("button", { name: /^bonus$/i })).toBeDisabled();
  });
});

describe("ItemsStep — the text before an item (ADR-084)", () => {
  const intro = "Read chapters 8 and 9 before answering.";
  const patchUrl = (id: string) => `PATCH /app/api/evaluations/${EVALUATION_ID}/items/${id}`;

  it("offers + Text in each gap, above the first row too, and opens the editor for that item", async () => {
    const user = userEvent.setup();
    mockFetch({});
    renderWithProviders(
      <ItemsStep
        target={target}
        lock={null}
        detail={makeEvaluationDetail({ items: [frozen, other] })}
        navigate={vi.fn()}
      />,
    );
    expect(screen.getByRole("button", { name: "Add a text before pointer-decl" })).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Add a text before array-decay" }));
    const dialog = await screen.findByRole("dialog", { name: "Text before array-decay" });
    expect(within(dialog).getByRole("button", { name: "Save" })).toBeInTheDocument();
  });

  it("shows the text as a band over its item, saves an edit and removes it after a confirmation", async () => {
    const user = userEvent.setup();
    const withIntro = makeItemRow(1, { internalName: "array-decay", intro });
    const { calls } = mockFetch({ [patchUrl(withIntro.id)]: ok([]) });
    renderWithProviders(
      <ItemsStep
        target={target}
        lock={null}
        detail={makeEvaluationDetail({ items: [frozen, withIntro] })}
        navigate={vi.fn()}
      />,
    );
    const row = rowOf("array-decay");
    expect(within(row).getByText("Text before the question")).toBeInTheDocument();
    expect(within(row).getByText(intro)).toBeInTheDocument();
    // It has one: no "+ Text" for it.
    expect(screen.queryByRole("button", { name: "Add a text before array-decay" })).toBeNull();

    await user.click(within(row).getByRole("button", { name: "Edit the text before array-decay" }));
    const dialog = await screen.findByRole("dialog", { name: "Text before array-decay" });
    await user.click(within(dialog).getByRole("button", { name: "Save" }));
    await waitFor(() => expect(calls.find((c) => c.method === "PATCH")?.body).toEqual({ intro }));

    await user.click(
      within(rowOf("array-decay")).getByRole("button", { name: "Remove the text before array-decay" }),
    );
    await user.click(await screen.findByRole("button", { name: "Remove the text" }));
    await waitFor(() =>
      expect(calls.filter((c) => c.method === "PATCH").map((c) => c.body)).toContainEqual({ intro: null }),
    );
  });

  it("is locked with the item list", () => {
    mockFetch({});
    const withIntro = makeItemRow(1, { internalName: "array-decay", intro });
    renderWithProviders(
      <ItemsStep
        target={target}
        lock={itemListLock("running", 2)}
        detail={makeEvaluationDetail({ items: [frozen, withIntro] })}
        navigate={vi.fn()}
      />,
    );
    expect(screen.queryByRole("button", { name: /^add a text before/i })).toBeNull();
    expect(screen.getByRole("button", { name: "Edit the text before array-decay" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Remove the text before array-decay" })).toBeDisabled();
  });
});
