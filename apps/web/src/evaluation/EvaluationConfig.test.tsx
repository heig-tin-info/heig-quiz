import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { PAGE_SIZE } from "../pool/filters";
import { makeClassroomDetail } from "../test/fixtures";
import {
  EVALUATION_ID,
  id,
  makeEvaluationDetail,
  makeItemRow,
} from "../test/live-fixtures";
import { labelIssues } from "../test/labels";
import {
  fail,
  mockFetch,
  noContent,
  ok,
  renderWithProviders,
  type RouteHandler,
} from "../test/render";
import { EvaluationConfig } from "./EvaluationConfig";

/*
 * The three-step flow of docs/spec/08 §8.2, asserted where it touches the
 * server: adding questions, applying a preset, and opening the waiting room.
 * Everything else on these screens is a control bound to `PATCH`, which the
 * preset test covers once for all of them.
 */

const CLASSROOM = id("classroom", 1);
const QUESTION = id("question", 7);

function routes(
  detail = makeEvaluationDetail(),
  extra: Record<string, RouteHandler> = {},
): Record<string, RouteHandler> {
  return {
    [`GET /app/api/evaluations/${EVALUATION_ID}`]: ok(detail),
    [`GET /app/api/classrooms/${CLASSROOM}`]: ok(makeClassroomDetail({ id: CLASSROOM })),
    [`GET /app/api/evaluations/${EVALUATION_ID}/pools`]: ok([
      { id: id("pool", 1), name: "PRG1", visibility: "private", ownerId: "u", isPersonal: false, createdAt: detail.evaluation.createdAt, questionCount: 1 },
    ]),
    // The picker asks with the pool screen's own query string (FF-11).
    [`GET /app/api/pools/${id("pool", 1)}/questions?limit=${PAGE_SIZE}`]: ok({
      items: [
        {
          id: QUESTION,
          type: "mcq",
          internalName: "Pointer declaration",
          difficulty: 2,
          tags: [],
          categoryId: null,
          latestNumber: 1,
          hasDraftChanges: false,
          keyless: false,
          updatedAt: detail.evaluation.createdAt,
          deprecated: false,
        },
      ],
      nextCursor: null,
      total: 1,
    }),
    ...extra,
  };
}

const navigate = vi.fn();

