import { screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { ActivitySummary } from "@quiz/contracts";

import { id, liveAt } from "../test/live-fixtures";
import { mockFetch, ok, renderWithProviders } from "../test/render";
import { ActivitiesPage } from "./ActivitiesPage";
import { spanOf } from "./Timeline";

/*
 * The schedule as a gantt (#190, a port of heig-classroom's Timeline): on a
 * wide window, one bar per dated activity around a "now" line; on a phone,
 * the week list instead.
 */

const MIN = 60_000;
const DAYS = 24 * 60 * MIN;
const ROOM = { id: id("classroom", 1), name: "EMB-2026", courseCode: "EMB" };

function activity(n: number, over: Partial<ActivitySummary> = {}): ActivitySummary {
  return {
    id: id("activity", n),
    title: `Activity ${n}`,
    mode: "exam",
    state: "draft",
    classroom: ROOM,
    takeHome: false,
    opensAt: null,
    closesAt: null,
    startedAt: null,
    updatedAt: liveAt(-MIN),
    ...over,
  };
}

const SERIES = activity(1, {
  title: "Série 4 — deux semaines",
  mode: "exercise",
  takeHome: true,
  state: "running",
  opensAt: liveAt(-9 * DAYS),
  startedAt: liveAt(-9 * DAYS),
  closesAt: liveAt(5 * DAYS),
});
const LOBBY = activity(2, { title: "Quiz 4 — chaînes", state: "lobby" });
const POLL = activity(3, { title: "Which loop?", mode: "poll", state: "running", classroom: null, startedAt: liveAt(-4 * MIN) });
const NEXT = activity(4, { title: "Série 6 — SPI", state: "scheduled", opensAt: liveAt(7 * DAYS), closesAt: liveAt(13 * DAYS) });
const DRAFT = activity(5, { title: "Quiz 1 — undated" });

describe("spanOf", () => {
  const now = Date.now();
  it("runs an open activity without a closing up to now, and puts an undated one on now", () => {
    expect(spanOf(POLL, now)).toEqual({ s: new Date(POLL.startedAt!).getTime(), d: now });
    expect(spanOf(LOBBY, now)).toEqual({ s: now, d: now });
  });
  it("spans opening to closing, and gives an undated draft no place", () => {
    expect(spanOf(NEXT, now)).toEqual({
      s: new Date(NEXT.opensAt!).getTime(),
      d: new Date(NEXT.closesAt!).getTime(),
    });
    expect(spanOf(DRAFT, now)).toBeNull();
  });
});

describe("the schedule view", () => {
  const original = window.matchMedia;
  const wide = (on: boolean) =>
    vi.stubGlobal("matchMedia", (query: string) => ({ ...original(query), matches: on }));
  beforeEach(() => localStorage.setItem("quiz-activities-view", "schedule"));
  afterEach(() => vi.stubGlobal("matchMedia", original));

  it("draws the gantt on a wide window: every dated activity a bar, the open ones around now", async () => {
    wide(true);
    const user = userEvent.setup();
    const navigate = vi.fn();
    mockFetch({ "GET /app/api/activities": ok([SERIES, LOBBY, POLL, NEXT, DRAFT]) });
    renderWithProviders(<ActivitiesPage navigate={navigate} />);

    // `Série 4` is also named in no other block: only its bar carries it.
    const bar = await screen.findByRole("button", { name: "Série 4 — deux semaines" });
    // Next week's series is outside the default frame (what is in progress);
    // zooming out brings it in.
    expect(screen.queryByRole("button", { name: "Série 6 — SPI" })).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Zoom out" }));
    expect(screen.getByRole("button", { name: "Série 6 — SPI" })).toBeInTheDocument();
    expect(screen.getByTestId("timeline-now")).toBeInTheDocument();
    // The undated draft has no bar, and the legend says so.
    expect(screen.queryByRole("button", { name: "Quiz 1 — undated" })).not.toBeInTheDocument();
    expect(screen.getByText("One undated draft is not on the timeline")).toBeInTheDocument();
    // A classroom row per classroom, the anonymous polls together.
    expect(screen.getByRole("button", { name: /EMB · EMB-2026/, expanded: true })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /No classroom/, expanded: true })).toBeInTheDocument();

    await user.click(bar);
    expect(navigate).toHaveBeenLastCalledWith({ view: "live", id: SERIES.id });
  });

  it("falls back to the week list on a phone", async () => {
    wide(false);
    mockFetch({ "GET /app/api/activities": ok([SERIES, NEXT]) });
    renderWithProviders(<ActivitiesPage navigate={vi.fn()} />);
    expect(await screen.findByText(/This week/)).toBeInTheDocument();
    expect(screen.queryByTestId("timeline-now")).not.toBeInTheDocument();
  });
});
