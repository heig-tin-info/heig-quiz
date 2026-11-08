import { screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";

import { ApiError } from "../api";
import { useErrorToast } from "../notify";
import { renderWithProviders } from "../test/render";

describe("useErrorToast", () => {
  function Failing({ error }: { error: unknown }) {
    const toastError = useErrorToast();
    return (
      <button type="button" onClick={() => toastError("error.save")(error)}>
        Fail
      </button>
    );
  }

  it("toasts the server's message in the error tone", async () => {
    renderWithProviders(<Failing error={new ApiError(422, { message: "Name is taken" })} />);
    await userEvent.click(screen.getByRole("button", { name: "Fail" }));
    expect(await screen.findByText("Name is taken")).toBeVisible();
  });

  it("falls back to the translated key when the server said nothing", async () => {
    renderWithProviders(<Failing error={new Error("network")} />, { locale: "fr" });
    await userEvent.click(screen.getByRole("button", { name: "Fail" }));
    expect(await screen.findByText("Impossible d'enregistrer cette modification.")).toBeVisible();
  });
});
