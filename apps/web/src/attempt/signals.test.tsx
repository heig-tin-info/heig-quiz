import { act, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import { fail, mockFetch, noContent } from "../test/render";
import { usePosition, type PositionState } from "./signals";

/*
 * The position reports of ADR-039: what the player tells the server is on
 * screen, and when. The server keeps the time; these pin which reports leave
 * the browser — the item on a move, `null` (kept alive) when the page hides
 * or the player goes away, nothing on a pause.
 */

const URL = "POST /app/api/attempts/a1/position";
/** Two item ids, uuids like the contract wants. */
const I1 = "11111111-1111-4111-8111-111111111111";
const I2 = "22222222-2222-4222-8222-222222222222";
const LIVE: PositionState = { live: true, visible: true, resend: 0 };

function setup(reply = noContent()) {
  const { calls, fetchMock } = mockFetch({ [URL]: () => reply });
  const hook = renderHook(
    ({ current, state }: { current: string | null; state: PositionState }) => usePosition("a1", current, state),
    { initialProps: { current: I1 as string | null, state: LIVE } },
  );
  const sent = () => calls.filter((c) => c.url.endsWith("/position")).map((c) => (c.body as { itemId: string | null }).itemId);
  const keptAlive = () => fetchMock.mock.calls.map(([, init]) => (init as RequestInit).keepalive);
  return { ...hook, sent, keptAlive };
}

/** Lets the rejected promise of a failed post settle. */
const settle = () => act(async () => {});

afterEach(() => {
  document.body.innerHTML = "";
});

describe("usePosition", () => {
  it("reports the question on mount, then once per move", () => {
    const { rerender, sent } = setup();
    rerender({ current: I1, state: LIVE });
    rerender({ current: I2, state: LIVE });
    expect(sent()).toEqual([I1, I2]);
  });

  it("reports null, kept alive, when the tab hides, and the question again when it returns", () => {
    const { rerender, sent, keptAlive } = setup();
    rerender({ current: I1, state: { ...LIVE, visible: false } });
    rerender({ current: I1, state: LIVE });
    expect(sent()).toEqual([I1, null, I1]);
    expect(keptAlive()).toEqual([false, true, false]);
  });

  it("sends nothing on a pause, and reports the question again at the resume", () => {
    const { rerender, sent } = setup();
    rerender({ current: I1, state: { ...LIVE, live: false } });
    expect(sent()).toEqual([I1]);
    rerender({ current: I1, state: LIVE });
    expect(sent()).toEqual([I1, I1]);
  });

  it("reports again when the stream comes back", () => {
    const { rerender, sent } = setup();
    rerender({ current: I1, state: { ...LIVE, resend: 1 } });
    expect(sent()).toEqual([I1, I1]);
  });

  it("sends the question again at the next occasion after a failure", async () => {
    const { rerender, sent } = setup(fail(500));
    await settle();
    rerender({ current: I1, state: { ...LIVE, visible: false } });
    rerender({ current: I1, state: LIVE });
    expect(sent()).toEqual([I1, null, I1]);
  });

  it("reports null when the player goes away while the attempt runs, and not after it ended", () => {
    const first = setup();
    first.unmount();
    expect(first.sent()).toEqual([I1, null]);

    const second = setup();
    second.rerender({ current: I1, state: { ...LIVE, live: false } });
    second.unmount();
    expect(second.sent()).toEqual([I1]);
  });
});
