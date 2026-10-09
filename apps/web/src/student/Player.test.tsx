import axe from "axe-core";
import { act, fireEvent, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { createElement, StrictMode, useState } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { AttemptOrLobby, AttemptView } from "@quiz/contracts";

import { makeAttemptItem, makeAttemptView } from "../test/attempt-fixtures";
import { elapse, flowingClock } from "../test/clock";
import { fail, mockFetch, noContent, ok, renderWithProviders } from "../test/render";
import { viewport } from "../test/viewport";
import { AttemptPage } from "./Attempt";

/*
 * Every render of the question host is counted, so a test can prove that the
 * one-second clock of the countdown does not re-render the question under it
 * (Monaco, the circuit canvas…). The wrapper renders the real host unchanged.
 */
const hostRenders = vi.hoisted(() => ({ count: 0 }));
vi.mock("./QuestionHost", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./QuestionHost")>();
  return {
    ...actual,
    QuestionHost: (props: Parameters<typeof actual.QuestionHost>[0]) => {
      hostRenders.count += 1;
      return createElement(actual.QuestionHost, props);
    },
  };
});

/*
 * The player, end to end in jsdom: what a reload brings back (F-LIVE-06), the
 * two keyboard shortcuts of the DoD, and an axe pass on the rendered screen.
 *
 * `POST /evaluations/:id/attempt` is what a reload of `/take/:id` actually
 * calls — it is idempotent and answers with the stored answers and the stored
 * position — so the restore test goes through the real route rather than
 * through a component prop.
 */

const EVAL = "e1";
const ATTEMPT = "a1";

const numberConstraints = { minLength: 0, maxLength: 255, integer: true, min: 0 };

/** Three questions, reopened on the second: an answered mcq, an answered and an empty short. */
const attemptView = (over: Partial<AttemptView["attempt"]> = {}): AttemptView =>
  makeAttemptView({
    attempt: { id: ATTEMPT, lastItemId: "i2", ...over },
    evaluation: { id: EVAL },
    items: [
      makeAttemptItem({ id: "i1", position: 1, points: 2, answer: { selected: [1] }, revision: 3 }),
      makeAttemptItem({
        id: "i2",
        position: 2,
        type: "short",
        student: { prompt: "Combien d'octets pour un `int` ?", kind: "number", constraints: numberConstraints },
        answer: { text: "4" },
        revision: 2,
      }),
      makeAttemptItem({
        id: "i3",
        position: 3,
        type: "short",
        student: { prompt: "Et pour un `char` ?", kind: "number", constraints: numberConstraints },
      }),
    ],
  });

const entry = (view: AttemptView): AttemptOrLobby => ({ kind: "attempt", view });

/** The same evaluation, cut down to its first question (F-LIVE-09). */
const oneItemView = (): AttemptView => {
  const view = attemptView({ lastItemId: "i1" });
  return { ...view, items: [view.items[0]!] };
};

const withNavigation = (
  view: AttemptView,
  navigation: "free" | "forward_only" | "milestones",
): AttemptView => ({
  ...view,
  evaluation: {
    ...view.evaluation,
    settings: { ...view.evaluation.settings, navigation },
  },
});

/** `buttonClass` writes the accent fill, and only for `primary`. */
const isPrimary = (el: HTMLElement) => el.classList.contains("bg-accent");

/** Like the API: the flag the student asked for is the flag that comes back. */
const doneEcho = (call: { body: unknown }) =>
  ok({
    done: (call.body as { done: boolean }).done,
    nextItemId: null,
    serverNow: "2026-09-20T10:00:01.000Z",
  });

const skipEcho = (call: { body: unknown }) =>
  ok({ skipped: (call.body as { skipped: boolean }).skipped, serverNow: "2026-09-20T10:00:01.000Z" });
const flagEcho = (call: { body: unknown }) =>
  ok({ flagged: (call.body as { flagged: boolean }).flagged, serverNow: "2026-09-20T10:00:01.000Z" });

function stubs(view: AttemptView, overrides: Parameters<typeof mockFetch>[0] = {}) {
  return mockFetch({
    ...Object.fromEntries(
      ["i1", "i2", "i3"].flatMap((i) => [
        [`POST /app/api/attempts/${ATTEMPT}/answers/${i}/skip`, skipEcho],
        [`POST /app/api/attempts/${ATTEMPT}/answers/${i}/flag`, flagEcho],
        [`PUT /app/api/attempts/${ATTEMPT}/answers/${i}`, ok({ accepted: true, revision: 9, serverNow: "2026-09-20T10:00:01.000Z" })],
      ]),
    ),
    [`POST /app/api/evaluations/${EVAL}/attempt`]: ok(entry(view)),
    [`GET /app/api/attempts/${ATTEMPT}`]: ok(entry(view)),
    [`POST /app/api/attempts/${ATTEMPT}/position`]: noContent(),
    [`POST /app/api/attempts/${ATTEMPT}/events`]: noContent(),
    [`POST /app/api/attempts/${ATTEMPT}/answers/i1/done`]: doneEcho,
    [`POST /app/api/attempts/${ATTEMPT}/answers/i2/done`]: doneEcho,
    [`POST /app/api/attempts/${ATTEMPT}/answers/i3/done`]: doneEcho,
    ...overrides,
  });
}

const render = (view = attemptView()) =>
  renderWithProviders(<AttemptPage evaluationId={EVAL} navigate={() => {}} />, {
    locale: "fr",
    route: `/take/${EVAL}`,
  });

