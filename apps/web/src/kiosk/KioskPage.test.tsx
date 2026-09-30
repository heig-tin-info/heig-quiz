import { act, renderHook, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import { QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { KioskDeviceAuthorization, PublicConfig } from "@quiz/contracts";

import { I18nProvider } from "../i18n";
import { fail, makeQueryClient, mockFetch, ok, renderWithProviders, type RouteHandler } from "../test/render";
import { KioskPage } from "./KioskPage";
import { KIOSK_RETRY_MS, useKioskStation } from "./useKioskStation";

const MOCK: PublicConfig["kiosk"] = { extensionId: null, mock: true };

const auth = (patch: Partial<KioskDeviceAuthorization> = {}): KioskDeviceAuthorization => ({
  device_code: "dc-1",
  user_code: "BCDF-GHJK",
  verification_uri: "https://quiz.test/pair",
  verification_uri_complete: "https://quiz.test/pair?code=BCDF-GHJK",
  expires_in: 300,
  interval: 2,
  label: "Poste de secours n° 7",
  ...patch,
});

const ACTIVE = ok({ station: { label: "Poste de secours n° 7", status: "active" } });

function station(routes: Record<string, RouteHandler>) {
  return mockFetch({
    "POST /app/api/kiosk/attest/challenge": ok({ challenge: "Y2hhbGxlbmdl" }),
    "POST /app/api/kiosk/attest/verify": ACTIVE,
    "POST /app/api/kiosk/device_authorization": ok(auth()),
    ...routes,
  });
}

/** The replies of the token endpoint, in order; the last one repeats. */
function tokens(...replies: RouteHandler[]): RouteHandler {
  let i = 0;
  return (call) => {
    const reply = replies[Math.min(i++, replies.length - 1)]!;
    return typeof reply === "function" ? reply(call) : reply;
  };
}

const wrapper = ({ children }: { children: ReactNode }) => (
  <QueryClientProvider client={makeQueryClient()}>
    <I18nProvider>{children}</I18nProvider>
  </QueryClientProvider>
);

/** Lets every pending promise and timer up to `ms` from now run. */
const advance = (ms = 0) => act(() => vi.advanceTimersByTimeAsync(ms));

const count = (calls: { url: string }[], url: string) => calls.filter((c) => c.url === url).length;

beforeEach(() => {
  vi.useFakeTimers();
  localStorage.clear();
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("the station's loop (ADR-051 §7)", () => {
  it("attests, shows a code, polls at the interval, slows down when told, and opens the approved exam", async () => {
    const { calls } = station({
      "POST /app/api/kiosk/token": tokens(
        fail(400, { error: "authorization_pending" }),
        fail(400, { error: "slow_down" }),
        ok({ redirect: "/take/e1" }),
      ),
    });
    const open = vi.fn();
    const { result } = renderHook(() => useKioskStation(MOCK, true, open), { wrapper });
    expect(result.current.kind).toBe("starting");
    await advance();

    // The development attestation: one device id per browser, kept.
    const verify = calls.find((c) => c.url === "/app/api/kiosk/attest/verify")!;
    expect(verify.body).toEqual({ response: expect.stringMatching(/^mock:dev-/) });
    expect(result.current).toMatchObject({ kind: "code", auth: { user_code: "BCDF-GHJK" } });

    await advance(1_999);
    expect(count(calls, "/app/api/kiosk/token")).toBe(0);
    await advance(1);
    expect(count(calls, "/app/api/kiosk/token")).toBe(1);
    expect(calls.at(-1)!.body).toEqual({
      grant_type: "urn:ietf:params:oauth:grant-type:device_code",
      device_code: "dc-1",
    });
    await advance(2_000);
    expect(count(calls, "/app/api/kiosk/token")).toBe(2); // slow_down: 7 s from now
    await advance(6_999);
    expect(count(calls, "/app/api/kiosk/token")).toBe(2);
    await advance(1);
    expect(count(calls, "/app/api/kiosk/token")).toBe(3);
    expect(open).toHaveBeenCalledWith("/take/e1");
    expect(result.current.kind).toBe("opening");
  });

  it("renews the code when it expires, and when the server says it is spent", async () => {
    let issued = 0;
    const { calls } = station({
      "POST /app/api/kiosk/device_authorization": () => ok(auth({ device_code: `dc-${++issued}`, expires_in: 5 })),
      "POST /app/api/kiosk/token": (call) =>
        (call.body as { device_code: string }).device_code === "dc-2"
          ? fail(400, { error: "expired_token" })
          : fail(400, { error: "authorization_pending" }),
    });
    const { result } = renderHook(() => useKioskStation(MOCK, true, vi.fn()), { wrapper });
    await advance();
    expect(result.current).toMatchObject({ kind: "code", auth: { device_code: "dc-1" } });
    await advance(6_000); // polls at 2 and 4 s; at 6 s the code is past its 5 s
    expect(result.current).toMatchObject({ kind: "code", auth: { device_code: "dc-2" } });
    await advance(2_000); // dc-2 answers expired_token: a third code at once
    expect(result.current).toMatchObject({ kind: "code", auth: { device_code: "dc-3" } });
    // Each new code comes after an attestation: a station that waits is never silent (ADR-051 §6).
    expect(count(calls, "/app/api/kiosk/attest/verify")).toBe(3);
  });

  it("says a station out of the registry is not recognised, and tries again every 30 s", async () => {
    let verified = 0;
    const { calls } = station({
      "POST /app/api/kiosk/attest/verify": () =>
        ++verified === 1 ? ok({ station: { label: null, status: "unnamed" } }) : ACTIVE,
      "POST /app/api/kiosk/token": fail(400, { error: "authorization_pending" }),
    });
    const { result } = renderHook(() => useKioskStation(MOCK, true, vi.fn()), { wrapper });
    await advance();
    expect(result.current.kind).toBe("not_recognised");
    expect(count(calls, "/app/api/kiosk/device_authorization")).toBe(0);
    await advance(KIOSK_RETRY_MS - 1);
    expect(count(calls, "/app/api/kiosk/attest/challenge")).toBe(1);
    await advance(1);
    expect(count(calls, "/app/api/kiosk/attest/challenge")).toBe(2);
    expect(result.current.kind).toBe("code");
  });

  it("goes back to the attestation when the station stops being recognised mid-pairing", async () => {
    const { calls } = station({ "POST /app/api/kiosk/token": fail(403, { error: "not_recognised" }) });
    const { result } = renderHook(() => useKioskStation(MOCK, true, vi.fn()), { wrapper });
    await advance(2_000);
    expect(result.current.kind).toBe("not_recognised");
    await advance(KIOSK_RETRY_MS);
    expect(count(calls, "/app/api/kiosk/attest/challenge")).toBe(2);
  });

  it("reports a missing extension to verify, never pretends to have attested", async () => {
    const { calls } = station({ "POST /app/api/kiosk/attest/verify": fail(403, { error: "not_attested" }) });
    const { result } = renderHook(
      () => useKioskStation({ extensionId: "abcdefghijklmnop", mock: false }, true, vi.fn()),
      { wrapper },
    );
    await advance();
    expect(calls.find((c) => c.url === "/app/api/kiosk/attest/verify")!.body).toEqual({
      error: "extension_unreachable",
    });
    expect(result.current.kind).toBe("not_recognised");
  });

  it("asks the extension for a ping, then the machine key's answer", async () => {
    const sendMessage = vi.fn((_id: string, message: { type: string }, reply: (r: unknown) => void) =>
      reply(message.type === "ping" ? { ok: true, version: "1.0" } : { ok: true, response: "UkVTUA==" }),
    );
    vi.stubGlobal("chrome", { runtime: { sendMessage } });
    const { calls } = station({ "POST /app/api/kiosk/token": fail(400, { error: "authorization_pending" }) });
    renderHook(() => useKioskStation({ extensionId: "ext-id", mock: false }, true, vi.fn()), { wrapper });
    await advance();
    expect(sendMessage.mock.calls.map((c) => [c[0], c[1]])).toEqual([
      ["ext-id", { type: "ping" }],
      ["ext-id", { type: "attest", challenge: "Y2hhbGxlbmdl" }],
    ]);
    expect(calls.find((c) => c.url === "/app/api/kiosk/attest/verify")!.body).toEqual({ response: "UkVTUA==" });
  });

  it("waits for the configuration, and says the platform is out of reach without the kiosk path", async () => {
    const { calls } = station({});
    const { result, rerender } = renderHook(({ ready }) => useKioskStation(null, ready, vi.fn()), {
      wrapper,
      initialProps: { ready: false },
    });
    await advance();
    expect(calls).toHaveLength(0);
    rerender({ ready: true });
    await advance();
    expect(result.current.kind).toBe("unavailable");
    expect(calls).toHaveLength(0);
  });
});

describe("the station's screen", () => {
  it("shows the station's name, its code and the QR of the phone's page", async () => {
    station({
      "GET /app/api/config": ok({ devLogin: false, kiosk: MOCK }),
      "POST /app/api/kiosk/token": fail(400, { error: "authorization_pending" }),
    });
    renderWithProviders(<KioskPage />, { route: "/kiosk" });
    await advance();
    await advance();
    expect(screen.getByRole("heading", { name: "Poste de secours n° 7" })).toBeVisible();
    expect(screen.getByText("BCDF-GHJK")).toBeVisible();
    expect(screen.getByText("New code in 5:00")).toBeVisible();
    expect(screen.getByText(/open quiz\.test\/pair and type the code/)).toBeVisible();
    expect(screen.getByRole("img", { name: /code BCDF-GHJK/ })).toBeInTheDocument();
    await advance(61_000);
    expect(screen.getByText("New code in 3:59")).toBeVisible();
  });

  it("says a station that is not recognised should call the supervisor, and nothing technical", async () => {
    station({
      "GET /app/api/config": ok({ devLogin: false, kiosk: MOCK }),
      "POST /app/api/kiosk/device_authorization": fail(403, { error: "not_recognised" }),
    });
    renderWithProviders(<KioskPage />, { route: "/kiosk" });
    await advance();
    await advance();
    expect(screen.getByRole("heading", { name: "Station not recognised" })).toBeVisible();
    expect(screen.getByText("Call the supervisor.")).toBeVisible();
  });
});
