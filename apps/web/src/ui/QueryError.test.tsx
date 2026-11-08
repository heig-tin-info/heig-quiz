import { screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import { ApiError } from "../api";
import { renderWithProviders } from "../test/render";
import { QueryError } from ".";

describe("QueryError", () => {
  it("shows the server's own message and retries on demand", async () => {
    const onRetry = vi.fn();
    renderWithProviders(
      <QueryError
        title="Could not load your classrooms"
        error={new ApiError(503, { message: "GitHub is unavailable" })}
        onRetry={onRetry}
      />,
    );
    expect(screen.getByText("Could not load your classrooms")).toBeVisible();
    expect(screen.getByText("GitHub is unavailable")).toBeVisible();
    await userEvent.click(screen.getByRole("button", { name: "Retry" }));
    expect(onRetry).toHaveBeenCalledTimes(1);
  });

  // W9: the default is the TRANSLATED `error.server`, not an English literal.
  it("falls back when the failure carries no message", () => {
    renderWithProviders(<QueryError title="Could not load this classroom" error={new Error("x")} />);
    expect(screen.getByText("The server did not answer. Try again in a moment.")).toBeVisible();
    // No retry handler: no Retry button either.
    expect(screen.queryByRole("button", { name: "Retry" })).toBeNull();
  });

  it("uses the caller's fallback (student surfaces pass a translated one)", () => {
    renderWithProviders(
      <QueryError
        title="Could not load your classrooms"
        error={new ApiError(500, null)}
        fallback="Le serveur n'a pas répondu."
      />,
    );
    expect(screen.getByText("Le serveur n'a pas répondu.")).toBeVisible();
  });

  it("disables Retry while the refetch is in flight", () => {
    renderWithProviders(
      <QueryError title="Could not load" error={new Error("x")} onRetry={vi.fn()} retrying />,
    );
    expect(screen.getByRole("button", { name: "Retry" })).toBeDisabled();
  });

  // D02: one query hands over its error, its refetch and its fetching flag.
  it("reads the error, the retry and the busy state from one query", async () => {
    const refetch = vi.fn();
    const query = { error: new ApiError(503, { message: "GitHub is unavailable" }), refetch, isFetching: false };
    const { rerender } = renderWithProviders(<QueryError title="Could not load" query={query} />);
    expect(screen.getByText("GitHub is unavailable")).toBeVisible();
    await userEvent.click(screen.getByRole("button", { name: "Retry" }));
    expect(refetch).toHaveBeenCalledTimes(1);
    rerender(<QueryError title="Could not load" query={{ ...query, isFetching: true }} />);
    expect(screen.getByRole("button", { name: "Retry" })).toBeDisabled();
  });
});
