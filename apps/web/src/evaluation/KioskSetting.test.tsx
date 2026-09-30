import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";

import { Harness, open, PATCH, withMode } from "../test/advancedDisclosure";
import { mockFetch, ok, renderWithProviders } from "../test/render";

/* ADR-051 §2: kiosk stations, an exam's second trusted client, under SEB. */

const config = (kiosk: boolean) => ({ "GET /app/api/config": ok({ devLogin: false, kiosk: kiosk ? { extensionId: null, mock: true } : null }) });

describe("the kiosk-station setting", () => {
  it("is offered on an exam where the kiosk path exists, and sends the switch alone", async () => {
    const detail = withMode("exam");
    const { calls } = mockFetch({ ...config(true), [PATCH]: ok(detail) });
    renderWithProviders(<Harness detail={detail} />);
    await open();
    const toggle = await screen.findByRole("switch", { name: "Kiosk stations" });
    expect(toggle).not.toBeChecked();
    // Beside Safe Exam Browser, not instead of it.
    expect(screen.getByRole("switch", { name: "Safe Exam Browser" })).toBeInTheDocument();
    await userEvent.click(toggle);
    await waitFor(() =>
      expect(calls.find((c) => c.method === "PATCH")?.body).toEqual({ settings: { kiosk: true } }),
    );
  });

  it("is not offered where the platform has no kiosk path, nor on an exercise", async () => {
    const { calls } = mockFetch(config(false));
    const { unmount } = renderWithProviders(<Harness detail={withMode("exam")} />);
    await open();
    await waitFor(() => expect(calls.some((c) => c.url === "/app/api/config")).toBe(true));
    expect(screen.queryByRole("switch", { name: "Kiosk stations" })).toBeNull();
    unmount();
    mockFetch(config(true));
    renderWithProviders(<Harness detail={withMode("exercise")} />);
    await open();
    expect(screen.queryByRole("switch", { name: "Kiosk stations" })).toBeNull();
  });

  it("stays in sight while it is on, so it can be turned off, even without the kiosk path", async () => {
    mockFetch(config(false));
    renderWithProviders(<Harness detail={withMode("exam", { kiosk: true })} />);
    await open();
    expect(screen.getByRole("switch", { name: "Kiosk stations" })).toBeChecked();
  });
});
