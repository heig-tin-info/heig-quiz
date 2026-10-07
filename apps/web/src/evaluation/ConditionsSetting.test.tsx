import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";

import type { EvaluationDetail, EvaluationSettings } from "@quiz/contracts";

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
  return <ConditionsSetting config={detail.evaluation} patch={patch} disabled={disabled} />;
}

const PATCH = `PATCH /app/api/evaluations/${EVALUATION_ID}`;
const two = [
  { kind: "allowed" as const, text: "Notes" },
  { kind: "forbidden" as const, text: "Phones" },
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
});
