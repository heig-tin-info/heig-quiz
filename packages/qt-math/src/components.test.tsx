/**
 * Smoke tests: the components render, report every change and keep no
 * state. Under jsdom MathLive resolves to its server build, so the math
 * field falls back to its LaTeX input — the surface a test can type in.
 */
import { render, screen } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import { MathEditor } from "./Editor.js";
import { MathPlayer } from "./Player.js";
import { MathReview } from "./Review.js";
import { emptyMathDraft } from "./schema.js";
import { mathServer } from "./server.js";
import { config, SECRET_CONFIG } from "./test/fixtures.js";

const student = mathServer.toStudent(SECRET_CONFIG, { seed: 1, itemId: "i", shuffle: false });

describe("MathEditor", () => {
  it("renders the statement, the variables and the first key, echoed as read", () => {
    render(<MathEditor config={SECRET_CONFIG} onChange={() => {}} />);
    expect(screen.getByLabelText("Statement")).toHaveValue(SECRET_CONFIG.prompt);
    expect(screen.getByLabelText("Name 1")).toHaveValue("R_1");
    expect(screen.getByLabelText("From 2")).toHaveValue(1);
    expect(screen.getByLabelText("Expression 1 (LaTeX)")).toHaveValue("\\frac{R_1 R_2}{R_1+R_2}");
    expect(screen.getAllByText("Read as")).toHaveLength(2);
  });

  it("reports a typed key without keeping it, and says why a key does not read", async () => {
    const onChange = vi.fn();
    render(<MathEditor config={config({ answers: [{ value: "x+y", points: 1 }] })} onChange={onChange} />);
    expect(screen.getByText("Unknown variable: y. The variables are x.")).toBeInTheDocument();
    await userEvent.type(screen.getByLabelText("Expression 1 (LaTeX)"), "2");
    expect(onChange).toHaveBeenCalledWith(expect.objectContaining({ answers: [{ value: "x+y2", points: 1 }] }));
  });

  it("adds and removes rows through onChange", async () => {
    const onChange = vi.fn();
    render(<MathEditor config={config()} onChange={onChange} />);
    await userEvent.click(screen.getByRole("button", { name: "Add a variable" }));
    expect(onChange.mock.calls[0]?.[0].symbols).toHaveLength(2);
    await userEvent.click(screen.getByRole("button", { name: "Add an accepted answer" }));
    expect(onChange.mock.calls[1]?.[0].answers).toEqual([{ value: "2x^2-3", points: 1 }, { value: "", points: 1 }]);
    expect(screen.getByRole("button", { name: "Remove the variable x" })).toBeDisabled();
  });

  it("toggles a forbidden function as a chip", async () => {
    const onChange = vi.fn();
    render(<MathEditor config={SECRET_CONFIG} onChange={onChange} />);
    expect(screen.getByRole("button", { name: "sin" })).toHaveAttribute("aria-pressed", "true");
    await userEvent.click(screen.getByRole("button", { name: "cos" }));
    expect(onChange.mock.calls[0]?.[0].forbidden).toEqual(["sin", "cos"]);
    await userEvent.click(screen.getByRole("button", { name: "sin" }));
    expect(onChange.mock.calls[1]?.[0].forbidden).toEqual([]);
  });

  it("offers the graph only with one variable", () => {
    const { rerender } = render(<MathEditor config={config()} onChange={() => {}} />);
    expect(screen.getByLabelText("With target")).toBeEnabled();
    rerender(<MathEditor config={SECRET_CONFIG} onChange={() => {}} />);
    expect(screen.getByLabelText("With target")).toBeDisabled();
  });

  it("renders the empty draft", () => {
    render(<MathEditor config={emptyMathDraft()} onChange={() => {}} />);
    expect(screen.getByLabelText("Name 1")).toHaveValue("x");
  });
});

