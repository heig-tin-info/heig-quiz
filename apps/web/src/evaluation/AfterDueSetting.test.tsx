import { screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

import { makeEvaluationDetail } from "../test/grading-fixtures";
import { mockFetch, ok, renderWithProviders } from "../test/render";
import { AfterDueSetting } from "./AfterDueSetting";

/*
 * "Practice after the due date" (ADR-122): one switch on an exercise, its
 * own writer, its value the effective one — the default included, open on
 * every exercise (ADR-124).
 */

afterEach(() => {
  vi.unstubAllGlobals();
});

const exercise = (over: { afterDueOpen: boolean; afterDue?: "open" | "hidden" }) => {
  const detail = makeEvaluationDetail();
  return {
    ...detail,
    evaluation: {
      ...detail.evaluation,
      mode: "exercise" as const,
      afterDueOpen: over.afterDueOpen,
      settings: { ...detail.evaluation.settings, ...(over.afterDue ? { afterDue: over.afterDue } : {}) },
    },
  };
};

describe("the after-due practice switch", () => {
  it("is on by default and hides the practice through its own writer", async () => {
    const user = userEvent.setup();
    const detail = exercise({ afterDueOpen: true });
    const { calls } = mockFetch({
      [`PUT /app/api/evaluations/${detail.evaluation.id}/after-due`]: ok(exercise({ afterDueOpen: false, afterDue: "hidden" })),
    });
    renderWithProviders(<AfterDueSetting detail={detail} />);
    const toggle = screen.getByRole("switch", { name: "Practice after the due date" });
    expect(toggle).toHaveAttribute("aria-checked", "true");
    expect(screen.getByText("Once over, the exercise stays open for practice. It never counts.")).toBeVisible();
    await user.click(toggle);
    await vi.waitFor(() => expect(calls.find((c) => c.method === "PUT")?.body).toEqual({ afterDue: "hidden" }));
  });

  it("reads off once the teacher hid it, as the server reports it", () => {
    mockFetch({});
    renderWithProviders(<AfterDueSetting detail={exercise({ afterDueOpen: false, afterDue: "hidden" })} />);
    expect(screen.getByRole("switch", { name: "Practice after the due date" })).toHaveAttribute("aria-checked", "false");
  });
});
