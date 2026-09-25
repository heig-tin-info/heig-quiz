import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";

import type { EvaluationDetail } from "@quiz/contracts";

import { EVALUATION_ID, makeEvaluationDetail } from "../test/live-fixtures";
import { mockFetch, ok, renderWithProviders } from "../test/render";
import { AdvancedDisclosure } from "./AdvancedDisclosure";
import { useEvaluationPatch } from "./usePatch";

/* ADR-026 (#130): negative marking, one switch for the whole evaluation. */

const withMode = (
  mode: EvaluationDetail["evaluation"]["mode"],
  negativeMarking?: boolean,
): EvaluationDetail => {
  const detail = makeEvaluationDetail();
  return {
    ...detail,
    evaluation: {
      ...detail.evaluation,
      mode,
      settings: {
        ...detail.evaluation.settings,
        ...(negativeMarking === undefined ? {} : { negativeMarking }),
      },
    },
  };
};

function Harness({ detail, disabled = false }: { detail: EvaluationDetail; disabled?: boolean }) {
  const patch = useEvaluationPatch(EVALUATION_ID);
  return (
    <AdvancedDisclosure detail={detail} patch={patch} disabled={disabled} feedbackDisabled={false} />
  );
}

const PATCH = `PATCH /app/api/evaluations/${EVALUATION_ID}`;

async function open() {
  await userEvent.click(screen.getByRole("button", { name: /^advanced options$/i }));
}

describe("the negative-marking setting", () => {
  it("is off by default, says what it does, and sends the switch alone", async () => {
    const detail = withMode("exam");
    const { calls } = mockFetch({ [PATCH]: ok(detail) });
    renderWithProviders(<Harness detail={detail} />);
    await open();
    const toggle = screen.getByRole("switch", { name: "Negative marking" });
    expect(toggle).not.toBeChecked();
    expect(screen.getByText(/a wrong answer costs points and no answer costs nothing/)).toBeVisible();
    await userEvent.click(toggle);
    await waitFor(() =>
      expect(calls.find((c) => c.method === "PATCH")?.body).toEqual({
        settings: { negativeMarking: true },
      }),
    );
  });

  it("shows the stored value, frozen with the rest of the structure", async () => {
    renderWithProviders(<Harness detail={withMode("exercise", true)} disabled />);
    await open();
    const toggle = screen.getByRole("switch", { name: "Negative marking" });
    expect(toggle).toBeChecked();
    expect(toggle).toBeDisabled();
  });

  it("is not offered on a poll, which has no score", async () => {
    renderWithProviders(<Harness detail={withMode("poll")} />);
    await open();
    expect(screen.queryByRole("switch", { name: "Negative marking" })).toBeNull();
  });
});
