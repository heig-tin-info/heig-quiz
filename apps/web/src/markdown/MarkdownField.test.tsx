import { fireEvent, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { describe, expect, it, vi } from "vitest";

import { renderWithProviders } from "../test/render";
import { MarkdownField } from "./MarkdownField";

/*
 * The field is controlled, so every test drives it through a tiny stateful
 * host: what is asserted is what the parent would have been told to store.
 */
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

/** Puts the caret (or a selection) where a test needs it. */
function select(start: number, end = start) {
  const el = area();
  el.focus();
  el.setSelectionRange(start, end);
}

describe("MarkdownField — toolbar", () => {
  it("wraps the selection in bold and keeps it selected", async () => {
    renderWithProviders(<Host initial="Soit p un pointeur" />);
    select(5, 6);
    await userEvent.click(screen.getByRole("button", { name: /^Bold/ }));
    expect(area()).toHaveValue("Soit **p** un pointeur");
    await waitFor(() => expect(area().selectionStart).toBe(7));
    expect(area().selectionEnd).toBe(8);
  });

  it("inserts a placeholder when nothing is selected", async () => {
    renderWithProviders(<Host initial="" />);
    await userEvent.click(screen.getByRole("button", { name: /^Italic/ }));
    expect(area()).toHaveValue("*italic text*");
  });

  it("wraps a single line in backticks and a multi-line selection in a fence", async () => {
    renderWithProviders(<Host initial="int n" />);
    select(0, 5);
    await userEvent.click(screen.getByRole("button", { name: "Code" }));
    expect(area()).toHaveValue("`int n`");
  });

  it("inserts a fenced block over a multi-line selection", async () => {
    renderWithProviders(<Host initial={"int a;\nint b;"} />);
    select(0, 13);
    await userEvent.click(screen.getByRole("button", { name: "Code" }));
    expect(area()).toHaveValue("```c\nint a;\nint b;\n```");
  });

  it("inserts inline math", async () => {
    renderWithProviders(<Host initial="" />);
    await userEvent.click(screen.getByRole("button", { name: "Equation" }));
    expect(area()).toHaveValue("$x^2$");
  });

  it("inserts a link and leaves the caret inside the URL", async () => {
    renderWithProviders(<Host initial="see here" />);
    select(4, 8);
    await userEvent.click(screen.getByRole("button", { name: "Link" }));
    expect(area()).toHaveValue("see [here](https://)");
    await waitFor(() => expect(area().selectionStart).toBe(19));
  });

  it("hides the image button when no upload handler was given", () => {
    renderWithProviders(<Host initial="" />);
    expect(screen.queryByRole("button", { name: /image/i })).toBeNull();
  });
});

describe("MarkdownField — keyboard", () => {
  it("Ctrl+B and Ctrl+I apply emphasis", async () => {
    renderWithProviders(<Host initial="abc" />);
    select(0, 3);
    await userEvent.keyboard("{Control>}b{/Control}");
    expect(area()).toHaveValue("**abc**");
    select(2, 5);
    await userEvent.keyboard("{Control>}i{/Control}");
    expect(area()).toHaveValue("***abc***");
  });

  it("Tab inserts two spaces instead of leaving the field", async () => {
    renderWithProviders(<Host initial="" />);
    select(0);
    await userEvent.keyboard("{Tab}");
    expect(area()).toHaveValue("  ");
    expect(area()).toHaveFocus();
  });

  it("Shift+Tab outdents the lines of the selection", async () => {
    renderWithProviders(<Host initial={"  - a\n  - b"} />);
    select(0, 11);
    await userEvent.keyboard("{Shift>}{Tab}{/Shift}");
    expect(area()).toHaveValue("- a\n- b");
  });
});

describe("MarkdownField — images", () => {
  const png = () => new File(["x"], "schema.png", { type: "image/png" });

  it("uploads a pasted image and inserts its asset reference", async () => {
    const onUploadImage = vi.fn(async () => ({ id: "a1b2" }));
    renderWithProviders(<Host initial="Text" onUploadImage={onUploadImage} />);
    select(4);
    fireEvent.paste(area(), { clipboardData: { files: [png()], items: [], getData: () => "" } });
    await waitFor(() => expect(onUploadImage).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(area()).toHaveValue("Text\n\n![schema](asset:a1b2)"));
  });

  it("uploads a dropped image too", async () => {
    const onUploadImage = vi.fn(async () => ({ id: "c3" }));
    renderWithProviders(<Host initial="" onUploadImage={onUploadImage} />);
    fireEvent.drop(area(), { dataTransfer: { files: [png()], items: [], types: ["Files"] } });
    await waitFor(() => expect(area()).toHaveValue("![schema](asset:c3)"));
  });

  it("ignores a pasted file that is not an image", async () => {
    const onUploadImage = vi.fn(async () => ({ id: "nope" }));
    renderWithProviders(<Host initial="" onUploadImage={onUploadImage} />);
    const pdf = new File(["x"], "notes.pdf", { type: "application/pdf" });
    fireEvent.paste(area(), { clipboardData: { files: [pdf], items: [], getData: () => "" } });
    await new Promise((r) => setTimeout(r, 10));
    expect(onUploadImage).not.toHaveBeenCalled();
  });
});

describe("MarkdownField — panes", () => {
  it("offers the three panes, Write first", () => {
    renderWithProviders(<Host initial="x" />);
    for (const name of ["Write", "Preview", "Source"]) {
      expect(screen.getByRole("radio", { name })).toBeInTheDocument();
    }
    expect(screen.getByRole("radio", { name: "Write" })).toBeChecked();
  });

  it("Preview renders the markdown and hides the textarea", async () => {
    renderWithProviders(<Host initial="**bold** and `code`" />);
    await userEvent.click(screen.getByRole("radio", { name: "Preview" }));
    expect(screen.queryByRole("textbox", { name: "Prompt" })).toBeNull();
    expect(screen.getByText("bold").tagName).toBe("STRONG");
    expect(screen.getByText("code").tagName).toBe("CODE");
  });

  it("Source shows the same textarea without the toolbar, ready for Tiptap to take Write", async () => {
    renderWithProviders(<Host initial="x" />);
    expect(screen.getByRole("toolbar", { name: "Formatting" })).toBeInTheDocument();
    await userEvent.click(screen.getByRole("radio", { name: "Source" }));
    expect(area()).toHaveValue("x");
    expect(screen.queryByRole("toolbar")).toBeNull();
  });

  it("shows the French labels under the French locale (N-I18N-01)", () => {
    renderWithProviders(<Host initial="" />, { locale: "fr" });
    expect(screen.getByRole("radio", { name: "Écrire" })).toBeInTheDocument();
    expect(screen.getByRole("radio", { name: "Aperçu" })).toBeInTheDocument();
    expect(screen.getByRole("radio", { name: "Source" })).toBeInTheDocument();
  });
});
