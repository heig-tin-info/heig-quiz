import { act, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it } from "vitest";

import { installBattery, refuseBattery, uninstallBattery } from "../test/battery";
import { renderWithProviders } from "../test/render";
import { BatteryClock } from "./BatteryClock";

/** The pill, once the battery's promise has answered. */
const pill = () => screen.findByRole("button", { expanded: false });

describe("BatteryClock (issue #1151)", () => {
  afterEach(uninstallBattery);

  it("draws nothing where the browser has no Battery Status API", async () => {
    renderWithProviders(<BatteryClock />);
    await act(async () => {});
    expect(screen.queryByRole("button")).not.toBeInTheDocument();
  });

  it("draws nothing where the browser refuses it", async () => {
    refuseBattery();
    renderWithProviders(<BatteryClock />);
    await act(async () => {});
    expect(screen.queryByRole("button")).not.toBeInTheDocument();
  });

  it("shows the level, and unfolds the time and the time left on a click", async () => {
    installBattery({ level: 0.42, dischargingTime: 80 * 60 + 25 });
    renderWithProviders(<BatteryClock />);
    const button = await pill();
    expect(button).toHaveAccessibleName("Battery 42%, 1 h 20 min left");
    expect(button).toHaveTextContent(/^42%$/);
    await userEvent.click(button);
    expect(button).toHaveAttribute("aria-expanded", "true");
    expect(button).toHaveTextContent(/^42%·\d{2}:\d{2}·1 h 20 min left$/);
    expect(button.getAttribute("aria-label")).toMatch(/^Battery 42%, 1 h 20 min left, time \d{2}:\d{2}$/);
    await userEvent.click(button);
    expect(button).toHaveAttribute("aria-expanded", "false");
    expect(button).toHaveTextContent(/^42%$/);
  });

  it("says charging, in French too", async () => {
    installBattery({ level: 0.15, charging: true, chargingTime: 1800, dischargingTime: Infinity });
    renderWithProviders(<BatteryClock />, { locale: "fr" });
    const button = await pill();
    expect(button).toHaveAccessibleName(/^Batterie 15%, en charge$/);
    // Charging, a low level is no warning.
    expect(button.className).not.toMatch(/warning|danger/);
  });

  it("turns warning at 20 % and danger at 10 %, discharging", async () => {
    const fake = installBattery({ level: 0.21 });
    renderWithProviders(<BatteryClock />);
    const button = await pill();
    expect(button.className).not.toMatch(/warning|danger/);
    fake.set({ level: 0.2 });
    expect(button).toHaveClass("bg-warning-soft", "text-warning");
    fake.set({ level: 0.1 });
    expect(button).toHaveClass("bg-danger-soft", "text-danger");
    fake.set({ charging: true });
    expect(button.className).not.toMatch(/warning|danger/);
  });

  it("shows the clock alone on a machine with no battery", async () => {
    installBattery({ level: 1, charging: true, chargingTime: 0, dischargingTime: Infinity });
    renderWithProviders(<BatteryClock />);
    const button = await pill();
    expect(button).toHaveAccessibleName("Time");
    expect(button).toHaveTextContent("");
    await userEvent.click(button);
    expect(button).toHaveTextContent(/^\d{2}:\d{2}$/);
    expect(button.getAttribute("aria-label")).toMatch(/^Time \d{2}:\d{2}$/);
  });

  it("says nothing of a time left the browser does not know yet", async () => {
    installBattery({ level: 0.6, dischargingTime: Infinity });
    renderWithProviders(<BatteryClock />);
    expect(await pill()).toHaveAccessibleName("Battery 60%");
  });
});
