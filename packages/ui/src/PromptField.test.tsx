import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import type { RichTextProps } from "@quiz/core/client";

import { PromptField } from "./PromptField.js";

const base = {
  id: "p",
  label: "Statement",
  value: "Hello",
  labelClassName: "lbl",
  textareaClassName: "ta",
};

describe("PromptField", () => {
  it("falls back to a labelled textarea and reports every keystroke", () => {
    const onChange = vi.fn();
    render(<PromptField {...base} onChange={onChange} />);
    const field = screen.getByLabelText("Statement");
    expect(field.tagName).toBe("TEXTAREA");
    expect(field).toHaveValue("Hello");
    expect(field).toHaveAttribute("rows", "4");
    expect(document.querySelector("label")?.htmlFor).toBe("p");
    fireEvent.change(field, { target: { value: "Hi" } });
    expect(onChange).toHaveBeenCalledWith("Hi");
  });

  it("uses the host's rich editor under a caption, never a <label for>", () => {
    const seen: RichTextProps[] = [];
    const RichText = (props: RichTextProps) => {
      seen.push(props);
      return <div id={props.id} aria-label={props["aria-label"]} />;
    };
    const upload = async () => "asset:x";
    render(
      <PromptField {...base} onChange={() => {}} RichText={RichText} uploadImage={upload} holes disabled />,
    );
    expect(document.querySelector("label")).toBeNull();
    expect(screen.getByText("Statement").tagName).toBe("SPAN");
    expect(seen[0]).toMatchObject({
      id: "p",
      "aria-label": "Statement",
      value: "Hello",
      holes: true,
      disabled: true,
      uploadImage: upload,
    });
  });

  it("passes no `holes` and no `uploadImage` the caller did not give", () => {
    const seen: RichTextProps[] = [];
    const RichText = (props: RichTextProps) => {
      seen.push(props);
      return null;
    };
    render(<PromptField {...base} onChange={() => {}} RichText={RichText} />);
    expect(seen[0]).not.toHaveProperty("holes");
    expect(seen[0]).not.toHaveProperty("uploadImage");
    expect(seen[0]).not.toHaveProperty("disabled");
  });
});
