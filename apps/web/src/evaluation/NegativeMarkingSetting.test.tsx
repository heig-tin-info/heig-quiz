import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";

import { mockFetch, ok, renderWithProviders } from "../test/render";
import { Harness, open, PATCH, withMode } from "../test/advancedDisclosure";

/* ADR-026 (#130): negative marking, one choice of the multiple-answer
   select for the whole evaluation; the wire keeps it beside the policy. */

const scoring = () => screen.getByRole("combobox", { name: "Multiple-answer scoring" });
const patchBody = (calls: { method: string; body?: unknown }[]) => calls.find((c) => c.method === "PATCH")?.body;

describe("the negative-marking choice", () => {
  it("is off by default, and choosing it sends the setting alone, the policy kept", async () => {
    const detail = withMode("exam");
    const { calls } = mockFetch({ [PATCH]: ok(detail) });
    renderWithProviders(<Harness detail={detail} />);
    await open();
    expect(scoring()).toHaveValue(detail.evaluation.mcqPolicy);
    await userEvent.selectOptions(scoring(), "Negative marking");
    await waitFor(() => expect(patchBody(calls)).toEqual({ settings: { negativeMarking: true } }));
  });

  it("shows while on, says what it does, and a policy chosen again turns it off", async () => {
    const detail = withMode("exam", { negativeMarking: true });
    const { calls } = mockFetch({ [PATCH]: ok(detail) });
    renderWithProviders(<Harness detail={detail} />);
    await open();
    expect(scoring()).toHaveValue("negative");
    expect(screen.getByText(/A wrong answer costs points, no answer costs none/)).toBeVisible();
    await userEvent.selectOptions(scoring(), "Ripkey");
    await waitFor(() =>
      expect(patchBody(calls)).toEqual({ mcqPolicy: "ripkey", settings: { negativeMarking: false } }),
    );
  });

  it("sends a policy alone while negative marking is off", async () => {
    const detail = withMode("exam");
    const { calls } = mockFetch({ [PATCH]: ok(detail) });
    renderWithProviders(<Harness detail={detail} />);
    await open();
    await userEvent.selectOptions(scoring(), "Symmetric");
    await waitFor(() => expect(patchBody(calls)).toEqual({ mcqPolicy: "symmetric" }));
  });

  it("shows the stored value, frozen with the rest of the structure", async () => {
    renderWithProviders(<Harness detail={withMode("exercise", { negativeMarking: true })} disabled />);
    await open();
    expect(scoring()).toHaveValue("negative");
    expect(scoring()).toBeDisabled();
  });

  it("is not offered on a poll, which has no score", async () => {
    renderWithProviders(<Harness detail={withMode("poll", { negativeMarking: true })} />);
    await open();
    expect(screen.queryByRole("option", { name: "Negative marking" })).toBeNull();
    expect(scoring()).not.toHaveValue("negative");
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
    await userEvent.click(within(group).getByRole("radio", { name: "All or nothing" }));
    await waitFor(() =>
      expect(calls.find((c) => c.method === "PATCH")?.body).toEqual({
        settings: { categorizePolicy: "all_or_nothing" },
      }),
    );
  });

  it("is hidden while negative marking, which replaces it too, is chosen", async () => {
    renderWithProviders(<Harness detail={withMode("exam", { negativeMarking: true })} holdsCategorize />);
    await open();
    expect(screen.queryByRole("radiogroup", { name: "Categorize scoring" })).toBeNull();
  });

  it("is not offered while the evaluation holds no categorize question", async () => {
    renderWithProviders(<Harness detail={withMode("exam")} />);
    await open();
    expect(screen.queryByRole("radiogroup", { name: "Categorize scoring" })).toBeNull();
  });
});

