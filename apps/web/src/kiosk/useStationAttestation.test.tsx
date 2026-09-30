import { QueryClientProvider } from "@tanstack/react-query";
import { act, renderHook, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ApiError, api } from "../api";
import { fail, makeQueryClient, mockFetch, ok } from "../test/render";
import { useStationAttestation } from "./useStationAttestation";

/*
 * ADR-051 §6 on the attempt page: a write answered `423 kiosk_suspended`
 * raises the notice, a later accepted attestation lifts it; the submit is
 * re-attested, and retried once when the server found it stale.
 */

const CONFIG = { "GET /app/api/config": ok({ devLogin: false, kiosk: { extensionId: null, mock: true } }) };
const ATTESTED = {
  "POST /app/api/kiosk/attest/challenge": ok({ challenge: "Yw==" }),
  "POST /app/api/kiosk/attest/verify": ok({ station: { label: "Poste n° 7", status: "active" } }),
};

function providers() {
  const client = makeQueryClient();
  return ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={client}>{children}</QueryClientProvider>
  );
}

beforeEach(() => vi.useFakeTimers({ shouldAdvanceTime: true }));
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("useStationAttestation", () => {
  it("is suspended on a 423 kiosk_suspended, and lifts itself on the next accepted attestation", async () => {
    mockFetch({
      ...CONFIG,
      "POST /app/api/kiosk/attest/challenge": ok({ challenge: "Yw==" }),
      "POST /app/api/kiosk/attest/verify": fail(403, { error: "not_attested" }),
      "PUT /x": fail(423, { error: "kiosk_suspended" }),
    });
    const { result } = renderHook(() => useStationAttestation(true), { wrapper: providers() });
    await act(async () => {
      await api("/x", { method: "PUT" }).catch(() => undefined);
    });
    expect(result.current.suspended).toBe(true);
    // Still refused at the next try: still suspended.
    await act(async () => void (await vi.advanceTimersByTimeAsync(30_000)));
    expect(result.current.suspended).toBe(true);
    mockFetch({ ...CONFIG, ...ATTESTED });
    await act(async () => void (await vi.advanceTimersByTimeAsync(30_000)));
    await waitFor(() => expect(result.current.suspended).toBe(false));
  });

  it("re-attests before the submit, and retries once a stale one", async () => {
    const { calls } = mockFetch({ ...CONFIG, ...ATTESTED });
    const { result } = renderHook(() => useStationAttestation(true), { wrapper: providers() });
    // The public configuration names the attestation mode: read it first.
    await waitFor(() => expect(calls.some((c) => c.url === "/app/api/config")).toBe(true));
    await act(async () => void (await vi.advanceTimersByTimeAsync(0)));
    const submit = vi
      .fn<() => Promise<string>>()
      .mockRejectedValueOnce(new ApiError(423, { error: "kiosk_attestation_stale" }))
      .mockResolvedValueOnce("submitted");
    let outcome: string | undefined;
    await act(async () => {
      outcome = await result.current.guardSubmit(submit);
    });
    expect(outcome).toBe("submitted");
    expect(submit).toHaveBeenCalledTimes(2);
    expect(calls.filter((c) => c.url === "/app/api/kiosk/attest/verify")).toHaveLength(2);
  });

  it("submits untouched off a station", async () => {
    const { calls } = mockFetch(CONFIG);
    const { result } = renderHook(() => useStationAttestation(false), { wrapper: providers() });
    const submit = vi.fn(async () => "ok");
    await act(async () => void (await result.current.guardSubmit(submit)));
    expect(submit).toHaveBeenCalledOnce();
    expect(calls.filter((c) => c.url.startsWith("/app/api/kiosk"))).toHaveLength(0);
  });
});
