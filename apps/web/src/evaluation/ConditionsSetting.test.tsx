import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";

import type { CourseCondition, EvaluationDetail, EvaluationSettings } from "@quiz/contracts";

import { EVALUATION_ID, makeEvaluationDetail } from "../test/live-fixtures";
import { mockFetch, ok, renderWithProviders } from "../test/render";
import { ConditionsSetting } from "./ConditionsSetting";
import { evaluationTarget } from "./editTarget";
import { useConfigPatch } from "./usePatch";

/* ADR-079 (F-EVAL-33): the announced conditions, sent whole, beside what the platform adds. */

const withSettings = (settings: Partial<EvaluationSettings>): EvaluationDetail => {
  const detail = makeEvaluationDetail();
  return { ...detail, evaluation: { ...detail.evaluation, settings: { ...detail.evaluation.settings, ...settings } } };
};

function Harness({ detail, disabled = false }: { detail: EvaluationDetail; disabled?: boolean }) {
  const patch = useConfigPatch(evaluationTarget(EVALUATION_ID));
  return <ConditionsSetting config={detail.evaluation} courseId={detail.courseId} patch={patch} disabled={disabled} />;
}

const PATCH = `PATCH /app/api/evaluations/${EVALUATION_ID}`;
const two = [
  { kind: "allowed" as const, text: "Notes" },
  { kind: "forbidden" as const, text: "Phones" },
];
const CATALOG = `GET /app/api/courses/${makeEvaluationDetail().courseId}/conditions`;
const catalog: CourseCondition[] = [
  { id: "11111111-1111-4111-8111-111111111111", kind: "allowed", text: "A dictionary", archivedAt: null },
  { id: "22222222-2222-4222-8222-222222222222", kind: "forbidden", text: "Smartwatches", archivedAt: null },
  // Archived: never offered.
  { id: "44444444-4444-4444-8444-444444444444", kind: "info", text: "Retired line", archivedAt: "2026-01-01T00:00:00.000Z" },
];
const lastPatch = (calls: { method: string; body: unknown }[]) => calls.filter((c) => c.method === "PATCH").at(-1)?.body;

