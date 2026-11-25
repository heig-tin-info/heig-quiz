import { screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { AssistDock } from "../assist/AssistDock";
import { makeMe } from "../test/fixtures";
import { mockFetch, ok, renderWithProviders } from "../test/render";
import { phoneScreen, viewport } from "../test/viewport";
import { PageHeader } from "./page";

/*
 * A phone held in the hand goes without the help assistant and the page's
 * "?" (ADR-080 §7, amendment of 2026-11-24): narrow AND touch. A narrow
 * window with a mouse (a desktop zoomed to 200 %, N-A11Y-04) and a touch
 * screen with room (a tablet) keep both.
 */
const initial = window.matchMedia;
afterEach(() => {
  vi.stubGlobal("matchMedia", initial);
});

const AVAILABLE = { "GET /app/api/assist/availability": ok({ available: true, stub: false }) };

function screenWithHelp() {
  return (
    <>
      <PageHeader title="Pool" help="pool" />
      <AssistDock me={makeMe()} route={{ view: "home" }} teacherUi />
    </>
  );
}

describe("on a phone held in the hand", () => {
  it("draws neither the assistant nor the page's help, and asks nothing", () => {
    phoneScreen({ coarse: true });
    const { calls } = mockFetch(AVAILABLE);
    const { container } = renderWithProviders(screenWithHelp());
    expect(screen.getByRole("heading", { name: "Pool" })).toBeInTheDocument();
    // In the page, hidden: out of sight, of the focus and of a screen reader.
    expect(screen.queryByRole("button", { name: "Help" })).toBeNull();
    expect(container.querySelector('[data-coach="page.help"]')).not.toBeVisible();
    expect(screen.queryByRole("button", { name: "Ask the help assistant" })).toBeNull();
    expect(calls).toHaveLength(0);
  });

  it.each([
    ["a narrow window with a mouse (zoomed desktop)", () => phoneScreen()],
    ["a wide touch screen (tablet)", () => viewport(768, { coarse: true })],
  ])("keeps both on %s", async (_, media) => {
    media();
    mockFetch(AVAILABLE);
    renderWithProviders(screenWithHelp());
    expect(screen.getByRole("button", { name: "Help" })).toBeVisible();
    await waitFor(() => expect(screen.getByRole("button", { name: "Ask the help assistant" })).toBeInTheDocument());
  });
});
