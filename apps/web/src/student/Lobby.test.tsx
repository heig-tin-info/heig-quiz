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
  conditions: {
    announced: [
      { kind: "allowed", text: "Une feuille A4 de notes" },
      { kind: "forbidden", text: "<b>Téléphones</b>" },
    ],
    imposed: [
      { key: "duration", kind: "info", durationS: 1200, bonusPercent: 33 },
      { key: "attempts", kind: "info", maxAttempts: 1 },
      { key: "autosave", kind: "info" },
    ],
  },
  present: 18,
  enrolled: 24,
  timeBonusPercent: 33,
  serverNow: "2026-09-20T10:00:00.000Z",
};

function render(onStart = vi.fn(), onLeave = vi.fn(), shown: LobbyView = view) {
  vi.stubGlobal("EventSource", FakeStream);
  const result = renderWithProviders(
    <Lobby view={shown} onStart={onStart} onLeave={onLeave} />,
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

  it("states the teacher's conditions first, then the platform's (ADR-079)", () => {
    render();
    const announced = screen.getByRole("heading", { name: "Annoncées par votre enseignant" });
    const imposed = screen.getByRole("heading", { name: "Imposées par la plateforme" });
    expect(announced.compareDocumentPosition(imposed) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(screen.getByText("Une feuille A4 de notes")).toBeInTheDocument();
    // The kind is a word, not a colour.
    expect(screen.getByText("Autorisé")).toBeInTheDocument();
    expect(screen.getByText("Interdit")).toBeInTheDocument();
    // The teacher's text is plain text, never markup.
    expect(screen.getByText("<b>Téléphones</b>")).toBeInTheDocument();
    expect(screen.getByText("Enregistré au fil de la frappe")).toBeInTheDocument();
    expect(screen.getByText("Une seule tentative")).toBeInTheDocument();
  });

  it("states the duration with the student's extra time, once", () => {
    render();
    expect(screen.getByText("27 minutes dès que vous commencez")).toBeInTheDocument();
    expect(screen.getByText("Votre temps supplémentaire de 33 % est compris.")).toBeInTheDocument();
  });

  it("explains a locked navigation (F-LIVE-08)", () => {
    render(undefined, undefined, {
      ...view,
      conditions: { announced: [], imposed: [{ key: "navigation", kind: "info", navigation: "forward_only" }] },
    });
    expect(screen.getByText("Sens unique")).toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "Annoncées par votre enseignant" })).toBeNull();
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

  it("starts at once when the snapshot already says running (a resume before the stream opened)", () => {
    const { stream, onStart } = render();
    stream.emit({
      type: "snapshot",
      serverNow: "2026-09-20T10:01:00.000Z",
      subject: `lobby:${view.evaluation.id}`,
      state: { ...view, evaluation: { ...view.evaluation, state: "running" } },
    });
    expect(onStart).toHaveBeenCalledTimes(1);
  });

  it("stays when the snapshot says the lobby", () => {
    const { stream, onStart } = render();
    stream.emit({
      type: "snapshot",
      serverNow: "2026-09-20T10:01:00.000Z",
      subject: `lobby:${view.evaluation.id}`,
      state: view,
    });
    expect(onStart).not.toHaveBeenCalled();
  });

  it("ignores a frame of the grammar that is not the lobby's", () => {
    const { stream, onStart } = render();
    stream.emit({
      type: "grading.progress",
      evaluationId: view.evaluation.id,
      done: 1,
      total: 2,
      phase: "auto",
    });
    expect(onStart).not.toHaveBeenCalled();
    expect(screen.getByRole("img", { name: "18 étudiants présents sur 24" })).toBeInTheDocument();
  });

  it("drops a frame that is not a valid ServerEvent", () => {
    const { stream, onStart } = render();
    for (const fn of stream.listeners.get("evaluation.state") ?? []) {
      act(() => fn({ data: '{"type":"evaluation.state","state":"running"}' } as MessageEvent));
    }
    expect(onStart).not.toHaveBeenCalled();
  });

  /* ADR-026: the student is told before the first question. */
  it("says that wrong answers cost points when the evaluation uses negative marking", () => {
    render(vi.fn(), vi.fn(), {
      ...view,
      conditions: { announced: [], imposed: [{ key: "negative_marking", kind: "info" }] },
    });
    expect(screen.getByText("Les réponses fausses coûtent des points")).toBeInTheDocument();
    expect(screen.getByText(/ne pas répondre ne coûte rien/)).toBeInTheDocument();
  });

  it("says nothing of it otherwise", () => {
    render();
    expect(screen.queryByText("Les réponses fausses coûtent des points")).toBeNull();
  });
});
