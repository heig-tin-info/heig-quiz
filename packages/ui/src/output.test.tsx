import { fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { OutputCells, OutputControls, OutputDiff, OutputHeads, useOutputMode, WhitespaceText, type OutputStrings } from "./output.js";

const strings: OutputStrings = {
  expected: "Expected",
  got: "Got",
  truncated: "Output truncated",
  outputSideBySide: "Side by side",
  outputDiff: "Diff",
  outputView: "Output view",
  showWhitespace: "Show whitespace",
  outputDiffHeader: "Difference",
  noFinalNewline: "No newline at end",
  truncatedDiff: "Compared up to the cut.",
};

function Row(props: Partial<Parameters<typeof OutputCells>[0]>) {
  return (
    <table>
      <tbody>
        <tr>
          <OutputCells
            mode="side"
            expected="1 2 3"
            expectedFallback="Any output"
            actual="1 2 3"
            ok={true}
            showWhitespace={false}
            strings={strings}
            className="td"
            {...props}
          />
        </tr>
      </tbody>
    </table>
  );
}

describe("WhitespaceText", () => {
  it("keeps the real text, so copying a cell copies the output", () => {
    const { container } = render(<WhitespaceText text={"a  b\t\n"} glyphs />);
    expect(container.textContent).toBe("a  b\t\n");
    const marks = [...container.querySelectorAll("[data-ws]")].map((e) => e.getAttribute("data-ws"));
    expect(marks).toEqual(["space", "space", "tab"]);
  });

  it("draws nothing when glyphs are off", () => {
    const { container } = render(<WhitespaceText text={"a  b"} glyphs={false} />);
    expect(container.querySelector("[data-ws]")).toBeNull();
  });

  it("marks a missing final newline only when the comparison counts it", () => {
    const { rerender } = render(<WhitespaceText text="6" glyphs noFinalNewline="No newline at end" />);
    expect(screen.queryByRole("img", { name: "No newline at end" })).toBeNull();
    rerender(<WhitespaceText text="6" glyphs compare={{ trimTrailing: false }} noFinalNewline="No newline at end" />);
    expect(screen.getByRole("img", { name: "No newline at end" })).toBeInTheDocument();
  });
});

describe("OutputDiff", () => {
  it("lists expected lines as removed and obtained ones as added, each with its sign", () => {
    const { container } = render(
      <OutputDiff expected={"sum = 6\nbye"} actual={"sum =  6\nbye"} glyphs={false} strings={strings} />,
    );
    const ops = [...container.querySelectorAll("[data-op]")].map((e) => e.getAttribute("data-op"));
    expect(ops).toEqual(["removed", "added", "equal"]);
    // The gutter's − and + are visible; a screen reader hears which side.
    expect(container.textContent).toContain("−");
    expect(screen.getByText("Expected:", { exact: false })).toHaveClass("sr-only");
    // The one extra space is the obtained line's only changed character.
    expect(container.querySelector(".bg-success\\/25")?.textContent).toBe(" ");
  });

  it("says when the obtained output was cut, without drawing the cut as a difference", () => {
    const { container } = render(
      <OutputDiff expected={"a\nb\nc\n"} actual={"a\nb"} truncated glyphs={false} strings={strings} />,
    );
    expect([...container.querySelectorAll("[data-op]")].every((e) => e.getAttribute("data-op") === "equal")).toBe(true);
    expect(screen.getByText("Compared up to the cut.")).toBeInTheDocument();
  });
});

describe("OutputCells", () => {
  it("renders two cells side by side and one in diff mode", () => {
    const { container, rerender } = render(<Row />);
    expect(container.querySelectorAll("td")).toHaveLength(2);
    rerender(<Row mode="diff" />);
    expect(container.querySelectorAll("td")).toHaveLength(1);
  });

  it("turns the glyphs on by itself when the outputs differ only by whitespace", () => {
    const { container } = render(<Row actual="1  2 3" ok={false} />);
    expect(container.querySelectorAll("[data-ws]").length).toBeGreaterThan(0);
  });

  it("keeps them off for a real difference, until the reader asks", () => {
    const { container, rerender } = render(<Row expected="1  2" actual="1  3" ok={false} />);
    expect(container.querySelector("[data-ws]")).toBeNull();
    rerender(<Row expected="1  2" actual="1  3" ok={false} showWhitespace />);
    expect(container.querySelector("[data-ws]")).not.toBeNull();
  });

  it("draws no diff without an expected output, nor for a passed case", () => {
    const { container, rerender } = render(<Row mode="diff" expected={null} actual="hello" ok={false} />);
    expect(container.querySelector("[data-op]")).toBeNull();
    expect(container.textContent).toBe("hello");
    rerender(<Row mode="diff" ok />);
    expect(container.querySelector("[data-op]")).toBeNull();
  });

  it("shows the fallback for a case whose output is not compared, and a dash for one not run", () => {
    render(<Row expected={null} actual={null} ok={null} />);
    expect(screen.getByText("Any output")).toBeInTheDocument();
    expect(screen.getByText("—")).toBeInTheDocument();
  });
});

describe("OutputHeads", () => {
  it("replaces Expected and Got with the diff column", () => {
    const { rerender } = render(
      <table>
        <thead>
          <tr>
            <OutputHeads mode="side" strings={strings} className="th" />
          </tr>
        </thead>
      </table>,
    );
    expect(screen.getAllByRole("columnheader").map((h) => h.textContent)).toEqual(["Expected", "Got"]);
    rerender(
      <table>
        <thead>
          <tr>
            <OutputHeads mode="diff" strings={strings} className="th" />
          </tr>
        </thead>
      </table>,
    );
    expect(screen.getAllByRole("columnheader").map((h) => h.textContent)).toEqual(["Difference"]);
  });
});

describe("OutputControls and useOutputMode", () => {
  afterEach(() => localStorage.clear());

  function Harness() {
    const [mode, setMode] = useOutputMode();
    return (
      <OutputControls
        name="o"
        mode={mode}
        onMode={setMode}
        showWhitespace={false}
        onShowWhitespace={() => {}}
        strings={strings}
      />
    );
  }

  it("remembers the chosen view in this browser", () => {
    const { unmount } = render(<Harness />);
    expect(screen.getByRole("radio", { name: "Side by side" })).toBeChecked();
    fireEvent.click(screen.getByRole("radio", { name: "Diff" }));
    expect(screen.getByRole("radio", { name: "Diff" })).toBeChecked();
    unmount();
    render(<Harness />);
    expect(screen.getByRole("radio", { name: "Diff" })).toBeChecked();
  });

  it("falls back to side by side when storage is unavailable", () => {
    const spy = vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new Error("blocked");
    });
    render(<Harness />);
    expect(screen.getByRole("radio", { name: "Side by side" })).toBeChecked();
    spy.mockRestore();
  });
});
