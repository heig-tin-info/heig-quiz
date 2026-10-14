import { screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { en } from "./i18n/en";
import { fr } from "./i18n/fr";
import { LoginRefusedPage } from "./LoginRefusedPage";
import { renderWithProviders } from "./test/render";

describe("LoginRefusedPage (ADR-111 §6)", () => {
  it.each([
    ["restricted", en["loginRefused.restricted"]],
    ["not_invited", en["loginRefused.not_invited"]],
    ["retry", en["loginRefused.retry"]],
    // Anything else reads as the admission refusal.
    ["../evil", en["loginRefused.not_invited"]],
  ])("says why for reason=%s, with one way back home", (reason, body) => {
    renderWithProviders(<LoginRefusedPage />, { route: `/sign-in/refused?reason=${reason}` });
    expect(screen.getByRole("heading", { level: 1 })).toHaveTextContent(en["loginRefused.title"]);
    expect(screen.getByText(body)).toBeInTheDocument();
    expect(screen.getByRole("link", { name: en["loginRefused.home"] })).toHaveAttribute("href", "/");
  });

  it("speaks French", () => {
    renderWithProviders(<LoginRefusedPage />, { locale: "fr", route: "/sign-in/refused?reason=retry" });
    expect(screen.getByText(fr["loginRefused.retry"])).toBeInTheDocument();
  });
});