describe("the zen player on a wide screen", () => {
  // The setup's narrow stub, back for the tests after these.
  const narrow = window.matchMedia;
  afterEach(() => vi.stubGlobal("matchMedia", narrow));

  it("stands the list and the points beside the question; the flag stays on its card", async () => {
    viewport(1280);
    const view = attemptView();
    const { calls } = stubs(view);
    const { container } = render(view);
    const list = await screen.findByRole("navigation", { name: "Progression : question 2 sur 3" });
    // One list, and it is in the side column: no strip left in the bar.
    expect(list.closest("aside")).not.toBeNull();
    expect(container.querySelector("header nav")).toBeNull();
    const aside = list.closest("aside")!;
    // Question 2 is worth one point, said once, beside the list.
    expect(aside).toHaveTextContent("Question 2 · 1 point");
    expect(container.querySelector("main")).not.toHaveTextContent("1 point");
    // The flag is the question's, in the main column, and there is only one.
    const flags = screen.getAllByRole("button", { name: "Marquer à revoir" });
    expect(flags).toHaveLength(1);
    expect(aside).not.toContainElement(flags[0]!);
    expect(container.querySelector("main")).toContainElement(flags[0]!);
    await userEvent.click(flags[0]!);
    await waitFor(() =>
      expect(calls.some((c) => c.url.endsWith("/answers/i2/flag"))).toBe(true),
    );
    // A row of the list moves, like a circle of the strip.
    await userEvent.click(within(list).getByRole("button", { name: /^Question 3,/ }));
    expect(await screen.findByText("Question 3", { selector: "p" })).toBeInTheDocument();
  });

  it("draws no side column for a single question: nothing to list", async () => {
    viewport(1280);
    const view = oneItemView();
    stubs(view);
    const { container } = render(view);
    await screen.findByText("Question 1");
    expect(container.querySelector("aside")).toBeNull();
    // The points stay where a narrow screen has them, and so does the flag.
    expect(screen.getByText("2 points")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Marquer à revoir" })).toBeInTheDocument();
  });

  it("keeps the strip over the question under the breakpoint", async () => {
    viewport(900);
    const view = attemptView();
    stubs(view);
    const { container } = render(view);
    const strip = await screen.findByRole("navigation", { name: "Progression : question 2 sur 3" });
    expect(strip.closest("header")).not.toBeNull();
    expect(container.querySelector("aside")).toBeNull();
  });
});

describe("the zen player", () => {
  it("restores the answers and the position after a reload (F-LIVE-06)", async () => {
    const view = attemptView();
    stubs(view);
    render(view);

    // The position the server remembered, not the first question.
    expect(await screen.findByText("Question 2")).toBeInTheDocument();
    const field = (await screen.findByLabelText("Votre réponse")) as HTMLInputElement;
    expect(field.value).toBe("4");
    // And the answer of a question the student is not looking at is loaded too.
    await userEvent.keyboard("{Alt>}{ArrowLeft}{/Alt}");
    expect(await screen.findByText("Question 1")).toBeInTheDocument();
    const chosen = await screen.findByRole("radio", { name: "*x" });
    expect(chosen).toBeChecked();
  });

  it("tells the server where the student is", async () => {
    const view = attemptView();
    const { calls } = stubs(view);
    render(view);
    await screen.findByText("Question 2");
    await waitFor(() =>
      expect(
        calls.some(
          (c) => c.url.endsWith("/position") && (c.body as { itemId: string }).itemId === "i2",
        ),
      ).toBe(true),
    );
  });

  it("moves with Alt + arrows; Ctrl + Enter validates in forward_only only (issue #89)", async () => {
    const view = attemptView();
    const { calls } = stubs(view);
    const { unmount } = render(view);
    await screen.findByText("Question 2");

    await userEvent.keyboard("{Alt>}{ArrowRight}{/Alt}");
    expect(await screen.findByText("Question 3")).toBeInTheDocument();
    await userEvent.keyboard("{Alt>}{ArrowLeft}{/Alt}");
    expect(await screen.findByText("Question 2")).toBeInTheDocument();

    // `free` has nothing to validate: the shortcut asks for nothing.
    await userEvent.keyboard("{Control>}{Enter}{/Control}");
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(calls.some((c) => c.url.endsWith("/done"))).toBe(false);
    unmount();

    const forward = withNavigation(attemptView(), "forward_only");
    const second = stubs(forward);
    render(forward);
    await screen.findByText("Question 2");
    await userEvent.keyboard("{Control>}{Enter}{/Control}");
    // The same confirmation as the button: it is irreversible, so the focus
    // lands on Cancel and a habitual Enter does NOT validate.
    let dialog = await screen.findByRole("dialog");
    expect(within(dialog).getByRole("button", { name: "Annuler" })).toHaveFocus();
    await userEvent.keyboard("{Enter}");
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(second.calls.some((c) => c.url.endsWith("/done"))).toBe(false);

    await userEvent.keyboard("{Control>}{Enter}{/Control}");
    dialog = await screen.findByRole("dialog");
    await userEvent.click(within(dialog).getByRole("button", { name: "Valider et continuer" }));
    await waitFor(() =>
      expect(second.calls.some((c) => c.url.endsWith("/answers/i2/done"))).toBe(true),
    );
  });

  // Real timers, because the debounce is the thing under test.
  it("autosaves a change, debounced, with a growing revision", async () => {
    const view = attemptView();
    const saves: unknown[] = [];
    mockFetch({
      [`POST /app/api/evaluations/${EVAL}/attempt`]: ok(entry(view)),
      [`POST /app/api/attempts/${ATTEMPT}/position`]: noContent(),
      [`POST /app/api/attempts/${ATTEMPT}/events`]: noContent(),
      [`PUT /app/api/attempts/${ATTEMPT}/answers/i2`]: (call) => {
        saves.push(call.body);
        return ok({ revision: 3, accepted: true, serverNow: "2026-09-20T10:00:02.000Z" });
      },
    });
    render(view);
    const field = await screen.findByLabelText("Votre réponse");
    await userEvent.type(field, "2");
    await waitFor(() => expect(saves).toHaveLength(1));
    // Seeded from the view's revision 2, so the first local change is 3.
    expect((saves[0] as { revision: number }).revision).toBe(3);
    expect((saves[0] as { payload: { text: string } }).payload.text).toBe("42");
    // The badge carries the word twice on purpose: visible from `sm` up, and
    // for a screen reader under it, where the bar has no room for it.
    expect(await screen.findAllByText("Sauvegardé")).not.toHaveLength(0);
  });

  it("says 'not saved' while the question holds back an answer over its limit (#267)", async () => {
    const base = attemptView();
    const essay = {
      ...base.items[1]!,
      type: "rich",
      student: { prompt: "Explain.", format: "plain", maxChars: 5 },
      answer: { text: "ab" },
    };
    const view = { ...base, items: [base.items[0]!, essay, base.items[2]!] };
    stubs(view);
    render(view);
    const field = await screen.findByLabelText("Votre réponse");
    // `maxLength` stops a keyboard; a change event goes past it, as a drop may.
    fireEvent.change(field, { target: { value: "abcdefgh" } });
    expect(await screen.findAllByText("Non sauvegardé")).not.toHaveLength(0);
    fireEvent.change(field, { target: { value: "abc" } });
    await waitFor(() => expect(screen.queryAllByText("Non sauvegardé")).toHaveLength(0));
    // Leaving the question drops what it held back, and the flag with it.
    fireEvent.change(field, { target: { value: "abcdefgh" } });
    expect(await screen.findAllByText("Non sauvegardé")).not.toHaveLength(0);
    await userEvent.keyboard("{Alt>}{ArrowRight}{/Alt}");
    expect(await screen.findByText("Question 3")).toBeInTheDocument();
    expect(screen.queryAllByText("Non sauvegardé")).toHaveLength(0);
  });

  /*
   * The bug this test exists for: `main.tsx` wraps the app in `<StrictMode>`,
   * which in development mounts, runs the cleanup and mounts again while
   * KEEPING the refs. The cleanup's non-final `stop()` used to be
   * irreversible, so in a real browser not one `PUT …/answers/:itemId` ever
   * left — while the badge went on saying "saved". Production, the unit tests
   * and the smoke script all skipped the double mount, so nothing caught it.
   */
  it(
    "still autosaves when the player is mounted twice by StrictMode",
    async () => {
      const view = attemptView();
      const saves: unknown[] = [];
      mockFetch({
        [`POST /app/api/evaluations/${EVAL}/attempt`]: ok(entry(view)),
        [`POST /app/api/attempts/${ATTEMPT}/position`]: noContent(),
        [`POST /app/api/attempts/${ATTEMPT}/events`]: noContent(),
        [`PUT /app/api/attempts/${ATTEMPT}/answers/i2`]: (call) => {
          saves.push(call.body);
          return ok({ revision: 3, accepted: true, serverNow: "2026-09-20T10:00:02.000Z" });
        },
      });
      renderWithProviders(
        <StrictMode>
          <AttemptPage evaluationId={EVAL} navigate={() => {}} />
        </StrictMode>,
        { locale: "fr", route: `/take/${EVAL}` },
      );

      const field = await screen.findByLabelText("Votre réponse");
      await userEvent.type(field, "2");
      await waitFor(() => expect(saves).toHaveLength(1));
      expect((saves[0] as { payload: { text: string } }).payload.text).toBe("42");
    },
  );

  it("shows the time-up screen and stops writing once the attempt is closed", async () => {
    const view = attemptView({ state: "expired" });
    const { calls } = stubs(view);
    render(view);
    expect(await screen.findByText("Temps écoulé")).toBeInTheDocument();
    expect(calls.some((c) => c.method === "PUT")).toBe(false);
  });

  it("deletes the attempt's notepad once the attempt is over, and no other's (ADR-090)", async () => {
    const base = attemptView({ state: "expired" });
    const view = { ...base, evaluation: { ...base.evaluation, settings: { ...base.evaluation.settings, notepad: "provided" as const } } };
    const notes = JSON.stringify({ pages: ["x"], page: 0, checkpoint: -1, savedAt: Date.now() });
    localStorage.setItem(`quiz.notepad.${ATTEMPT}`, notes);
    localStorage.setItem("quiz.notepad.other-tab", notes);
    stubs(view);
    render(view);
    expect(await screen.findByText("Temps écoulé")).toBeInTheDocument();
    expect(localStorage.getItem(`quiz.notepad.${ATTEMPT}`)).toBeNull();
    expect(localStorage.getItem("quiz.notepad.other-tab")).toBe(notes);
  });

  it("names the progress strip and its segments for a screen reader", async () => {
    const view = attemptView();
    stubs(view);
    render(view);
    const strip = await screen.findByRole("navigation", {
      name: "Progression : question 2 sur 3",
    });
    expect(within(strip).getAllByRole("button")).toHaveLength(3);
    // Answered with no click: the answer is there, so the list says so.
    expect(
      within(strip).getByRole("button", { name: "Question 2, répondue, en cours" }),
    ).toBeInTheDocument();
    expect(within(strip).getByRole("button", { name: "Question 3, sans réponse" })).toBeInTheDocument();
  });

  /*
   * The player is rendered outside the Shell, so the account menu that holds
   * the light/dark toggle everywhere else is not on screen: without this
   * button a student sitting an exam at night cannot switch the theme at all.
   */
  it("switches the theme from the header, left of the clock", async () => {
    const view = attemptView();
    stubs(view);
    render(view);
    const toggle = await screen.findByRole("button", { name: "Passer au thème sombre" });
    await userEvent.click(toggle);
    expect(document.documentElement).toHaveClass("dark");
    // The same button, relabelled, takes it back: an explicit choice both ways.
    await userEvent.click(screen.getByRole("button", { name: "Passer au thème clair" }));
    expect(document.documentElement).not.toHaveClass("dark");
  });

  it("keeps the theme toggle when a manual evaluation has no clock", async () => {
    const view = attemptView({ deadlineAt: null });
    stubs(view);
    render(view);
    expect(
      await screen.findByRole("button", { name: "Passer au thème sombre" }),
    ).toBeInTheDocument();
  });

  /*
   * W5: the only `<h1>` used to be "Question 2 of 3" — 13 px, `fg-faint`, and
   * rewritten on every move. The heading now names the page (the evaluation)
   * and the counter is announced instead, politely.
   */
  it("makes the evaluation the heading and the counter a live line", async () => {
    const view = attemptView();
    stubs(view);
    render(view);
    await screen.findByText("Question 2");
    const headings = screen.getAllByRole("heading", { level: 1 });
    expect(headings).toHaveLength(1);
    expect(headings[0]).toHaveTextContent("Quiz 3 — Pointeurs");
    const counter = screen.getByText("Question 2");
    expect(counter.tagName).toBe("P");
    expect(counter).toHaveAttribute("aria-live", "polite");
  });

  /*
   * W15: DESIGN.md promises the palette "from anywhere", and the player is
   * rendered outside the Shell that used to be the only place it existed.
   * The list is short on purpose: during an exam there is nowhere else to go.
   */
  it("opens a student-only command palette on Ctrl+K", async () => {
    const view = attemptView();
    stubs(view);
    render(view);
    await screen.findByText("Question 2");

    await userEvent.keyboard("{Control>}k{/Control}");
    const palette = await screen.findByRole("dialog");
    expect(within(palette).getByRole("option", { name: /Rendre mes réponses/ })).toBeVisible();
    expect(within(palette).getByRole("option", { name: /Question suivante/ })).toBeVisible();
    expect(within(palette).getByRole("option", { name: /Question précédente/ })).toBeVisible();
    expect(within(palette).getByRole("option", { name: /Revenir à mes quiz/ })).toBeVisible();
    // No teacher command anywhere near it.
    expect(within(palette).queryByRole("option", { name: /Administration/ })).toBeNull();

    // And it runs: the next question is one Enter away.
    await userEvent.keyboard("{Escape}");
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  });

  /*
   * F-LIVE-08 and F-LIVE-09, as the product owner read them after sitting a
   * one-question quiz: nothing on the screen may be a control that does
   * nothing, and nothing may be a control that quietly does the opposite of
   * what it says.
   */
  describe("navigation and the question states (issue #89)", () => {
    it("draws no strip and no previous / next for a single question", async () => {
      const view = oneItemView();
      stubs(view);
      render(view);
      await screen.findByText("Question 1");

      expect(screen.queryByRole("navigation")).toBeNull();
      expect(screen.queryByRole("button", { name: "Précédent" })).toBeNull();
      expect(screen.queryByRole("button", { name: "Suivant" })).toBeNull();
      // The rest of the frame is untouched, and `free` validates nothing.
      expect(screen.getByRole("button", { name: "Rendre" })).toBeInTheDocument();
      expect(screen.queryByRole("button", { name: "Valider et continuer" })).toBeNull();
      // And the two arrows are harmless rather than broken.
      await userEvent.keyboard("{Alt>}{ArrowRight}{/Alt}");
      expect(screen.getByText("Question 1")).toBeInTheDocument();
    });

    it("keeps the strip and both arrows as soon as there are several", async () => {
      const view = attemptView();
      stubs(view);
      render(view);
      await screen.findByText("Question 2");

      expect(
        await screen.findByRole("navigation", { name: "Progression : question 2 sur 3" }),
      ).toBeInTheDocument();
      expect(screen.getByRole("button", { name: "Précédent" })).toBeEnabled();
      expect(screen.getByRole("button", { name: "Suivant" })).toBeEnabled();
    });

    it("counts a question as answered with no click, and hands the accent to 'Suivant'", async () => {
      const view = attemptView();
      stubs(view);
      render(view);
      await screen.findByText("Question 2");

      expect(screen.getByText("Répondue")).toBeInTheDocument();
      expect(isPrimary(screen.getByRole("button", { name: "Suivant" }))).toBe(true);
      expect(screen.queryByRole("button", { name: "Marquer comme faite" })).toBeNull();
      // An answered question is not skippable: that would erase the answer.
      expect(screen.queryByRole("button", { name: "Laisser sans réponse" })).toBeNull();
    });

    it("leaves the accent off an empty question in free mode: the field is the action", async () => {
      const view = attemptView({ lastItemId: "i3" });
      stubs(view);
      render(view);
      await screen.findByText("Question 3");
      for (const button of screen.getAllByRole("button")) expect(isPrimary(button)).toBe(false);
    });

    it("settles an empty question with 'Leave unanswered', and an answer takes it back", async () => {
      const view = attemptView({ lastItemId: "i3" });
      const { calls } = stubs(view);
      render(view);
      await screen.findByText("Question 3");

      await userEvent.click(
        screen.getByRole("button", { name: "Laisser sans réponse" }),
      );
      await waitFor(() =>
        expect(
          calls.some(
            (c) =>
              c.url.endsWith("/answers/i3/skip") && (c.body as { skipped: boolean }).skipped,
          ),
        ).toBe(true),
      );
      expect(await screen.findByText("Laissée sans réponse")).toBeInTheDocument();
      const strip = screen.getByRole("navigation", { name: "Progression : question 3 sur 3" });
      expect(
        within(strip).getByRole("button", { name: "Question 3, laissée sans réponse, en cours" }),
      ).toBeInTheDocument();
      // Settled: the accent goes to the way out of the last question.
      expect(isPrimary(screen.getByRole("button", { name: "Rendre" }))).toBe(true);
      // And it can be taken back by hand — the chip is pressed (issue #128)…
      const skip = screen.getByRole("button", { name: "Laisser sans réponse" });
      expect(skip).toHaveAttribute("aria-pressed", "true");

      // …or by answering, which the list reads at once.
      await userEvent.type(await screen.findByLabelText("Votre réponse"), "1");
      expect(await screen.findByText("Répondue")).toBeInTheDocument();
      expect(screen.queryByText("Laissée sans réponse")).toBeNull();
      expect(
        screen.queryByRole("button", { name: "Laisser sans réponse" }),
      ).toBeNull();
    });

    // Issue #128: the tools are real toggles, never the accent; the flag is
    // an icon in the corner of the card, "Leave unanswered" a chip under it.
    it("draws the flag in the card and 'Leave unanswered' under it, as neutral toggles", async () => {
      const view = attemptView({ lastItemId: "i3" });
      const { calls } = stubs(view);
      render(view);
      await screen.findByText("Question 3");

      const flag = screen.getByRole("button", { name: "Marquer à revoir" });
      const skip = screen.getByRole("button", { name: "Laisser sans réponse" });
      expect(flag.compareDocumentPosition(skip) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
      for (const chip of [flag, skip]) {
        expect(chip).toHaveAttribute("aria-pressed", "false");
        expect(isPrimary(chip)).toBe(false);
        expect(chip.className).not.toMatch(/accent/);
      }

      await userEvent.click(skip);
      await waitFor(() => expect(skip).toHaveAttribute("aria-pressed", "true"));
      await userEvent.click(skip);
      await waitFor(() => expect(skip).toHaveAttribute("aria-pressed", "false"));
      expect(
        calls
          .filter((c) => c.url.endsWith("/answers/i3/skip"))
          .map((c) => (c.body as { skipped: boolean }).skipped),
      ).toEqual([true, false]);

      await userEvent.click(flag);
      await waitFor(() => expect(flag).toHaveAttribute("aria-pressed", "true"));
      expect(flag).toHaveAccessibleName("Marquer à revoir");
      expect(flag.className).not.toMatch(/accent|warning/);
    });

    it("toggles the review flag, stored on the server and shown in the list", async () => {
      const view = attemptView();
      const { calls } = stubs(view);
      render(view);
      await screen.findByText("Question 2");

      const flag = screen.getByRole("button", { name: "Marquer à revoir" });
      expect(flag).toHaveAttribute("aria-pressed", "false");
      await userEvent.click(flag);
      // One name, on or off (issue #128): `aria-pressed` carries the state.
      await waitFor(() => expect(flag).toHaveAttribute("aria-pressed", "true"));
      const pressed = flag;
      expect(isPrimary(pressed)).toBe(false);
      await waitFor(() =>
        expect(
          calls.some(
            (c) =>
              c.url.endsWith("/answers/i2/flag") && (c.body as { flagged: boolean }).flagged,
          ),
        ).toBe(true),
      );
      const strip = screen.getByRole("navigation", { name: "Progression : question 2 sur 3" });
      expect(
        within(strip).getByRole("button", {
          name: "Question 2, répondue, marquée à revoir, en cours",
        }),
      ).toBeInTheDocument();

      await userEvent.click(pressed);
      await waitFor(() => expect(flag).toHaveAttribute("aria-pressed", "false"));
    });

    it("offers 'Clear' on a multiple choice only, and it puts the question back to unanswered", async () => {
      const view = attemptView({ lastItemId: "i1" });
      stubs(view);
      render(view);
      await screen.findByText("Question 1");
      expect(await screen.findByRole("radio", { name: "*x" })).toBeChecked();

      await userEvent.click(screen.getByRole("button", { name: "Effacer ma sélection" }));
      expect(screen.getByRole("radio", { name: "*x" })).not.toBeChecked();
      expect(screen.queryByText("Répondue")).toBeNull();
      expect(
        screen.getByRole("button", { name: "Laisser sans réponse" }),
      ).toBeInTheDocument();

      // A short answer holds a text the student empties by hand: no Clear.
      await userEvent.keyboard("{Alt>}{ArrowRight}{/Alt}");
      await screen.findByText("Question 2");
      expect(screen.queryByRole("button", { name: "Effacer ma sélection" })).toBeNull();
    });

    it("forward_only: 'Valider et continuer' is the primary, asks first, and closes the question", async () => {
      const view = withNavigation(attemptView({ lastItemId: "i3" }), "forward_only");
      const { calls } = stubs(view);
      render(view);
      await screen.findByText("Question 3");

      // Empty, the step is named for what it closes, and it is the only
      // way to leave the question blank: no "Leave unanswered" beside it.
      const blank = screen.getByRole("button", { name: "Laisser vide et continuer" });
      expect(isPrimary(blank)).toBe(true);
      expect(screen.queryByRole("button", { name: "Laisser sans réponse" })).toBeNull();
      // Cancelling the confirmation sends nothing.
      await userEvent.click(blank);
      let dialog = await screen.findByRole("dialog");
      expect(within(dialog).getByText("Valider cette question ?")).toBeInTheDocument();
      expect(within(dialog).getByText(/elle comptera comme non répondue/)).toBeInTheDocument();
      await userEvent.click(within(dialog).getByRole("button", { name: "Annuler" }));
      expect(calls.some((c) => c.url.endsWith("/done"))).toBe(false);

      // Answered, it validates.
      await userEvent.type(await screen.findByLabelText("Votre réponse"), "1");
      const validate = await screen.findByRole("button", { name: "Valider et continuer" });
      expect(isPrimary(validate)).toBe(true);
      await userEvent.click(screen.getByRole("button", { name: "Valider et continuer" }));
      dialog = await screen.findByRole("dialog");
      await userEvent.click(within(dialog).getByRole("button", { name: "Valider et continuer" }));
      expect(await screen.findByText("Validée")).toBeInTheDocument();
      // No way back, by button or by shortcut: the server answers 409.
      expect(screen.queryByRole("button", { name: "Valider et continuer" })).toBeNull();
      const before = calls.filter((c) => c.url.endsWith("/done")).length;
      await userEvent.keyboard("{Control>}{Enter}{/Control}");
      expect(calls.filter((c) => c.url.endsWith("/done"))).toHaveLength(before);
      // The last question validated: handing in is what is left.
      await waitFor(() =>
        expect(isPrimary(screen.getByRole("button", { name: "Rendre" }))).toBe(true),
      );
    });

    it("milestones: an empty checkpoint reads 'Laisser vide et continuer'; elsewhere 'Laisser sans réponse' stays", async () => {
      const checkpointAt = (id: string) => {
        const view = withNavigation(attemptView({ lastItemId: "i3" }), "milestones");
        return { ...view, items: view.items.map((i) => ({ ...i, milestone: i.id === id })) };
      };
      stubs(checkpointAt("i3"));
      const { unmount } = render(checkpointAt("i3"));
      await screen.findByText("Question 3");
      expect(isPrimary(screen.getByRole("button", { name: "Laisser vide et continuer" }))).toBe(
        true,
      );
      expect(screen.queryByRole("button", { name: "Laisser sans réponse" })).toBeNull();
      unmount();

      // The same empty question, not a checkpoint: nothing to validate, and
      // it can be left unanswered by hand.
      stubs(checkpointAt("i2"));
      render(checkpointAt("i2"));
      await screen.findByText("Question 3");
      expect(screen.getByRole("button", { name: "Laisser sans réponse" })).toBeInTheDocument();
      expect(screen.queryByRole("button", { name: /et continuer$/ })).toBeNull();
    });

    it("milestones: the checkpoint's confirmation says the notepad is emptied too, when there is one (ADR-090)", async () => {
      const base = withNavigation(attemptView({ lastItemId: "i3" }), "milestones");
      const view = {
        ...base,
        evaluation: { ...base.evaluation, settings: { ...base.evaluation.settings, notepad: "provided" as const } },
        items: base.items.map((i) => ({ ...i, milestone: i.id === "i3" })),
      };
      stubs(view);
      render(view);
      await screen.findByText("Question 3");
      await userEvent.click(screen.getByRole("button", { name: "Laisser vide et continuer" }));
      const dialog = await screen.findByRole("dialog");
      expect(within(dialog).getByText("Passer un jalon ferme toutes les questions qui le précèdent et vide le calepin.")).toBeInTheDocument();
    });

    it("never sends the notes: no request carries them, through an autosave and a checkpoint (ADR-090)", async () => {
      const base = withNavigation(attemptView({ lastItemId: "i3" }), "milestones");
      const view = {
        ...base,
        evaluation: { ...base.evaluation, settings: { ...base.evaluation.settings, notepad: "provided" as const } },
        items: base.items.map((i) => ({ ...i, milestone: i.id === "i3" })),
      };
      const { calls } = stubs(view);
      render(view);
      await screen.findByText("Question 3");
      const marker = "NOTEPAD-MARKER-7f3a";
      await userEvent.click(await screen.findByRole("button", { name: "Calepin" }));
      await userEvent.type(screen.getByRole("textbox", { name: /^Page 1 sur 1$/ }), marker);
      await userEvent.keyboard("{Escape}");
      await userEvent.type(await screen.findByLabelText("Votre réponse"), "7");
      await waitFor(() => expect(calls.some((c) => c.method === "PUT")).toBe(true));
      await userEvent.click(screen.getByRole("button", { name: "Valider et continuer" }));
      const dialog = await screen.findByRole("dialog");
      await userEvent.click(within(dialog).getByRole("button", { name: "Valider et continuer" }));
      await waitFor(() => expect(calls.some((c) => c.url.endsWith("/done"))).toBe(true));
      // Every request — answers, position, journal, validation — by URL and body.
      expect(calls.length).toBeGreaterThan(0);
      for (const call of calls) {
        expect(call.url).not.toContain(marker);
        expect(JSON.stringify(call.body ?? null)).not.toContain(marker);
      }
    });

    it("keeps the question open when the latest answer failed to save (5xx, then validate)", async () => {
      const view = withNavigation(attemptView({ lastItemId: "i3" }), "forward_only");
      const { calls } = stubs(view, {
        [`PUT /app/api/attempts/${ATTEMPT}/answers/i3`]: fail(500, { error: "boom" }),
      });
      render(view);
      await screen.findByText("Question 3");
      await userEvent.type(await screen.findByLabelText("Votre réponse"), "7");
      await waitFor(() => expect(calls.some((c) => c.method === "PUT")).toBe(true));

      await userEvent.click(screen.getByRole("button", { name: "Valider et continuer" }));
      const dialog = await screen.findByRole("dialog");
      await userEvent.click(within(dialog).getByRole("button", { name: "Valider et continuer" }));

      expect(
        await screen.findByText(/Votre dernière réponse n'est pas encore enregistrée/),
      ).toBeInTheDocument();
      // Nothing was validated: the older answer is not locked for good.
      expect(calls.some((c) => c.url.endsWith("/done"))).toBe(false);
      expect(screen.getByRole("button", { name: "Valider et continuer" })).toBeInTheDocument();
      expect(screen.queryByText("Validée")).toBeNull();
    });

    it("makes 'Rendre' the accent on a one-question attempt that holds an answer", async () => {
      const view = oneItemView();
      stubs(view);
      render(view);
      await screen.findByText("Question 1");
      await waitFor(() =>
        expect(isPrimary(screen.getByRole("button", { name: "Rendre" }))).toBe(true),
      );
      // And handing in still goes through its confirmation (F-LIVE-10).
      await userEvent.click(screen.getByRole("button", { name: "Rendre" }));
      expect(await screen.findByText("Rendre vos réponses ?")).toBeInTheDocument();
    });
  });

  /*
   * Issue #125: an exercise can be left at any time and continued from the
   * student home; an exam keeps the zen player with nowhere to go.
   */
  describe("the way home", () => {
    const exercise = (): AttemptView => {
      const view = attemptView();
      return { ...view, evaluation: { ...view.evaluation, mode: "exercise" } };
    };
    const renderWith = (navigate: (r: unknown) => void) =>
      renderWithProviders(<AttemptPage evaluationId={EVAL} navigate={navigate} />, {
        locale: "fr",
        route: `/take/${EVAL}`,
      });

    it("offers no Home button during an exam", async () => {
      stubs(attemptView());
      render();
      await screen.findByText("Question 2");
      expect(screen.queryByRole("button", { name: "Revenir à mes quiz" })).toBeNull();
    });

    it(
      "goes home from an exercise without handing in, once the pending answer is saved",
      async () => {
        const view = exercise();
        const saves: unknown[] = [];
        const { calls } = stubs(view, {
          [`PUT /app/api/attempts/${ATTEMPT}/answers/i2`]: (call) => {
            saves.push(call.body);
            return ok({ accepted: true, revision: 9, serverNow: "2026-09-20T10:00:01.000Z" });
          },
        });
        const navigate = vi.fn();
        renderWith(navigate);
        const field = await screen.findByLabelText("Votre réponse");
        // Typed, and still inside the 300 ms debounce when Home is pressed.
        await userEvent.type(field, "2");
        await userEvent.click(screen.getByRole("button", { name: "Revenir à mes quiz" }));
        await waitFor(() => expect(navigate).toHaveBeenCalledWith({ view: "home" }));
        // The answer reached the server first…
        expect((saves.at(-1) as { payload: { text: string } }).payload.text).toBe("42");
        // …and nothing was handed in: the attempt stays in progress.
        expect(calls.some((c) => c.url.endsWith("/submit"))).toBe(false);
      },
    );

    /** Home pressed with "2" typed and still in its debounce. */
    const typeThenHome = async (user: ReturnType<typeof userEvent.setup> = userEvent.setup()) => {
      await user.type(await screen.findByLabelText("Votre réponse"), "2");
      await user.click(screen.getByRole("button", { name: "Revenir à mes quiz" }));
    };

    /** The leave bound is 6 s of wall clock: jumped, on a flowing clock. */
    const pastTheLeaveBound = () => elapse(6_000);

    it("asks before leaving when an answer cannot be saved, Stay focused", async () => {
      stubs(exercise(), {
        [`PUT /app/api/attempts/${ATTEMPT}/answers/i2`]: fail(500, { error: "boom" }),
      });
      const navigate = vi.fn();
      renderWith(navigate);
      await typeThenHome();
      const dialog = await screen.findByRole("dialog");
      expect(within(dialog).getByText(/risquent d'être perdues/)).toBeInTheDocument();
      expect(within(dialog).getByRole("button", { name: "Rester" })).toHaveFocus();
      await userEvent.click(within(dialog).getByRole("button", { name: "Rester" }));
      await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
      expect(navigate).not.toHaveBeenCalledWith({ view: "home" });

      // Asked again, the student may leave anyway.
      await userEvent.click(screen.getByRole("button", { name: "Revenir à mes quiz" }));
      await userEvent.click(
        within(await screen.findByRole("dialog")).getByRole("button", { name: "Partir quand même" }),
      );
      await waitFor(() => expect(navigate).toHaveBeenCalledWith({ view: "home" }));
    });

    it("says the evaluation is paused when the save met a 410 paused", async () => {
      stubs(exercise(), {
        [`PUT /app/api/attempts/${ATTEMPT}/answers/i2`]: fail(410, {
          error: "attempt_closed",
          reason: "paused",
          deadlineAt: null,
          serverNow: "2026-09-20T10:00:01.000Z",
        }),
      });
      renderWith(vi.fn());
      await typeThenHome();
      const dialog = await screen.findByRole("dialog", { name: "Quitter cet exercice ?" });
      expect(within(dialog).getByText(/mis l'évaluation en pause/)).toBeInTheDocument();
      expect(within(dialog).queryByText(/connexion/)).toBeNull();
    });

    it("says the attempt is closed when the save met a 410 closed", async () => {
      stubs(exercise(), {
        [`PUT /app/api/attempts/${ATTEMPT}/answers/i2`]: fail(410, {
          error: "attempt_closed",
          reason: "deadline",
          deadlineAt: null,
          serverNow: "2026-09-20T10:00:01.000Z",
        }),
      });
      renderWith(vi.fn());
      await typeThenHome();
      const dialog = await screen.findByRole("dialog", { name: "Quitter cet exercice ?" });
      expect(within(dialog).getByText(/Cette tentative est fermée/)).toBeInTheDocument();
    });

    /** Every autosave hangs: the request leaves and never answers. */
    const hangSaves = (fetchMock: ReturnType<typeof stubs>["fetchMock"]) => {
      const base = fetchMock.getMockImplementation()!;
      fetchMock.mockImplementation((input: RequestInfo | URL, init: RequestInit = {}) =>
        init.method === "PUT" ? new Promise<Response>(() => {}) : base(input, init),
      );
    };

    it("stops waiting for a hung save after a few seconds, and never fires twice", async () => {
      const user = flowingClock();
      const { fetchMock } = stubs(exercise());
      hangSaves(fetchMock);
      const navigate = vi.fn();
      renderWith(navigate);
      await typeThenHome(user);
      const home = screen.getByRole("button", { name: "Revenir à mes quiz" });
      // Leaving is under way: Home reads as disabled but keeps the focus,
      // and a second press asks nothing more.
      await waitFor(() => expect(home).toHaveAttribute("aria-disabled", "true"));
      expect(home).toHaveFocus();
      await user.click(home);
      expect(screen.queryByRole("dialog")).toBeNull();
      // The bound is 6 s: the question is asked, not a dead button.
      await pastTheLeaveBound();
      const dialog = await screen.findByRole("dialog");
      expect(screen.getAllByRole("dialog")).toHaveLength(1);
      expect(within(dialog).getByText(/risquent d'être perdues/)).toBeInTheDocument();
      await user.click(within(dialog).getByRole("button", { name: "Rester" }));
      await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
      // Back where the student was: on Home, enabled again.
      await waitFor(() => expect(home).toHaveFocus());
      expect(home).not.toHaveAttribute("aria-disabled");
      expect(navigate).not.toHaveBeenCalledWith({ view: "home" });
    });

    it("asks nothing once the player is gone (Home, then Back)", async () => {
      const user = flowingClock();
      const { fetchMock } = stubs(exercise());
      hangSaves(fetchMock);
      function Away() {
        const [on, setOn] = useState(true);
        return (
          <>
            {on ? <AttemptPage evaluationId={EVAL} navigate={() => {}} /> : null}
            <button type="button" onClick={() => setOn(false)}>
              back
            </button>
          </>
        );
      }
      renderWithProviders(<Away />, { locale: "fr", route: `/take/${EVAL}` });
      await typeThenHome(user);
      await user.click(screen.getByRole("button", { name: "back" }));
      expect(screen.queryByText("Question 2")).toBeNull();
      // Past the 6 s bound: the confirmation stays shut on the next page.
      await elapse(6_500);
      expect(screen.queryByRole("dialog")).toBeNull();
    });
  });

  it("has no axe violation", async () => {
    const view = attemptView();
    stubs(view);
    const { container } = render(view);
    await screen.findByText("Question 2");
    const results = await axe.run(container, {
      // jsdom computes no layout and no cascade, so contrast is measured in
      // the screenshots instead (DESIGN.md holds the measured table).
      rules: { "color-contrast": { enabled: false } },
    });
    expect(results.violations.map((v) => `${v.id}: ${v.nodes.length}`)).toEqual([]);
  });
});

/*
 * The countdown of the bar (invariant 5): it counts down to the SERVER's
 * deadline on the server's clock, once a second, and it closes nothing by
 * itself at zero — the ticker does, and its `attempt.closed` frame is what
 * turns the player read-only. The clock ticks in the countdown alone: the
 * question under it must not re-render with every second.
 */
describe("the zen player's clock", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  /** Three seconds left, on a server whose clock the browser does not share. */
  const nearDeadline = () =>
    attemptView({
      serverNow: "2026-09-20T10:00:00.000Z",
      deadlineAt: "2026-09-20T10:00:03.000Z",
    });

  const timer = () => screen.getByRole("timer");

  /*
   * Only the clock is faked — the interval every countdown shares, and the
   * time itself — so once the countdown has joined the tick (`firstSecond`),
   * a tick happens exactly when the test says, however loaded the machine.
   * The fetches, the queries and Testing Library's waits keep their real
   * timers.
   */
  const fakeClock = (now: number) =>
    vi.useFakeTimers({ now, toFake: ["setInterval", "clearInterval", "Date"] });

  /*
   * The countdown joins the tick in an effect, which React may run a
   * macrotask after the digits are drawn: on a loaded runner, after the
   * test's first jump, and that tick is lost. So the first second is awaited
   * until the digits move — by the tick, or by the late subscription reading
   * the clock — and the countdown is ticking from then on.
   */
  const firstSecond = async () => {
    const shown = timer().textContent;
    act(() => void vi.advanceTimersByTime(1_000));
    await waitFor(() => expect(timer().textContent).not.toBe(shown));
  };

  it("counts down to the server's deadline and stops at zero without closing anything", async () => {
    // The browser is an hour off: only the server's time may count.
    fakeClock(Date.parse("2026-09-20T11:00:00.000Z"));
    const view = nearDeadline();
    const { calls } = stubs(view);
    render(view);
    await screen.findByText("Question 2");
    expect(timer()).toHaveTextContent("0:03");

    await firstSecond();
    expect(timer()).toHaveTextContent("0:02");

    act(() => void vi.advanceTimersByTime(5_000));
    expect(timer()).toHaveTextContent("0:00");
    expect(timer()).toHaveAccessibleName("Le temps est écoulé.");
    // Zero is a display, not a decision: the player is still there, and it
    // asked the server nothing.
    expect(screen.getByText("Question 2")).toBeInTheDocument();
    expect(screen.queryByText("Temps écoulé")).toBeNull();
    expect(calls.some((c) => c.url.endsWith("/submit"))).toBe(false);
  });

  it("does not re-render the question on a tick", async () => {
    fakeClock(Date.parse("2026-09-20T10:00:00.000Z"));
    const view = attemptView();
    stubs(view);
    render(view);
    await screen.findByLabelText("Votre réponse");
    // Let the mount settle (the position post, the first autosave state).
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    await firstSecond();
    const before = hostRenders.count;
    const shown = timer().textContent;

    // One `act` per second: each tick is its own commit, as in a browser.
    for (let tick = 0; tick < 3; tick++) act(() => void vi.advanceTimersByTime(1_000));
    expect(timer().textContent).not.toBe(shown);
    expect(hostRenders.count).toBe(before);
  });
});

/*
 * F-EVAL-13 over the page's one connection: the player journals a
 * `reconnect` and replays what the server has not acknowledged when a LOST
 * connection comes back — and does neither on the first open.
 */
class FakeStream {
  static last: FakeStream | null = null;
  onopen: (() => void) | null = null;
  onerror: (() => void) | null = null;
  onmessage: ((e: MessageEvent) => void) | null = null;
  constructor(readonly url: string) {
    FakeStream.last = this;
  }
  addEventListener() {}
  removeEventListener() {}
  close() {}
}

describe("the zen player's connection", () => {
  afterEach(() => {
    FakeStream.last = null;
    // Only EventSource: the jsdom setup's own stubs must survive (Attempt.test).
    vi.stubGlobal("EventSource", undefined);
  });

  it(
    "journals one reconnect and replays the unacked answer on a reopen, not on the first open",
    async () => {
      vi.stubGlobal("EventSource", FakeStream);
      const view = attemptView();
      let failing = true;
      const saves: unknown[] = [];
      const { calls } = mockFetch({
        [`POST /app/api/evaluations/${EVAL}/attempt`]: ok(entry(view)),
        [`GET /app/api/attempts/${ATTEMPT}`]: ok(entry(view)),
        [`POST /app/api/attempts/${ATTEMPT}/position`]: noContent(),
        [`POST /app/api/attempts/${ATTEMPT}/events`]: noContent(),
        [`PUT /app/api/attempts/${ATTEMPT}/answers/i2`]: (call) => {
          saves.push(call.body);
          return failing
            ? fail(503)
            : ok({ revision: 3, accepted: true, serverNow: "2026-09-20T10:00:02.000Z" });
        },
      });
      render(view);
      const field = await screen.findByLabelText("Votre réponse");
      const stream = FakeStream.last!;
      expect(stream.url).toBe(`/app/api/events?watch=attempt%3A${ATTEMPT}`);
      const reconnects = () =>
        calls.filter(
          (c) =>
            c.url.endsWith("/events") && (c.body as { kind?: string } | null)?.kind === "reconnect",
        );

      act(() => stream.onopen?.());
      expect(reconnects()).toHaveLength(0);

      // Two refused writes: the next backoff retry is a full second away.
      await userEvent.type(field, "2");
      await waitFor(() => expect(saves).toHaveLength(2), { timeout: 3_000 });
      failing = false;

      act(() => {
        stream.onerror?.();
        stream.onopen?.();
      });
      // The replay leaves at once, well before the backoff would have sent it.
      await waitFor(() => expect(saves).toHaveLength(3), { timeout: 400 });
      expect((saves[2] as { payload: { text: string } }).payload.text).toBe("42");
      await waitFor(() => expect(reconnects()).toHaveLength(1));
    },
  );

  it("keeps what the student typed when a refetch lands before the autosave", async () => {
    vi.stubGlobal("EventSource", FakeStream);
    const view = attemptView();
    // The server's copy is older than the field, and its clock has moved: a
    // new object, as every real refetch is.
    const later = attemptView({ serverNow: "2026-09-20T10:01:00.000Z" });
    let refetched = 0;
    mockFetch({
      [`POST /app/api/evaluations/${EVAL}/attempt`]: ok(entry(view)),
      [`GET /app/api/attempts/${ATTEMPT}`]: () => {
        refetched += 1;
        return ok(entry(later));
      },
      [`POST /app/api/attempts/${ATTEMPT}/position`]: noContent(),
      [`POST /app/api/attempts/${ATTEMPT}/events`]: noContent(),
      // Never acknowledged: the typing stays ahead of the server.
      [`PUT /app/api/attempts/${ATTEMPT}/answers/i2`]: fail(503),
    });
    render(view);
    const field = (await screen.findByLabelText("Votre réponse")) as HTMLInputElement;
    await userEvent.type(field, "2");
    await userEvent.keyboard("{Alt>}{ArrowLeft}{/Alt}");
    expect(await screen.findByText("Question 1")).toBeInTheDocument();

    const stream = FakeStream.last!;
    act(() => {
      stream.onopen?.();
      stream.onerror?.();
      stream.onopen?.();
    });
    await waitFor(() => expect(refetched).toBeGreaterThan(0));
    await act(() => new Promise((resolve) => setTimeout(resolve, 50)));

    // Still on the question the student moved to, not on the stale bookmark…
    expect(screen.getByText("Question 1")).toBeInTheDocument();
    // …and the answer still holds the keystroke the server never stored.
    await userEvent.keyboard("{Alt>}{ArrowRight}{/Alt}");
    expect(await screen.findByText("Question 2")).toBeInTheDocument();
    expect(((await screen.findByLabelText("Votre réponse")) as HTMLInputElement).value).toBe("42");
  });
});

/* ADR-079: the conditions read before the start stay one press away, in the bar. */
describe("the conditions during the attempt", () => {
  it("reopen from the bar, in a dialog, teacher first", async () => {
    const view: AttemptView = {
      ...attemptView(),
      conditions: {
        announced: [{ kind: "allowed", text: "Une feuille A4 de notes" }],
        imposed: [{ key: "autosave", kind: "info" }],
      },
    };
    stubs(view);
    render(view);
    await userEvent.click(await screen.findByRole("button", { name: "Voir les conditions" }));
    const dialog = await screen.findByRole("dialog", { name: "Conditions" });
    expect(within(dialog).getByText("Une feuille A4 de notes")).toBeInTheDocument();
    expect(within(dialog).getByText("Enregistré au fil de la frappe")).toBeInTheDocument();
  });

  it("are not offered when there are none", async () => {
    stubs(attemptView());
    render();
    await screen.findByText("Question 2");
    expect(screen.queryByRole("button", { name: "Voir les conditions" })).toBeNull();
  });
});

describe("the text before a question (ADR-084)", () => {
  const INTRO = "Lisez le **chapitre 8** avant de répondre.";
  /** The three questions, the third preceded by a text. */
  const withIntro = (navigation: "free" | "forward_only" | "milestones", lastItemId: string) => {
    const view = withNavigation(attemptView({ lastItemId }), navigation);
    return {
      ...view,
      items: view.items.map((item) => (item.id === "i3" ? { ...item, intro: INTRO } : item)),
    };
  };

  it("shows the passage on arriving, Continue opens the question, and free navigation reopens it", async () => {
    const view = withIntro("free", "i2");
    stubs(view);
    render(view);
    await screen.findByText("Question 2");
    await userEvent.click(screen.getByRole("button", { name: "Suivant" }));

    expect(await screen.findByText("Avant la question 3")).toBeInTheDocument();
    expect(screen.getByText("chapitre 8")).toBeInTheDocument();
    // The passage is not a question: nothing to flag or answer, one primary action.
    expect(screen.queryByRole("button", { name: "Marquer à revoir" })).toBeNull();
    const go = screen.getByRole("button", { name: "Continuer" });
    expect(isPrimary(go)).toBe(true);
    expect(screen.queryByText(/ne pourrez plus relire/)).toBeNull();

    await userEvent.click(go);
    expect(await screen.findByText("Question 3")).toBeInTheDocument();
    expect(screen.queryByText("chapitre 8")).toBeNull();
    await userEvent.click(screen.getByRole("button", { name: "Relire le texte" }));
    expect(await screen.findByText("Avant la question 3")).toBeInTheDocument();
  });

  it("is one way under forward_only: said before Continue, not reopenable after", async () => {
    const view = withIntro("forward_only", "i3");
    stubs(view);
    render(view);
    expect(await screen.findByText("Avant la question 3")).toBeInTheDocument();
    expect(screen.getByText(/ne pourrez plus relire ce texte/)).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Continuer" }));
    expect(await screen.findByText("Question 3")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Relire le texte" })).toBeNull();
  });

  it("is not shown again on reloading a question already started", async () => {
    const view = withIntro("free", "i2");
    const started = {
      ...view,
      items: view.items.map((item) => (item.id === "i2" ? { ...item, intro: INTRO } : item)),
    };
    stubs(started);
    render(started);
    expect(await screen.findByText("Question 2")).toBeInTheDocument();
    expect(screen.queryByText("Avant la question 2")).toBeNull();
    // Still there to read again, under free navigation.
    expect(screen.getByRole("button", { name: "Relire le texte" })).toBeInTheDocument();
  });
});

describe("the zen player's integrity journal (F-EVAL-13)", () => {
  const withLog = (view: AttemptView, logVisibility: boolean): AttemptView => ({
    ...view,
    evaluation: { ...view.evaluation, settings: { ...view.evaluation.settings, logVisibility } },
  });
  /** The window loses the focus for real (not into an iframe); the check runs a tick later. */
  const leave = () =>
    act(async () => {
      window.dispatchEvent(new Event("blur"));
      await new Promise((resolve) => setTimeout(resolve, 10));
    });
  const events = (calls: { url: string }[]) => calls.filter((c) => c.url.endsWith("/events"));

  it("journals leaving the page when the evaluation logs it", async () => {
    const view = attemptView();
    const { calls } = stubs(view);
    render(view);
    await screen.findByText("Question 2");
    await leave();
    expect(events(calls)).toHaveLength(1);
  });

  it.each([
    ["the evaluation does not log it", withLog(attemptView(), false)],
    ["in the teacher's preview", attemptView({ preview: true })],
  ])("journals nothing when %s", async (_, view) => {
    const { calls } = stubs(view);
    render(view);
    await screen.findByText("Question 2");
    await leave();
    expect(events(calls)).toEqual([]);
  });
});
