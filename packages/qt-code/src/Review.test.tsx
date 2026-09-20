import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { finalizeRunnerCode, studentDetails } from "./grade.js";
import { CodeReview } from "./Review.js";
import type { CodeAnswer, CodeDetails } from "./schema.js";
import { codeServer } from "./server.js";
import { codeConfig, FINALIZE_CTX, outcome } from "./test/fixtures.js";

const config = codeConfig();
const student = codeServer.toStudent(config, { seed: 7, itemId: "i", shuffle: false });
const answer: CodeAnswer = { regions: ["#include <stdio.h>\n", "    return 6;\n"] };

/** One passing visible case, one failing visible case, one passing hidden case. */
const graded = finalizeRunnerCode(
  config,
  answer,
  FINALIZE_CTX,
  outcome([{ stdout: "6\n" }, { stdout: "nope" }, { stdout: "5 (hidden-expected-marker)" }]),
);

function setup(details: CodeDetails | null, props: Partial<React.ComponentProps<typeof CodeReview>> = {}) {
  render(
    <CodeReview
      student={student}
      answer={answer}
      solution={null}
      details={details}
      points={graded.points}
      maxPoints={10}
      audience="student"
      {...props}
    />,
  );
}

describe("CodeReview", () => {
  it("shows the score and one row per visible case", () => {
    setup(studentDetails(graded.details));
    expect(screen.getByText("7.5 / 10 points")).toBeInTheDocument();
    expect(screen.getByText("three items")).toBeInTheDocument();
    expect(screen.getByText("Passed")).toBeInTheDocument();
    expect(screen.getByText("Failed")).toBeInTheDocument();
  });

  it("counts the hidden cases instead of naming them", () => {
    setup(studentDetails(graded.details));
    expect(screen.getByText("Hidden cases: 1 of 1 passed.")).toBeInTheDocument();
    expect(screen.queryByText("negative-values")).toBeNull();
    expect(screen.queryByText("5 (hidden-expected-marker)")).toBeNull();
  });

  it("names them once the feedback policy opens them (docs/06 Q8)", () => {
    setup(studentDetails(graded.details, { showHiddenCaseNames: true }), {
      showHiddenCaseNames: true,
    });
    expect(screen.getByText("negative-values")).toBeInTheDocument();
    expect(screen.getByText("Hidden case")).toBeInTheDocument();
    // Even then, the expected output of a hidden case stays closed.
    expect(screen.queryByText("5 (hidden-expected-marker)")).toBeNull();
  });

  it("shows everything to a teacher", () => {
    setup(graded.details, { audience: "teacher" });
    expect(screen.getByText("negative-values")).toBeInTheDocument();
    // Expected AND actual output of the hidden case: the teacher sees both.
    expect(screen.getAllByText("5 (hidden-expected-marker)")).toHaveLength(2);
  });

  it("puts the compiler output first when the build failed", () => {
    const failed = finalizeRunnerCode(
      config,
      answer,
      FINALIZE_CTX,
      outcome([], { ok: false, stderr: "main.c:7: error: expected ';' before '}'" }),
    );
    setup(failed.details, { points: 0 });
    expect(screen.getByText("Compilation failed")).toBeInTheDocument();
    expect(screen.getByLabelText("Compiler output").textContent).toContain("expected ';'");
  });

  it("says when the answer is waiting for a human", () => {
    setup({ ...graded.details, runner: "unavailable" });
    expect(
      screen.getByText("The runner was unavailable; this answer is waiting for a manual grade."),
    ).toBeInTheDocument();
  });

  it("renders the reference solution only when the host passes one", () => {
    setup(studentDetails(graded.details));
    expect(screen.queryByText("Reference solution")).toBeNull();

    setup(studentDetails(graded.details), {
      solution: codeServer.toSolution(config, { seed: 0, itemId: "i", shuffle: false }),
    });
    expect(screen.getByText("Reference solution")).toBeInTheDocument();
  });

  it("says so when nothing was answered at all", () => {
    setup(null, { answer: null });
    expect(screen.getByText("Not answered.")).toBeInTheDocument();
  });
});
