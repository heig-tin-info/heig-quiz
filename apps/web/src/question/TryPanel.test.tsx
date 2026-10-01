import { screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";

import type { TryResult } from "@quiz/contracts";

import { mockFetch, ok, renderWithProviders } from "../test/render";
import { TryPanel } from "./TryPanel";

/*
 * The try panel's verdict line (issue #267): a PROPOSED grade — an essay, a
 * manual circuit — is not a score, and when the grader says why it only
 * proposed, the author reads the reason.
 */

const PREVIEW = {
  type: "mcq",
  student: {
    prompt: "Que vaut un pointeur non initialisé ?",
    choices: [
      { id: 0, text: "NULL" },
      { id: 1, text: "Une valeur indéterminée" },
    ],
    mode: "single",
  },
  itemPoints: 1,
  parameterized: false,
};

function renderWith(result: TryResult) {
  mockFetch({
    "POST /app/api/questions/q1/preview": ok(PREVIEW),
    "POST /app/api/questions/q1/try": ok(result),
  });
  renderWithProviders(<TryPanel questionId="q1" type="mcq" />);
}

const graded = { status: "graded", points: 0, maxPoints: 1, details: null, solution: null } as const;

describe("TryPanel — a proposed grade", () => {
  it("shows the score of a grade", async () => {
    renderWith(graded);
    await userEvent.click(await screen.findByRole("button", { name: "Grade my answer" }));
    expect(await screen.findByText("0 of 1 points")).toBeInTheDocument();
  });

  it("says 'to grade by hand' instead of a score", async () => {
    renderWith({ ...graded, manual: true });
    await userEvent.click(await screen.findByRole("button", { name: "Grade my answer" }));
    expect(await screen.findByText("To grade by hand")).toBeInTheDocument();
    expect(screen.queryByText("0 of 1 points")).toBeNull();
  });

  it("gives the grader's reason, in words, when it gave one", async () => {
    renderWith({ ...graded, manual: true, comment: "reference_failed" });
    await userEvent.click(await screen.findByRole("button", { name: "Grade my answer" }));
    expect(
      await screen.findByText(/Your reference circuit did not simulate/),
    ).toBeInTheDocument();
  });
});

describe("TryPanel — a parameterized question", () => {
  it("says the question is tried on draw 1 of the five, as the server says", async () => {
    mockFetch({ "POST /app/api/questions/q1/preview": ok({ ...PREVIEW, parameterized: true }) });
    renderWithProviders(<TryPanel questionId="q1" type="mcq" />);
    expect(await screen.findByText(/you answer draw 1 of the five/)).toBeInTheDocument();
  });
});
