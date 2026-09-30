import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { EvaluationDetail } from "@quiz/contracts";

import { EVALUATION_ID, makeEvaluationDetail, makeItemRow } from "../test/live-fixtures";
import { fail, mockFetch, ok, renderWithProviders } from "../test/render";
import { LaunchStep } from "./LaunchStep";
import { toLocalInput } from "./timing";

/*
 * The pre-flight checklist of #152: which rows block, which warn, what the
 * one action posts, and what "Schedule…" sends before it changes the state.
 */

const BASE = `/app/api/evaluations/${EVALUATION_ID}`;
const HOUR = 3_600_000;

const navigate = vi.fn();
const onStep = vi.fn();

function withEvaluation(patch: Partial<EvaluationDetail["evaluation"]>, over: Partial<EvaluationDetail> = {}) {
  const base = makeEvaluationDetail(over);
  return { ...base, evaluation: { ...base.evaluation, ...patch } };
}

function render(detail: EvaluationDetail) {
  return renderWithProviders(<LaunchStep detail={detail} navigate={navigate} onStep={onStep} />);
}

beforeEach(() => {
  navigate.mockClear();
  onStep.mockClear();
});

describe("LaunchStep checklist (#152)", () => {
  it("reads Ready when nothing needs a look, and keeps unlinked accounts as information", async () => {
    mockFetch({});
    render(makeEvaluationDetail());
    expect(screen.getByRole("heading", { name: /^ready$/i })).toBeInTheDocument();
    expect(screen.getByText(/24 expected in the room/i)).toBeInTheDocument();
    expect(screen.getByText(/2 have not signed in yet/i)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /open the waiting room/i })).toBeEnabled();
    expect(screen.getByRole("status")).toHaveTextContent(/start the evaluation from the dashboard/i);
  });

  it("counts the warnings, lists them first, and updates stale versions in place", async () => {
    const user = userEvent.setup();
    const stale = makeItemRow(1);
    const { calls } = mockFetch({ [`POST ${BASE}/items/update-versions`]: ok([]) });
    render(
      makeEvaluationDetail({
        items: [makeItemRow(0), stale],
        staleItems: [stale.id],
        roster: { enrolled: 24, unlinked: 0, conflicts: 2 },
      }),
    );
    expect(screen.getByRole("heading", { name: /2 things to look at/i })).toBeInTheDocument();
    // A warning never disables the launch: only the server's refusals do.
    expect(screen.getByRole("button", { name: /open the waiting room/i })).toBeEnabled();
    const rows = screen.getAllByText(/newer version|roster conflicts|questions,/i);
    expect(rows[0]).toHaveTextContent(/newer version/i);
    expect(rows[1]).toHaveTextContent(/2 roster conflicts/i);

    await user.click(screen.getByRole("button", { name: /^update$/i }));
    await waitFor(() =>
      expect(calls.find((c) => c.url.endsWith("/update-versions"))).toMatchObject({ method: "POST" }),
    );
  });

  // F-EVAL-26: a template that moved is a warning, and its fix is the pull.
  it("warns that the template moved, and opens the pull's confirmation", async () => {
    const user = userEvent.setup();
    mockFetch({
      [`GET ${BASE}/pull-template`]: ok({
        templateId: "t1",
        templateTitle: "Final exam",
        from: 1,
        to: 2,
        added: [],
        removed: [],
        changed: [],
        reordered: false,
        deprecatedItems: [],
        unlinkedItems: [],
      }),
    });
    render(withEvaluation({ originRevision: 1 }, { templateRevision: 2 }));
    expect(screen.getByRole("heading", { name: /1 thing to look at/i })).toBeInTheDocument();
    expect(screen.getByText("The template has a newer revision (rev. 1 → 2)")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: /update…/i }));
    const dialog = await screen.findByRole("dialog");
    expect(await within(dialog).findByText(/only the new revision is recorded/i)).toBeInTheDocument();
  });

  it("offers no pull once an attempt exists, nor without a template", () => {
    mockFetch({});
    const { unmount } = render(
      withEvaluation({ originRevision: 1 }, { templateRevision: 2, attemptCount: 1 }),
    );
    expect(screen.queryByText(/newer revision/i)).not.toBeInTheDocument();
    unmount();
    render(withEvaluation({ originRevision: 1 }, { templateRevision: null }));
    expect(screen.queryByText(/newer revision/i)).not.toBeInTheDocument();
  });

  it("names negative marking and SEB only in the modes the server honours them", () => {
    mockFetch({});
    const settings = {
      ...makeEvaluationDetail().evaluation.settings,
      negativeMarking: true,
      safeExamBrowser: true,
    };
    const { unmount } = render(withEvaluation({ settings }));
    expect(screen.getByText(/negative marking/i)).toBeInTheDocument();
    expect(screen.getByText(/safe exam browser/i)).toBeInTheDocument();
    unmount();
    // A poll ignores both switches.
    render(withEvaluation({ mode: "poll", settings }));
    expect(screen.queryByText(/negative marking/i)).toBeNull();
    expect(screen.queryByText(/safe exam browser/i)).toBeNull();
  });

  it("warns on an empty roster, and blocks on a common end already past (#178)", async () => {
    mockFetch({});
    const past = {
      settings: { ...makeEvaluationDetail().evaluation.settings, timing: "deadline" as const },
      opensAt: new Date(Date.now() - 2 * HOUR).toISOString(),
      closesAt: new Date(Date.now() - HOUR).toISOString(),
    };
    const { unmount } = render(
      withEvaluation(past, { roster: { enrolled: 0, unlinked: 0, conflicts: 0 } }),
    );
    // The server refuses to open it: a blocker, not a warning.
    expect(screen.getByRole("heading", { name: /not ready yet/i })).toBeInTheDocument();
    expect(screen.getByText(/nobody in the classroom yet/i)).toBeInTheDocument();
    expect(screen.getByText(/the common end has passed/i)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /open the waiting room/i })).toBeDisabled();
    unmount();

    // Scheduled, its dates cannot be moved one at a time: the row points to
    // "Back to draft", not to the timing step.
    render(withEvaluation({ ...past, state: "scheduled" }));
    // In the row and in the status line of the action bar.
    expect(screen.getAllByText(/go back to draft to choose new dates/i)).toHaveLength(2);
    expect(screen.getByRole("button", { name: /^back to draft$/i })).toBeEnabled();
  });

  it("blocks when every question is a bonus, as the server does (ADR-052)", () => {
    mockFetch({});
    render(
      makeEvaluationDetail({
        items: [{ ...makeItemRow(0), bonus: true }],
        totalPoints: 0,
      }),
    );
    expect(screen.getByText(/no question counts towards the total/i)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /open the waiting room/i })).toBeDisabled();
  });

  it("sends a row to the step or the roster that fixes it", async () => {
    const user = userEvent.setup();
    mockFetch({});
    render(makeEvaluationDetail());
    await user.click(screen.getByRole("button", { name: /24 expected in the room/i }));
    expect(navigate).toHaveBeenCalledWith({
      view: "classroom",
      id: makeEvaluationDetail().evaluation.classroomId,
      tab: "roster",
    });
    await user.click(screen.getByRole("button", { name: /2 questions/i }));
    expect(onStep).toHaveBeenCalledWith("questions");
  });

  it("opens the evaluation itself when there is no waiting room", async () => {
    const user = userEvent.setup();
    const { calls } = mockFetch({ [`POST ${BASE}/start`]: ok({}) });
    render(
      withEvaluation({
        mode: "exercise",
        settings: { ...makeEvaluationDetail().evaluation.settings, lobby: "skip" },
      }),
    );
    expect(screen.queryByRole("button", { name: /open the waiting room/i })).toBeNull();
    await user.click(screen.getByRole("button", { name: /^open$/i }));
    await waitFor(() =>
      expect(calls.find((c) => c.url.endsWith("/start"))).toMatchObject({ body: { confirm: true } }),
    );
    expect(calls.some((c) => c.url.endsWith("/state"))).toBe(false);
  });

  it("says a scheduled evaluation opens by itself, and takes it back to draft", async () => {
    const user = userEvent.setup();
    const { calls } = mockFetch({ [`POST ${BASE}/state`]: ok({}) });
    render(withEvaluation({ state: "scheduled", opensAt: new Date(Date.now() + 24 * HOUR).toISOString() }));
    expect(screen.getByRole("status")).toHaveTextContent(/opens by itself on/i);
    await user.click(screen.getByRole("button", { name: /^back to draft$/i }));
    await waitFor(() =>
      expect(calls.find((c) => c.url.endsWith("/state"))).toMatchObject({ body: { to: "draft" } }),
    );
  });
});

