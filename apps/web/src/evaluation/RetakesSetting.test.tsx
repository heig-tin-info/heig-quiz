import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";

import type { EvaluationDetail } from "@quiz/contracts";

import { EVALUATION_ID, makeEvaluationDetail } from "../test/live-fixtures";
import { mockFetch, ok, renderWithProviders } from "../test/render";
import { RetakesSetting } from "./RetakesSetting";
import { useEvaluationPatch } from "./usePatch";

/* F-EVAL-15 (ADR-025): the retake rule of an exercise, sent whole. */

const exercise = (retakes?: EvaluationDetail["evaluation"]["settings"]["retakes"]) => {
  const detail = makeEvaluationDetail();
  return {
    ...detail,
    evaluation: {
      ...detail.evaluation,
      mode: "exercise" as const,
      settings: { ...detail.evaluation.settings, ...(retakes ? { retakes } : {}) },
    },
  };
};

function Harness({ detail, disabled = false }: { detail: EvaluationDetail; disabled?: boolean }) {
  const patch = useEvaluationPatch(EVALUATION_ID);
  return <RetakesSetting detail={detail} patch={patch} disabled={disabled} />;
}

const PATCH = `PATCH /app/api/evaluations/${EVALUATION_ID}`;

describe("RetakesSetting", () => {
  it("shows one switch while retakes are off, and sends the whole rule when switched on", async () => {
    const detail = exercise();
    const { calls } = mockFetch({ [PATCH]: ok(detail) });
    renderWithProviders(<Harness detail={detail} />);
    expect(screen.queryByText("Result kept")).toBeNull();
    await userEvent.click(screen.getByRole("switch", { name: "Several attempts" }));
    await waitFor(() =>
      expect(calls.find((c) => c.method === "PATCH")?.body).toEqual({
        settings: { retakes: { enabled: true, keep: "best", maxAttempts: null } },
      }),
    );
  });

  it("sets the kept attempt and the maximum, empty meaning no limit", async () => {
    const detail = exercise({ enabled: true, keep: "best", maxAttempts: 3 });
    const { calls } = mockFetch({ [PATCH]: ok(detail) });
    renderWithProviders(<Harness detail={detail} />);

    await userEvent.click(screen.getByRole("radio", { name: "Last" }));
    await waitFor(() =>
      expect(calls.filter((c) => c.method === "PATCH").at(-1)?.body).toEqual({
        settings: { retakes: { enabled: true, keep: "last", maxAttempts: 3 } },
      }),
    );

    const max = screen.getByRole("spinbutton", { name: "Maximum" });
    expect(max).toHaveValue(3);
    await userEvent.clear(max);
    await userEvent.tab();
    await waitFor(() =>
      expect(calls.filter((c) => c.method === "PATCH").at(-1)?.body).toEqual({
        settings: { retakes: { enabled: true, keep: "best", maxAttempts: null } },
      }),
    );
  });

  it("is frozen with the rest of the structure", () => {
    renderWithProviders(
      <Harness detail={exercise({ enabled: true, keep: "best", maxAttempts: null })} disabled />,
    );
    expect(screen.getByRole("switch", { name: "Several attempts" })).toBeDisabled();
    expect(screen.getByRole("spinbutton", { name: "Maximum" })).toBeDisabled();
  });
});