describe("MathPlayer", () => {
  it("echoes how the answer was read, and names what is wrong", () => {
    const onChange = vi.fn();
    const { rerender } = render(<MathPlayer student={student} answer={{ latex: "R_1 R_2/(R_1+R_2)" }} onChange={onChange} readOnly={false} />);
    expect(screen.getByText(/the variables are R_1, R_2/)).toBeInTheDocument();
    expect(screen.getByTestId("math-echo")).toHaveTextContent("Read as");
    rerender(<MathPlayer student={student} answer={{ latex: "R_3" }} onChange={onChange} readOnly={false} />);
    expect(screen.getByText("Unknown variable: R_3. The variables are R_1, R_2.")).toBeInTheDocument();
    rerender(<MathPlayer student={student} answer={{ latex: "\\sin(R_1)" }} onChange={onChange} readOnly={false} />);
    expect(screen.getByText("Not allowed here: sin.")).toBeInTheDocument();
    rerender(<MathPlayer student={student} answer={{ latex: "R_1!" }} onChange={onChange} readOnly={false} />);
    expect(screen.getByText(/Not available here: Factorial/)).toBeInTheDocument();
  });

  it("reports what is typed without keeping it", async () => {
    const onChange = vi.fn();
    render(<MathPlayer student={student} answer={{ latex: "" }} onChange={onChange} readOnly={false} />);
    await userEvent.type(screen.getByLabelText("Your answer (LaTeX)"), "R");
    expect(onChange).toHaveBeenCalledWith({ latex: "R" });
    expect(screen.getByLabelText("Your answer (LaTeX)")).toHaveValue("");
  });

  it("locks the field when read-only", () => {
    render(<MathPlayer student={student} answer={{ latex: "R_1" }} onChange={() => {}} readOnly />);
    expect(screen.getByLabelText("Your answer (LaTeX)")).toBeDisabled();
  });

  it("draws the answer and the target when the question has a graph", () => {
    const plotted = mathServer.toStudent(config({ plot: "target" }), { seed: 1, itemId: "i", shuffle: false });
    const { container, rerender } = render(<MathPlayer student={plotted} answer={{ latex: "x^2" }} onChange={() => {}} readOnly={false} />);
    expect(container.querySelectorAll("path[data-curve]")).toHaveLength(2);
    expect(container.querySelector("path[data-curve=answer]")?.getAttribute("d")).toMatch(/^M/);
    rerender(<MathPlayer student={plotted} answer={{ latex: "x^" }} onChange={() => {}} readOnly={false} />);
    expect(container.querySelectorAll("path[data-curve]")).toHaveLength(1);
  });

  it("lists the key under the field in a teacher's preview", () => {
    render(
      <MathPlayer
        student={student}
        answer={{ latex: "" }}
        onChange={() => {}}
        readOnly={false}
        answerKey={mathServer.toSolution(SECRET_CONFIG, { seed: 1, itemId: "i", shuffle: false })}
      />,
    );
    expect(screen.getByText("Accepted answers")).toBeInTheDocument();
    expect(screen.getByText("$R_1+R_2$")).toBeInTheDocument();
  });
});

describe("MathReview", () => {
  const solution = mathServer.toSolution(SECRET_CONFIG, { seed: 1, itemId: "i", shuffle: false });

  it("shows the verdict, the echo and the accepted answers", () => {
    render(
      <MathReview
        student={student}
        answer={{ latex: "R_1+R_2" }}
        solution={solution}
        details={{ status: "graded", matchedIndex: 1, fraction: 0.25, latex: "\\mathrm{R_1}+\\mathrm{R_2}" }}
        points={0.25}
        maxPoints={1}
        audience="teacher"
      />,
    );
    expect(screen.getByText("Partially accepted")).toBeInTheDocument();
    expect(screen.getByText("Matched accepted answer #2")).toBeInTheDocument();
    expect(screen.getByText("$\\mathrm{R_1}+\\mathrm{R_2}$")).toBeInTheDocument();
    expect(screen.getByText("(0.25)")).toBeInTheDocument();
    expect(screen.getByText("0.25 / 1")).toBeInTheDocument();
  });

  it("says why an answer was not readable, from the stored details, and hides the key when the policy does", () => {
    render(
      <MathReview
        student={student}
        answer={{ latex: "R_1+R_3" }}
        solution={null}
        details={{ status: "invalid", problem: { code: "unknown_symbol", names: ["R_3"] }, matchedIndex: null, fraction: 0, latex: null }}
        points={0}
        maxPoints={1}
        audience="student"
      />,
    );
    expect(screen.getByText("Not readable")).toBeInTheDocument();
    expect(screen.getByText("Unknown variable: R_3. The variables are R_1, R_2.")).toBeInTheDocument();
    expect(screen.queryByText("Accepted answers")).not.toBeInTheDocument();
  });

  it("reads 'No answer' and a dash before grading", () => {
    render(<MathReview student={student} answer={null} solution={solution} details={null} points={null} maxPoints={1} audience="student" />);
    expect(screen.getByText("No answer")).toBeInTheDocument();
    expect(screen.getByText("— / 1")).toBeInTheDocument();
  });
});
