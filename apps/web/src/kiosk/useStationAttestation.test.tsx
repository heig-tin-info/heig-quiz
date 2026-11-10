import { QueryClientProvider } from "@tanstack/react-query";
import { act, renderHook, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { KIOSK_REATTEST_MS } from "@quiz/domain";

import { ApiError, api } from "../api";
import { fail, makeQueryClient, mockFetch, ok } from "../test/render";
import { KIOSK_RETRY_MS } from "./useKioskStation";
import { useStationAttestation } from "./useStationAttestation";

/*
 * ADR-051 §6 on the attempt route: the station attests at once, then every
 * ten minutes; a failed attestation is tried again every 30 s; a write
 * answered `423 kiosk_suspended` raises the notice, a later accepted
 * attestation lifts it; the submit is re-attested, and retried once when the
 * server found it stale. One attestation at a time.
 */

const CONFIG = { "GET /app/api/config": ok({ devLogin: false, kiosk: { extensionId: null, mock: true } }) };
const ATTESTED = {
  "POST /app/api/kiosk/attest/challenge": ok({ challenge: "Yw==" }),
  "POST /app/api/kiosk/attest/verify": ok({ station: { label: "Poste n° 7", status: "active" } }),
};

const verifies = (calls: { url: string }[]) =>
  calls.filter((c) => c.url === "/app/api/kiosk/attest/verify").length;
const challenges = (calls: { url: string }[]) =>
  calls.filter((c) => c.url === "/app/api/kiosk/attest/challenge").length;
const advance = (ms: number) => act(async () => void (await vi.advanceTimersByTimeAsync(ms)));

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
  it("attests on mount, before the first round, then every ten minutes (issue #1076)", async () => {
    const { calls } = mockFetch({ ...CONFIG, ...ATTESTED });
    renderHook(() => useStationAttestation(true), { wrapper: providers() });
    await waitFor(() => expect(verifies(calls)).toBe(1));
    await advance(KIOSK_REATTEST_MS - 1_000);
    expect(verifies(calls)).toBe(1);
    await advance(1_000);
    expect(verifies(calls)).toBe(2);
    await advance(KIOSK_REATTEST_MS);
    expect(verifies(calls)).toBe(3);
  });

  it("tries a failed attestation again every 30 s, without the notice, until one is accepted", async () => {
    let verified = 0;
    const { calls } = mockFetch({
      ...CONFIG,
      "POST /app/api/kiosk/attest/challenge": ok({ challenge: "Yw==" }),
      // The first attempt never reaches a verdict the server kept: a lost request.
      "POST /app/api/kiosk/attest/verify": () =>
        ++verified === 1 ? fail(502) : ok({ station: { label: "Poste n° 7", status: "active" } }),
    });
    const { result } = renderHook(() => useStationAttestation(true), { wrapper: providers() });
    await waitFor(() => expect(verifies(calls)).toBe(1));
    expect(result.current.suspended).toBe(false);
    await advance(KIOSK_RETRY_MS);
    expect(verifies(calls)).toBe(2);
    // Accepted: back to the ten-minute round, counted from the mount.
    await advance(KIOSK_RETRY_MS * 2);
    expect(verifies(calls)).toBe(2);
    await advance(KIOSK_REATTEST_MS - KIOSK_RETRY_MS * 3);
    expect(verifies(calls)).toBe(3);
  });

  it("never runs two attestations at once: a stale submit joins the one in flight", async () => {
    let release: () => void = () => undefined;
    const held = new Promise<void>((resolve) => (release = resolve));
    const { calls, fetchMock } = mockFetch({ ...CONFIG, ...ATTESTED });
    vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input).endsWith("/attest/verify")) await held;
      return fetchMock(input, init);
    });
    const { result } = renderHook(() => useStationAttestation(true), { wrapper: providers() });
    await waitFor(() => expect(challenges(calls)).toBe(1));
    const submit = vi
      .fn<() => Promise<string>>()
      .mockRejectedValueOnce(new ApiError(423, { error: "kiosk_attestation_stale" }))
      .mockResolvedValueOnce("submitted");
    let outcome: Promise<string> | undefined;
    await act(async () => {
      outcome = result.current.guardSubmit(submit);
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(challenges(calls)).toBe(1);
    expect(submit).toHaveBeenCalledOnce();
    release();
    await act(async () => void (await outcome));
    expect(await outcome).toBe("submitted");
    expect(challenges(calls)).toBe(1);
    expect(verifies(calls)).toBe(1);
  });

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

  it("re-attests after a stale submit, and retries it once", async () => {
    const { calls } = mockFetch({ ...CONFIG, ...ATTESTED });
    const { result } = renderHook(() => useStationAttestation(true), { wrapper: providers() });
    // The attestation on mount, once the configuration named the mode.
    await waitFor(() => expect(verifies(calls)).toBe(1));
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
    expect(verifies(calls)).toBe(2);
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
