import { act, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { LobbyView, ServerEvent } from "@quiz/contracts";

import { renderWithProviders } from "../test/render";
import { Lobby } from "./Lobby";

/*
 * jsdom has no EventSource, so the stream is stubbed here rather than
 * skipped: the lobby's whole behaviour is "wait, and leave when the server
 * says the evaluation is running".
 */
const streams: FakeStream[] = [];

class FakeStream {
  onopen: (() => void) | null = null;
  onerror: (() => void) | null = null;
  readonly listeners = new Map<string, Set<(e: MessageEvent) => void>>();
  constructor(readonly url: string) {
    streams.push(this);
  }
  addEventListener(name: string, fn: (e: MessageEvent) => void) {
    const set = this.listeners.get(name) ?? new Set();
    set.add(fn);
    this.listeners.set(name, set);
  }
  removeEventListener(name: string, fn: (e: MessageEvent) => void) {
    this.listeners.get(name)?.delete(fn);
  }
  close() {}
  emit(event: ServerEvent) {
    act(() => {
      for (const fn of this.listeners.get(event.type) ?? []) {
        fn({ data: JSON.stringify(event) } as MessageEvent);
      }
    });
  }
}

const view: LobbyView = {
  evaluation: {
    id: "11111111-1111-4111-8111-111111111111",
    title: "Quiz 3 — Pointeurs",
    state: "lobby",
    announcedDurationS: 1200,
  },
  present: 18,
  enrolled: 24,
  timeBonusPercent: 33,
  serverNow: "2026-09-20T10:00:00.000Z",
};

function render(onStart = vi.fn(), onLeave = vi.fn()) {
  vi.stubGlobal("EventSource", FakeStream);
  const result = renderWithProviders(
    <Lobby view={view} navigation="free" onStart={onStart} onLeave={onLeave} />,
    { locale: "fr" },
  );
  return { ...result, onStart, onLeave, stream: streams.at(-1)! };
}

afterEach(() => {
  streams.length = 0;
  vi.unstubAllGlobals();
});

describe("the lobby", () => {
  it("watches the lobby subject — the one that counts as present — and shows the ring", () => {
    const { stream } = render();
    expect(stream.url).toBe(
      "/app/api/events?watch=lobby%3A11111111-1111-4111-8111-111111111111",
    );
    expect(
      screen.getByRole("img", { name: "18 étudiants présents sur 24" }),
    ).toBeInTheDocument();
    expect(screen.getByText("Le professeur démarrera le quiz.")).toBeInTheDocument();
  });

  it("has no primary action, only the discreet way out", () => {
    const { onLeave } = render();
    const buttons = screen.getAllByRole("button");
    expect(buttons).toHaveLength(1);
    expect(buttons[0]).toHaveTextContent("Quitter");
    buttons[0]!.click();
    expect(onLeave).toHaveBeenCalled();
  });

  it("states the three rules, navigation first when it is known", () => {
    render();
    expect(screen.getByText("Navigation libre")).toBeInTheDocument();
    expect(screen.getByText("Enregistré au fil de la frappe")).toBeInTheDocument();
    expect(screen.getByText("Une seule tentative")).toBeInTheDocument();
  });

  it("follows the live count", () => {
    const { stream } = render();
    stream.emit({
      type: "lobby.count",
      evaluationId: view.evaluation.id,
      present: 23,
      enrolled: 24,
    });
    expect(
      screen.getByRole("img", { name: "23 étudiants présents sur 24" }),
    ).toBeInTheDocument();
  });

  it("starts the attempt the moment the evaluation turns running", () => {
    const { stream, onStart } = render();
    stream.emit({
      type: "evaluation.state",
      evaluationId: view.evaluation.id,
      state: "running",
      pausedAt: null,
      closesAt: null,
      serverNow: "2026-09-20T10:01:00.000Z",
    });
    expect(onStart).toHaveBeenCalledTimes(1);
  });

  it("drops a frame that is not a valid ServerEvent", () => {
    const { stream, onStart } = render();
    for (const fn of stream.listeners.get("evaluation.state") ?? []) {
      act(() => fn({ data: '{"type":"evaluation.state","state":"running"}' } as MessageEvent));
    }
    expect(onStart).not.toHaveBeenCalled();
  });
});
