import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import { makeClassroomDetail } from "../test/fixtures";
import { EVALUATION_ID, id, makeEvaluationDetail } from "../test/live-fixtures";
import { mockFetch, ok, renderWithProviders, type RouteHandler } from "../test/render";
import { EvaluationConfig } from "./EvaluationConfig";

/*
 * ADR-018 and its second addendum — what is left of the walk on this page.
 *
 * The walk itself is entered from the frame's `Teacher | Student` switch and
 * is tested with that switch (`Header.test.tsx`, `studentView.test.tsx`); the
 * page's own "View as student" button, its confirmation and its self-enrol
 * call are gone. What the page still owns is the teacher's own test attempt:
 * it is thrown away from the overflow menu so the walk can be done again.
 */

const CLASSROOM = id("classroom", 1);
const ATTEMPT = id("attempt", 1);

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

  /*
   * The two buttons the header used to carry, and the menu line that opened a
   * modal to change one word. One test so that putting any of them back is a
   * red run rather than a code review.
   */
  it("carries neither student button, and renames on the title instead", async () => {
    const user = userEvent.setup();
    const navigate = vi.fn();
    const { calls } = mockFetch(routes());
    renderWithProviders(<EvaluationConfig id={EVALUATION_ID} navigate={navigate} />, {
      route: "/evaluations/x?step=questions",
    });

    expect(await screen.findByRole("button", { name: /^actions$/i })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /^view as student$/i })).toBeNull();
    expect(screen.queryByRole("button", { name: /^preview as student$/i })).toBeNull();

    await user.click(screen.getByRole("button", { name: /^actions$/i }));
    expect(await screen.findByRole("menuitem", { name: /delete evaluation/i })).toBeInTheDocument();
    expect(screen.queryByRole("menuitem", { name: /^rename$/i })).toBeNull();
    expect(calls.some((c) => c.url.endsWith("/self-enroll"))).toBe(false);
    expect(calls.some((c) => c.url.endsWith("/preview"))).toBe(false);
  });
});
