import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { AttemptOrLobby, ChangelogList, Me } from "@quiz/contracts";

import App from "../App";
import quizLogo from "../assets/quiz.svg?raw";
import { resetEventStream } from "../realtime/useEventStream";
import { makeMe } from "../test/fixtures";
import { mockFetch, ok, renderWithProviders } from "../test/render";
import type { Accessory } from "./art";
import { setFestiveEnabled } from "./festive";
import { LOGO_BOX, withAccessory } from "./logo";

/*
 * The festive touches (ADR-093): drawn by the frame only, so an attempt and
 * a confined session never get any of it; played once a day; switched off
 * from the settings.
 */

const EVAL = "11111111-1111-4111-8111-111111111111";
const CHRISTMAS = new Date(2026, 11, 20, 10, 0);

class FakeStream {
  onopen: (() => void) | null = null;
  onerror: (() => void) | null = null;
  onmessage: ((e: MessageEvent) => void) | null = null;
  addEventListener() {}
  removeEventListener() {}
  close() {}
}

const lobby: AttemptOrLobby = {
  kind: "lobby",
  view: {
    evaluation: { id: EVAL, title: "Quiz 3 — Pointers", state: "lobby" },
    conditions: { announced: [], imposed: [] },
    present: 3,
    enrolled: 6,
    serverNow: "2026-12-20T10:00:00.000Z",
  },
};

function render(route: string, me: Me = makeMe({ role: "teacher" }), unseen: ChangelogList = []) {
  vi.stubGlobal("EventSource", FakeStream);
  const { calls } = mockFetch({
    "GET /app/api/me": ok(me),
    "GET /app/api/courses": ok([]),
    "GET /app/api/pools": ok([]),
    "GET /app/api/changelog/unseen": ok(unseen),
    "POST /app/api/me/changelog": { status: 204, body: undefined },
    [`POST /app/api/evaluations/${EVAL}/attempt`]: ok(lobby),
  });
  return { calls, ...renderWithProviders(<App />, { route }) };
}

const session = (kind: "seb" | "kiosk") =>
  makeMe({
    session: { kind, evaluationId: EVAL, projectId: null, readOnly: false, superPowersUntil: null, superPowersAvailable: false },
  });

/** No accessory, no layer, once the page had time to ask for the drawings had it wanted them. */
async function expectBare(route: string, me?: Me) {
  const { calls } = render(route, me);
  await waitFor(() => expect(calls.some((c) => c.url === "/app/api/me")).toBe(true));
  await new Promise((r) => setTimeout(r, 100));
  expect(document.querySelector(".festive-accessory, .festive-layer")).toBeNull();
}

/** The sidebar's and the top bar's: jsdom applies no CSS, both are there. */
const sheetButton = async () => (await screen.findAllByRole("button", { name: "Happy holidays: learn more" }))[0]!;

/** The setup's stub, put back after the reduced-motion case replaced it. */
const matchMedia = window.matchMedia;

beforeEach(() => {
  vi.setSystemTime(CHRISTMAS);
});

afterEach(() => {
  vi.useRealTimers();
  resetEventStream();
  localStorage.clear();
  sessionStorage.clear();
  setFestiveEnabled(true);
  vi.stubGlobal("EventSource", undefined);
  vi.stubGlobal("matchMedia", matchMedia);
});

describe("the festive touches", () => {
  it("dress the frame's logo, whose accessory opens the day's sheet", async () => {
    const { container } = render("/");
    await userEvent.click(await sheetButton());
    const sheet = await screen.findByRole("dialog", { name: "Happy holidays" });
    expect(within(sheet).getByRole("link", { name: /Read on Wikipedia/ })).toHaveAttribute(
      "href",
      "https://en.wikipedia.org/wiki/Christmas",
    );
    // The hat sits in the Q's group, so it dances with the Q.
    expect(container.querySelector(".logo-q .festive-accessory")).not.toBeNull();
  });

  it("play the ambient once a day, behind the page", async () => {
    const first = render("/");
    await waitFor(() => expect(document.querySelector(".festive-layer")).not.toBeNull());
    expect(document.querySelector(".festive-layer")).toHaveAttribute("aria-hidden", "true");
    first.unmount();

    const again = render("/");
    await sheetButton();
    expect(document.querySelector(".festive-layer")).toBeNull();
    again.unmount();
  });

  it("never play under reduced motion; the accessory stays", async () => {
    vi.stubGlobal("matchMedia", (query: string) => ({
      matches: query.includes("prefers-reduced-motion"),
      media: query,
      addEventListener() {},
      removeEventListener() {},
      addListener() {},
      removeListener() {},
    }));
    render("/");
    await sheetButton();
    expect(document.querySelector(".festive-layer")).toBeNull();
  });

  it("are off when this browser said so", async () => {
    setFestiveEnabled(false);
    render("/");
    expect((await screen.findAllByRole("button", { name: "Quiz" }))[0]).toBeVisible();
    expect(screen.queryByRole("button", { name: /learn more/ })).toBeNull();
    expect(document.querySelector(".festive-accessory")).toBeNull();
  });

  it("wait for What's new, then play", async () => {
    const unseen: ChangelogList = [
      { id: "x", kind: "new", text: { en: "Something new.", fr: "Du nouveau." }, liveAt: "2026-12-19T08:00:00.000Z", commitSha: "abc1234" },
    ];
    render("/", makeMe({ role: "teacher" }), unseen);
    const whatsNew = await screen.findByRole("dialog", { name: "What's new" });
    expect(document.querySelector(".festive-layer")).toBeNull();
    await userEvent.click(within(whatsNew).getByRole("button", { name: "Got it" }));
    await waitFor(() => expect(document.querySelector(".festive-layer")).not.toBeNull());
  });

  it("play on the home and the lists only, not on a page such as the settings", async () => {
    render("/settings");
    await sheetButton();
    await new Promise((r) => setTimeout(r, 100));
    expect(document.querySelector(".festive-layer")).toBeNull();
  });

  it.each([
    ["an attempt", `/take/${EVAL}`, makeMe({ role: "student" })],
    ["a Safe Exam Browser session", `/take/${EVAL}`, session("seb")],
    ["a kiosk session", `/take/${EVAL}`, session("kiosk")],
    ["the evaluation preview", `/evaluations/${EVAL}/preview`, undefined],
    ["the poll projection", `/evaluations/${EVAL}/poll`, undefined],
    ["the live dashboard, which may be projected", `/evaluations/${EVAL}/live`, undefined],
  ])("never reach %s", async (_, route, me) => {
    await expectBare(route, me);
  });
});

describe("withAccessory", () => {
  it("draws in the logo's own units", () => {
    expect(quizLogo).toContain(`viewBox="0 0 ${LOGO_BOX.width} ${LOGO_BOX.height}"`);
  });

  const svg = `<svg><g class="logo-q"><path d="Q"/></g><g class="logo-u"><path d="U"/></g></svg>`;
  const accessory = (behind: boolean): Accessory => ({
    bubble: "u",
    behind,
    enter: "pop",
    svg: "<i/>",
    box: [0, 0, 1, 1],
  });

  it("draws an accessory over its bubble, last in the group", () => {
    expect(withAccessory(svg, accessory(false))).toContain(
      `<g class="logo-u"><path d="U"/><g class="festive-accessory festive-enter-pop"><i/></g></g>`,
    );
  });

  it("draws an accessory behind its bubble, first in the group", () => {
    expect(withAccessory(svg, accessory(true))).toContain(
      `<g class="logo-u"><g class="festive-accessory festive-enter-pop"><i/></g><path d="U"/></g>`,
    );
  });
});
