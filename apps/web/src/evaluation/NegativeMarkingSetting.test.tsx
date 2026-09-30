import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";

import { mockFetch, ok, renderWithProviders } from "../test/render";
import { Harness, open, PATCH, withMode } from "../test/advancedDisclosure";

/* ADR-026 (#130): negative marking, one switch for the whole evaluation. */

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
    renderWithProviders(<Harness detail={withMode("exercise", { negativeMarking: true })} disabled />);
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
    renderWithProviders(<Harness detail={withMode("exam", { negativeMarking: true })} holdsCategorize />);
    await open();
    expect(screen.getAllByText(/Negative marking is on and replaces this policy\./)).toHaveLength(2);
  });

  it("is not offered while the evaluation holds no categorize question", async () => {
    renderWithProviders(<Harness detail={withMode("exam")} />);
    await open();
    expect(screen.queryByRole("radiogroup", { name: "Categorize scoring" })).toBeNull();
  });
});

