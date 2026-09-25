import axe from "axe-core";
import { act, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { StrictMode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { AttemptOrLobby, AttemptView } from "@quiz/contracts";

import { fail, mockFetch, noContent, ok, renderWithProviders } from "../test/render";
import { AttemptPage } from "./Attempt";

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

const attemptView = (over: Partial<AttemptView["attempt"]> = {}): AttemptView => ({
  attempt: {
    id: ATTEMPT,
    state: "in_progress",
    startedAt: "2026-09-20T09:50:00.000Z",
    deadlineAt: "2026-09-20T10:20:00.000Z",
    lastItemId: "i2",
    serverNow: "2026-09-20T10:00:00.000Z",
    preview: false,
    readOnly: false,
    ...over,
  },
  evaluation: {
    id: EVAL,
    title: "Quiz 3 — Pointeurs",
    mode: "exam",
    state: "running",
    settings: {
      navigation: "free",
      presentation: "zen",
      lobby: "manual",
      shuffleItems: false,
      shuffleChoices: true,
      timing: "duration",
      showProgressBar: true,
      logVisibility: true,
      requireFullscreen: false,
    },
    feedbackPolicy: {
      when: "on_release",
      showAnswer: true,
      showKey: false,
      showExplanation: false,
      showHiddenCaseNames: true,
      showTeacherComment: true,
    },
    pausedAt: null,
    totalPoints: 4,
  },
  items: [
    {
      id: "i1",
      position: 1,
      points: 2,
      type: "mcq",
      milestone: false,
      student: {
        prompt: "Quelle expression donne l'adresse de `x` ?",
        mode: "single",
        choices: [
          { id: 0, text: "&x" },
          { id: 1, text: "*x" },
        ],
      },
      answer: { selected: [1] },
      revision: 3,
      markedDone: false,
      skipped: false,
      flagged: false,
      locked: false,
    },
    {
      id: "i2",
      position: 2,
      points: 1,
      type: "short",
      milestone: false,
      student: {
        prompt: "Combien d'octets pour un `int` ?",
        kind: "number",
        constraints: { minLength: 0, maxLength: 255, integer: true, min: 0 },
      },
      answer: { text: "4" },
      revision: 2,
      markedDone: false,
      skipped: false,
      flagged: false,
      locked: false,
    },
    {
      id: "i3",
      position: 3,
      points: 1,
      type: "short",
      milestone: false,
      student: {
        prompt: "Et pour un `char` ?",
        kind: "number",
        constraints: { minLength: 0, maxLength: 255, integer: true, min: 0 },
      },
      answer: null,
      revision: 0,
      markedDone: false,
      skipped: false,
      flagged: false,
      locked: false,
    },
  ],
});

const entry = (view: AttemptView): AttemptOrLobby => ({ kind: "attempt", view });

/** The same evaluation, cut down to its first question (F-LIVE-09). */
const oneItemView = (): AttemptView => {
  const view = attemptView({ lastItemId: "i1" });
  return { ...view, items: [view.items[0]!] };
};

const withNavigation = (view: AttemptView, navigation: "free" | "forward_only"): AttemptView => ({
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

  // Real timers, because the debounce is the thing under test. Mounting the
  // lazy player, typing and waiting 300 ms costs more than the 5 s default.
  it("autosaves a change, debounced, with a growing revision", { timeout: 15_000 }, async () => {
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
    { timeout: 15_000 },
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
      expect(screen.queryByRole("button", { name: "Je ne répondrai pas à cette question" })).toBeNull();
    });

    it("leaves the accent off an empty question in free mode: the field is the action", async () => {
      const view = attemptView({ lastItemId: "i3" });
      stubs(view);
      render(view);
      await screen.findByText("Question 3");
      for (const button of screen.getAllByRole("button")) expect(isPrimary(button)).toBe(false);
    });

    it("settles an empty question with 'I won't answer', and an answer takes it back", async () => {
      const view = attemptView({ lastItemId: "i3" });
      const { calls } = stubs(view);
      render(view);
      await screen.findByText("Question 3");

      await userEvent.click(
        screen.getByRole("button", { name: "Je ne répondrai pas à cette question" }),
      );
      await waitFor(() =>
        expect(
          calls.some(
            (c) =>
              c.url.endsWith("/answers/i3/skip") && (c.body as { skipped: boolean }).skipped,
          ),
        ).toBe(true),
      );
      expect(await screen.findByText("Je n'y réponds pas")).toBeInTheDocument();
      const strip = screen.getByRole("navigation", { name: "Progression : question 3 sur 3" });
      expect(
        within(strip).getByRole("button", { name: "Question 3, vous n'y répondrez pas, en cours" }),
      ).toBeInTheDocument();
      // Settled: the accent goes to the way out of the last question.
      expect(isPrimary(screen.getByRole("button", { name: "Rendre" }))).toBe(true);
      // And it can be taken back by hand…
      expect(screen.getByRole("button", { name: "Finalement, y répondre" })).toBeInTheDocument();

      // …or by answering, which the list reads at once.
      await userEvent.type(await screen.findByLabelText("Votre réponse"), "1");
      expect(await screen.findByText("Répondue")).toBeInTheDocument();
      expect(screen.queryByText("Je n'y réponds pas")).toBeNull();
      expect(screen.queryByRole("button", { name: "Finalement, y répondre" })).toBeNull();
    });

    it("toggles the review flag, stored on the server and shown in the list", async () => {
      const view = attemptView();
      const { calls } = stubs(view);
      render(view);
      await screen.findByText("Question 2");

      const flag = screen.getByRole("button", { name: "Marquer à revoir" });
      expect(flag).toHaveAttribute("aria-pressed", "false");
      await userEvent.click(flag);
      const pressed = await screen.findByRole("button", { name: "Marquée à revoir" });
      expect(pressed).toHaveAttribute("aria-pressed", "true");
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
      expect(await screen.findByRole("button", { name: "Marquer à revoir" })).toBeInTheDocument();
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
        screen.getByRole("button", { name: "Je ne répondrai pas à cette question" }),
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

      const validate = screen.getByRole("button", { name: "Valider et continuer" });
      expect(isPrimary(validate)).toBe(true);
      // Cancelling the confirmation sends nothing.
      await userEvent.click(validate);
      let dialog = await screen.findByRole("dialog");
      expect(within(dialog).getByText("Valider cette question ?")).toBeInTheDocument();
      await userEvent.click(within(dialog).getByRole("button", { name: "Annuler" }));
      expect(calls.some((c) => c.url.endsWith("/done"))).toBe(false);

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
      { timeout: 15_000 },
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

    it("stays when the pending answer cannot be saved", { timeout: 15_000 }, async () => {
      const view = exercise();
      stubs(view, {
        [`PUT /app/api/attempts/${ATTEMPT}/answers/i2`]: fail(500, { error: "boom" }),
      });
      const navigate = vi.fn();
      renderWith(navigate);
      await userEvent.type(await screen.findByLabelText("Votre réponse"), "2");
      await userEvent.click(screen.getByRole("button", { name: "Revenir à mes quiz" }));
      expect(
        await screen.findByText(/Vérifiez votre connexion, puis réessayez/),
      ).toBeInTheDocument();
      expect(navigate).not.toHaveBeenCalledWith({ view: "home" });
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
    { timeout: 15_000 },
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
});
