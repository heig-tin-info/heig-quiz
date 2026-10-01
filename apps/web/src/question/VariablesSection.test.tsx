import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { describe, expect, it, vi } from "vitest";

import type { DraftInstances, ParametersDraft, ZodIssueLite } from "@quiz/contracts";

import { elapse, flowingClock } from "../test/clock";
import { mockFetch, ok, renderWithProviders } from "../test/render";
import { isVariablesIssue, reconcileRows, VariablesSection } from "./VariablesSection";

/*
 * The Variables section of a parameterized question (ADR-056 §8): behind a
 * disclosure while the question is static, open on its table once it is
 * not; its rows edited into the draft's `variables`, the last one removed
 * making the question static again; issues on their row; and the five
 * draws, computed by the API, never in the browser.
 */

const FALL: ParametersDraft = {
  rows: [
    { name: "h", expr: "randint(10, 100)", format: "int" },
    { name: "g", expr: "choice([3.71, 9.81, 24.79])", format: ".2" },
    { name: "t", expr: "sqrt(2*h/g)", format: ".2" },
  ],
  condition: "t > 1.5",
};

const DRAWS: DraftInstances = {
  issues: [],
  instances: [0, 1, 2, 3, 4].map((seed) => ({
    seed,
    values: [
      { name: "h", value: String(40 + seed) },
      { name: "g", value: "9.81" },
      { name: "t", value: `2.${seed}0` },
    ],
    student: { prompt: `Une bille tombe de ${40 + seed} m.`, kind: "number", constraints: { minLength: 0, maxLength: 255, integer: false } },
    solution: { expected: [`2.${seed}0 ± 0.01`] },
    itemPoints: 1,
    explanation: `La chute dure 2.${seed}0 s.`,
  })),
};

/** The section under a draft whose statement is a plain text field, as the type's form would hold it. */
function Host({
  initial,
  issues = [],
  onChange = () => {},
  prompt: initialPrompt = "",
}: {
  initial: ParametersDraft | null;
  issues?: ZodIssueLite[];
  onChange?: (next: ParametersDraft | null) => void;
  prompt?: string;
}) {
  const [variables, setVariables] = useState(initial);
  const [prompt, setPrompt] = useState(initialPrompt);
  return (
    <>
      <textarea aria-label="Statement" value={prompt} onChange={(e) => setPrompt(e.target.value)} />
      <VariablesSection
        questionId="q1"
        type="short"
        config={{ prompt }}
        explanation=""
        variables={variables}
        onChange={(next) => {
          onChange(next);
          setVariables(next);
        }}
        issues={issues}
        disabled={false}
        savedStamp="2026-10-01T10:00:00.000Z"
        dirty={false}
      />
    </>
  );
}

/** Writes the statement as a whole, as a paste would: `[` means nothing to `fireEvent`. */
const write = (text: string) => fireEvent.change(screen.getByLabelText("Statement"), { target: { value: text } });

