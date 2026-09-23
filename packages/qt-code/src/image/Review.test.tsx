/** `CodeImageReview`: the graded picture beside the target. */
import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { FINALIZE_CTX, outcome } from "../test/fixtures.js";
import { finalizeRunnerCodeImage } from "./grade.js";
import { CodeImageReview } from "./Review.js";
import { codeimageServer } from "./server.js";
import { imageConfig, IMG_SECRET_REFERENCE } from "./test/fixtures.js";

const config = imageConfig();
const view = { seed: 0, itemId: "i", shuffle: false };
const student = codeimageServer.toStudent(config, view);
const answer = { regions: ["x"] };

function graded(stdout: string, compile = {}) {
  return finalizeRunnerCodeImage(config, answer, FINALIZE_CTX, outcome([{ stdout }], compile));
}

describe("CodeImageReview", () => {
  it("shows the score, the picture and its difference with the target", () => {
    const g = graded("1 0 1 0\n0 1 0 1\n1 0 1 1\n");
    render(
      <CodeImageReview
        student={student}
        answer={answer}
        solution={null}
        details={g.details}
        points={g.points}
        maxPoints={g.maxPoints}
        audience="student"
      />,
    );
    expect(screen.getByText("9.17 / 10 points")).toBeInTheDocument();
    expect(screen.getByText("11 / 12 pixels correct (91.6 %)")).toBeInTheDocument();
    expect(screen.getByRole("img", { name: "Your image" })).toBeInTheDocument();
    expect(screen.getByRole("img", { name: "Difference with the target" })).toBeInTheDocument();
  });

  it("shows the compiler's refusal", () => {
    const g = graded("", { ok: false, stderr: "main.c: error" });
    render(
      <CodeImageReview
        student={student}
        answer={answer}
        solution={null}
        details={g.details}
        points={0}
        maxPoints={10}
        audience="student"
      />,
    );
    expect(screen.getByText("Compilation failed")).toBeInTheDocument();
    expect(screen.getByText("main.c: error")).toBeInTheDocument();
  });

  it("shows the reference solution only when the solution travels", () => {
    const g = graded("1");
    const { rerender } = render(
      <CodeImageReview
        student={student}
        answer={answer}
        solution={null}
        details={g.details}
        points={g.points}
        maxPoints={10}
        audience="student"
      />,
    );
    expect(screen.queryByText(/secret-image-reference/)).toBeNull();
    rerender(
      <CodeImageReview
        student={student}
        answer={answer}
        solution={codeimageServer.toSolution(config, view)}
        details={g.details}
        points={g.points}
        maxPoints={10}
        audience="teacher"
      />,
    );
    expect(screen.getByText(IMG_SECRET_REFERENCE.trim(), { exact: false })).toBeInTheDocument();
  });

  it("reads a grading-level marker as 'not answered'", () => {
    render(
      <CodeImageReview
        student={student}
        answer={null}
        solution={null}
        details={{ reason: "no_answer" } as never}
        points={0}
        maxPoints={10}
        audience="student"
      />,
    );
    expect(screen.getByText("Not answered.")).toBeInTheDocument();
  });
});
