import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { CourseRole, EvaluationDetail } from "@quiz/contracts";

import { dashboardKey } from "../queryKeys";
import { initialGrid } from "../realtime/grid";
import { resetEventStream } from "../realtime/useEventStream";
import { EVALUATION_ID, makeDashboard, makeEvaluationDetail } from "../test/live-fixtures";
import { makeCourseSummary } from "../test/fixtures";
import { fail, makeQueryClient, mockFetch, ok, renderWithProviders } from "../test/render";
import { LiveDashboard } from "./LiveDashboard";
import { LIVE_TOGGLES_KEY } from "./toggles";

/*
 * "Publish the correction" of a running exercise (ADR-050): a tertiary
 * action of the live header's overflow menu — never on an exam — behind a
 * confirmation that says what THIS feedback policy will show, and replaced,
 * once done, by a badge and "Present the correction".
 */

class SilentEventSource {
  onopen = null;
  onerror = null;
  onmessage = null;
  addEventListener() {}
  removeEventListener() {}
  close() {}
}

const navigate = vi.fn();
const PUBLISH = `POST /app/api/evaluations/${EVALUATION_ID}/publish-correction`;

function exercise(over: (detail: EvaluationDetail) => void = () => {}): EvaluationDetail {
  const detail = makeEvaluationDetail();
  detail.evaluation.mode = "exercise";
  detail.evaluation.state = "running";
  over(detail);
  return detail;
}

function setup(
  detail: EvaluationDetail,
  publishReply = ok({ correctionPublishedAt: "2026-09-30T10:00:00.000Z", queued: 1 }),
  myRole: CourseRole = "owner",
) {
  localStorage.setItem(LIVE_TOGGLES_KEY, JSON.stringify({ names: true, answers: true, results: true }));
  const view = makeDashboard(2, 2);
  const queryClient = makeQueryClient();
  queryClient.setQueryData(dashboardKey(EVALUATION_ID, true, true), initialGrid(view));
  const stubs = mockFetch({
    [`GET /app/api/evaluations/${EVALUATION_ID}`]: ok(detail),
    [`GET /app/api/evaluations/${EVALUATION_ID}/dashboard?includeAnswers=1&results=1`]: ok(view),
    [PUBLISH]: publishReply,
    // The course list the owner's actions are decided from (ADR-068).
    "GET /app/api/courses": ok([makeCourseSummary({ id: detail.courseId, myRole })]),
  });
  const rendered = renderWithProviders(<LiveDashboard id={EVALUATION_ID} navigate={navigate} />, {
    queryClient,
  });
  return { ...rendered, ...stubs };
}

/** Opens the header's overflow menu and picks the item named `name`. */
async function pick(user: ReturnType<typeof userEvent.setup>, name: RegExp) {
  await screen.findByRole("heading", { name: /quiz 3 — pointers/i });
  await user.click(screen.getByRole("button", { name: /^actions$/i }));
  await user.click(await screen.findByRole("menuitem", { name }));
}

beforeEach(() => {
  vi.stubGlobal("EventSource", SilentEventSource);
  navigate.mockReset();
});
afterEach(() => resetEventStream());

describe("LiveDashboard — publishing the correction (ADR-050)", () => {
  it("is never offered on an exam, nor on an exercise still in its waiting room", async () => {
    const exam = makeEvaluationDetail({});
    exam.evaluation.state = "running";
    for (const detail of [exam, exercise((d) => (d.evaluation.state = "lobby"))]) {
      const { unmount } = setup(detail);
      await screen.findByRole("heading", { name: /quiz 3 — pointers/i });
      expect(screen.queryByRole("button", { name: /^actions$/i })).not.toBeInTheDocument();
      expect(screen.queryByText(/correction published/i)).not.toBeInTheDocument();
      unmount();
    }
  });

  it("is never offered to an assistant of the course, who still presents it once published (ADR-068)", async () => {
    const user = userEvent.setup();
    const { unmount } = setup(exercise(), undefined, "assistant");
    await screen.findByRole("heading", { name: /quiz 3 — pointers/i });
    expect(screen.queryByRole("button", { name: /^actions$/i })).not.toBeInTheDocument();
    unmount();

    setup(
      exercise((d) => (d.evaluation.correctionPublishedAt = "2026-09-30T09:00:00.000Z")),
      undefined,
      "assistant",
    );
    await pick(user, /present the correction/i);
    expect(navigate).toHaveBeenCalledWith({ view: "correction", evaluationId: EVALUATION_ID });
  });

  it("says in the reader's words why the server refused, and reads the evaluation again", async () => {
    const user = userEvent.setup();
    const { calls } = setup(
      exercise(),
      fail(409, { error: "correction_not_open", message: "only a running exercise publishes" }),
    );
    await pick(user, /publish the correction/i);
    const detailReads = () =>
      calls.filter((c) => c.method === "GET" && c.url === `/app/api/evaluations/${EVALUATION_ID}`).length;
    const before = detailReads();
    await user.click(within(await screen.findByRole("dialog")).getByRole("button", { name: /publish the correction/i }));
    expect(await screen.findByText(/can only be published while the exercise is running/i)).toBeVisible();
    expect(screen.queryByText("only a running exercise publishes")).toBeNull();
    await waitFor(() => expect(detailReads()).toBeGreaterThan(before));
  });

  it("asks first, says what the policy shows, and publishes on confirmation", async () => {
    const user = userEvent.setup();
    const { calls } = setup(
      exercise((d) => {
        d.evaluation.settings = { ...d.evaluation.settings, retakes: { enabled: true, keep: "best", maxAttempts: null } };
        d.evaluation.feedbackPolicy = { ...d.evaluation.feedbackPolicy, when: "on_release", showKey: false };
      }),
    );
    await pick(user, /publish the correction/i);

    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).getByText(/can still retake it/i)).toBeInTheDocument();
    expect(within(dialog).getByText(/projection becomes available/i)).toBeInTheDocument();
    expect(within(dialog).getByText(/without the answer key/i)).toBeInTheDocument();
    expect(within(dialog).getByText(/cannot be undone/i)).toBeInTheDocument();
    // Nothing is sent before the confirmation.
    expect(calls.some((c) => c.url.endsWith("/publish-correction"))).toBe(false);

    await user.click(within(dialog).getByRole("button", { name: /publish the correction/i }));
    await waitFor(() => {
      const call = calls.find((c) => c.url.endsWith("/publish-correction"));
      expect(call?.method).toBe("POST");
      expect(call?.body).toEqual({ confirm: true });
    });
  });

  it("says students see nothing more under the policy none", async () => {
    const user = userEvent.setup();
    setup(exercise((d) => (d.evaluation.feedbackPolicy = { ...d.evaluation.feedbackPolicy, when: "none" })));
    await pick(user, /publish the correction/i);
    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).getByText(/students see nothing more/i)).toBeInTheDocument();
    expect(within(dialog).getByText(/can still hand in/i)).toBeInTheDocument();
  });

  it("once published, says so and offers the projection instead", async () => {
    const user = userEvent.setup();
    setup(exercise((d) => (d.evaluation.correctionPublishedAt = "2026-09-30T09:00:00.000Z")));
    expect(await screen.findByText(/correction published/i)).toBeInTheDocument();
    await pick(user, /present the correction/i);
    expect(navigate).toHaveBeenCalledWith({ view: "correction", evaluationId: EVALUATION_ID });
    expect(screen.queryByRole("menuitem", { name: /publish the correction/i })).not.toBeInTheDocument();
  });
});
