import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

import { makeClassroomDetail } from "../test/fixtures";
import { EVALUATION_ID, id, makeEvaluationDetail } from "../test/live-fixtures";
import { mockFetch, noContent, ok, renderWithProviders, type RouteHandler } from "../test/render";
import { studentViewOn, studentViewReturn } from "../studentView";
import { EvaluationConfig } from "./EvaluationConfig";

/*
 * ADR-018 — "View as student": the REAL walk.
 *
 * What is asserted here is the three-step decision the button makes, because
 * that is the only logic the screen owns: join when there is no seat, switch
 * the app into the student view remembering the way back, and go to the
 * student's own route. Everything the teacher sees after that belongs to the
 * student player and is tested there.
 */

const CLASSROOM = id("classroom", 1);

function routes(
  detail = makeEvaluationDetail(),
  extra: Record<string, RouteHandler> = {},
): Record<string, RouteHandler> {
  return {
    [`GET /app/api/evaluations/${EVALUATION_ID}`]: ok(detail),
    [`GET /app/api/classrooms/${CLASSROOM}`]: ok(makeClassroomDetail({ id: CLASSROOM })),
    ...extra,
  };
}

const ATTEMPT = id("attempt", 1);

afterEach(() => {
  localStorage.clear();
});

describe("View as student (ADR-018)", () => {
  it("offers a seat first when the teacher holds none, then walks", async () => {
    const user = userEvent.setup();
    const navigate = vi.fn();
    const { calls } = mockFetch(
      routes(makeEvaluationDetail(), {
        [`POST /app/api/classrooms/${CLASSROOM}/self-enroll`]: noContent(),
      }),
    );
    renderWithProviders(<EvaluationConfig id={EVALUATION_ID} navigate={navigate} />, {
      route: "/evaluations/x?step=questions",
    });

    await user.click(await screen.findByRole("button", { name: /^view as student$/i }));
    const dialog = await screen.findByRole("dialog");
    expect(dialog).toHaveTextContent(/you need a seat in this classroom/i);
    await user.click(await screen.findByRole("button", { name: /^join as student$/i }));

    await waitFor(() =>
      expect(calls.some((c) => c.url.endsWith("/self-enroll") && c.method === "POST")).toBe(true),
    );
    await waitFor(() =>
      expect(navigate).toHaveBeenCalledWith({ view: "attempt", evaluationId: EVALUATION_ID }),
    );
    // The way back, so the banner of the student view returns HERE.
    expect(studentViewOn()).toBe(true);
    expect(studentViewReturn()).toEqual({ view: "evaluation", id: EVALUATION_ID });
  });

  it("does not switch anything when the confirmation is refused", async () => {
    const user = userEvent.setup();
    const navigate = vi.fn();
    const { calls } = mockFetch(routes());
    renderWithProviders(<EvaluationConfig id={EVALUATION_ID} navigate={navigate} />, {
      route: "/evaluations/x?step=questions",
    });

    await user.click(await screen.findByRole("button", { name: /^view as student$/i }));
    await user.click(await screen.findByRole("button", { name: /^cancel$/i }));

    expect(calls.some((c) => c.url.endsWith("/self-enroll"))).toBe(false);
    expect(navigate).not.toHaveBeenCalled();
    expect(studentViewOn()).toBe(false);
  });

  it("goes straight through when the teacher already holds a staff seat", async () => {
    const user = userEvent.setup();
    const navigate = vi.fn();
    const { calls } = mockFetch(
      routes(
        makeEvaluationDetail({ self: { seat: true, staffSeat: true, attemptId: null } }),
      ),
    );
    renderWithProviders(<EvaluationConfig id={EVALUATION_ID} navigate={navigate} />, {
      route: "/evaluations/x?step=questions",
    });

    await user.click(await screen.findByRole("button", { name: /^view as student$/i }));
    await waitFor(() =>
      expect(navigate).toHaveBeenCalledWith({ view: "attempt", evaluationId: EVALUATION_ID }),
    );
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(calls.some((c) => c.url.endsWith("/self-enroll"))).toBe(false);
  });
});

describe("Reset my test attempt (ADR-018)", () => {
  it("is offered only when a staff attempt exists, and confirms first", async () => {
    const user = userEvent.setup();
    const navigate = vi.fn();
    const { calls } = mockFetch(
      routes(
        makeEvaluationDetail({ self: { seat: true, staffSeat: true, attemptId: ATTEMPT } }),
        { [`DELETE /app/api/evaluations/${EVALUATION_ID}/attempt`]: ok({ deleted: true }) },
      ),
    );
    renderWithProviders(<EvaluationConfig id={EVALUATION_ID} navigate={navigate} />, {
      route: "/evaluations/x?step=questions",
    });

    await user.click(await screen.findByRole("button", { name: /^actions$/i }));
    await user.click(await screen.findByRole("menuitem", { name: /reset my test attempt/i }));
    expect(await screen.findByRole("dialog")).toHaveTextContent(/your answers, your journal/i);
    await user.click(await screen.findByRole("button", { name: /^delete my attempt$/i }));

    await waitFor(() =>
      expect(
        calls.some((c) => c.method === "DELETE" && c.url.endsWith("/attempt")),
      ).toBe(true),
    );
  });

  it("is absent while the teacher has no test attempt", async () => {
    const user = userEvent.setup();
    const navigate = vi.fn();
    mockFetch(routes(makeEvaluationDetail({ self: { seat: true, staffSeat: true, attemptId: null } })));
    renderWithProviders(<EvaluationConfig id={EVALUATION_ID} navigate={navigate} />, {
      route: "/evaluations/x?step=questions",
    });

    await user.click(await screen.findByRole("button", { name: /^actions$/i }));
    expect(await screen.findByRole("menuitem", { name: /delete evaluation/i })).toBeInTheDocument();
    expect(screen.queryByRole("menuitem", { name: /reset my test attempt/i })).toBeNull();
  });
});