describe("ConditionsSetting", () => {
  it("adds a one-off condition, trimmed, at the end of the list", async () => {
    const detail = withSettings({ conditions: two });
    const { calls } = mockFetch({ [PATCH]: ok(detail) });
    renderWithProviders(<Harness detail={detail} />);
    const add = screen.getByRole("button", { name: "Add" });
    expect(add).toBeDisabled();
    await userEvent.selectOptions(screen.getAllByRole("combobox", { name: "Kind" }).at(-1)!, "provided");
    await userEvent.type(screen.getByRole("textbox", { name: "Condition" }), "  A formula sheet ");
    await userEvent.click(add);
    await waitFor(() =>
      expect(lastPatch(calls)).toEqual({
        settings: { conditions: [...two, { kind: "provided", text: "A formula sheet" }] },
      }),
    );
  });

  it("edits a text on leaving the field, and puts a blank one back", async () => {
    const detail = withSettings({ conditions: two });
    const { calls } = mockFetch({ [PATCH]: ok(detail) });
    renderWithProviders(<Harness detail={detail} />);
    const first = screen.getByRole("textbox", { name: "Condition 1" });
    await userEvent.clear(first);
    await userEvent.tab();
    expect(first).toHaveValue("Notes");
    expect(lastPatch(calls)).toBeUndefined();
    await userEvent.type(first, " (A4)");
    await userEvent.tab();
    await waitFor(() =>
      expect(lastPatch(calls)).toEqual({ settings: { conditions: [{ kind: "allowed", text: "Notes (A4)" }, two[1]] } }),
    );
  });

  it("moves and removes a condition from its menu", async () => {
    const detail = withSettings({ conditions: two });
    const { calls } = mockFetch({ [PATCH]: ok(detail) });
    renderWithProviders(<Harness detail={detail} />);
    await userEvent.click(screen.getByRole("button", { name: "Actions on “Notes”" }));
    await userEvent.click(screen.getByRole("menuitem", { name: "Move down" }));
    await waitFor(() => expect(lastPatch(calls)).toEqual({ settings: { conditions: [two[1], two[0]] } }));
    await userEvent.click(screen.getByRole("button", { name: "Actions on “Phones”" }));
    await userEvent.click(screen.getByRole("menuitem", { name: "Remove" }));
    await waitFor(() => expect(lastPatch(calls)).toEqual({ settings: { conditions: [two[0]] } }));
  });

  it("previews what the platform adds from the settings, and nothing for calculator `none`", () => {
    renderWithProviders(<Harness detail={withSettings({ calculator: "scientific", negativeMarking: true })} />);
    expect(screen.getByText("Added by the platform")).toBeInTheDocument();
    expect(screen.getByText("A scientific calculator")).toBeInTheDocument();
    expect(screen.getByText("Wrong answers cost points")).toBeInTheDocument();
  });

  it("stops offering Add at 20 conditions", () => {
    const many = Array.from({ length: 20 }, (_, i) => ({ kind: "info" as const, text: `Line ${i}` }));
    renderWithProviders(<Harness detail={withSettings({ conditions: many })} />);
    expect(screen.queryByRole("button", { name: "Add" })).toBeNull();
    expect(screen.getByText("At most 20 conditions.")).toBeInTheDocument();
  });

  it("is frozen with the rest of the settings", () => {
    renderWithProviders(<Harness detail={withSettings({ conditions: two })} disabled />);
    expect(screen.getByRole("textbox", { name: "Condition 1" })).toBeDisabled();
    expect(screen.queryByRole("button", { name: "Actions on “Notes”" })).toBeNull();
    expect(screen.getByRole("button", { name: "Add" })).toBeDisabled();
  });

  describe("the course's catalog (F-ORG-16)", () => {
    it("appends a ticked entry as a snapshot with its catalogId, and unticking removes it", async () => {
      const detail = withSettings({ conditions: [{ ...two[0]!, catalogId: catalog[0]!.id }, two[1]!] });
      const { calls } = mockFetch({ [PATCH]: ok(detail), [CATALOG]: ok(catalog) });
      renderWithProviders(<Harness detail={detail} />);
      const dictionary = await screen.findByRole("checkbox", { name: /A dictionary/ });
      expect(dictionary).toBeChecked();
      // The linked row says where it came from; the one-off row does not.
      expect(screen.getAllByText("Catalog")).toHaveLength(1);
      expect(screen.queryByText(/Retired line/)).toBeNull();

      await userEvent.click(screen.getByRole("checkbox", { name: /Smartwatches/ }));
      await waitFor(() =>
        expect(lastPatch(calls)).toEqual({
          settings: {
            conditions: [
              { ...two[0]!, catalogId: catalog[0]!.id },
              two[1],
              { kind: "forbidden", text: "Smartwatches", catalogId: catalog[1]!.id },
            ],
          },
        }),
      );
      await userEvent.click(dictionary);
      await waitFor(() => expect(lastPatch(calls)).toEqual({ settings: { conditions: [two[1]] } }));
    });

    it("shows a condition whose entry left the catalog as a one-off one, and keeps its catalogId", async () => {
      const gone = "33333333-3333-4333-8333-333333333333";
      const detail = withSettings({ conditions: [{ kind: "info", text: "Archived since", catalogId: gone }] });
      const { calls } = mockFetch({ [PATCH]: ok(detail), [CATALOG]: ok(catalog) });
      renderWithProviders(<Harness detail={detail} />);
      expect(await screen.findByRole("checkbox", { name: /A dictionary/ })).not.toBeChecked();
      expect(screen.queryByText("Catalog")).toBeNull();
      await userEvent.click(screen.getByRole("checkbox", { name: /A dictionary/ }));
      await waitFor(() =>
        expect(lastPatch(calls)).toEqual({
          settings: {
            conditions: [
              { kind: "info", text: "Archived since", catalogId: gone },
              { kind: "allowed", text: "A dictionary", catalogId: catalog[0]!.id },
            ],
          },
        }),
      );
    });

    it("disables the unticked entries at 20 conditions, and says where the catalog is kept when empty", async () => {
      const many = Array.from({ length: 20 }, (_, i) => ({ kind: "info" as const, text: `Line ${i}` }));
      mockFetch({ [CATALOG]: ok(catalog) });
      const { unmount } = renderWithProviders(<Harness detail={withSettings({ conditions: many })} />);
      expect(await screen.findByRole("checkbox", { name: /A dictionary/ })).toBeDisabled();
      unmount();

      mockFetch({ [CATALOG]: ok([]) });
      renderWithProviders(<Harness detail={withSettings({ conditions: two })} />);
      expect(await screen.findByText(/The course has no catalog yet/)).toBeInTheDocument();
    });
  });
});
