import { fireEvent, screen, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { circuitServer } from "@quiz/qt-circuit/server";
import type { DiagramConfig } from "@quiz/qt-diagram/client";

import { QuestionEditorHost } from "../questionTypes";
import { renderWithProviders } from "../test/render";
import type { SyncState } from "../ui";
import { EditorExpandChrome } from "./EditorExpandLayer";
import { PlayedQuestion } from "./PreviewedQuestion";

/*
 * The teacher's expand layer (`EditorProps.Expand`, ADR-046 addendum): every
 * editor host lends it, a canvas of the `diagram` or `circuit` editor opens
 * in it under a bar that says what is being edited, the draft's save state
 * where the screen autosaves, and "Close". Unlike the attempt's, Alt+←/→ is
 * not its business: there is no question to move to.
 */
const config: DiagramConfig = {
  configVersion: 1,
  prompt: "Complétez l'organigramme.",
  rubric: "",
  kind: "flow",
  reference: { nodes: [{ id: "r1d7fe4k", t: "terminal", x: 340, y: 20, name: "Début" }], links: [] },
};

function Editor({ type = "diagram", value = config as unknown }: { type?: string; value?: unknown }) {
  return <QuestionEditorHost type={type} config={value} onChange={vi.fn()} />;
}

function renderEditor(sync?: SyncState) {
  renderWithProviders(
    sync === undefined ? (
      <Editor />
    ) : (
      <EditorExpandChrome.Provider value={sync}>
        <Editor />
      </EditorExpandChrome.Provider>
    ),
  );
}

async function expandReference() {
  // The reference is the first canvas; the starter is not drawn yet.
  fireEvent.click((await screen.findAllByRole("button", { name: "Expand" }))[0]!);
  return screen.getByRole("dialog", { name: "Reference diagram" });
}

describe("the editor's expand layer", () => {
  it("opens a canvas under its title, the save state and one way out", async () => {
    renderEditor("saved");
    const layer = await expandReference();
    expect(layer).toContainElement(screen.getByRole("group", { name: "Reference diagram" }));
    expect(layer).toHaveTextContent("Saved");
    expect(within(layer).queryByRole("button", { name: "Back to the questions" })).toBeNull();
    fireEvent.click(within(layer).getByRole("button", { name: "Close" }));
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("shows no save state where the host saves nothing (the poll launcher)", async () => {
    renderEditor();
    const layer = await expandReference();
    expect(layer).not.toHaveTextContent("Saved");
  });

  it("lets the canvas cancel its tool on Escape first, and closes on the next one", async () => {
    renderEditor();
    await expandReference();
    const canvas = screen.getByRole("group", { name: "Reference diagram" });
    fireEvent.click(screen.getByRole("button", { name: "Action" }));
    fireEvent.keyDown(canvas, { key: "Escape" });
    expect(screen.getByRole("dialog")).toBeInTheDocument();
    fireEvent.keyDown(canvas, { key: "Escape" });
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("keeps the text tab working inside the layer, and stays open on its Escape", async () => {
    renderEditor();
    const layer = await expandReference();
    fireEvent.click(within(layer).getByRole("radio", { name: "Text" }));
    const text = within(layer).getByRole("textbox", { name: "Text" });
    fireEvent.focus(text);
    fireEvent.keyDown(text, { key: "Escape" });
    expect(screen.getByRole("dialog")).toBeInTheDocument();
  });

  it("does not close on Alt+arrow: that is the attempt's navigation", async () => {
    renderEditor();
    await expandReference();
    fireEvent.keyDown(screen.getByRole("group", { name: "Reference diagram" }), { key: "ArrowRight", altKey: true });
    expect(screen.getByRole("dialog")).toBeInTheDocument();
  });

  it("expands the circuit editor's reference too", async () => {
    renderWithProviders(<Editor type="circuit" value={circuitServer.emptyDraft()} />);
    fireEvent.click(await screen.findByRole("button", { name: "Expand" }));
    const layer = screen.getByRole("dialog", { name: "Reference circuit" });
    expect(within(layer).getAllByRole("group", { name: "Reference circuit" }).length).toBeGreaterThan(0);
    fireEvent.keyDown(within(layer).getAllByRole("group", { name: "Reference circuit" })[0]!, { key: "Escape" });
    expect(screen.queryByRole("dialog")).toBeNull();
  });
});

describe("a teacher's preview", () => {
  it("lends the same layer to a player it hosts", async () => {
    renderWithProviders(
      <PlayedQuestion view={{ type: "diagram", points: 2, student: { prompt: "Dessinez.", kind: "flow" } }} />,
    );
    fireEvent.click(await screen.findByRole("button", { name: "Expand" }));
    const layer = screen.getByRole("dialog", { name: "Your diagram" });
    expect(layer).toContainElement(screen.getByRole("group", { name: "Your diagram" }));
    expect(within(layer).getByRole("button", { name: "Close" })).toBeInTheDocument();
  });
});
