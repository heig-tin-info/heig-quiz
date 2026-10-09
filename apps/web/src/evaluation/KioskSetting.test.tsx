import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";

import type { EvaluationSettings } from "@quiz/contracts";

import { Harness, open, PATCH, withMode } from "../test/advancedDisclosure";
import { mockFetch, ok, renderWithProviders } from "../test/render";

/* ADR-027, ADR-051 §2: an exam's "Allowed devices", one choice over its
   two trusted-client switches (`safeExamBrowser`, `kiosk`). */

const config = (kiosk: boolean) => ({ "GET /app/api/config": ok({ devLogin: false, kiosk: kiosk ? { extensionId: null, mock: true } : null }) });

const ANY = /^Any device/;
const SEB = /^Safe Exam Browser/;
const EITHER = /^SEB or kiosk station/;
const KIOSK = /^Kiosk station only/;

type Pair = Pick<EvaluationSettings, "safeExamBrowser" | "kiosk">;
const pairs: Record<string, Pair> = {
  any: { safeExamBrowser: false, kiosk: false },
  seb: { safeExamBrowser: true, kiosk: false },
  either: { safeExamBrowser: true, kiosk: true },
  kiosk: { safeExamBrowser: false, kiosk: true },
};
const names: Record<string, RegExp> = { any: ANY, seb: SEB, either: EITHER, kiosk: KIOSK };

describe("the allowed-devices setting", () => {
  it.each([
    ["any", "seb", { safeExamBrowser: true }],
    ["any", "either", { safeExamBrowser: true, kiosk: true }],
    ["any", "kiosk", { kiosk: true }],
    ["seb", "any", { safeExamBrowser: false }],
    ["seb", "kiosk", { safeExamBrowser: false, kiosk: true }],
    ["either", "seb", { kiosk: false }],
    ["kiosk", "either", { safeExamBrowser: true }],
    ["kiosk", "any", { kiosk: false }],
  ])("from %s to %s, sends only the keys that change, in one patch", async (from, to, body) => {
    const detail = withMode("exam", pairs[from]);
    const { calls } = mockFetch({ ...config(true), [PATCH]: ok(detail) });
    renderWithProviders(<Harness detail={detail} />);
    await open();
    expect(await screen.findByRole("radio", { name: names[from] })).toBeChecked();
    await userEvent.click(screen.getByRole("radio", { name: names[to] }));
    await waitFor(() => expect(calls.some((c) => c.method === "PATCH")).toBe(true));
    const patches = calls.filter((c) => c.method === "PATCH");
    expect(patches).toHaveLength(1);
    expect(patches[0]!.body).toEqual({ settings: body });
  });

  it("offers the four choices, in order, where the kiosk path exists", async () => {
    mockFetch(config(true));
    renderWithProviders(<Harness detail={withMode("exam")} />);
    await open();
    await screen.findByRole("radio", { name: KIOSK });
    const group = screen.getByRole("group", { name: "Allowed devices" });
    const radios = Array.from(group.querySelectorAll("input[type=radio]"));
    expect(radios.map((r) => (r as HTMLInputElement).value)).toEqual(["any", "seb", "either", "kiosk"]);
  });

  it("hides the kiosk choices where the platform has no kiosk path", async () => {
    const { calls } = mockFetch(config(false));
    renderWithProviders(<Harness detail={withMode("exam")} />);
    await open();
    await waitFor(() => expect(calls.some((c) => c.url === "/app/api/config")).toBe(true));
    expect(screen.getByRole("radio", { name: ANY })).toBeChecked();
    expect(screen.getByRole("radio", { name: SEB })).toBeInTheDocument();
    expect(screen.queryByRole("radio", { name: EITHER })).toBeNull();
    expect(screen.queryByRole("radio", { name: KIOSK })).toBeNull();
  });

  it("keeps the kiosk choice in force in sight without the kiosk path, so it can be left", async () => {
    const { calls } = mockFetch(config(false));
    renderWithProviders(<Harness detail={withMode("exam", pairs.either)} />);
    await open();
    await waitFor(() => expect(calls.some((c) => c.url === "/app/api/config")).toBe(true));
    expect(screen.getByRole("radio", { name: EITHER })).toBeChecked();
    expect(screen.queryByRole("radio", { name: KIOSK })).toBeNull();
  });

  it("is not shown outside an exam", async () => {
    mockFetch(config(true));
    renderWithProviders(<Harness detail={withMode("exercise", pairs.either)} />);
    await open();
    expect(screen.queryByRole("group", { name: "Allowed devices" })).toBeNull();
    expect(screen.queryByRole("radio", { name: ANY })).toBeNull();
  });

  it("is disabled, whole, when the configuration is frozen", async () => {
    const { calls } = mockFetch(config(true));
    renderWithProviders(<Harness detail={withMode("exam")} disabled />);
    await open();
    await screen.findByRole("radio", { name: KIOSK });
    for (const name of [ANY, SEB, EITHER, KIOSK]) expect(screen.getByRole("radio", { name })).toBeDisabled();
    await userEvent.click(screen.getByRole("radio", { name: SEB }));
    expect(calls.some((c) => c.method === "PATCH")).toBe(false);
  });
});
