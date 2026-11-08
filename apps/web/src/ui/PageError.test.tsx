import { screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import { renderWithProviders } from "../test/render";
import { PageError } from ".";

/*
 * W3: a query that fails and takes the page with it still has to leave the
 * document a heading. `QueryError` returned on its own left a route whose
 * `document.querySelectorAll("h1").length` was 0 — nothing for a screen
 * reader to land on, and no way to tell which page had failed.
 */
describe("PageError", () => {
  it("keeps the page's heading above the alert", () => {
    renderWithProviders(<PageError title="Pool not found" error={new Error("x")} />);
    expect(screen.getByRole("heading", { level: 1, name: "Pool not found" })).toBeVisible();
    expect(screen.getByText("Something went wrong")).toBeVisible();
    expect(screen.getByText(/The server did not answer/)).toBeVisible();
  });

  it("offers the retry it was given", async () => {
    const onRetry = vi.fn();
    renderWithProviders(
      <PageError title="Pool not found" error={new Error("x")} onRetry={onRetry} />,
    );
    await userEvent.click(screen.getByRole("button", { name: "Retry" }));
    expect(onRetry).toHaveBeenCalledTimes(1);
  });
});
