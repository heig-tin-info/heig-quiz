import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";

import type { EvaluationDetail } from "@quiz/contracts";

import { EVALUATION_ID, makeEvaluationDetail } from "../test/live-fixtures";
import { mockFetch, ok, renderWithProviders } from "../test/render";
import { evaluationTarget } from "./editTarget";
import { ModeControl } from "./ModeChoice";
import { useConfigPatch } from "./usePatch";

/* ADR-092: the mode is a control while it can change, the badge it was otherwise. */

const detailOf = (
  mode: "exam" | "exercise",
  over: Partial<EvaluationDetail["evaluation"]> = {},
): EvaluationDetail => {
  const detail = makeEvaluationDetail();
  return { ...detail, evaluation: { ...detail.evaluation, mode, ...over } };
};

function Harness({
  detail,
  changeable = true,
  scheduled = false,
}: {
  detail: EvaluationDetail;
  changeable?: boolean;
  scheduled?: boolean;
}) {
  const patch = useConfigPatch(evaluationTarget(EVALUATION_ID));
  return <ModeControl config={detail.evaluation} changeable={changeable} scheduled={scheduled} patch={patch} />;
}

const PATCH = `PATCH /app/api/evaluations/${EVALUATION_ID}`;

describe("ModeControl", () => {
  it("is a two-option control that patches only the mode", async () => {
    const detail = detailOf("exam");
    const { calls } = mockFetch({ [PATCH]: ok(detail) });
    renderWithProviders(<Harness detail={detail} />);
    expect(screen.getByRole("radio", { name: "Exam" })).toBeChecked();
    await userEvent.click(screen.getByRole("radio", { name: "Exercise" }));
    await waitFor(() => expect(calls.find((c) => c.method === "PATCH")?.body).toEqual({ mode: "exercise" }));
  });

  it("is the read-only badge once the mode is frozen", () => {
    mockFetch({});
    renderWithProviders(<Harness detail={detailOf("exam")} changeable={false} />);
    expect(screen.queryByRole("radiogroup")).toBeNull();
    expect(screen.getByText("Exam")).toBeInTheDocument();
  });

  it("disables the exam option, with its hint, while retakes are on", () => {
    const base = detailOf("exercise");
    const detail = detailOf("exercise", {
      settings: { ...base.evaluation.settings, retakes: { enabled: true, keep: "best", maxAttempts: null } },
    });
    mockFetch({});
    renderWithProviders(<Harness detail={detail} />);
    expect(screen.getByRole("radio", { name: "Exam" })).toBeDisabled();
    expect(screen.getByRole("radio", { name: "Exercise" })).toBeEnabled();
    expect(screen.getAllByText("Turn off multiple attempts first.").length).toBeGreaterThan(0);
  });

  it("asks first when the evaluation is scheduled, and writes nothing on Cancel", async () => {
    const detail = detailOf("exam");
    const { calls } = mockFetch({ [PATCH]: ok(detail) });
    renderWithProviders(<Harness detail={detail} scheduled />);
    await userEvent.click(screen.getByRole("radio", { name: "Exercise" }));
    expect(await screen.findByText(/Students already see this evaluation/)).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(calls.filter((c) => c.method === "PATCH")).toEqual([]);

    await userEvent.click(screen.getByRole("radio", { name: "Exercise" }));
    await userEvent.click(await screen.findByRole("button", { name: /Switch to: Exercise/ }));
    await waitFor(() => expect(calls.find((c) => c.method === "PATCH")?.body).toEqual({ mode: "exercise" }));
  });

  it("says so when immediate feedback falls back going to an exam", async () => {
    const base = detailOf("exercise");
    const detail = detailOf("exercise", {
      feedbackPolicy: { ...base.evaluation.feedbackPolicy, when: "immediate" },
    });
    mockFetch({ [PATCH]: ok(detail) });
    renderWithProviders(<Harness detail={detail} />);
    await userEvent.click(screen.getByRole("radio", { name: "Exam" }));
    expect(await screen.findByText(/An exam never gives feedback immediately/)).toBeInTheDocument();
  });
});
