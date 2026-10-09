import { fireEvent, render, screen, within } from "@testing-library/react";
import { useState, type ReactNode } from "react";
import { describe, expect, it, vi } from "vitest";

import type { EditorProps, ExpandProps } from "@quiz/core/client";
import { emptyScene } from "@quiz/diagram/server";

import { DiagramQuestionEditor } from "./Editor.js";
import { DiagramPlayer } from "./Player.js";
import { DiagramReview } from "./Review.js";
import type { DiagramConfig } from "./schema.js";
import { config, REFERENCE, STARTER } from "./test/fixtures.js";

/** The legend of the editor's kind picker (`strings.ts`). */
const KIND_LEGEND = "Kind of diagram";

/** A host that owns the config, as the question editor does. */
function EditorHost({
  initial,
  onChange,
  published,
  Expand,
}: {
  initial: DiagramConfig;
  onChange: (c: DiagramConfig) => void;
  published?: boolean;
  Expand?: EditorProps<DiagramConfig>["Expand"];
}) {
  const [value, setValue] = useState(initial);
  return (
    <DiagramQuestionEditor
      config={value}
      published={published ?? false}
      {...(Expand === undefined ? {} : { Expand })}
      onChange={(next) => {
        setValue(next);
        onChange(next);
      }}
    />
  );
}

/** The host's layer, reduced to what the player relies on. */
function TestExpand({ open, onClose, title, children }: ExpandProps): ReactNode {
  if (!open) return null;
  return (
    <div role="dialog" aria-label="Expanded" title={title}>
      <button type="button" onClick={onClose}>
        Back to the questions
      </button>
      {children}
    </div>
  );
}

describe("DiagramQuestionEditor", () => {
  it("offers the eight kinds, and changes an empty draft's kind at once", () => {
    const onChange = vi.fn();
    render(<EditorHost initial={config({ reference: emptyScene(), starter: undefined })} onChange={onChange} />);
    // The kinds, not the Diagram / Text choice of the reference's toolbar.
    expect(within(screen.getByRole("group", { name: KIND_LEGEND })).getAllByRole("radio")).toHaveLength(8);
    fireEvent.click(screen.getByRole("radio", { name: /State machine/ }));
    expect(onChange.mock.lastCall?.[0]).toMatchObject({ kind: "state" });
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("asks before a kind change empties the reference and the starter", () => {
    const onChange = vi.fn();
    render(<EditorHost initial={config()} onChange={onChange} />);
    fireEvent.click(screen.getByRole("radio", { name: /Flowchart/ }));
    expect(onChange).not.toHaveBeenCalled();
    expect(screen.getByRole("alert")).toHaveTextContent("Change the kind of diagram?");
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(screen.queryByRole("alert")).toBeNull();
    expect(screen.getByRole("radio", { name: /UML class/ })).toBeChecked();

    fireEvent.click(screen.getByRole("radio", { name: /Flowchart/ }));
    fireEvent.click(screen.getByRole("button", { name: "Change and empty" }));
    const next = onChange.mock.lastCall?.[0] as DiagramConfig;
    expect(next.kind).toBe("flow");
    expect(next.reference).toEqual(emptyScene());
    expect("starter" in next).toBe(false);
  });

  it("locks the kind once the question is published", () => {
    render(<EditorHost initial={config()} onChange={vi.fn()} published />);
    expect(screen.queryByRole("group", { name: KIND_LEGEND })).toBeNull();
    expect(screen.getByText(/fixed once the question is published/)).toBeInTheDocument();
  });

  it("copies the reference into the starter under fresh ids", () => {
    const onChange = vi.fn();
    const { starter: _drop, ...bare } = config();
    render(<EditorHost initial={bare} onChange={onChange} />);
    fireEvent.click(screen.getByRole("button", { name: "Copy the reference into the starter" }));
    const starter = (onChange.mock.lastCall?.[0] as DiagramConfig).starter!;
    expect(starter.nodes.map((n) => n.name)).toEqual(REFERENCE.nodes.map((n) => n.name));
    const referenceIds = new Set([...REFERENCE.nodes, ...REFERENCE.links].map((x) => x.id));
    for (const item of [...starter.nodes, ...starter.links]) expect(referenceIds.has(item.id)).toBe(false);
    const ids = new Set(starter.nodes.map((n) => n.id));
    for (const link of starter.links) expect(ids.has(link.a) && ids.has(link.b)).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: "Remove the starter" }));
    expect("starter" in (onChange.mock.lastCall?.[0] as DiagramConfig)).toBe(false);
  });

  it("expands the reference and the starter each on its own, text tab included", () => {
    const onChange = vi.fn();
    render(<EditorHost initial={config()} onChange={onChange} Expand={TestExpand} />);
    const [reference, starter] = screen.getAllByRole("button", { name: "Expand" });
    expect(starter).toBeDefined();

    fireEvent.click(reference!);
    const layer = screen.getByRole("dialog", { name: "Expanded" });
    expect(layer).toHaveAttribute("title", "Reference diagram");
    // The layer holds the one live reference canvas; the starter stays inline.
    expect(screen.getAllByRole("group", { name: "Reference diagram" })).toHaveLength(1);
    expect(layer).toContainElement(screen.getByRole("group", { name: "Reference diagram" }));
    expect(layer).not.toContainElement(screen.getByRole("group", { name: "Starter diagram" }));
    expect(screen.getByText("This diagram is open over the page.")).toBeInTheDocument();

    // The text tab works in the layer: typing there edits the reference.
    fireEvent.click(within(layer).getByRole("radio", { name: "Text" }));
    const text = within(layer).getByRole("textbox", { name: "Text" });
    fireEvent.focus(text);
    fireEvent.change(text, { target: { value: "class Solo" } });
    expect((onChange.mock.lastCall?.[0] as DiagramConfig).reference.nodes.map((n) => n.name)).toEqual(["Solo"]);

    fireEvent.click(within(layer).getByRole("button", { name: "Back to the questions" }));
    expect(screen.queryByRole("dialog")).toBeNull();

    fireEvent.click(screen.getAllByRole("button", { name: "Expand" })[1]!);
    expect(screen.getByRole("dialog")).toHaveAttribute("title", "Starter diagram");
    expect(screen.getByRole("dialog")).toContainElement(screen.getByRole("group", { name: "Starter diagram" }));
  });
});

