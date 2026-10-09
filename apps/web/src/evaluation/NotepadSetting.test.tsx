import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";

import { Harness, open, PATCH, withMode } from "../test/advancedDisclosure";
import { mockFetch, ok, renderWithProviders } from "../test/render";

/* ADR-090: the notepad provided, the calculator's sibling in the advanced options. */

const config = { "GET /app/api/config": ok({ devLogin: false, kiosk: null }) };

describe("the notepad setting", () => {
  it("offers none, provided and provided without copy-paste, and sends the choice alone", async () => {
    const detail = withMode("exam");
    const { calls } = mockFetch({ ...config, [PATCH]: ok(detail) });
    renderWithProviders(<Harness detail={detail} />);
    await open();
    const group = screen.getByRole("radiogroup", { name: "Notepad provided" });
    expect(within(group).getByRole("radio", { name: "None" })).toBeChecked();
    expect(screen.getByText("No notepad on the student's screen.")).toBeInTheDocument();
    await userEvent.click(within(group).getByRole("radio", { name: "No copy-paste" }));
    await waitFor(() =>
      expect(calls.find((c) => c.method === "PATCH")?.body).toEqual({ settings: { notepad: "provided_no_clipboard" } }),
    );
  });

  it("says where the notes live when it is on", async () => {
    mockFetch(config);
    renderWithProviders(<Harness detail={withMode("exercise", { notepad: "provided" })} />);
    await open();
    expect(screen.getByText(/never reach the server, and are deleted at hand-in/)).toBeInTheDocument();
  });

  it("is not offered on a poll", async () => {
    mockFetch(config);
    renderWithProviders(<Harness detail={withMode("poll")} />);
    await open();
    expect(screen.queryByRole("radiogroup", { name: "Notepad provided" })).toBeNull();
  });
});
