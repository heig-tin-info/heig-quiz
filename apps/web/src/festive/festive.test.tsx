import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { AttemptOrLobby } from "@quiz/contracts";

import App from "../App";
import { resetEventStream } from "../realtime/useEventStream";
import { makeMe } from "../test/fixtures";
import { mockFetch, ok, renderWithProviders } from "../test/render";
import type { Accessory } from "./art";
import { setFestiveEnabled } from "./festive";
import { withAccessory } from "./logo";

/*
 * The festive touches (ADR-092): drawn by the frame only, so an attempt and
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

function render(route: string, me = makeMe({ role: "teacher" })) {
  vi.stubGlobal("EventSource", FakeStream);
  mockFetch({
    "GET /app/api/me": ok(me),
    "GET /app/api/courses": ok([]),
    "GET /app/api/pools": ok([]),
    [`POST /app/api/evaluations/${EVAL}/attempt`]: ok(lobby),
  });
  return renderWithProviders(<App />, { route });
}

/** The sidebar's and the top bar's: jsdom applies no CSS, both are there. */
const sheetButton = async () => (await screen.findAllByRole("button", { name: "Happy holidays: learn more" }))[0]!;

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

  it("never reach an attempt", async () => {
    render(`/take/${EVAL}`, makeMe({ role: "student" }));
    expect(await screen.findByText("Quiz 3 — Pointers")).toBeVisible();
    // Long enough for the drawings' chunk, had anything asked for it.
    await new Promise((r) => setTimeout(r, 50));
    expect(document.querySelector(".festive-accessory, .festive-layer")).toBeNull();
  });

  it("never reach a Safe Exam Browser session", async () => {
    render(
      `/take/${EVAL}`,
      makeMe({
        session: {
          kind: "seb",
          evaluationId: EVAL,
          projectId: null,
          readOnly: false,
          superPowersUntil: null,
          superPowersAvailable: false,
        },
      }),
    );
    expect(await screen.findByText("Quiz 3 — Pointers")).toBeVisible();
    await new Promise((r) => setTimeout(r, 50));
    expect(document.querySelector(".festive-accessory, .festive-layer")).toBeNull();
  });
});

describe("withAccessory", () => {
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