describe("the waiting-room preview (#152)", () => {
  it("draws the student's waiting room without opening its stream", () => {
    const streams = vi.fn();
    vi.stubGlobal("EventSource", streams);
    mockFetch({});
    const detail = makeEvaluationDetail();
    render(detail);
    const preview = screen.getByRole("complementary", { name: /what students will see/i });
    expect(within(preview).getByText(detail.evaluation.title)).toBeInTheDocument();
    // Nobody is present yet, out of the roster the launch step counts.
    expect(within(preview).getByRole("img", { name: /0 .*24/ })).toBeInTheDocument();
    // A staff seat watching `lobby:` would be counted present (ADR-018).
    expect(streams).not.toHaveBeenCalled();
    // Rules only: no question of the evaluation is named in it.
    for (const item of detail.items) {
      expect(preview.textContent).not.toContain(item.internalName);
    }
    vi.unstubAllGlobals();
  });

  it("has nothing to preview without a waiting room", () => {
    mockFetch({});
    render(
      withEvaluation({
        mode: "exercise",
        settings: { ...makeEvaluationDetail().evaluation.settings, lobby: "skip" },
      }),
    );
    expect(screen.queryByRole("complementary", { name: /what students will see/i })).toBeNull();
    expect(screen.queryByRole("button", { name: /what students will see/i })).toBeNull();
  });

  it("opens the same picture in a sheet from the phone row", async () => {
    const user = userEvent.setup();
    mockFetch({});
    render(makeEvaluationDetail());
    await user.click(screen.getByRole("button", { name: /what students will see/i }));
    const sheet = await screen.findByRole("dialog", { name: /what students will see/i });
    expect(within(sheet).getByText(makeEvaluationDetail().evaluation.title)).toBeInTheDocument();
  });
});