describe("EvaluationConfig", () => {
  it("adds questions from a pool through the picker sheet", async () => {
    const user = userEvent.setup();
    const { calls } = mockFetch(
      routes(makeEvaluationDetail({ items: [] }), {
        [`POST /app/api/evaluations/${EVALUATION_ID}/items`]: ok([makeItemRow(0)]),
      }),
    );
    renderWithProviders(<EvaluationConfig id={EVALUATION_ID} navigate={navigate} />, {
      route: "/evaluations/x?step=questions",
    });

    await user.click(await screen.findByRole("button", { name: /add questions/i }));
    const sheet = await screen.findByRole("dialog");
    await user.click(await within(sheet).findByRole("checkbox", { name: /pointer declaration/i }));
    await user.click(within(sheet).getByRole("button", { name: /add 1 question/i }));

    await waitFor(() =>
      expect(
        calls.find((c) => c.method === "POST" && c.url.endsWith("/items")),
      ).toMatchObject({ body: { questionIds: [QUESTION] } }),
    );
  });

  it("shows the stale badge and updates every stale item in one click", async () => {
    const user = userEvent.setup();
    const stale = makeItemRow(1, { versionNumber: 1, latestVersionNumber: 3 });
    const detail = makeEvaluationDetail({
      items: [makeItemRow(0), stale],
      staleItems: [stale.id],
    });
    const { calls } = mockFetch(
      routes(detail, {
        [`POST /app/api/evaluations/${EVALUATION_ID}/items/update-versions`]: ok([]),
      }),
    );
    renderWithProviders(<EvaluationConfig id={EVALUATION_ID} navigate={navigate} />, {
      route: "/evaluations/x?step=questions",
    });

    expect(await screen.findByText(/version 3 available/i)).toBeInTheDocument();
    // #85: the frozen version reads in a column of its own, the newer one beside it.
    const row = screen.getByText(stale.internalName).closest("li")!;
    expect(within(row).getByText("v1")).toBeInTheDocument();
    expect(within(row).getByText("v3")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: /update it/i }));
    await waitFor(() =>
      expect(calls.some((c) => c.url.endsWith("/items/update-versions"))).toBe(true),
    );
  });

  it("a preset writes the settings it names", async () => {
    const user = userEvent.setup();
    const exercise = makeEvaluationDetail({
      evaluation: { ...makeEvaluationDetail().evaluation, mode: "exercise" },
    });
    const { calls } = mockFetch(
      routes(exercise, {
        [`PATCH /app/api/evaluations/${EVALUATION_ID}`]: ok(exercise),
      }),
    );
    renderWithProviders(<EvaluationConfig id={EVALUATION_ID} navigate={navigate} />, {
      route: "/evaluations/x?step=timing",
    });

    await user.click(await screen.findByRole("button", { name: /homework exercise/i }));
    await waitFor(() => {
      const patch = calls.find((c) => c.method === "PATCH");
      expect(patch?.body).toMatchObject({
        settings: { timing: "deadline", lobby: "skip" },
        durationS: null,
        feedbackPolicy: { when: "immediate" },
      });
      // A common end needs its opening time (#76): the preset writes both.
      expect(patch?.body).toHaveProperty("opensAt", expect.any(String));
      expect(patch?.body).toHaveProperty("closesAt", expect.any(String));
    });
  });

  it("the matched preset's card says the values in force, the other what it would set (#87)", async () => {
    const base = makeEvaluationDetail();
    mockFetch(routes({ ...base, evaluation: { ...base.evaluation, durationS: 30 * 60 } }));
    renderWithProviders(<EvaluationConfig id={EVALUATION_ID} navigate={navigate} />, {
      route: "/evaluations/x?step=timing",
    });
    const inClass = await screen.findByRole("button", { name: /in-class evaluation/i });
    expect(inClass).toHaveAttribute("aria-pressed", "true");
    expect(inClass).toHaveTextContent(/^In-class evaluation30 minutes each, waiting room opened by you/);
    expect(inClass).not.toHaveTextContent(/45/);
    expect(screen.getByRole("button", { name: /homework exercise/i })).toHaveTextContent(
      /Sets a common deadline/,
    );
  });

  /*
   * "Time and mode" is the densest form of the flow: a duration, two dates
   * and three segmented controls, plus everything the advanced disclosure
   * holds. Every caption there has to name a real control.
   */
  it("gives every <label for> of the timing step a control to point at", async () => {
    const user = userEvent.setup();
    mockFetch(routes());
    renderWithProviders(<EvaluationConfig id={EVALUATION_ID} navigate={navigate} />, {
      route: "/evaluations/x?step=timing",
    });
    expect(await screen.findByRole("button", { name: /^advanced options$/i })).toBeInTheDocument();
    expect(labelIssues()).toEqual([]);
    await user.click(screen.getByRole("button", { name: /^advanced options$/i }));
    await screen.findByRole("radio", { name: /^on release$/i });
    expect(labelIssues()).toEqual([]);
  });

  it("an exam is never offered immediate feedback (F-EVAL-11)", async () => {
    const user = userEvent.setup();
    mockFetch(routes());
    renderWithProviders(<EvaluationConfig id={EVALUATION_ID} navigate={navigate} />, {
      route: "/evaluations/x?step=timing",
    });
    await user.click(await screen.findByRole("button", { name: /^advanced options$/i }));
    expect(await screen.findByRole("radio", { name: /^on release$/i })).toBeInTheDocument();
    expect(screen.queryByRole("radio", { name: /^right away$/i })).not.toBeInTheDocument();
    expect(screen.getByText(/not offered in class/i)).toBeInTheDocument();
  });

  it("the take-home preset asks an exam for feedback on release, never right away (#78)", async () => {
    const user = userEvent.setup();
    const { calls } = mockFetch(
      routes(makeEvaluationDetail(), {
        [`PATCH /app/api/evaluations/${EVALUATION_ID}`]: ok(makeEvaluationDetail()),
      }),
    );
    renderWithProviders(<EvaluationConfig id={EVALUATION_ID} navigate={navigate} />, {
      route: "/evaluations/x?step=timing",
    });
    await user.click(await screen.findByRole("button", { name: /homework exercise/i }));
    await waitFor(() =>
      expect(calls.find((c) => c.method === "PATCH")?.body).toMatchObject({
        feedbackPolicy: { when: "on_release" },
      }),
    );
  });

  /*
   * #78: "in class" is not only the exam mode. An exercise given a waiting
   * room starts everybody together, and immediate feedback would reach the
   * first students while the others are still working.
   */
  describe("immediate feedback in class (#78)", () => {
    const exercise = (lobby: "skip" | "manual", when: "on_release" | "immediate") =>
      makeEvaluationDetail({
        evaluation: {
          ...makeEvaluationDetail().evaluation,
          mode: "exercise",
          settings: { ...makeEvaluationDetail().evaluation.settings, lobby },
          feedbackPolicy: { ...makeEvaluationDetail().evaluation.feedbackPolicy, when },
        },
      });

    it("offers it to a take-home exercise", async () => {
      const user = userEvent.setup();
      mockFetch(routes(exercise("skip", "immediate")));
      renderWithProviders(<EvaluationConfig id={EVALUATION_ID} navigate={navigate} />, {
        route: "/evaluations/x?step=timing",
      });
      await user.click(await screen.findByRole("button", { name: /^advanced options$/i }));
      expect(await screen.findByRole("radio", { name: /^right away$/i })).toBeChecked();
      expect(screen.queryByText(/not offered in class/i)).toBeNull();
    });

    it("hides it, and says why, for an exercise with a waiting room", async () => {
      const user = userEvent.setup();
      mockFetch(routes(exercise("manual", "on_release")));
      renderWithProviders(<EvaluationConfig id={EVALUATION_ID} navigate={navigate} />, {
        route: "/evaluations/x?step=timing",
      });
      await user.click(await screen.findByRole("button", { name: /^advanced options$/i }));
      expect(await screen.findByRole("radio", { name: /^on release$/i })).toBeChecked();
      expect(screen.queryByRole("radio", { name: /^right away$/i })).toBeNull();
      expect(screen.getByText(/not offered in class/i)).toBeInTheDocument();
    });

    it("brings the policy back to 'on release' in the same patch that adds a waiting room", async () => {
      const user = userEvent.setup();
      const detail = exercise("skip", "immediate");
      const { calls } = mockFetch(
        routes(detail, { [`PATCH /app/api/evaluations/${EVALUATION_ID}`]: ok(detail) }),
      );
      renderWithProviders(<EvaluationConfig id={EVALUATION_ID} navigate={navigate} />, {
        route: "/evaluations/x?step=timing",
      });
      await user.click(await screen.findByRole("button", { name: /^advanced options$/i }));
      await user.click(await screen.findByRole("radio", { name: /^you start$/i }));
      await waitFor(() =>
        expect(calls.find((c) => c.method === "PATCH")?.body).toEqual({
          settings: { lobby: "manual" },
          feedbackPolicy: { when: "on_release" },
        }),
      );
    });

    it("leaves the policy alone when the waiting room changes nothing about it", async () => {
      const user = userEvent.setup();
      const detail = exercise("skip", "on_release");
      const { calls } = mockFetch(
        routes(detail, { [`PATCH /app/api/evaluations/${EVALUATION_ID}`]: ok(detail) }),
      );
      renderWithProviders(<EvaluationConfig id={EVALUATION_ID} navigate={navigate} />, {
        route: "/evaluations/x?step=timing",
      });
      await user.click(await screen.findByRole("button", { name: /^advanced options$/i }));
      await user.click(await screen.findByRole("radio", { name: /^you start$/i }));
      await waitFor(() =>
        expect(calls.find((c) => c.method === "PATCH")?.body).toEqual({
          settings: { lobby: "manual" },
        }),
      );
    });
  });

  /*
   * docs/04 §4.4: the evaluation level of the MCQ scoring hierarchy. The
   * select shows the five policies and the row describes the one in force,
   * so a teacher reads what it does without opening the help.
   */
  it("changes the MCQ scoring policy of the evaluation", async () => {
    const user = userEvent.setup();
    const { calls } = mockFetch(
      routes(makeEvaluationDetail(), {
        [`PATCH /app/api/evaluations/${EVALUATION_ID}`]: ok(makeEvaluationDetail()),
      }),
    );
    renderWithProviders(<EvaluationConfig id={EVALUATION_ID} navigate={navigate} />, {
      route: "/evaluations/x?step=timing",
    });

    await user.click(await screen.findByRole("button", { name: /^advanced options$/i }));
    const select = await screen.findByRole("combobox", { name: /multiple-answer scoring/i });
    expect(
      screen.getByText(/full marks for the exact set of correct choices/i),
    ).toBeInTheDocument();
    await user.selectOptions(select, "discordance");
    await waitFor(() => {
      const patch = calls.find((c) => c.method === "PATCH");
      expect(patch?.body).toMatchObject({ mcqPolicy: "discordance" });
    });
  });

  it("the launch step opens the waiting room", async () => {
    const user = userEvent.setup();
    const { calls } = mockFetch(
      routes(makeEvaluationDetail(), {
        [`POST /app/api/evaluations/${EVALUATION_ID}/state`]: ok({}),
      }),
    );
    renderWithProviders(<EvaluationConfig id={EVALUATION_ID} navigate={navigate} />, {
      route: "/evaluations/x?step=launch",
    });

    await user.click(await screen.findByRole("button", { name: /open the waiting room/i }));
    await waitFor(() =>
      expect(calls.find((c) => c.url.endsWith("/state"))).toMatchObject({ body: { to: "lobby" } }),
    );
  });

  it("refuses to launch an evaluation with no question", async () => {
    mockFetch(routes(makeEvaluationDetail({ items: [] })));
    renderWithProviders(<EvaluationConfig id={EVALUATION_ID} navigate={navigate} />, {
      route: "/evaluations/x?step=launch",
    });
    expect(await screen.findByText(/add at least one question/i)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /open the waiting room/i })).toBeDisabled();
  });

  /*
   * #76: a common end with no opening time used to reach the launch step,
   * where "Open the waiting room" failed with the server's English message.
   */
  describe("an incomplete timing (#76)", () => {
    const takeHome = () =>
      makeEvaluationDetail({
        evaluation: {
          ...makeEvaluationDetail().evaluation,
          mode: "exercise",
          settings: { ...makeEvaluationDetail().evaluation.settings, timing: "deadline", lobby: "skip" },
          durationS: null,
          opensAt: null,
          closesAt: "2026-10-01T10:00:00.000Z",
        },
      });

    it("keeps 'Go to launch' on the step, and points at the missing field", async () => {
      const user = userEvent.setup();
      mockFetch(routes(takeHome()));
      renderWithProviders(<EvaluationConfig id={EVALUATION_ID} navigate={navigate} />, {
        route: "/evaluations/x?step=timing",
      });

      const opensAt = await screen.findByLabelText(/^opens at$/i);
      expect(opensAt).not.toHaveAttribute("aria-invalid");
      await user.click(screen.getByRole("button", { name: /^go to launch$/i }));

      expect(screen.queryByRole("button", { name: /open the waiting room/i })).toBeNull();
      expect(opensAt).toHaveAttribute("aria-invalid", "true");
      expect(opensAt).toHaveAccessibleDescription(/enter the opening time/i);
      expect(opensAt).toHaveFocus();
      // The closing time is set: only the missing field is marked.
      expect(screen.getByLabelText(/^closes at$/i)).not.toHaveAttribute("aria-invalid");
    });

    it("goes to the launch step once the timing is complete", async () => {
      const user = userEvent.setup();
      const complete = takeHome();
      complete.evaluation.opensAt = "2026-09-24T08:00:00.000Z";
      mockFetch(routes(complete));
      renderWithProviders(<EvaluationConfig id={EVALUATION_ID} navigate={navigate} />, {
        route: "/evaluations/x?step=timing",
      });
      await user.click(await screen.findByRole("button", { name: /^go to launch$/i }));
      expect(await screen.findByRole("button", { name: /open the waiting room/i })).toBeEnabled();
    });

    it("says what is missing on the launch step reached by its tab, and offers no launch", async () => {
      mockFetch(routes(takeHome()));
      renderWithProviders(<EvaluationConfig id={EVALUATION_ID} navigate={navigate} />, {
        route: "/evaluations/x?step=launch",
      });
      expect(await screen.findByText(/finish the timing in time and mode/i)).toBeInTheDocument();
      expect(screen.getByText(/enter the opening time/i)).toBeInTheDocument();
      expect(screen.getByRole("button", { name: /open the waiting room/i })).toBeDisabled();
      expect(screen.getByRole("button", { name: /schedule it/i })).toBeDisabled();
    });

    it("translates the server's refusal instead of printing it", async () => {
      const user = userEvent.setup();
      mockFetch(
        routes(makeEvaluationDetail(), {
          [`POST /app/api/evaluations/${EVALUATION_ID}/state`]: fail(409, {
            error: "illegal_transition",
            message: "the timing settings are incomplete (F-EVAL-04): opensAt",
            reason: "timing_incomplete",
            missing: ["opensAt"],
          }),
        }),
      );
      renderWithProviders(<EvaluationConfig id={EVALUATION_ID} navigate={navigate} />, {
        route: "/evaluations/x?step=launch",
      });
      await user.click(await screen.findByRole("button", { name: /open the waiting room/i }));
      expect(await screen.findByText(/did not change state/i)).toBeInTheDocument();
      expect(screen.getByText(/enter the opening time/i)).toBeInTheDocument();
      expect(screen.queryByText(/F-EVAL-04/)).toBeNull();
    });
  });

  it("freezes the structure once a student has started", async () => {
    mockFetch(routes(makeEvaluationDetail({ editable: false, attemptCount: 3 })));
    renderWithProviders(<EvaluationConfig id={EVALUATION_ID} navigate={navigate} />, {
      route: "/evaluations/x?step=questions",
    });
    expect(await screen.findByText(/the structure is frozen/i)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /add questions/i })).toBeDisabled();
  });

  it("freezes the question list once the evaluation is opened, nobody entered yet (#79)", async () => {
    const base = makeEvaluationDetail();
    mockFetch(
      routes({ ...base, editable: false, evaluation: { ...base.evaluation, state: "running" } }),
    );
    renderWithProviders(<EvaluationConfig id={EVALUATION_ID} navigate={navigate} />, {
      route: "/evaluations/x?step=questions",
    });
    expect(await screen.findByText(/its questions are frozen/i)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /add questions/i })).toBeDisabled();
    for (const remove of screen.getAllByRole("button", { name: /^remove/i })) {
      expect(remove).toBeDisabled();
    }
    for (const points of screen.getAllByRole("spinbutton")) expect(points).toBeDisabled();
  });

  describe("the configuration locks while the evaluation runs (#86)", () => {
    const inState = (state: "running" | "closed", attemptCount: number) => {
      const base = makeEvaluationDetail();
      return {
        ...base,
        editable: false,
        attemptCount,
        evaluation: { ...base.evaluation, state },
      };
    };

    it("disables everything but the access code and the feedback, nobody entered yet, and says where time is added", async () => {
      const user = userEvent.setup();
      navigate.mockClear();
      mockFetch(routes(inState("running", 0)));
      renderWithProviders(<EvaluationConfig id={EVALUATION_ID} navigate={navigate} />, {
        route: "/evaluations/x?step=timing",
      });
      expect(await screen.findByText(/locked until it closes/i)).toBeInTheDocument();
      expect(screen.getByText(/use the live dashboard/i)).toBeInTheDocument();
      expect(screen.queryByText(/the structure is frozen/i)).toBeNull();
      expect(screen.getByRole("button", { name: /in-class evaluation/i })).toBeDisabled();
      expect(screen.getByRole("button", { name: /homework exercise/i })).toBeDisabled();
      expect(screen.getByLabelText(/^minutes$/i)).toBeDisabled();

      await user.click(screen.getByRole("button", { name: /^advanced options$/i }));
      // A forgotten answer key must be hideable mid-run (#86); the rest stays frozen.
      expect(await screen.findByRole("radio", { name: /^on release$/i })).toBeEnabled();
      expect(screen.getByRole("switch", { name: /show the expected answer/i })).toBeEnabled();
      expect(screen.getByRole("switch", { name: /progress bar/i })).toBeDisabled();
      expect(screen.getByText(/feedback policy can still change/i)).toBeInTheDocument();
      expect(screen.getByRole("textbox", { name: /access code/i })).toBeEnabled();

      await user.click(screen.getByRole("button", { name: /^live dashboard$/i }));
      expect(navigate).toHaveBeenCalledWith({ view: "live", id: EVALUATION_ID });
    });

    it("keeps the feedback policy editable once closed, before the release", async () => {
      const user = userEvent.setup();
      mockFetch(routes(inState("closed", 3)));
      renderWithProviders(<EvaluationConfig id={EVALUATION_ID} navigate={navigate} />, {
        route: "/evaluations/x?step=timing",
      });
      expect(await screen.findByText(/the structure is frozen/i)).toBeInTheDocument();
      expect(screen.queryByText(/locked until it closes/i)).toBeNull();
      await user.click(screen.getByRole("button", { name: /^advanced options$/i }));
      expect(await screen.findByRole("radio", { name: /^on release$/i })).toBeEnabled();
    });
  });

  it("renders the failed state of its own query", async () => {
    mockFetch({});
    renderWithProviders(<EvaluationConfig id={EVALUATION_ID} navigate={navigate} />);
    expect(await screen.findByText(/evaluation not found/i)).toBeInTheDocument();
  });

  /*
   * The three steps say where they lead, by name. "Next" and "Back" were a
   * wizard's words on a screen that is a tab strip.
   */
  it("names the step each navigation button leads to", async () => {
    mockFetch(routes());
    const { unmount } = renderWithProviders(
      <EvaluationConfig id={EVALUATION_ID} navigate={navigate} />,
      { route: "/evaluations/x?step=questions" },
    );
    expect(await screen.findByRole("button", { name: /^go to time and mode$/i })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /^next$/i })).toBeNull();
    expect(screen.queryByRole("button", { name: /^back to/i })).toBeNull();
    unmount();

    renderWithProviders(<EvaluationConfig id={EVALUATION_ID} navigate={navigate} />, {
      route: "/evaluations/x?step=timing",
    });
    expect(await screen.findByRole("button", { name: /^back to questions$/i })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /^go to launch$/i })).toBeInTheDocument();
  });

  /*
   * Renaming lives on the title now: no menu line, no modal, no layer for one
   * word. The four things asserted here are the whole contract — it opens, it
   * saves what was typed through the ordinary PATCH, Escape changes nothing,
   * and a title trimmed to nothing is refused with the old one restored.
   */
  describe("the title renames itself", () => {
    const RENAME = /^rename evaluation: quiz 3/i;

    async function open() {
      const user = userEvent.setup();
      renderWithProviders(<EvaluationConfig id={EVALUATION_ID} navigate={navigate} />, {
        route: "/evaluations/x?step=questions",
      });
      await user.click(await screen.findByRole("button", { name: RENAME }));
      return { user, input: await screen.findByRole("textbox", { name: /^title$/i }) };
    }

    it("saves the new title on Enter, through the ordinary PATCH", async () => {
      const renamed = makeEvaluationDetail();
      renamed.evaluation.title = "Quiz 3 — arrays";
      const { calls } = mockFetch(
        routes(makeEvaluationDetail(), {
          [`PATCH /app/api/evaluations/${EVALUATION_ID}`]: ok(renamed),
        }),
      );
      const { user, input } = await open();

      await user.clear(input);
      await user.type(input, "Quiz 3 — arrays{Enter}");

      await waitFor(() =>
        expect(calls.find((c) => c.method === "PATCH")).toMatchObject({
          body: { title: "Quiz 3 — arrays" },
        }),
      );
      expect(await screen.findByRole("button", { name: /^rename evaluation: quiz 3 — arrays/i }))
        .toBeInTheDocument();
      // The same "Saved" the rest of the app answers a write with.
      expect(await screen.findByText(/^saved$/i)).toBeInTheDocument();
    });

    it("writes nothing when Escape cancels", async () => {
      const { calls } = mockFetch(routes());
      const { user, input } = await open();

      await user.clear(input);
      await user.type(input, "Something else{Escape}");

      expect(await screen.findByRole("button", { name: RENAME })).toBeInTheDocument();
      expect(calls.some((c) => c.method === "PATCH")).toBe(false);
    });

    it("refuses an empty title and puts the old one back", async () => {
      const { calls } = mockFetch(routes());
      const { user, input } = await open();

      await user.clear(input);
      await user.type(input, "   ");
      await user.tab();

      expect(await screen.findByRole("button", { name: RENAME })).toBeInTheDocument();
      expect(calls.some((c) => c.method === "PATCH")).toBe(false);
    });

    it("stays available once a student has started (the title is not frozen)", async () => {
      mockFetch(routes(makeEvaluationDetail({ editable: false, attemptCount: 3 })));
      renderWithProviders(<EvaluationConfig id={EVALUATION_ID} navigate={navigate} />, {
        route: "/evaluations/x?step=questions",
      });
      expect(await screen.findByRole("button", { name: RENAME })).toBeEnabled();
    });
  });

  it("the launch step offers only the way back", async () => {
    mockFetch(routes());
    renderWithProviders(<EvaluationConfig id={EVALUATION_ID} navigate={navigate} />, {
      route: "/evaluations/x?step=launch",
    });
    expect(
      await screen.findByRole("button", { name: /^back to time and mode$/i }),
    ).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /^go to /i })).toBeNull();
  });
});