describe("VariablesSection", () => {
  it("stays folded on a static question, and adding a first row makes it parameterized", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    mockFetch({});
    renderWithProviders(<Host initial={null} onChange={onChange} />);
    const disclosure = screen.getByRole("button", { name: "Random values" });
    expect(disclosure).toHaveAttribute("aria-expanded", "false");
    expect(screen.queryByRole("button", { name: "Add a variable" })).toBeNull();

    await user.click(disclosure);
    await user.click(screen.getByRole("button", { name: "Add a variable" }));
    expect(onChange).toHaveBeenLastCalledWith({ rows: [{ name: "", expr: "", format: "" }] });
    await user.type(screen.getByLabelText("Name 1"), "h");
    expect(onChange).toHaveBeenLastCalledWith({ rows: [{ name: "h", expr: "", format: "" }] });
  });

  it("opens on the table of a parameterized question, and removing the last row makes it static", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    mockFetch({ "POST /app/api/questions/q1/draft/instances": ok(DRAWS) });
    renderWithProviders(<Host initial={{ rows: [FALL.rows[0]!] }} onChange={onChange} />);
    expect(screen.getByLabelText("Expression 1")).toHaveValue("randint(10, 100)");
    expect(screen.getByLabelText("Format 1")).toHaveDisplayValue("Integer");
    await user.selectOptions(screen.getByLabelText("Format 1"), "Decimals");
    expect(onChange).toHaveBeenLastCalledWith({ rows: [{ ...FALL.rows[0]!, format: ".2" }] });
    await user.click(screen.getByRole("button", { name: "Remove h" }));
    expect(onChange).toHaveBeenLastCalledWith(null);
  });

  it("says each issue on its row, the condition's under the condition", () => {
    mockFetch({ "POST /app/api/questions/q1/draft/instances": ok({ instances: [], issues: [] }) });
    const issues: ZodIssueLite[] = [
      { path: ["variables", "t"], code: "custom", message: "parameters.unknown_name" },
      { path: ["variables", "condition"], code: "custom", message: "parameters.not_a_boolean" },
    ];
    renderWithProviders(<Host initial={FALL} issues={issues} />);
    expect(screen.getByLabelText("Expression 3")).toHaveAttribute("aria-invalid", "true");
    expect(screen.getByLabelText("Expression 1")).not.toHaveAttribute("aria-invalid");
    expect(screen.getByText("Unknown name: a row reads only the variables above it.")).toBeInTheDocument();
    expect(screen.getByText("The condition must be true or false.")).toBeInTheDocument();
  });

  it("shows the five draws the API computed, and plays one with its key", async () => {
    const user = userEvent.setup();
    const { calls } = mockFetch({ "POST /app/api/questions/q1/draft/instances": ok(DRAWS) });
    renderWithProviders(<Host initial={FALL} />);
    const table = await screen.findByRole("table");
    expect(within(table).getAllByRole("row")).toHaveLength(6);
    expect(within(table).getByText("2.30")).toBeInTheDocument();
    // Nothing but the question's id leaves the browser.
    expect(calls.find((c) => c.url.endsWith("/draft/instances"))?.body).toBeNull();

    await user.click(screen.getByRole("button", { name: "Show draw 2" }));
    expect(screen.getByText("Draw 2")).toBeInTheDocument();
    expect(await screen.findByText("Une bille tombe de 41 m.", {}, { timeout: 10_000 })).toBeInTheDocument();
    expect(screen.getByText("La chute dure 2.10 s.")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Show answers" }));
    expect(await screen.findByText("2.10 ± 0.01")).toBeInTheDocument();
    // The player and the review are lazy chunks: a loaded CI worker needs the room.
  }, 20_000);

  it("asks for the issues to be fixed when the draft does not draw", async () => {
    mockFetch({
      "POST /app/api/questions/q1/draft/instances": ok({
        instances: [],
        issues: [{ path: ["variables", "h"], code: "custom", message: "parameters.parse_error" }],
      }),
    });
    renderWithProviders(<Host initial={FALL} />);
    expect(await screen.findByText("Fix the issues above to see the draws.")).toBeInTheDocument();
  });
});

describe("VariablesSection — rows declared by the text (ADR-056, addendum of 2026-10-01)", () => {
  it("adds an empty row for a [[name]] the text gains, even on a static question", async () => {
    const onChange = vi.fn();
    mockFetch({ "POST /app/api/questions/q1/draft/instances": ok({ instances: [], issues: [] }) });
    renderWithProviders(<Host initial={null} onChange={onChange} />);
    write("From [[h]] m, in `[[code]]`, [[2*w]].\n\n```c\nint m[[fenced]];\n```");
    await waitFor(() => expect(onChange).toHaveBeenLastCalledWith({ rows: [{ name: "h", expr: "", format: "" }] }));
    expect(screen.getByLabelText("Name 1")).toHaveValue("h");
    expect(screen.queryByLabelText("Name 2")).toBeNull();
  });

  it("never leaves the rows of a name typed on its way: [[h]] grown to [[height]]", async () => {
    const onChange = vi.fn();
    mockFetch({ "POST /app/api/questions/q1/draft/instances": ok({ instances: [], issues: [] }) });
    renderWithProviders(<Host initial={null} onChange={onChange} />);
    for (const text of ["[[h]]", "[[he]]", "[[hei]]", "[[height"]) write(text);
    write("[[height]]");
    await waitFor(() => expect(onChange).toHaveBeenCalled());
    expect(onChange.mock.calls).toEqual([[{ rows: [{ name: "height", expr: "", format: "" }] }]]);
  });

  it("removes an empty row it created when the reference goes, and keeps one with an expression, flagged unused", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    mockFetch({ "POST /app/api/questions/q1/draft/instances": ok({ instances: [], issues: [] }) });
    renderWithProviders(<Host initial={null} onChange={onChange} />);
    write("[[h]] and [[k]]");
    await waitFor(() => expect(screen.getByLabelText("Name 2")).toHaveValue("k"));
    await user.type(screen.getByLabelText("Expression 1"), "7");
    write("nothing left");
    await waitFor(() =>
      expect(onChange).toHaveBeenLastCalledWith({ rows: [{ name: "h", expr: "7", format: "" }] }),
    );
    expect(screen.getByText("h is not used anywhere.")).toBeInTheDocument();
  });

  it("acts on an edit only: opening a text with an undeclared [[name]] changes nothing", async () => {
    flowingClock();
    const onChange = vi.fn();
    mockFetch({ "POST /app/api/questions/q1/draft/instances": ok({ instances: [], issues: [] }) });
    renderWithProviders(<Host initial={null} onChange={onChange} prompt="Old [[x]]" />);
    await elapse(5_000);
    expect(onChange).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: "Random values" })).toHaveAttribute("aria-expanded", "false");
  });

  it("counts a row as used by the text, another row or the condition, never by itself", () => {
    mockFetch({ "POST /app/api/questions/q1/draft/instances": ok({ instances: [], issues: [] }) });
    const table: ParametersDraft = {
      rows: [
        { name: "a", expr: "randint(1, 9)", format: "" },
        { name: "b", expr: "a + 1", format: "" },
        { name: "c", expr: "c", format: "" },
        { name: "d", expr: "1", format: "" },
      ],
      condition: "d > 0",
    };
    renderWithProviders(<Host initial={table} prompt="[[b * 2]]" />);
    expect(screen.getAllByText(/is not used anywhere/).map((p) => p.textContent)).toEqual(["c is not used anywhere."]);
  });
});

