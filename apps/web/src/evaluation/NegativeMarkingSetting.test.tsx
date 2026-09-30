import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";

import type { EvaluationDetail } from "@quiz/contracts";

import { EVALUATION_ID, makeEvaluationDetail } from "../test/live-fixtures";
import { mockFetch, ok, renderWithProviders } from "../test/render";
import { AdvancedDisclosure } from "./AdvancedDisclosure";
import { evaluationTarget } from "./editTarget";
import { useConfigPatch } from "./usePatch";

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

function Harness({
  detail,
  disabled = false,
  holdsCategorize = false,
}: {
  detail: EvaluationDetail;
  disabled?: boolean;
  holdsCategorize?: boolean;
}) {
  const patch = useConfigPatch(evaluationTarget(EVALUATION_ID));
  return (
    <AdvancedDisclosure
      config={detail.evaluation}
      patch={patch}
      disabled={disabled}
      feedbackDisabled={false}
      holdsCategorize={holdsCategorize}
    />
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

/* ADR-036: the categorize policy, what an `inherit` categorize question defers to. */
describe("the categorize policy setting", () => {
  it("reads per card when absent, and sends the setting alone", async () => {
    const detail = withMode("exam");
    const { calls } = mockFetch({ [PATCH]: ok(detail) });
    renderWithProviders(<Harness detail={detail} holdsCategorize />);
    await open();
    const group = screen.getByRole("radiogroup", { name: "Categorize scoring" });
    expect(within(group).getByRole("radio", { name: "Per card" })).toBeChecked();
    await userEvent.click(within(group).getByRole("radio", { name: "Exact" }));
    await waitFor(() =>
      expect(calls.find((c) => c.method === "PATCH")?.body).toEqual({
        settings: { categorizePolicy: "all_or_nothing" },
      }),
    );
  });

  it("says, on both policy rows, that negative marking replaces them while it is on", async () => {
    renderWithProviders(<Harness detail={withMode("exam", true)} holdsCategorize />);
    await open();
    expect(screen.getAllByText(/Negative marking is on and replaces this policy\./)).toHaveLength(2);
  });

  it("is not offered while the evaluation holds no categorize question", async () => {
    renderWithProviders(<Harness detail={withMode("exam")} />);
    await open();
    expect(screen.queryByRole("radiogroup", { name: "Categorize scoring" })).toBeNull();
  });
});

/* ADR-051 §2: kiosk stations, an exam's second trusted client, under SEB. */
describe("the kiosk-station setting", () => {
  const exam = (kiosk?: boolean): EvaluationDetail => {
    const detail = withMode("exam");
    return kiosk === undefined
      ? detail
      : { ...detail, evaluation: { ...detail.evaluation, settings: { ...detail.evaluation.settings, kiosk } } };
  };
  const config = (kiosk: boolean) => ({ "GET /app/api/config": ok({ devLogin: false, kiosk }) });

  it("is offered on an exam where the kiosk path exists, and sends the switch alone", async () => {
    const detail = exam();
    const { calls } = mockFetch({ ...config(true), [PATCH]: ok(detail) });
    renderWithProviders(<Harness detail={detail} />);
    await open();
    const toggle = await screen.findByRole("switch", { name: "Kiosk stations" });
    expect(toggle).not.toBeChecked();
    // Beside Safe Exam Browser, not instead of it.
    expect(screen.getByRole("switch", { name: "Safe Exam Browser" })).toBeInTheDocument();
    await userEvent.click(toggle);
    await waitFor(() =>
      expect(calls.find((c) => c.method === "PATCH")?.body).toEqual({ settings: { kiosk: true } }),
    );
  });

  it("is not offered where the platform has no kiosk path, nor on an exercise", async () => {
    mockFetch(config(false));
    const { unmount } = renderWithProviders(<Harness detail={exam()} />);
    await open();
    await waitFor(() => expect(screen.getByRole("switch", { name: "Safe Exam Browser" })).toBeInTheDocument());
    expect(screen.queryByRole("switch", { name: "Kiosk stations" })).toBeNull();
    unmount();
    mockFetch(config(true));
    renderWithProviders(<Harness detail={withMode("exercise")} />);
    await open();
    expect(screen.queryByRole("switch", { name: "Kiosk stations" })).toBeNull();
  });

  it("stays in sight while it is on, so it can be turned off, even without the kiosk path", async () => {
    mockFetch(config(false));
    renderWithProviders(<Harness detail={exam(true)} />);
    await open();
    expect(screen.getByRole("switch", { name: "Kiosk stations" })).toBeChecked();
  });
});