describe("DiagramPlayer", () => {
  const student = { prompt: "Draw the figures.", kind: "class" as const, starter: STARTER };

  it("shows the starter and writes nothing before the first edit", () => {
    const onChange = vi.fn();
    render(<DiagramPlayer student={student} answer={null} onChange={onChange} readOnly={false} />);
    expect(screen.getByRole("group", { name: "Your diagram" })).toBeInTheDocument();
    expect(onChange).not.toHaveBeenCalled();
  });

  it("sends the whole scene on an edit", () => {
    const onChange = vi.fn();
    render(<DiagramPlayer student={student} answer={null} onChange={onChange} readOnly={false} />);
    const group = screen.getByRole("group", { name: "Your diagram" });
    fireEvent.keyDown(group, { key: "a", ctrlKey: true });
    fireEvent.keyDown(group, { key: "Delete" });
    expect(onChange).toHaveBeenLastCalledWith({ scene: emptyScene() });
  });

  it("opens the canvas in the host's layer, one editor at a time, and closes it", () => {
    render(<DiagramPlayer student={student} answer={null} onChange={vi.fn()} readOnly={false} Expand={TestExpand} />);
    fireEvent.click(screen.getByRole("button", { name: "Expand" }));
    const layer = screen.getByRole("dialog", { name: "Expanded" });
    expect(layer).toContainElement(screen.getByRole("group", { name: "Your diagram" }));
    expect(screen.getAllByRole("group", { name: "Your diagram" })).toHaveLength(1);
    fireEvent.click(screen.getByRole("button", { name: "Back to the questions" }));
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(screen.getByRole("group", { name: "Your diagram" })).toBeInTheDocument();
  });

  it("offers no tool on a locked attempt", () => {
    render(<DiagramPlayer student={student} answer={null} onChange={vi.fn()} readOnly />);
    expect(screen.queryByRole("toolbar")).toBeNull();
  });
});

describe("DiagramReview", () => {
  const student = { prompt: "Draw the figures.", kind: "class" as const };
  const answer = { scene: STARTER };
  const solution = { reference: REFERENCE, rubric: "Inheritance first." };

  it("stacks the answer, the reference and, for the teacher, both text forms", () => {
    render(
      <DiagramReview student={student} answer={answer} solution={solution} details={null} points={null} maxPoints={2} audience="teacher" />,
    );
    expect(screen.getByRole("img", { name: "Answer" })).toBeInTheDocument();
    expect(screen.getByRole("img", { name: "Reference diagram" })).toBeInTheDocument();
    expect(screen.getByText(/class Shape/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("radio", { name: "Reference" }));
    expect(screen.getByText(/class SecretCircleRef/)).toBeInTheDocument();
    expect(screen.getByText("Inheritance first.")).toBeInTheDocument();
  });

  it("shows a student the reference but no text form", () => {
    render(
      <DiagramReview
        student={student}
        answer={answer}
        solution={{ reference: REFERENCE }}
        details={null}
        points={1}
        maxPoints={2}
        audience="student"
      />,
    );
    expect(screen.getByRole("img", { name: "Reference diagram" })).toBeInTheDocument();
    expect(screen.queryByText("Text form")).toBeNull();
  });

  it("draws an answer of another kind without failing, and says it was drawn for another kind", () => {
    render(
      <DiagramReview
        student={{ prompt: "Draw.", kind: "state" as const }}
        answer={{ scene: REFERENCE }}
        solution={{ reference: { nodes: [{ id: "st000001", t: "state", x: 0, y: 0, name: "Idle" }], links: [] }, rubric: "" }}
        details={{ reason: "kind_mismatch", nodes: 2, links: 1 }}
        points={0}
        maxPoints={2}
        audience="teacher"
      />,
    );
    expect(screen.getByRole("img", { name: "Answer" })).toBeInTheDocument();
    expect(screen.getByText(/another kind of diagram/)).toBeInTheDocument();
  });

  it("says when there is no answer", () => {
    render(<DiagramReview student={student} answer={null} solution={null} details={null} points={0} maxPoints={2} audience="teacher" />);
    expect(screen.getByText("No answer")).toBeInTheDocument();
  });
});
