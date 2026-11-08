import { screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { ApiError } from "../api";
import { renderWithProviders } from "../test/render";
import { FormError } from ".";

describe("FormError", () => {
  it("renders nothing until the write has failed", () => {
    renderWithProviders(<FormError error={null} fallback="Could not save" title="Failed" />);
    expect(screen.queryByText("Could not save")).toBeNull();
    expect(screen.queryByText("Failed")).toBeNull();
  });

  it("is the one red line under a dialog's fields, with the server's message", () => {
    renderWithProviders(
      <FormError error={new ApiError(409, { message: "Code already taken" })} fallback="x" />,
    );
    // The message sits beside the circled "!" of `ErrorText`, inside its <p>.
    const line = screen.getByText("Code already taken").closest("p");
    expect(line).toHaveClass("text-danger");
    expect(line?.querySelector("svg[aria-hidden='true']")).not.toBeNull();
  });

  it("becomes a titled alert, falling back to the translated error.server", () => {
    renderWithProviders(<FormError error={new Error("x")} title="Could not save" />);
    expect(screen.getByRole("status")).toHaveTextContent("Could not save");
    expect(screen.getByText("The server did not answer. Try again in a moment.")).toBeVisible();
  });
});