/**
 * `@dnd-kit` reorders by comparing the RECTANGLES of the rows, and jsdom runs
 * no layout: every element reports a zero-sized box at the origin, so the
 * keyboard sensor has nowhere to move to and no collision to detect. This
 * stub lays the item rows out in a column — 56 px each, in DOM order — for the
 * duration of the reordering suite. It fakes geometry, nothing else: the
 * sensor, the collision detection and `onDragEnd` are the real ones.
 */
function stubRowLayout() {
  const real = Element.prototype.getBoundingClientRect;
  beforeEach(() => {
    Element.prototype.getBoundingClientRect = function (this: Element) {
      const parent = this.parentElement;
      const row = this.tagName === "LI" && parent ? Array.from(parent.children).indexOf(this) : 0;
      const top = this.tagName === "LI" ? row * 56 : 0;
      const height = this.tagName === "LI" ? 56 : 0;
      return {
        x: 0, y: top, top, left: 0, right: 800, bottom: top + height,
        width: 800, height, toJSON: () => ({}),
      } as DOMRect;
    };
  });
  afterEach(() => {
    Element.prototype.getBoundingClientRect = real;
  });
}

describe("EvaluationConfig — the questions step", () => {
  stubRowLayout();

  const THREE = [makeItemRow(0), makeItemRow(1), makeItemRow(2)];

  function renderQuestions(
    detail = makeEvaluationDetail({ items: THREE }),
    extra: Record<string, RouteHandler> = {},
  ) {
    const mocked = mockFetch(routes(detail, extra));
    renderWithProviders(<EvaluationConfig id={EVALUATION_ID} navigate={navigate} />, {
      route: "/evaluations/x?step=questions",
    });
    return mocked;
  }

  it("offers one named drag handle per row and no arrows", async () => {
    renderQuestions();
    const handles = await screen.findAllByRole("button", { name: /^reorder /i });
    expect(handles).toHaveLength(3);
    for (const handle of handles) {
      expect(handle.tagName).toBe("BUTTON");
      expect(handle).toHaveAttribute("aria-roledescription", "sortable");
    }
    expect(screen.queryByRole("button", { name: /^move (up|down)$/i })).toBeNull();
  });

  it("writes the whole new order in one PUT, from the keyboard alone", async () => {
    const { calls } = renderQuestions(undefined, {
      [`PUT /app/api/evaluations/${EVALUATION_ID}/items/order`]: ok(THREE),
    });

    (await screen.findByRole("button", { name: "Reorder Question 1" })).focus();
    await userEvent.keyboard(" ");
    await userEvent.keyboard("{ArrowDown}");
    await userEvent.keyboard(" ");

    await waitFor(() => {
      const puts = calls.filter((c) => c.method === "PUT" && c.url.endsWith("/items/order"));
      expect(puts).toHaveLength(1);
      expect(puts[0]?.body).toEqual({
        itemIds: [THREE[1]!.id, THREE[0]!.id, THREE[2]!.id],
      });
    });
    // The list shows the new order before the server has answered.
    const names = screen.getAllByRole("listitem").map((li) => li.textContent ?? "");
    expect(names[0]).toContain("Question 2");
    expect(names[1]).toContain("Question 1");
  });

  it("puts the rows back and says so when the reorder fails", async () => {
    renderQuestions(undefined, {
      [`PUT /app/api/evaluations/${EVALUATION_ID}/items/order`]: fail(409, {
        message: "locked",
      }),
    });

    (await screen.findByRole("button", { name: "Reorder Question 1" })).focus();
    await userEvent.keyboard(" ");
    await userEvent.keyboard("{ArrowDown}");
    await userEvent.keyboard(" ");

    expect(await screen.findByText(/new order could not be saved/i)).toBeInTheDocument();
    await waitFor(() => {
      expect(screen.getAllByRole("listitem")[0]?.textContent).toContain("Question 1");
    });
  });

  /*
   * F-EVAL-07 is a boolean on the item; the SCREEN is a separator between two
   * of them. Adding one patches the row above the gap, removing one patches
   * the same row back to false.
   */
  it("adds a milestone in the gap under a row", async () => {
    const user = userEvent.setup();
    const { calls } = renderQuestions(undefined, {
      [`PATCH /app/api/evaluations/${EVALUATION_ID}/items/${THREE[0]!.id}`]: ok(THREE[0]),
    });

    await user.click(
      await screen.findByRole("button", { name: /add a milestone after question 1/i }),
    );
    await waitFor(() =>
      expect(calls.find((c) => c.method === "PATCH")).toMatchObject({
        body: { milestone: true },
      }),
    );
  });

  it("shows the separator of a milestone item, and removes it", async () => {
    const user = userEvent.setup();
    const flagged = [makeItemRow(0, { milestone: true }), makeItemRow(1), makeItemRow(2)];
    const { calls } = renderQuestions(makeEvaluationDetail({ items: flagged }), {
      [`PATCH /app/api/evaluations/${EVALUATION_ID}/items/${flagged[0]!.id}`]: ok(flagged[0]),
    });

    expect(await screen.findByText(/^milestone$/i)).toBeInTheDocument();
    // The gap "+" is gone where a separator already stands.
    expect(screen.queryByRole("button", { name: /add a milestone after question 1/i })).toBeNull();
    // ...and there is no per-row switch left to disagree with the separator.
    expect(screen.queryByRole("switch", { name: /milestone/i })).toBeNull();

    await user.click(screen.getByRole("button", { name: /remove the milestone after question 1/i }));
    await waitFor(() =>
      expect(calls.find((c) => c.method === "PATCH")).toMatchObject({
        body: { milestone: false },
      }),
    );
  });

  it("offers the refresh button only on a row with a newer version", async () => {
    const user = userEvent.setup();
    const stale = makeItemRow(1, { versionNumber: 1, latestVersionNumber: 4 });
    const { calls } = renderQuestions(
      makeEvaluationDetail({ items: [makeItemRow(0), stale], staleItems: [stale.id] }),
      {
        [`POST /app/api/evaluations/${EVALUATION_ID}/items/update-versions`]: ok([]),
      },
    );

    const refresh = await screen.findAllByRole("button", { name: /^use the latest version of/i });
    expect(refresh).toHaveLength(1);
    expect(refresh[0]).toHaveAccessibleName("Use the latest version of Question 2");

    await user.click(refresh[0]!);
    await waitFor(() =>
      expect(
        calls.find((c) => c.method === "POST" && c.url.endsWith("/items/update-versions")),
      ).toMatchObject({ body: { itemIds: [stale.id] } }),
    );
  });

  /*
   * Taking an item out of an evaluation nobody has started takes nothing
   * away: the question stays in its pool. The dialog is what a change to
   * something a class has already answered deserves, and nothing less.
   */
  it("removes an item in one click while no attempt exists", async () => {
    const user = userEvent.setup();
    const { calls } = renderQuestions(undefined, {
      [`DELETE /app/api/evaluations/${EVALUATION_ID}/items/${THREE[0]!.id}`]: noContent(),
    });

    await user.click(
      await screen.findByRole("button", { name: /remove question 1 from the evaluation/i }),
    );
    await waitFor(() =>
      expect(calls.some((c) => c.method === "DELETE" && c.url.endsWith(THREE[0]!.id))).toBe(true),
    );
    expect(screen.queryByRole("dialog")).toBeNull();
  });
});