describe("the format: a kind and a count", () => {
  it("writes the stored strings, and keeps an unknown one on show", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    mockFetch({ "POST /app/api/questions/q1/draft/instances": ok({ instances: [], issues: [] }) });
    renderWithProviders(<Host initial={{ rows: [{ name: "h", expr: "1", format: "%d" }] }} onChange={onChange} prompt="[[h]]" />);
    expect(screen.getByLabelText("Format 1")).toHaveDisplayValue("%d");
    expect(screen.queryByLabelText("Digits 1")).toBeNull();

    await user.selectOptions(screen.getByLabelText("Format 1"), "Significant figures");
    expect(onChange).toHaveBeenLastCalledWith({ rows: [{ name: "h", expr: "1", format: "3s" }] });
    await user.selectOptions(screen.getByLabelText("Digits 1"), "4");
    expect(onChange).toHaveBeenLastCalledWith({ rows: [{ name: "h", expr: "1", format: "4s" }] });
    // The count is kept from one kind to the other.
    await user.selectOptions(screen.getByLabelText("Format 1"), "Decimals");
    expect(onChange).toHaveBeenLastCalledWith({ rows: [{ name: "h", expr: "1", format: ".4" }] });
    await user.selectOptions(screen.getByLabelText("Format 1"), "Automatic");
    expect(onChange).toHaveBeenLastCalledWith({ rows: [{ name: "h", expr: "1", format: "" }] });
    expect(screen.queryByLabelText("Digits 1")).toBeNull();
  });
});

describe("reconcileRows", () => {
  const row = (name: string, expr = "") => ({ name, expr, format: "" });

  it("returns the same rows when nothing changes", () => {
    const rows = [row("h", "1")];
    expect(reconcileRows(rows, ["h"], new Set()).rows).toBe(rows);
  });

  it("removes only its own empty rows, caps the table, and never touches the set it is given", () => {
    const auto = new Set(["x", "y"]);
    const next = reconcileRows([row("x"), row("y", "2"), row("z")], ["n"], auto);
    expect(next.rows).toEqual([row("y", "2"), row("z"), row("n")]);
    expect([...next.auto].sort()).toEqual(["n", "y"]);
    expect([...auto]).toEqual(["x", "y"]);
    const full = Array.from({ length: 20 }, (_, i) => row(`v${i}`, "1"));
    expect(reconcileRows(full, ["w"], new Set()).rows).toBe(full);
  });
});

describe("isVariablesIssue", () => {
  it("keeps the table's issues and a parameter issue of the whole question", () => {
    expect(isVariablesIssue({ path: ["variables", "h"], code: "custom", message: "parameters.bad_name" })).toBe(true);
    expect(isVariablesIssue({ path: [], code: "custom", message: "parameters.too_slow" })).toBe(true);
    expect(isVariablesIssue({ path: ["prompt"], code: "custom", message: "parameters.unknown_name" })).toBe(false);
    expect(isVariablesIssue({ path: [], code: "custom", message: "mcq.no_correct_choice" })).toBe(false);
  });
});
