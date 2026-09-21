import { fireEvent, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { describe, expect, it, vi } from "vitest";

import { renderWithProviders } from "../test/render";
import { resetShortcuts, useActiveShortcuts } from "../shortcuts";
import { modKey } from "../ui";
import { RichText } from "./RichText";

/*
 * jsdom implements `Range` but none of its layout methods, and ProseMirror
 * calls `getClientRects` while mapping the document to coordinates. The stubs
 * live here and not in `src/test/setup.ts`: they are this editor's need, and a
 * global stub would hide a real layout call in every other component test.
 */
if (typeof Range !== "undefined") {
  Range.prototype.getClientRects = () =>
    ({ length: 0, item: () => null, [Symbol.iterator]: function* () {} }) as unknown as DOMRectList;
  Range.prototype.getBoundingClientRect = () => new DOMRect();
}
// ProseMirror maps a click back to a document position through this one.
document.elementFromPoint ??= () => null;

/** The editing surface: a contenteditable that answers to `role="textbox"`. */
const surface = () => screen.getByRole("textbox", { name: "Prompt" });

/**
 * Selects everything in the surface through the real DOM selection, which is
 * what ProseMirror reads: `userEvent` types into a contenteditable by mutating
 * it, and leaves the selection collapsed at the start, so a toolbar action
 * that works ON a selection has nothing to work on until this runs.
 */
function selectAll() {
  const el = surface();
  el.focus();
  const range = document.createRange();
  range.selectNodeContents(el);
  const selection = window.getSelection();
  selection?.removeAllRanges();
  selection?.addRange(range);
  document.dispatchEvent(new Event("selectionchange"));
}

function Host({
  initial = "",
  onValue,
  ...props
}: {
  initial?: string;
  onValue?: (v: string) => void;
} & Partial<Parameters<typeof RichText>[0]>) {
  const [value, setValue] = useState(initial);
  return (
    <RichText
      aria-label="Prompt"
      value={value}
      onChange={(v) => {
        setValue(v);
        onValue?.(v);
      }}
      {...props}
    />
  );
}

describe("RichText — it shows the markdown, it does not print it", () => {
  it("renders emphasis, code and a link as nodes", () => {
    renderWithProviders(
      <Host initial="a **bold** word, `code`, and [a link](https://heig-vd.ch)" />,
    );
    expect(screen.getByText("bold").tagName).toBe("STRONG");
    expect(screen.getByText("code").tagName).toBe("CODE");
    expect(screen.getByText("a link").closest("a")).toHaveAttribute("href", "https://heig-vd.ch");
  });

  it("renders a formula with KaTeX rather than showing its dollars", () => {
    const { container } = renderWithProviders(<Host initial="La diagonale vaut $\\sqrt{2}$." />);
    expect(container.querySelector(".katex")).not.toBeNull();
    expect(surface().textContent).not.toContain("$");
  });

  it("renders a fenced block with its language", () => {
    const { container } = renderWithProviders(<Host initial={"```c\nint x = 1;\n```"} />);
    const code = container.querySelector("pre code");
    expect(code).not.toBeNull();
    expect(code?.textContent).toBe("int x = 1;");
  });

  it("resolves an asset image to the endpoint while storing the asset reference", () => {
    const { container } = renderWithProviders(<Host initial="![schema](asset:a1b2)" />);
    const img = container.querySelector("img");
    expect(img).toHaveAttribute("src", "/app/api/assets/a1b2");
    expect(img).toHaveAttribute("data-asset", "asset:a1b2");
  });
});

describe("RichText — what it tells its host", () => {
  it("says NOTHING on mount, so the draft is not autosaved for being looked at", async () => {
    const onChange = vi.fn();
    renderWithProviders(
      <RichText aria-label="Prompt" value="**bold** and `code`" onChange={onChange} />,
    );
    await new Promise((r) => setTimeout(r, 30));
    expect(onChange).not.toHaveBeenCalled();
  });

  it("emits markdown, not HTML, when the teacher types", async () => {
    const onValue = vi.fn();
    renderWithProviders(<Host initial="**bold**" onValue={onValue} />);
    await userEvent.type(surface(), "!");
    await waitFor(() => expect(onValue).toHaveBeenCalled());
    expect(onValue.mock.lastCall?.[0]).toMatch(/\*\*.*bold.*\*\*/);
    expect(onValue.mock.lastCall?.[0]).not.toContain("<strong>");
  });

  it("reloads when the value changes from outside (a restored version)", async () => {
    function Outside() {
      const [value, setValue] = useState("first");
      return (
        <>
          <button type="button" onClick={() => setValue("**second**")}>
            restore
          </button>
          <RichText aria-label="Prompt" value={value} onChange={setValue} />
        </>
      );
    }
    renderWithProviders(<Outside />);
    expect(surface().textContent).toContain("first");
    await userEvent.click(screen.getByRole("button", { name: "restore" }));
    await waitFor(() => expect(screen.getByText("second").tagName).toBe("STRONG"));
  });
});

describe("RichText — the toolbar", () => {
  it("offers the formatting actions, named and translated", () => {
    renderWithProviders(<Host initial="x" />);
    expect(screen.getByRole("toolbar", { name: "Formatting" })).toBeInTheDocument();
    for (const name of [/^Bold/, /^Italic/, "Code", "Code block", "Equation", "Link"]) {
      expect(screen.getByRole("button", { name })).toBeInTheDocument();
    }
  });

  it("hides the image action when no upload handler was given", () => {
    renderWithProviders(<Host initial="" />);
    expect(screen.queryByRole("button", { name: "Insert an image" })).toBeNull();
  });

  it("shows the French names under the French locale (N-I18N-01)", () => {
    renderWithProviders(<Host initial="" />, { locale: "fr" });
    expect(screen.getByRole("toolbar", { name: "Mise en forme" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Bloc de code" })).toBeInTheDocument();
  });

  it("makes the selection bold", async () => {
    const onValue = vi.fn();
    renderWithProviders(<Host initial="abc" onValue={onValue} />);
    selectAll();
    await userEvent.click(screen.getByRole("button", { name: /^Bold/ }));
    await waitFor(() => expect(onValue).toHaveBeenCalled());
    expect(onValue.mock.lastCall?.[0]).toBe("**abc**");
  });

  it("shows which mark the caret sits in", async () => {
    renderWithProviders(<Host initial="abc" />);
    const bold = screen.getByRole("button", { name: /^Bold/ });
    expect(bold).toHaveAttribute("aria-pressed", "false");
    selectAll();
    await userEvent.click(bold);
    await waitFor(() => expect(bold).toHaveAttribute("aria-pressed", "true"));
  });

  it("turns the paragraph into a fenced block", async () => {
    const onValue = vi.fn();
    renderWithProviders(<Host initial="int x;" onValue={onValue} />);
    await userEvent.click(screen.getByRole("button", { name: "Code block" }));
    await waitFor(() => expect(onValue).toHaveBeenCalled());
    expect(onValue.mock.lastCall?.[0]).toBe("```\nint x;\n```");
  });

  it("asks for an address before it makes a link, and applies it", async () => {
    const onValue = vi.fn();
    renderWithProviders(<Host initial="see here" onValue={onValue} />);
    selectAll();
    await userEvent.click(screen.getByRole("button", { name: "Link" }));
    const url = screen.getByLabelText("Address");
    await userEvent.type(url, "https://heig-vd.ch{Enter}");
    await waitFor(() => expect(onValue).toHaveBeenCalled());
    expect(onValue.mock.lastCall?.[0]).toContain("(https://heig-vd.ch)");
  });

  it("opens the formula dialog, and Escape leaves the prompt alone", async () => {
    const onValue = vi.fn();
    renderWithProviders(<Host initial="x" onValue={onValue} />);
    await userEvent.click(screen.getByRole("button", { name: "Equation" }));
    const latex = await screen.findByLabelText("LaTeX");
    await userEvent.type(latex, "\\sqrt{{2}");
    await userEvent.keyboard("{Escape}");
    await waitFor(() => expect(screen.queryByLabelText("LaTeX")).toBeNull());
    expect(onValue).not.toHaveBeenCalled();
  });

  it("writes the formula the dialog collected", async () => {
    const onValue = vi.fn();
    renderWithProviders(<Host initial="x" onValue={onValue} />);
    await userEvent.click(screen.getByRole("button", { name: "Equation" }));
    await userEvent.type(await screen.findByLabelText("LaTeX"), "\\sqrt{{2}{Enter}");
    await waitFor(() => expect(onValue).toHaveBeenCalled());
    expect(onValue.mock.lastCall?.[0]).toContain("$\\sqrt{2}$");
  });

  it("puts the formula on a line of its own when Display is picked", async () => {
    const onValue = vi.fn();
    renderWithProviders(<Host initial="x" onValue={onValue} />);
    await userEvent.click(screen.getByRole("button", { name: "Equation" }));
    await userEvent.type(await screen.findByLabelText("LaTeX"), "\\sqrt{{2}");
    await userEvent.click(screen.getByRole("radio", { name: "Display" }));
    await userEvent.click(screen.getByRole("button", { name: "Insert" }));
    await waitFor(() => expect(onValue).toHaveBeenCalled());
    expect(onValue.mock.lastCall?.[0]).toContain("$$\n\\sqrt{2}\n$$");
  });

  it("is hidden when the host asks for no toolbar, and Ctrl+B still works", async () => {
    const onValue = vi.fn();
    renderWithProviders(<Host initial="abc" toolbar="never" onValue={onValue} />);
    expect(screen.queryByRole("toolbar")).toBeNull();
    selectAll();
    await userEvent.keyboard("{Control>}b{/Control}");
    await waitFor(() => expect(onValue).toHaveBeenCalled());
    expect(onValue.mock.lastCall?.[0]).toBe("**abc**");
  });
});

describe("RichText — images", () => {
  const png = () => new File(["x"], "schema.png", { type: "image/png" });

  it("uploads a picked image and inserts its asset reference", async () => {
    const uploadImage = vi.fn(async () => "asset:a1b2");
    const onValue = vi.fn();
    const { container } = renderWithProviders(
      <Host initial="Text" uploadImage={uploadImage} onValue={onValue} />,
    );
    const input = container.querySelector("input[type=file]") as HTMLInputElement;
    // `fireEvent` and not `userEvent.upload`: the input is `sr-only`, and the
    // pointer checks of `userEvent` need a layout jsdom does not run.
    fireEvent.change(input, { target: { files: [png()] } });
    await waitFor(() => expect(uploadImage).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(onValue.mock.lastCall?.[0]).toContain("![schema](asset:a1b2)"));
  });
});

describe("RichText — inline mode, the row of a choice", () => {
  it("calls onEnter instead of splitting the paragraph", async () => {
    const onEnter = vi.fn();
    const onValue = vi.fn();
    renderWithProviders(<Host initial="abc" inline toolbar="never" onEnter={onEnter} onValue={onValue} />);
    surface().focus();
    await userEvent.keyboard("{Enter}");
    expect(onEnter).toHaveBeenCalledTimes(1);
    expect(onValue).not.toHaveBeenCalled();
  });

  it("gives Tab to the host, and lets it through when the host declines", async () => {
    const onTab = vi.fn(() => false);
    renderWithProviders(<Host initial="abc" inline toolbar="never" onTab={onTab} />);
    surface().focus();
    await userEvent.tab();
    expect(onTab).toHaveBeenCalledWith(false);
    expect(surface()).not.toHaveFocus();
  });

  it("keeps the caret when the host handled Tab", async () => {
    const onTab = vi.fn(() => true);
    renderWithProviders(<Host initial="abc" inline toolbar="never" onTab={onTab} />);
    surface().focus();
    await userEvent.tab();
    expect(onTab).toHaveBeenCalledWith(false);
    expect(surface()).toHaveFocus();
  });

  it("offers no code-block action, having nowhere to put one", () => {
    renderWithProviders(<Host initial="abc" inline />);
    expect(screen.queryByRole("button", { name: "Code block" })).toBeNull();
    expect(screen.getByRole("button", { name: /^Bold/ })).toBeInTheDocument();
  });
});

describe("RichText — the markdown source", () => {
  const toggle = () => screen.getByRole("button", { name: "Markdown source" });

  it("swaps the surface for the very same string in a textarea, and back", async () => {
    renderWithProviders(<Host initial="**bold** and `code`" />);
    expect(toggle()).toHaveAttribute("aria-pressed", "false");
    await userEvent.click(toggle());
    const area = screen.getByRole("textbox", { name: "Prompt" });
    expect(area.tagName).toBe("TEXTAREA");
    expect(area).toHaveValue("**bold** and `code`");
    expect(toggle()).toHaveAttribute("aria-pressed", "true");
    await userEvent.click(toggle());
    expect(screen.getByRole("textbox", { name: "Prompt" }).tagName).not.toBe("TEXTAREA");
  });

  it("carries an edit made in the source back into the rich surface", async () => {
    renderWithProviders(<Host initial="plain" />);
    await userEvent.click(toggle());
    const area = screen.getByRole("textbox", { name: "Prompt" });
    await userEvent.clear(area);
    await userEvent.type(area, "**loud**");
    await userEvent.click(toggle());
    expect(screen.getByText("loud").tagName).toBe("STRONG");
  });

  it("keeps Tab as an indent in the source pane", async () => {
    renderWithProviders(<Host initial="" />);
    await userEvent.click(toggle());
    const area = screen.getByRole("textbox", { name: "Prompt" }) as HTMLTextAreaElement;
    area.focus();
    await userEvent.keyboard("{Tab}");
    expect(area).toHaveValue("  ");
    expect(area).toHaveFocus();
  });

  it("is not offered on an inline field, which has no room for a second pane", () => {
    renderWithProviders(<Host initial="abc" inline toolbar="always" />);
    expect(screen.queryByRole("button", { name: "Markdown source" })).toBeNull();
  });
});

describe("RichText — the toolbar of an inline field", () => {
  it("appears only while the field has the caret", async () => {
    renderWithProviders(<Host initial="abc" inline toolbar="focus" />);
    expect(screen.queryByRole("toolbar")).toBeNull();
    surface().focus();
    await waitFor(() =>
      expect(screen.getByRole("toolbar", { name: "Formatting" })).toBeInTheDocument(),
    );
    // What a row of a list gets: the marks, a formula, a link. No fence.
    expect(screen.getByRole("button", { name: /^Bold/ })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Code block" })).toBeNull();
  });

  it("does not take the caret out of the field when a button is pressed", async () => {
    renderWithProviders(<Host initial="abc" inline toolbar="focus" />);
    surface().focus();
    const bold = await screen.findByRole("button", { name: /^Bold/ });
    // A default-prevented mousedown is the whole trick: the field keeps the
    // focus, so the button formats a selection instead of losing it.
    expect(fireEvent.mouseDown(bold)).toBe(false);
    expect(surface()).toHaveFocus();
  });
});

describe("RichText — what the shortcut strip shows", () => {
  function Strip() {
    const live = useActiveShortcuts();
    return <ul data-testid="strip">{live.map((s) => <li key={s.keys}>{`${s.keys} ${s.label}`}</li>)}</ul>;
  }

  it("publishes the formatting keys while the field has the focus, and the host's on top", async () => {
    resetShortcuts();
    renderWithProviders(
      <>
        <Host initial="abc" inline toolbar="focus" shortcuts={[{ keys: "Tab", label: "Add a choice" }]} />
        <Strip />
      </>,
    );
    expect(screen.getByTestId("strip")).toBeEmptyDOMElement();
    surface().focus();
    await waitFor(() =>
      expect(screen.getByTestId("strip")).toHaveTextContent("Tab Add a choice"),
    );
    expect(screen.getByTestId("strip")).toHaveTextContent(`${modKey()}+B Bold`);
  });
});

describe("RichText — disabled", () => {
  it("is not editable and its actions are off", () => {
    renderWithProviders(<Host initial="abc" disabled />);
    expect(surface()).toHaveAttribute("contenteditable", "false");
    expect(screen.getByRole("button", { name: /^Bold/ })).toBeDisabled();
  });
});
