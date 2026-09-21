import { fireEvent, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { describe, expect, it, vi } from "vitest";

import { renderWithProviders } from "../test/render";
import { MarkdownField } from "./MarkdownField";

/*
 * The field is controlled, so every test drives it through a tiny stateful
 * host: what is asserted is what the parent would have been told to store.
 *
 * `MarkdownField` is a label and an upload adapter around `RichText`
 * now — both surfaces live in the editor itself (RichText.test.tsx has the
 * toggle's own suite). What is tested HERE is that the whole thing still adds
 * up through the field a teacher actually meets: the same caret-level toolbar
 * of `insert.ts` under the same textarea, reached from the same field. So
 * most tests below open the source first, and `area()` is its textarea.
 */

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
document.elementFromPoint ??= () => null;
function Host({
  initial = "",
  onUploadImage,
  onValue,
}: {
  initial?: string;
  onUploadImage?: (file: File) => Promise<{ id: string }>;
  onValue?: (v: string) => void;
}) {
  const [value, setValue] = useState(initial);
  return (
    <MarkdownField
      value={value}
      onChange={(v) => {
        setValue(v);
        onValue?.(v);
      }}
      label="Prompt"
      onUploadImage={onUploadImage}
    />
  );
}

const area = () => screen.getByRole("textbox", { name: "Prompt" }) as HTMLTextAreaElement;

/**
 * Switches to the markdown source, where the textarea and `insert.ts` live.
 * One toggle at the end of the toolbar now, not a segmented control naming
 * two panes: "Write / Source" was the one thing the teacher did not
 * understand in the whole field.
 */
async function openSource() {
  await userEvent.click(screen.getByRole("button", { name: "Markdown source" }));
}

/** Puts the caret (or a selection) where a test needs it. */
function select(start: number, end = start) {
  const el = area();
  el.focus();
  el.setSelectionRange(start, end);
}

describe("MarkdownField — Source pane toolbar", () => {
  it("wraps the selection in bold and keeps it selected", async () => {
    renderWithProviders(<Host initial="Soit p un pointeur" />);
    await openSource();
    select(5, 6);
    await userEvent.click(screen.getByRole("button", { name: /^Bold/ }));
    expect(area()).toHaveValue("Soit **p** un pointeur");
    await waitFor(() => expect(area().selectionStart).toBe(7));
    expect(area().selectionEnd).toBe(8);
  });

  it("inserts a placeholder when nothing is selected", async () => {
    renderWithProviders(<Host initial="" />);
    await openSource();
    await userEvent.click(screen.getByRole("button", { name: /^Italic/ }));
    expect(area()).toHaveValue("*italic text*");
  });

  it("wraps a single line in backticks and a multi-line selection in a fence", async () => {
    renderWithProviders(<Host initial="int n" />);
    await openSource();
    select(0, 5);
    await userEvent.click(screen.getByRole("button", { name: "Code" }));
    expect(area()).toHaveValue("`int n`");
  });

  it("inserts a fenced block over a multi-line selection", async () => {
    renderWithProviders(<Host initial={"int a;\nint b;"} />);
    await openSource();
    select(0, 13);
    await userEvent.click(screen.getByRole("button", { name: "Code" }));
    expect(area()).toHaveValue("```c\nint a;\nint b;\n```");
  });

  it("inserts inline math", async () => {
    renderWithProviders(<Host initial="" />);
    await openSource();
    await userEvent.click(screen.getByRole("button", { name: "Equation" }));
    expect(area()).toHaveValue("$x^2$");
  });

  it("inserts a link and leaves the caret inside the URL", async () => {
    renderWithProviders(<Host initial="see here" />);
    await openSource();
    select(4, 8);
    await userEvent.click(screen.getByRole("button", { name: "Link" }));
    expect(area()).toHaveValue("see [here](https://)");
    await waitFor(() => expect(area().selectionStart).toBe(19));
  });

  it("hides the image button when no upload handler was given", async () => {
    renderWithProviders(<Host initial="" />);
    await openSource();
    expect(screen.queryByRole("button", { name: /image/i })).toBeNull();
  });
});

describe("MarkdownField — Source pane keyboard", () => {
  it("Ctrl+B and Ctrl+I apply emphasis", async () => {
    renderWithProviders(<Host initial="abc" />);
    await openSource();
    select(0, 3);
    await userEvent.keyboard("{Control>}b{/Control}");
    expect(area()).toHaveValue("**abc**");
    select(2, 5);
    await userEvent.keyboard("{Control>}i{/Control}");
    expect(area()).toHaveValue("***abc***");
  });

  it("Tab inserts two spaces instead of leaving the field", async () => {
    renderWithProviders(<Host initial="" />);
    await openSource();
    select(0);
    await userEvent.keyboard("{Tab}");
    expect(area()).toHaveValue("  ");
    expect(area()).toHaveFocus();
  });

  it("Shift+Tab outdents the lines of the selection", async () => {
    renderWithProviders(<Host initial={"  - a\n  - b"} />);
    await openSource();
    select(0, 11);
    await userEvent.keyboard("{Shift>}{Tab}{/Shift}");
    expect(area()).toHaveValue("- a\n- b");
  });
});

describe("MarkdownField — Source pane images", () => {
  const png = () => new File(["x"], "schema.png", { type: "image/png" });

  it("uploads a pasted image and inserts its asset reference", async () => {
    const onUploadImage = vi.fn(async () => ({ id: "a1b2" }));
    renderWithProviders(<Host initial="Text" onUploadImage={onUploadImage} />);
    await openSource();
    select(4);
    fireEvent.paste(area(), { clipboardData: { files: [png()], items: [], getData: () => "" } });
    await waitFor(() => expect(onUploadImage).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(area()).toHaveValue("Text\n\n![schema](asset:a1b2)"));
  });

  it("uploads a dropped image too", async () => {
    const onUploadImage = vi.fn(async () => ({ id: "c3" }));
    renderWithProviders(<Host initial="" onUploadImage={onUploadImage} />);
    await openSource();
    fireEvent.drop(area(), { dataTransfer: { files: [png()], items: [], types: ["Files"] } });
    await waitFor(() => expect(area()).toHaveValue("![schema](asset:c3)"));
  });

  it("ignores a pasted file that is not an image", async () => {
    const onUploadImage = vi.fn(async () => ({ id: "nope" }));
    renderWithProviders(<Host initial="" onUploadImage={onUploadImage} />);
    await openSource();
    const pdf = new File(["x"], "notes.pdf", { type: "application/pdf" });
    fireEvent.paste(area(), { clipboardData: { files: [pdf], items: [], getData: () => "" } });
    await new Promise((r) => setTimeout(r, 10));
    expect(onUploadImage).not.toHaveBeenCalled();
  });
});

describe("MarkdownField — panes", () => {
  it("names no pane at all: one toggle, where the formatting buttons are", () => {
    renderWithProviders(<Host initial="x" />);
    expect(screen.queryByRole("radio", { name: "Write" })).toBeNull();
    expect(screen.queryByRole("radio", { name: "Source" })).toBeNull();
    expect(screen.queryByRole("radio", { name: "Preview" })).toBeNull();
    const toggle = screen.getByRole("button", { name: "Markdown source" });
    expect(toggle).toHaveAttribute("aria-pressed", "false");
  });

  it("Write renders the markdown as nodes, not as characters", () => {
    renderWithProviders(<Host initial="**bold** and `code`" />);
    expect(screen.getByText("bold").tagName).toBe("STRONG");
    expect(screen.getByText("code").tagName).toBe("CODE");
  });

  it("Write is a rich surface and carries no textarea", () => {
    renderWithProviders(<Host initial="x" />);
    const box = screen.getByRole("textbox", { name: "Prompt" });
    expect(box.tagName).not.toBe("TEXTAREA");
    expect(box).toHaveAttribute("contenteditable", "true");
  });

  it("Source shows the very same string in a textarea, with its own toolbar", async () => {
    renderWithProviders(<Host initial="**bold** and `code`" />);
    await openSource();
    expect(area().tagName).toBe("TEXTAREA");
    expect(area()).toHaveValue("**bold** and `code`");
    expect(screen.getByRole("toolbar", { name: "Formatting" })).toBeInTheDocument();
  });

  it("keeps the label whichever surface shows, and carries no hint line", async () => {
    renderWithProviders(<Host initial="x" />);
    // The sentence under the field is gone: it named the shortcuts the
    // toolbar above it already shows, on every field of a four-field screen.
    expect(screen.getByText("Prompt")).toBeInTheDocument();
    expect(document.querySelector("p.text-fg-faint")).toBeNull();
    await openSource();
    expect(screen.getByRole("textbox", { name: "Prompt" }).tagName).toBe("TEXTAREA");
  });

  it("carries an edit made in Source back into Write", async () => {
    renderWithProviders(<Host initial="plain" />);
    await openSource();
    await userEvent.clear(area());
    await userEvent.type(area(), "**loud**");
    await openSource();
    expect(screen.getByText("loud").tagName).toBe("STRONG");
  });

  it("shows the French labels under the French locale (N-I18N-01)", () => {
    renderWithProviders(<Host initial="" />, { locale: "fr" });
    expect(screen.getByRole("button", { name: "Source markdown" })).toBeInTheDocument();
    expect(screen.getByRole("toolbar", { name: "Mise en forme" })).toBeInTheDocument();
  });
});

describe("MarkdownField — the Write pane uploads images too", () => {
  it("inserts the asset reference the upload returned", async () => {
    const onUploadImage = vi.fn(async () => ({ id: "w1" }));
    const onValue = vi.fn();
    const { container } = renderWithProviders(
      <Host initial="Text" onUploadImage={onUploadImage} onValue={onValue} />,
    );
    const input = container.querySelector("input[type=file]") as HTMLInputElement;
    fireEvent.change(input, {
      target: { files: [new File(["x"], "schema.png", { type: "image/png" })] },
    });
    await waitFor(() => expect(onUploadImage).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(onValue.mock.lastCall?.[0]).toContain("![schema](asset:w1)"));
  });
});
