import { screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import { renderWithProviders } from "../test/render";
import { Field, FormDialog } from ".";

describe("FormDialog", () => {
  const renderForm = (props: Partial<React.ComponentProps<typeof FormDialog>> = {}) => {
    const onClose = vi.fn();
    const onSubmit = vi.fn();
    renderWithProviders(
      <FormDialog
        title="New course"
        onClose={onClose}
        onSubmit={onSubmit}
        submitLabel="Create course"
        {...props}
      >
        <Field label="Name" value="" onChange={() => {}} />
      </FormDialog>,
    );
    return { dialog: screen.getByRole("dialog", { name: "New course" }), onClose, onSubmit };
  };

  it("owns the Cancel / submit footer and calls back on each", async () => {
    const { dialog, onClose, onSubmit } = renderForm();
    await userEvent.click(within(dialog).getByRole("button", { name: "Create course" }));
    expect(onSubmit).toHaveBeenCalledOnce();
    await userEvent.click(within(dialog).getByRole("button", { name: "Cancel" }));
    expect(onClose).toHaveBeenCalledOnce();
  });

  it("keeps the submit button disabled until the form can be sent", () => {
    const { dialog } = renderForm({ canSubmit: false });
    expect(within(dialog).getByRole("button", { name: "Create course" })).toBeDisabled();
  });

  it("shows the pending spinner on the submit button and disables it", () => {
    const { dialog } = renderForm({ submitting: true });
    expect(within(dialog).getByRole("button", { name: "Create course" })).toBeDisabled();
  });

  it("places the error after the fields", () => {
    const { dialog } = renderForm({ error: <p>Code already taken</p> });
    const field = within(dialog).getByLabelText("Name");
    const error = within(dialog).getByText("Code already taken");
    expect(field.compareDocumentPosition(error) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });
});
