import { screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { renderWithProviders } from "../test/render";
import { Menu, Spinner } from ".";

describe("the default accessible names", () => {
  // English names in a French render are what no other test looks for (FC-20).
  it("are translated for a menu trigger and a spinner", () => {
    renderWithProviders(
      <>
        <Menu items={[{ label: "Renommer", onSelect: () => {} }]} />
        <Spinner />
      </>,
      { locale: "fr" },
    );
    expect(screen.getByRole("button", { name: "Plus d'actions" })).toBeVisible();
    expect(screen.getByRole("status", { name: "Chargement…" })).toBeInTheDocument();
  });
});
