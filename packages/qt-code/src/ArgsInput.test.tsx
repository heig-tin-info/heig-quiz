import { fireEvent, render, screen } from "@testing-library/react";
import { useState } from "react";
import { describe, expect, it } from "vitest";

import { ArgsInput, commandLine, programName, shellQuote, type ArgsInputStrings } from "./ArgsInput.js";
import type { CodeLanguage } from "./schema.js";

const S: ArgsInputStrings = {
  argument: "Argument {n}",
  addArgument: "Add an argument",
  removeArgument: "Remove argument {n}",
  commandLine: "Command line",
};

describe("shellQuote", () => {
  it("leaves a literal argument alone", () => {
    expect(shellQuote("3")).toBe("3");
    expect(shellQuote("--width=4")).toBe("--width=4");
    expect(shellQuote("data/in.csv")).toBe("data/in.csv");
  });

  it("single-quotes an argument a shell would split or expand", () => {
    expect(shellQuote("hello world")).toBe("'hello world'");
    expect(shellQuote("x;y")).toBe("'x;y'");
    expect(shellQuote("$HOME")).toBe("'$HOME'");
    expect(shellQuote("*")).toBe("'*'");
  });

  it("escapes a single quote and keeps the empty argument", () => {
    expect(shellQuote("it's")).toBe("'it'\\''s'");
    expect(shellQuote("")).toBe("''");
  });

  it("writes the whole line after the program name", () => {
    expect(commandLine("./prog", ["hello world", "3"])).toBe("./prog 'hello world' 3");
    expect(commandLine("main.py", [])).toBe("main.py");
  });

  it("names argv[0] per language", () => {
    expect(programName("c")).toBe("./prog");
    expect(programName("rust")).toBe("./prog");
    expect(programName("python")).toBe("main.py");
    expect(programName("js")).toBe("main.js");
  });
});

function Harness({ initial, language = "c" }: { initial: string[]; language?: CodeLanguage }) {
  const [value, setValue] = useState(initial);
  return (
    <>
      <ArgsInput value={value} onChange={setValue} language={language} s={S} />
      <output data-testid="value">{JSON.stringify(value)}</output>
    </>
  );
}

const valueOf = () => JSON.parse(screen.getByTestId("value").textContent ?? "[]") as string[];

describe("ArgsInput", () => {
  it("shows argv[0] as the program name, not editable, and a numbered row per argument", () => {
    render(<Harness initial={["a", "b c"]} language="python" />);
    expect(screen.getByText("argv[0]")).toBeInTheDocument();
    expect(screen.getByText("main.py")).toBeInTheDocument();
    expect(screen.getAllByRole("textbox")).toHaveLength(2);
    expect(screen.getByLabelText("Argument 2")).toHaveValue("b c");
    expect(screen.getByLabelText("Command line").textContent).toContain("main.py a 'b c'");
  });

  it("inserts an empty row below on Enter and moves into it", () => {
    render(<Harness initial={["a", "b"]} />);
    fireEvent.keyDown(screen.getByLabelText("Argument 1"), { key: "Enter" });
    expect(valueOf()).toEqual(["a", "", "b"]);
    expect(screen.getByLabelText("Argument 2")).toHaveFocus();
  });

  it("removes an empty row on Backspace and moves to the previous one", () => {
    render(<Harness initial={["a", "", "b"]} />);
    fireEvent.keyDown(screen.getByLabelText("Argument 2"), { key: "Backspace" });
    expect(valueOf()).toEqual(["a", "b"]);
    expect(screen.getByLabelText("Argument 1")).toHaveFocus();
  });

  it("leaves Backspace alone in a row that still holds text", () => {
    render(<Harness initial={["a"]} />);
    fireEvent.keyDown(screen.getByLabelText("Argument 1"), { key: "Backspace" });
    expect(valueOf()).toEqual(["a"]);
  });

  it("removes a row with its trash button, and offers to add one when none is left", () => {
    render(<Harness initial={["only"]} />);
    fireEvent.click(screen.getByRole("button", { name: "Remove argument 1" }));
    expect(valueOf()).toEqual([]);
    const add = screen.getByRole("button", { name: "Add an argument" });
    expect(add).toHaveFocus();
    fireEvent.click(add);
    expect(valueOf()).toEqual([""]);
    expect(screen.getByLabelText("Argument 1")).toHaveFocus();
  });

  it("writes a row's text back", () => {
    render(<Harness initial={[""]} />);
    fireEvent.change(screen.getByLabelText("Argument 1"), { target: { value: "it's" } });
    expect(valueOf()).toEqual(["it's"]);
    expect(screen.getByLabelText("Command line").textContent).toContain("./prog 'it'\\''s'");
  });
});