describe("Schedule… (#152)", () => {
  it("writes the opening time, then schedules", async () => {
    const user = userEvent.setup();
    const { calls } = mockFetch({
      [`PATCH ${BASE}`]: ok(makeEvaluationDetail()),
      [`POST ${BASE}/state`]: ok({}),
    });
    render(makeEvaluationDetail());
    await user.click(screen.getByRole("button", { name: /schedule/i }));
    const dialog = await screen.findByRole("dialog", { name: /schedule the opening/i });
    const when = new Date(Date.now() + 48 * HOUR);
    when.setSeconds(0, 0);
    const input = within(dialog).getByLabelText(/opens at/i);
    await user.clear(input);
    await user.type(input, toLocalInput(when.toISOString()));
    await user.click(within(dialog).getByRole("button", { name: /^schedule$/i }));

    await waitFor(() => expect(calls.some((c) => c.url.endsWith("/state"))).toBe(true));
    const writes = calls.filter((c) => c.method !== "GET");
    expect(writes[0]).toMatchObject({ method: "PATCH", body: { opensAt: when.toISOString() } });
    expect(writes[1]).toMatchObject({ method: "POST", body: { to: "scheduled" } });
  });

  it("shows the opening time of a common end read-only, and leads to the timing to change it", async () => {
    const user = userEvent.setup();
    mockFetch({});
    render(
      withEvaluation({
        settings: { ...makeEvaluationDetail().evaluation.settings, timing: "deadline" },
        opensAt: new Date(Date.now() - HOUR).toISOString(),
        closesAt: new Date(Date.now() + 2 * HOUR).toISOString(),
      }),
    );
    await user.click(screen.getByRole("button", { name: /schedule/i }));
    const dialog = await screen.findByRole("dialog", { name: /schedule the opening/i });
    expect(within(dialog).queryByRole("textbox")).toBeNull();
    // Already past: scheduling it would open it at the next tick.
    expect(within(dialog).getByText(/this time has passed/i)).toBeInTheDocument();
    expect(within(dialog).getByRole("button", { name: /^schedule$/i })).toBeDisabled();
    await user.click(within(dialog).getByRole("button", { name: /change it in time and mode/i }));
    expect(onStep).toHaveBeenCalledWith("timing");
  });

  it("translates the server's refusal of a schedule without an opening time", async () => {
    const user = userEvent.setup();
    mockFetch({
      [`POST ${BASE}/state`]: fail(409, {
        error: "illegal_transition",
        message: "a scheduled evaluation needs an opening time",
        reason: "opens_at_missing",
      }),
    });
    const opensAt = new Date(Date.now() + 24 * HOUR).toISOString();
    render(withEvaluation({ opensAt }));
    await user.click(screen.getByRole("button", { name: /schedule/i }));
    const dialog = await screen.findByRole("dialog", { name: /schedule the opening/i });
    await user.click(within(dialog).getByRole("button", { name: /^schedule$/i }));
    expect(await within(dialog).findByText(/choose when it opens/i)).toBeInTheDocument();
  });

  it("translates the server's refusal of a common end its clock says has passed (#178)", async () => {
    const user = userEvent.setup();
    mockFetch({
      [`POST ${BASE}/state`]: fail(409, {
        error: "illegal_transition",
        message: "the common end has already passed",
        reason: "closes_at_past",
      }),
    });
    const opensAt = new Date(Date.now() + 24 * HOUR).toISOString();
    render(withEvaluation({ opensAt }));
    await user.click(screen.getByRole("button", { name: /schedule/i }));
    const dialog = await screen.findByRole("dialog", { name: /schedule the opening/i });
    await user.click(within(dialog).getByRole("button", { name: /^schedule$/i }));
    expect(await within(dialog).findByText(/the common end has passed/i)).toBeInTheDocument();
  });
});
