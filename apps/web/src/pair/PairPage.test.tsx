import { act, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { EvaluationConditions, Me, PairPreview } from "@quiz/contracts";

import { fail, mockFetch, ok, renderWithProviders, type RouteHandler } from "../test/render";
import { PairPage } from "./PairPage";
import { loadDecoder, type Decode } from "./scan";

vi.mock("./scan", async (actual) => ({ ...(await actual<typeof import("./scan")>()), loadDecoder: vi.fn() }));

const me: Me = {
  id: "u1",
  email: "lea@heig-vd.ch",
  givenName: "Léa",
  familyName: "Martin",
  role: "student",
  lastLoginAt: null,
  avatarUrl: null,
  hasUploadedAvatar: false,
  locale: null,
  dateFormat: null,
  mcqPolicy: null,
  coach: { enabled: false, seen: [] },
  rpnCalculator: null,
};

const E1 = "11111111-1111-4111-8111-111111111111";
const E2 = "11111111-1111-4111-8111-111111111112";
/** ADR-079 §7: what the server derives for a kiosk exam, with one condition of the teacher's. */
const conditionsOf = (text: string): EvaluationConditions => ({
  announced: [{ kind: "allowed", text }],
  imposed: [{ key: "trusted_client", kind: "forbidden", clients: ["kiosk"] }],
});
const NONE: EvaluationConditions = { announced: [], imposed: [] };
const exam = (id: string, title: string, conditions: EvaluationConditions = NONE) => ({
  id,
  title,
  classroomName: "PRG1-2026",
  courseCode: "PRG1",
  conditions,
});

const preview = (evaluations: PairPreview["evaluations"] = [exam(E1, "Test 1 — pointeurs")]): PairPreview => ({
  station: { label: "Poste de secours n° 7" },
  evaluations,
});

function render(routes: Record<string, RouteHandler>, route = "/pair?code=bcdf-ghjk", who: Me | null = me) {
  const stub = mockFetch(routes);
  const navigate = vi.fn();
  const result = renderWithProviders(<PairPage me={who} navigate={navigate} />, { route });
  return { ...result, ...stub, navigate };
}

afterEach(() => vi.unstubAllGlobals());

describe("the phone's pairing page (ADR-051 §7)", () => {
  it("signs a signed-out phone in, and comes back with the code", async () => {
    render({ "GET /app/api/config": ok({ devLogin: false, kiosk: null }) }, "/pair?code=bcdf-ghjk", null);
    const assign = vi.fn();
    vi.stubGlobal("location", { ...window.location, assign });
    await userEvent.click(screen.getByRole("button", { name: "Sign in" }));
    expect(assign).toHaveBeenCalledWith(`/app/auth/login?next=${encodeURIComponent("/pair?code=BCDF-GHJK")}`);
  });

  it("reads the code of the QR, shows the station to compare, and starts the one exam", async () => {
    const { calls } = render({
      "GET /app/api/pair/BCDF-GHJK": ok(preview()),
      "POST /app/api/pair": ok({ station: { label: "Poste de secours n° 7" } }),
    });
    expect(await screen.findByText("Poste de secours n° 7")).toBeVisible();
    // Read once, then out of the address bar.
    expect(window.location.search).toBe("");
    expect(screen.getByRole("radio", { name: /Test 1 — pointeurs/ })).toBeChecked();
    await userEvent.click(screen.getByRole("button", { name: "Start on this station" }));
    expect(calls.at(-1)).toMatchObject({ method: "POST", url: "/app/api/pair", body: { code: "BCDF-GHJK", evaluationId: E1 } });
    expect(await screen.findByRole("heading", { name: "The station is opening your exam" })).toBeVisible();
    expect(screen.getByText(/on the screen of Poste de secours n° 7/)).toBeVisible();
  });

  it("asks which exam when there are several", async () => {
    const { calls } = render({
      "GET /app/api/pair/BCDF-GHJK": ok(preview([exam(E1, "Test 1"), exam(E2, "Test 2")])),
      "POST /app/api/pair": ok({ station: { label: "Poste de secours n° 7" } }),
    });
    const start = await screen.findByRole("button", { name: "Start on this station" });
    expect(start).toBeDisabled();
    await userEvent.click(screen.getByRole("radio", { name: /Test 2/ }));
    await userEvent.click(start);
    expect(calls.at(-1)!.body).toEqual({ code: "BCDF-GHJK", evaluationId: E2 });
  });

  it("states the chosen exam's conditions before the student confirms (ADR-079 §7)", async () => {
    render({
      "GET /app/api/pair/BCDF-GHJK": ok(
        preview([exam(E1, "Test 1", conditionsOf("One A4 sheet")), exam(E2, "Test 2", conditionsOf("Open book"))]),
      ),
    });
    await screen.findByRole("button", { name: "Start on this station" });
    // Nothing chosen yet: no conditions to read.
    expect(screen.queryByRole("heading", { name: "Allowed" })).toBeNull();
    await userEvent.click(screen.getByRole("radio", { name: /Test 2/ }));
    expect(screen.getByRole("heading", { name: "Forbidden" })).toBeVisible();
    expect(screen.getByRole("heading", { name: "Allowed" })).toBeVisible();
    expect(screen.getByText("Open book")).toBeVisible();
    expect(screen.queryByText("One A4 sheet")).toBeNull();
    expect(screen.getByText("Any device other than the school's exam station")).toBeVisible();
    // Read before the action: the list comes first in the page.
    const start = screen.getByRole("button", { name: "Start on this station" });
    expect(screen.getByText("Open book").compareDocumentPosition(start) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it("formats a typed code, and refuses one that cannot be a code without asking the server", async () => {
    const { calls } = render({ "GET /app/api/pair/BCDF-GHJK": ok(preview()) }, "/pair");
    const field = screen.getByLabelText("Code shown on the station");
    await userEvent.type(field, "bcd");
    await userEvent.click(screen.getByRole("button", { name: "Continue" }));
    expect(screen.getByText("A code has 8 letters and digits, for example BCDF-GHJK.")).toBeVisible();
    expect(calls).toHaveLength(0);
    await userEvent.type(field, "fghjk");
    expect(field).toHaveValue("BCDF-GHJK");
    await userEvent.click(screen.getByRole("button", { name: "Continue" }));
    expect(await screen.findByText("Poste de secours n° 7")).toBeVisible();
  });

  it("says a wrong or expired code does not work, and lets the student type the one on screen", async () => {
    render({
      "GET /app/api/pair/BCDF-GHJK": fail(404, { error: "pairing_not_found" }),
      "GET /app/api/pair/CCCC-DDDD": ok(preview()),
    });
    expect(await screen.findByText("This code does not work")).toBeVisible();
    const field = screen.getByLabelText("Code shown on the station");
    await userEvent.clear(field);
    await userEvent.type(field, "ccccdddd");
    await userEvent.click(screen.getByRole("button", { name: "Continue" }));
    expect(await screen.findByText("Poste de secours n° 7")).toBeVisible();
  });

  it("says when too many wrong codes were typed", async () => {
    render({ "GET /app/api/pair/BCDF-GHJK": fail(429, { error: "rate_limited" }) });
    expect(await screen.findByText("Too many wrong codes. Try again in a few minutes.")).toBeVisible();
  });

  it("explains when no exam can be started on a station, and offers no start", async () => {
    render({ "GET /app/api/pair/BCDF-GHJK": ok(preview([])) });
    expect(await screen.findByText("No exam to start on a station")).toBeVisible();
    expect(screen.queryByRole("button", { name: "Start on this station" })).toBeNull();
    await userEvent.click(screen.getByRole("button", { name: "Change the code" }));
    expect(screen.getByLabelText("Code shown on the station")).toHaveValue("");
  });

  it("says an exam that can no longer be started there is refused", async () => {
    render({
      "GET /app/api/pair/BCDF-GHJK": ok(preview()),
      "POST /app/api/pair": fail(409, { error: "evaluation_not_pairable" }),
    });
    await userEvent.click(await screen.findByRole("button", { name: "Start on this station" }));
    const alert = await screen.findByText("This exam can no longer be started on a station. Ask the supervisor.");
    expect(within(alert.closest("div")!).getByText(/Ask the supervisor/)).toBeVisible();
  });
});

describe("scanning the station's QR with the page's camera", () => {
  const stop = vi.fn();
  const getUserMedia = vi.fn();
  const decode = vi.fn<Decode>();

  beforeEach(() => {
    stop.mockReset();
    decode.mockReset().mockResolvedValue(null);
    getUserMedia.mockReset().mockResolvedValue({ getTracks: () => [{ stop }] });
    Object.defineProperty(navigator, "mediaDevices", { value: { getUserMedia }, configurable: true });
    vi.spyOn(HTMLMediaElement.prototype, "play").mockResolvedValue(undefined);
    vi.mocked(loadDecoder).mockResolvedValue(decode);
  });
  afterEach(() => {
    Reflect.deleteProperty(navigator, "mediaDevices");
    vi.restoreAllMocks();
  });

  const open = async () => {
    await userEvent.click(screen.getByRole("button", { name: "Scan with camera" }));
    await waitFor(() => expect(decode).toHaveBeenCalled());
  };

  it("is offered only where the browser can open a camera", () => {
    Reflect.deleteProperty(navigator, "mediaDevices");
    render({}, "/pair");
    expect(screen.queryByRole("button", { name: "Scan with camera" })).toBeNull();
  });

  it("opens the rear camera inline, and lets it go on Cancel", async () => {
    render({}, "/pair");
    await open();
    expect(getUserMedia).toHaveBeenCalledWith({ video: { facingMode: "environment" }, audio: false });
    // Continue stays the one primary action.
    expect(screen.getByRole("button", { name: "Continue" })).toBeVisible();
    expect(stop).not.toHaveBeenCalled();
    await userEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(stop).toHaveBeenCalled();
    expect(screen.getByRole("button", { name: "Scan with camera" })).toBeVisible();
  });

  it("lets the camera go when the page is left", async () => {
    const { unmount } = render({}, "/pair");
    await open();
    unmount();
    expect(stop).toHaveBeenCalled();
  });

  it("lets the camera go when the page is hidden, and offers the scan again", async () => {
    render({}, "/pair");
    await open();
    vi.spyOn(document, "visibilityState", "get").mockReturnValue("hidden");
    act(() => {
      document.dispatchEvent(new Event("visibilitychange"));
    });
    expect(stop).toHaveBeenCalled();
    expect(screen.getByRole("button", { name: "Scan with camera" })).toBeVisible();
    expect(screen.queryByRole("button", { name: "Cancel" })).toBeNull();
  });

  it("names a QR that is not a station's, keeps scanning and sends nothing", async () => {
    decode.mockResolvedValue("https://evil.example/pair?code=BCDF-GHJK");
    const { calls } = render({}, "/pair");
    await open();
    expect(await screen.findByText("This QR code is not a station code.")).toBeVisible();
    await waitFor(() => expect(decode.mock.calls.length).toBeGreaterThan(1));
    expect(stop).not.toHaveBeenCalled();
    expect(calls).toHaveLength(0);
  });

  it("fills the field with a station's code, lets the camera go and looks it up once", async () => {
    decode.mockResolvedValue(`${window.location.origin}/pair?code=bcdf-ghjk`);
    const { calls } = render({ "GET /app/api/pair/BCDF-GHJK": ok(preview()) }, "/pair");
    await userEvent.click(screen.getByRole("button", { name: "Scan with camera" }));
    expect(await screen.findByText("Poste de secours n° 7")).toBeVisible();
    expect(stop).toHaveBeenCalledTimes(1);
    expect(decode).toHaveBeenCalledTimes(1);
    expect(calls.map((call) => call.url)).toEqual(["/app/api/pair/BCDF-GHJK"]);
  });

  it("falls back to typing when the camera is refused", async () => {
    getUserMedia.mockRejectedValue(new DOMException("denied", "NotAllowedError"));
    render({}, "/pair");
    await userEvent.click(screen.getByRole("button", { name: "Scan with camera" }));
    expect(await screen.findByText("Camera unavailable — type the code.")).toBeVisible();
    expect(screen.getByLabelText("Code shown on the station")).toHaveFocus();
    expect(screen.queryByRole("button", { name: "Cancel" })).toBeNull();
  });
});
