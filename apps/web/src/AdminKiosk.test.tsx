import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";

import type { KioskDevice } from "@quiz/contracts";

import { KioskSection } from "./AdminKiosk";
import { configKey } from "./queryKeys";
import { fail, makeQueryClient, mockFetch, ok, renderWithProviders } from "./test/render";

const CONFIG = "GET /app/api/config";
const LIST = "GET /app/api/admin/kiosk-devices";
const ON = ok({ devLogin: false, kiosk: { extensionId: null, mock: true } });

const unnamed: KioskDevice = {
  id: "33333333-3333-4333-8333-000000000001",
  googleDeviceId: "5CD3281JXQ",
  label: null,
  status: "unnamed",
  attestedAt: "2026-09-30T08:00:00.000Z",
  checkedAt: "2026-09-30T08:00:00.000Z",
  attestation: "ok",
};
const active: KioskDevice = {
  ...unnamed,
  id: "33333333-3333-4333-8333-000000000007",
  googleDeviceId: "5CD2417KLM",
  label: "Poste de secours n° 7",
  status: "active",
};
const retired: KioskDevice = {
  ...unnamed,
  id: "33333333-3333-4333-8333-000000000003",
  googleDeviceId: "NXHQEEZ001",
  label: "Ancien poste",
  status: "retired",
  attestation: "refused",
};

const patchOf = (d: KioskDevice) => `PATCH /app/api/admin/kiosk-devices/${d.id}`;

describe("the kiosk stations section (ADR-051 §5)", () => {
  it("is absent where the platform has no kiosk path, and asks for nothing", async () => {
    const { calls } = mockFetch({});
    const queryClient = makeQueryClient();
    queryClient.setQueryData(configKey, { devLogin: false, kiosk: null });
    renderWithProviders(<KioskSection />, { queryClient });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(screen.queryByText(/kiosk stations/i)).toBeNull();
    expect(calls).toEqual([]);
  });

  it("opens an unnamed station with its name field, and naming it sends the label", async () => {
    const { calls } = mockFetch({
      [CONFIG]: ON,
      [LIST]: ok([unnamed, active]),
      [patchOf(unnamed)]: ok({ ...unnamed, label: "Poste 1", status: "active" }),
    });
    renderWithProviders(<KioskSection />);

    const field = await screen.findByRole("textbox", { name: /station name/i });
    const name = screen.getByRole("button", { name: /^name$/i });
    expect(name).toBeDisabled();
    await userEvent.type(field, "  Poste 1 ");
    await userEvent.click(name);
    await waitFor(() =>
      expect(calls.find((c) => c.method === "PATCH")?.body).toEqual({ label: "Poste 1" }),
    );
    // The serial on the machine tells the admin which Chromebook the row is.
    expect(screen.getByText("5CD3281JXQ")).toBeInTheDocument();
    // The named station is a row like any other, no field of its own.
    expect(screen.getByText("Poste de secours n° 7")).toBeInTheDocument();
    expect(screen.getByText(/waiting for a name: 1/i)).toBeInTheDocument();
  });

  it("renames a station in its row, and Escape cancels", async () => {
    const { calls } = mockFetch({
      [CONFIG]: ON,
      [LIST]: ok([active]),
      [patchOf(active)]: ok({ ...active, label: "Poste n° 8" }),
    });
    renderWithProviders(<KioskSection />);
    const row = (await screen.findByText("Poste de secours n° 7")).closest("tr")!;

    await userEvent.click(within(row).getByRole("button", { name: /rename/i }));
    const field = within(row).getByRole("textbox", { name: /station name/i });
    await userEvent.keyboard("{Escape}");
    expect(field).not.toBeInTheDocument();

    await userEvent.click(within(row).getByRole("button", { name: /rename/i }));
    const again = within(row).getByRole("textbox", { name: /station name/i });
    await userEvent.clear(again);
    await userEvent.type(again, "Poste n° 8{Enter}");
    await waitFor(() =>
      expect(calls.find((c) => c.method === "PATCH")?.body).toEqual({ label: "Poste n° 8" }),
    );
  });

  it("retires after a confirmation, and reactivates a retired station", async () => {
    const { calls } = mockFetch({
      [CONFIG]: ON,
      [LIST]: ok([active, retired]),
      [patchOf(active)]: ok({ ...active, status: "retired" }),
      [patchOf(retired)]: ok({ ...retired, status: "active" }),
    });
    renderWithProviders(<KioskSection />);
    const row = (await screen.findByText("Poste de secours n° 7")).closest("tr")!;
    await userEvent.click(within(row).getByRole("button", { name: /retire/i }));
    const dialog = await screen.findByRole("dialog");
    await userEvent.click(within(dialog).getByRole("button", { name: /^retire$/i }));
    await waitFor(() =>
      expect(calls.find((c) => c.url.endsWith(active.id))?.body).toEqual({ status: "retired" }),
    );

    const old = screen.getByText("Ancien poste").closest("tr")!;
    expect(within(old).getByText(/refused/i)).toBeInTheDocument();
    await userEvent.click(within(old).getByRole("button", { name: /reactivate/i }));
    await waitFor(() =>
      expect(calls.find((c) => c.url.endsWith(retired.id))?.body).toEqual({ status: "active" }),
    );
  });

  it("says so when no station has attested yet, and offers a retry on failure", async () => {
    mockFetch({ [CONFIG]: ON, [LIST]: ok([]) });
    const { unmount } = renderWithProviders(<KioskSection />);
    expect(await screen.findByText(/no station yet/i)).toBeInTheDocument();
    unmount();

    mockFetch({ [CONFIG]: ON, [LIST]: fail(500, { error: "internal_error" }) });
    renderWithProviders(<KioskSection />);
    expect(await screen.findByRole("button", { name: /retry/i })).toBeInTheDocument();
  });
});
