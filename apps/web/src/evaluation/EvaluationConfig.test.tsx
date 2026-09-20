import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import { makeClassroomDetail } from "../test/fixtures";
import {
  EVALUATION_ID,
  id,
  makeEvaluationDetail,
  makeItemRow,
} from "../test/live-fixtures";
import { mockFetch, ok, renderWithProviders, type RouteHandler } from "../test/render";
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
    "GET /app/api/pools": ok([
      { id: id("pool", 1), name: "PRG1", visibility: "private", ownerId: "u", isPersonal: false, createdAt: detail.evaluation.createdAt, questionCount: 1 },
    ]),
    [`GET /app/api/pools/${id("pool", 1)}/questions`]: ok({
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
          updatedAt: detail.evaluation.createdAt,
          deprecated: false,
        },
      ],
      nextCursor: null,
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
    await user.click(screen.getByRole("button", { name: /update it/i }));
    await waitFor(() =>
      expect(calls.some((c) => c.url.endsWith("/items/update-versions"))).toBe(true),
    );
  });

  it("a preset writes the settings it names", async () => {
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
    await waitFor(() => {
      const patch = calls.find((c) => c.method === "PATCH");
      expect(patch?.body).toMatchObject({
        settings: { timing: "deadline", lobby: "skip" },
        durationS: null,
        feedbackPolicy: { when: "immediate" },
      });
    });
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

  it("freezes the structure once a student has started", async () => {
    mockFetch(routes(makeEvaluationDetail({ editable: false, attemptCount: 3 })));
    renderWithProviders(<EvaluationConfig id={EVALUATION_ID} navigate={navigate} />, {
      route: "/evaluations/x?step=questions",
    });
    expect(await screen.findByText(/the structure is frozen/i)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /add questions/i })).toBeDisabled();
  });

  it("renders the failed state of its own query", async () => {
    mockFetch({});
    renderWithProviders(<EvaluationConfig id={EVALUATION_ID} navigate={navigate} />);
    expect(await screen.findByText(/evaluation not found/i)).toBeInTheDocument();
  });
});
