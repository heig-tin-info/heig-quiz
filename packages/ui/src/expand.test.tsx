import { fireEvent, render, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { ExpandProps } from "@quiz/core/client";

import { ExpandableCanvas } from "./expand.js";

const strings = { expand: "Expand", expanded: "Open over the page.", expandHint: "Expand to draw." };

/** The host's layer, reduced to what the primitive relies on. */
function TestExpand({ open, onClose, title, children }: ExpandProps): ReactNode {
  if (!open) return null;
  return (
    <div role="dialog" aria-label={title}>
      <button type="button" onClick={onClose}>
        Close
      </button>
      {children}
    </div>
  );
}

/** The canvas says where it was drawn, so a test can tell the two apart. */
const canvas = (expanded: boolean) => <div data-testid="canvas">{expanded ? "filling" : "inline"}</div>;

function narrow() {
  vi.stubGlobal(
    "matchMedia",
    (query: string) =>
      ({ matches: false, media: query, addEventListener: () => {}, removeEventListener: () => {} }) as unknown as MediaQueryList,
  );
}

afterEach(() => vi.unstubAllGlobals());

describe("ExpandableCanvas", () => {
  it("draws the canvas inline, with no button, where the host lends no layer", () => {
    render(
      <ExpandableCanvas title="Your circuit" strings={strings} preview={<p>picture</p>}>
        {canvas}
      </ExpandableCanvas>,
    );
    expect(screen.getByText("Your circuit")).toBeInTheDocument();
    expect(screen.getByTestId("canvas")).toHaveTextContent("inline");
    expect(screen.queryByRole("button", { name: "Expand" })).toBeNull();
  });

  it("opens the layer under its title, and leaves one line in place of the inline canvas", () => {
    render(
      <ExpandableCanvas Expand={TestExpand} title="Reference diagram" strings={strings}>
        {canvas}
      </ExpandableCanvas>,
    );
    fireEvent.click(screen.getByRole("button", { name: "Expand" }));
    const layer = screen.getByRole("dialog", { name: "Reference diagram" });
    // One live canvas: the layer's, filling it.
    expect(screen.getAllByTestId("canvas")).toHaveLength(1);
    expect(layer).toContainElement(screen.getByTestId("canvas"));
    expect(screen.getByTestId("canvas")).toHaveTextContent("filling");
    expect(screen.getByText("Open over the page.")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Close" }));
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(screen.getByTestId("canvas")).toHaveTextContent("inline");
  });

  it("shows the caller's heading, hint and actions beside the button", () => {
    render(
      <ExpandableCanvas
        Expand={TestExpand}
        title="Reference"
        heading={<h3>Reference circuit</h3>}
        hint={<p>Your own answer.</p>}
        actions={<button type="button">Remove</button>}
        strings={strings}
      >
        {canvas}
      </ExpandableCanvas>,
    );
    expect(screen.getByRole("heading", { name: "Reference circuit" })).toBeInTheDocument();
    expect(screen.getByText("Your own answer.")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Remove" })).toBeInTheDocument();
  });

  it("shows the preview instead of the canvas on a narrow screen, and opens the layer from it", () => {
    narrow();
    render(
      <ExpandableCanvas Expand={TestExpand} title="Your circuit" strings={strings} preview={<p>picture</p>}>
        {canvas}
      </ExpandableCanvas>,
    );
    expect(screen.queryByTestId("canvas")).toBeNull();
    const preview = screen.getByRole("button", { name: "Expand to draw." });
    expect(preview).toHaveTextContent("picture");
    fireEvent.click(preview);
    expect(screen.getByRole("dialog")).toContainElement(screen.getByTestId("canvas"));
  });

  it("drops the preview's caption when the canvas is read-only", () => {
    narrow();
    render(
      <ExpandableCanvas Expand={TestExpand} title="Your circuit" strings={strings} preview={<p>picture</p>} locked>
        {canvas}
      </ExpandableCanvas>,
    );
    expect(screen.getByRole("button", { name: "Expand to draw." })).not.toHaveTextContent("Expand to draw.");
  });

  it("keeps the canvas live on a narrow screen without a preview (the editors)", () => {
    narrow();
    render(
      <ExpandableCanvas Expand={TestExpand} title="Reference" strings={strings}>
        {canvas}
      </ExpandableCanvas>,
    );
    expect(screen.getByTestId("canvas")).toHaveTextContent("inline");
  });
});
