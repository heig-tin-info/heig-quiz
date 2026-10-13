import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import type { EvaluationSummary } from "@quiz/contracts";

import { makeCourseSummary } from "../test/fixtures";
import { EVALUATION_ID, id, liveAt } from "../test/live-fixtures";
import { mockFetch, ok, renderWithProviders } from "../test/render";
import { isoDateTime } from "../ui";
import { ClassroomActivities } from "../ClassroomActivities";
import { NewEvaluationModal } from "./EvaluationList";

/*
 * The list on the classroom page: the badges, the one primary action, and
 * where a row click lands — the dashboard for a quiz with students in it, the
 * configuration for one that is still being written.
 */

const CLASSROOM = id("classroom", 1);

function summary(over: Partial<EvaluationSummary> = {}): EvaluationSummary {
  return {
    id: EVALUATION_ID,
    classroomId: CLASSROOM,
    title: "Quiz 3",
    mode: "exam",
    state: "draft",
    itemCount: 4,
    totalPoints: 7,
    attemptCount: 0,
    participantCount: 0,
    deletionRole: "assistant",
    opensAt: null,
    closesAt: null,
    startedAt: null,
    createdAt: liveAt(-3600_000),
    originRevision: null,
    templateRevision: null,
    ...over,
  };
}

const list = (rows: EvaluationSummary[]) => ({
  [`GET /app/api/classrooms/${CLASSROOM}/evaluations`]: ok(rows),
});

describe("the evaluations of the Activities tab", () => {
  it("shows one badge per state: the time left inside a running one, an outline for a released one (ADR-104)", async () => {
    mockFetch(
      list([
        summary({ state: "draft" }),
        summary({ id: id("evaluation", 2), state: "running", title: "Quiz 4", closesAt: liveAt(3 * 3600_000 + 30_000) }),
        summary({ id: id("evaluation", 3), state: "lobby", title: "Quiz 5", closesAt: liveAt(3600_000) }),
        summary({ id: id("evaluation", 4), state: "released", title: "Quiz 2" }),
      ]),
    );
    renderWithProviders(<ClassroomActivities classroomId={CLASSROOM} navigate={vi.fn()} doors={{ onNew: vi.fn() }} />);
    expect(await screen.findByText("draft")).toBeInTheDocument();
    // The timer is in the pill, named for a screen reader; a lobby's clock
    // has not started, so it gets none.
    const running = screen.getByText("running").closest("span")!;
    expect(within(running).getByText("3 h")).toBeInTheDocument();
    expect(within(running).getByText("closes in 3 h")).toBeInTheDocument();
    expect(within(screen.getByText("lobby").closest("span")!).queryByText(/closes in/)).toBeNull();
    // Released: finished, nothing awaited — the outline face.
    expect(screen.getByText("released").className).toContain("ring-current");
  });

  it("tells a scheduled one from a draft in blue, and says when each starts (#786, #795)", async () => {
    const opensAt = "2026-11-02T08:00:00.000Z";
    const closesAt = "2026-11-09T22:00:00.000Z";
    mockFetch(
      list([
        summary({ state: "draft", title: "Being written" }),
        summary({ id: id("evaluation", 2), state: "scheduled", title: "Planned", opensAt, closesAt }),
        // Opened by hand: no opensAt, only the start of its run.
        summary({ id: id("evaluation", 3), state: "running", title: "By hand", startedAt: "2026-10-13T09:15:00.000Z" }),
      ]),
    );
    renderWithProviders(<ClassroomActivities classroomId={CLASSROOM} navigate={vi.fn()} doors={{ onNew: vi.fn() }} />);
    const row = async (title: string) => within((await screen.findByText(title)).closest("tr")!);
    const planned = await row("Planned");
    expect(planned.getByText("scheduled").className).toContain("text-info");
    expect(planned.getByText(isoDateTime(opensAt))).toBeInTheDocument();
    // And when it ends, as a project says its deadline (#787).
    expect(planned.getByText(isoDateTime(closesAt))).toBeInTheDocument();
    expect((await row("By hand")).getByText(isoDateTime("2026-10-13T09:15:00.000Z"))).toBeInTheDocument();
    const draft = await row("Being written");
    expect(draft.getByText("draft").className).not.toContain("text-info");
    // Never scheduled: a dash where the time would be.
    expect(draft.queryByText(/\d{2}:\d{2}/)).toBeNull();
    expect(screen.getByRole("columnheader", { name: /Start/ })).toBeInTheDocument();
    expect(screen.getByRole("columnheader", { name: /End/ })).toBeInTheDocument();
  });

  it("opens the dashboard for a live one and the configuration for a draft", async () => {
    const user = userEvent.setup();
    const navigate = vi.fn();
    mockFetch(
      list([
        summary({ state: "draft", title: "Draft quiz" }),
        summary({ id: id("evaluation", 2), state: "running", title: "Live quiz" }),
      ]),
    );
    renderWithProviders(<ClassroomActivities classroomId={CLASSROOM} navigate={navigate} doors={{ onNew: vi.fn() }} />);

    await user.click(await screen.findByText("Draft quiz"));
    expect(navigate).toHaveBeenLastCalledWith({ view: "evaluation", id: EVALUATION_ID });
    await user.click(screen.getByText("Live quiz"));
    expect(navigate).toHaveBeenLastCalledWith({ view: "live", id: id("evaluation", 2) });
  });

  // WP10: the second half of an evaluation's life.
  it("sends a closed one to the grading and a published one to the results", async () => {
    const user = userEvent.setup();
    const navigate = vi.fn();
    mockFetch(
      list([
        summary({ state: "closed", title: "Closed quiz", attemptCount: 12 }),
        summary({ id: id("evaluation", 2), state: "released", title: "Published quiz" }),
      ]),
    );
    renderWithProviders(<ClassroomActivities classroomId={CLASSROOM} navigate={navigate} doors={{ onNew: vi.fn() }} />);

    await user.click(await screen.findByText("Closed quiz"));
    expect(navigate).toHaveBeenLastCalledWith({ view: "grading", evaluationId: EVALUATION_ID });
    await user.click(screen.getByText("Published quiz"));
    expect(navigate).toHaveBeenLastCalledWith({
      view: "results",
      evaluationId: id("evaluation", 2),
    });
  });

  it("offers both grading destinations in a closed row's menu, and neither in a draft's", async () => {
    const user = userEvent.setup();
    const navigate = vi.fn();
    mockFetch(
      list([
        summary({ state: "closed", title: "Closed quiz" }),
        summary({ id: id("evaluation", 2), state: "draft", title: "Draft quiz" }),
      ]),
    );
    renderWithProviders(<ClassroomActivities classroomId={CLASSROOM} navigate={navigate} doors={{ onNew: vi.fn() }} />);

    await user.click(await screen.findByRole("button", { name: /Closed quiz/ }));
    expect(await screen.findByRole("menuitem", { name: "Results" })).toBeInTheDocument();
    await user.click(screen.getByRole("menuitem", { name: "Grading" }));
    expect(navigate).toHaveBeenLastCalledWith({ view: "grading", evaluationId: EVALUATION_ID });

    await user.click(screen.getByRole("button", { name: /Draft quiz/ }));
    await waitFor(() => expect(screen.getByRole("menu")).toBeInTheDocument());
    expect(screen.queryByRole("menuitem", { name: "Grading" })).not.toBeInTheDocument();
    expect(screen.queryByRole("menuitem", { name: "Results" })).not.toBeInTheDocument();
  });

  it("greys out Delete for an assistant where only a teacher of the course may delete, saying why (ADR-068 §3)", async () => {
    const user = userEvent.setup();
    const course = id("course", 1);
    mockFetch({
      [`GET /app/api/classrooms/${CLASSROOM}`]: ok({
        id: CLASSROOM,
        name: "A",
        period: "",
        archivedAt: null,
        course: { id: course, name: "Programmation C", code: "PRG1" },
        roster: [],
      }),
      "GET /app/api/courses": ok([makeCourseSummary({ id: course, myRole: "assistant" })]),
      ...list([
        summary({ state: "released", title: "Released quiz", deletionRole: "owner" }),
        summary({ id: id("evaluation", 2), title: "Draft quiz" }),
      ]),
    });
    renderWithProviders(<ClassroomActivities classroomId={CLASSROOM} navigate={vi.fn()} doors={{ onNew: vi.fn() }} />);

    await user.click(await screen.findByRole("button", { name: /Released quiz/ }));
    const refused = await screen.findByRole("menuitem", { name: /Delete evaluation/ });
    await waitFor(() => expect(refused).toBeDisabled());
    expect(refused).toHaveTextContent("only a teacher of the course may delete it");

    await user.keyboard("{Escape}");
    await user.click(screen.getByRole("button", { name: /Draft quiz/ }));
    expect(await screen.findByRole("menuitem", { name: "Delete evaluation" })).toBeEnabled();
  });

  it("asks the page for the dialog from the empty state, and has no button of its own", async () => {
    const user = userEvent.setup();
    const onNew = vi.fn();
    mockFetch(list([]));
    const { unmount } = renderWithProviders(
      <ClassroomActivities classroomId={CLASSROOM} navigate={vi.fn()} doors={{ onNew }} />,
    );
    await user.click(await screen.findByRole("button", { name: /new evaluation/i }));
    expect(onNew).toHaveBeenCalledOnce();
    unmount();

    // With rows, "New evaluation" is the page header's (#295), not the list's.
    mockFetch(list([summary()]));
    renderWithProviders(<ClassroomActivities classroomId={CLASSROOM} navigate={vi.fn()} doors={{ onNew }} />);
    await screen.findByText("Quiz 3");
    expect(screen.queryByRole("button", { name: /new evaluation/i })).toBeNull();
  });

  it("offers the new project beside it in the empty state, only when it has a door", async () => {
    const user = userEvent.setup();
    const onSelect = vi.fn();
    mockFetch(list([]));
    const { unmount } = renderWithProviders(
      <ClassroomActivities classroomId={CLASSROOM} navigate={vi.fn()} doors={{ onNew: vi.fn(), newProject: { onSelect } }} />,
    );
    await user.click(await screen.findByRole("button", { name: /new project/i }));
    expect(onSelect).toHaveBeenCalledOnce();
    unmount();

    mockFetch(list([]));
    renderWithProviders(<ClassroomActivities classroomId={CLASSROOM} navigate={vi.fn()} doors={{ onNew: vi.fn(), newProject: null }} />);
    await screen.findByRole("button", { name: /new evaluation/i });
    expect(screen.queryByRole("button", { name: /new project/i })).toBeNull();
  });

  it("creates one from the dialog and hands its id over", async () => {
    const user = userEvent.setup();
    const onCreated = vi.fn();
    const { calls } = mockFetch({
      [`POST /app/api/classrooms/${CLASSROOM}/evaluations`]: ok(summary()),
    });
    renderWithProviders(
      <NewEvaluationModal classroomId={CLASSROOM} onClose={vi.fn()} onCreated={onCreated} />,
    );

    const dialog = await screen.findByRole("dialog");
    await user.type(within(dialog).getByLabelText(/title/i), "Quiz 5");
    await user.click(within(dialog).getByRole("button", { name: /create evaluation/i }));

    await waitFor(() =>
      expect(calls.find((c) => c.method === "POST")).toMatchObject({
        body: { title: "Quiz 5", mode: "exam", preset: "exam" },
      }),
    );
    await waitFor(() => expect(onCreated).toHaveBeenCalledWith(EVALUATION_ID));
  });

  it("stands in the server's order until a column label is clicked", async () => {
    const user = userEvent.setup();
    mockFetch(
      list([
        summary({ title: "Zebra", state: "draft" }),
        summary({ id: id("evaluation", 2), title: "Alpha", state: "closed" }),
      ]),
    );
    renderWithProviders(<ClassroomActivities classroomId={CLASSROOM} navigate={vi.fn()} doors={{ onNew: vi.fn() }} />);
    await screen.findByText("Zebra");

    // The list arrives the way the classroom works through it, and stays there.
    const titles = () =>
      screen
        .getAllByRole("row")
        .slice(1)
        .map((row) => within(row).getAllByRole("cell")[0]?.textContent ?? "");
    expect(titles()[0]).toContain("Zebra");

    await user.click(screen.getByRole("button", { name: "Title" }));
    expect(titles()[0]).toContain("Alpha");
    expect(screen.getByRole("columnheader", { name: "Title" })).toHaveAttribute(
      "aria-sort",
      "ascending",
    );
  });

  it("offers no layout switch for a single evaluation", async () => {
    mockFetch(list([summary()]));
    renderWithProviders(<ClassroomActivities classroomId={CLASSROOM} navigate={vi.fn()} doors={{ onNew: vi.fn() }} />);
    await screen.findByText("Quiz 3");
    expect(screen.queryByRole("radiogroup", { name: "Layout" })).toBeNull();
  });

  it("renders the empty and the failed states", async () => {
    mockFetch(list([]));
    const { unmount } = renderWithProviders(
      <ClassroomActivities classroomId={CLASSROOM} navigate={vi.fn()} doors={{ onNew: vi.fn() }} />,
    );
    expect(await screen.findByText(/no evaluation yet/i)).toBeInTheDocument();
    unmount();

    mockFetch({});
    renderWithProviders(<ClassroomActivities classroomId={CLASSROOM} navigate={vi.fn()} doors={{ onNew: vi.fn() }} />);
    expect(await screen.findByText(/evaluation not found/i)).toBeInTheDocument();
  });

  // ADR-031: "Start from" exists only when the course has a template.
  describe("start from a template", () => {
    const COURSE = id("course", 1);
    const TEMPLATE = id("template", 1);
    const classroom = {
      [`GET /app/api/classrooms/${CLASSROOM}`]: ok({
        id: CLASSROOM,
        name: "A",
        period: "",
        archivedAt: null,
        course: { id: COURSE, name: "Programmation C", code: "PRG1" },
        roster: [],
      }),
    };
    const template = {
      id: TEMPLATE,
      courseId: COURSE,
      title: "Final exam",
      mode: "exam",
      revision: 2,
      itemCount: 3,
      totalPoints: 6,
    };

    it("saves a row as a template from its menu, never a poll's", async () => {
      const user = userEvent.setup();
      const { calls } = mockFetch({
        ...classroom,
        ...list([
          summary({ state: "closed", title: "Closed quiz" }),
          summary({ id: id("evaluation", 2), mode: "poll", state: "closed", title: "A poll" }),
        ]),
        [`POST /app/api/evaluations/${EVALUATION_ID}/template`]: ok(template),
      });
      renderWithProviders(<ClassroomActivities classroomId={CLASSROOM} navigate={vi.fn()} doors={{ onNew: vi.fn() }} />);

      await user.click(await screen.findByRole("button", { name: /A poll/ }));
      await waitFor(() => expect(screen.getByRole("menu")).toBeInTheDocument());
      expect(screen.queryByRole("menuitem", { name: "Save as template" })).not.toBeInTheDocument();

      await user.click(screen.getByRole("button", { name: /Closed quiz/ }));
      await user.click(await screen.findByRole("menuitem", { name: "Save as template" }));
      const dialog = await screen.findByRole("dialog", { name: /Programmation C/ });
      await user.click(within(dialog).getByRole("button", { name: "Save as template" }));
      await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
      expect(calls).toContainEqual({
        url: `/app/api/evaluations/${EVALUATION_ID}/template`,
        method: "POST",
        body: { title: "Closed quiz" },
      });
    });

    it("leaves the dialog unchanged when the course has none", async () => {
      const user = userEvent.setup();
      mockFetch({
        ...classroom,
        [`GET /app/api/courses/${COURSE}/templates`]: ok([]),
      });
      renderWithProviders(
        <NewEvaluationModal classroomId={CLASSROOM} onClose={vi.fn()} onCreated={vi.fn()} />,
      );
      const dialog = await screen.findByRole("dialog");
      expect(within(dialog).queryByLabelText("Start from")).not.toBeInTheDocument();
      expect(within(dialog).getByText("Mode")).toBeInTheDocument();
    });

    it("instantiates the chosen template and opens the new evaluation", async () => {
      const user = userEvent.setup();
      const onCreated = vi.fn();
      const created = id("evaluation", 9);
      const { calls } = mockFetch({
        ...classroom,
        [`GET /app/api/courses/${COURSE}/templates`]: ok([template]),
        [`POST /app/api/templates/${TEMPLATE}/instances`]: {
          status: 201,
          body: { evaluation: { id: created }, deprecatedItems: [] },
        },
      });
      renderWithProviders(
        <NewEvaluationModal classroomId={CLASSROOM} onClose={vi.fn()} onCreated={onCreated} />,
      );
      const select = await screen.findByLabelText("Start from");
      await user.selectOptions(select, TEMPLATE);
      const dialog = screen.getByRole("dialog");
      expect(within(dialog).getByRole("textbox")).toHaveValue("Final exam");
      // The choice is the template's, shown read-only (ADR-092).
      expect(within(dialog).queryByText("Mode")).not.toBeInTheDocument();
      expect(within(dialog).queryByRole("radiogroup")).not.toBeInTheDocument();
      expect(within(dialog).getByText(/mode included \(Exam, which you can change afterwards/)).toBeInTheDocument();
      await user.click(screen.getByRole("button", { name: "Create evaluation" }));
      await waitFor(() => expect(onCreated).toHaveBeenCalledWith(created));
      const post = calls.find((c) => c.method === "POST");
      expect(post?.body).toEqual({ classroomId: CLASSROOM, title: "Final exam" });
    });
  });

  // F-EVAL-26: the badge is the pull's door, shown only where the pull is accepted.
  describe("behind its template", () => {
    const BEHIND = { originRevision: 1, templateRevision: 3 };
    const PULL = `/app/api/evaluations/${EVALUATION_ID}/pull-template`;
    const item = (position: number, name: string, extra: Record<string, unknown> = {}) => ({
      position,
      questionId: id("question", position),
      internalName: name,
      versionNumber: 1,
      points: 2,
      milestone: false,
      ...extra,
    });
    const preview = {
      templateId: id("template", 1),
      templateTitle: "Final exam",
      from: 1,
      to: 3,
      added: [item(3, "loops")],
      removed: [item(4, "local-extra")],
      changed: [{ from: item(0, "sizeof-ptr"), to: item(0, "sizeof-ptr", { points: 3, versionNumber: 2 }) }],
      reordered: true,
      deprecatedItems: [],
      unlinkedItems: [],
    };

    it("shows the badge only on a pullable row that is behind", async () => {
      mockFetch(
        list([
          summary({ title: "Behind draft", ...BEHIND }),
          summary({ id: id("evaluation", 2), title: "Up to date", originRevision: 3, templateRevision: 3 }),
          summary({ id: id("evaluation", 3), title: "Behind but taken", attemptCount: 1, ...BEHIND }),
          summary({ id: id("evaluation", 4), title: "Behind but open", state: "lobby", ...BEHIND }),
          summary({ id: id("evaluation", 5), title: "Scheduled behind", state: "scheduled", ...BEHIND }),
        ]),
      );
      renderWithProviders(<ClassroomActivities classroomId={CLASSROOM} navigate={vi.fn()} doors={{ onNew: vi.fn() }} />);
      await screen.findByText("Behind draft");
      const badges = screen.getAllByRole("button", { name: /from its template/i });
      expect(badges.map((b) => b.getAttribute("aria-label"))).toEqual([
        "Update “Behind draft” from its template (rev. 1 → 3)",
        "Update “Scheduled behind” from its template (rev. 1 → 3)",
      ]);
      expect(badges[0]).toHaveTextContent("template rev. 1 → 3");
    });

    it("confirms with the two-way summary, pulls, and loses the badge", async () => {
      const user = userEvent.setup();
      const navigate = vi.fn();
      let pulled = false;
      const { calls } = mockFetch({
        [`GET /app/api/classrooms/${CLASSROOM}/evaluations`]: () =>
          ok([summary({ title: "Behind draft", ...BEHIND, ...(pulled ? { originRevision: 3 } : {}) })]),
        [`GET ${PULL}`]: ok(preview),
        [`POST ${PULL}`]: () => {
          pulled = true;
          return ok({ detail: {}, deprecatedItems: [] });
        },
      });
      renderWithProviders(<ClassroomActivities classroomId={CLASSROOM} navigate={navigate} doors={{ onNew: vi.fn() }} />);

      await user.click(await screen.findByRole("button", { name: /from its template/i }));
      // The badge opens the confirmation, not the evaluation.
      expect(navigate).not.toHaveBeenCalled();
      const dialog = await screen.findByRole("dialog");
      expect(within(dialog).getByText("rev. 1 → 3")).toBeInTheDocument();
      expect(within(dialog).getByText("Added (1): loops")).toBeInTheDocument();
      expect(within(dialog).getByText("Removed (1): local-extra")).toBeInTheDocument();
      expect(within(dialog).getByText("Changed (1): sizeof-ptr (v1 → v2, 2 → 3 pts)")).toBeInTheDocument();
      expect(within(dialog).getByText(/order of the questions changes/i)).toBeInTheDocument();
      expect(within(dialog).getByText(/are replaced/i)).toBeInTheDocument();

      await user.click(within(dialog).getByRole("button", { name: "Replace questions" }));
      await waitFor(() =>
        expect(calls.find((c) => c.method === "POST")).toMatchObject({ url: PULL, body: { revision: 3 } }),
      );
      await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
      await waitFor(() =>
        expect(screen.queryByRole("button", { name: /from its template/i })).not.toBeInTheDocument(),
      );
    });

    it("says only the revision is recorded when no question differs, and refuses an unlinked pool", async () => {
      const user = userEvent.setup();
      mockFetch({
        ...list([summary({ title: "Behind draft", ...BEHIND })]),
        [`GET ${PULL}`]: ok({
          ...preview,
          added: [],
          removed: [],
          changed: [],
          reordered: false,
          unlinkedItems: [{ position: 0, questionId: id("question", 0), internalName: "sizeof-ptr" }],
        }),
      });
      renderWithProviders(<ClassroomActivities classroomId={CLASSROOM} navigate={vi.fn()} doors={{ onNew: vi.fn() }} />);
      await user.click(await screen.findByRole("button", { name: /from its template/i }));
      const dialog = await screen.findByRole("dialog");
      expect(await within(dialog).findByText(/only the new revision is recorded/i)).toBeInTheDocument();
      expect(within(dialog).getByText(/no longer linked to the course: sizeof-ptr/i)).toBeInTheDocument();
      expect(within(dialog).getByRole("button", { name: "Record revision" })).toBeDisabled();
    });
  });
});

describe("Rename from a row's menu (#804)", () => {
  it("renames a running exam and a poll through the heading's PATCH, and the list updates", async () => {
    const user = userEvent.setup();
    let titles = { exam: "Quiz 3", poll: "A very long poll title that the list truncates" };
    const { calls } = mockFetch({
      [`GET /app/api/classrooms/${CLASSROOM}/evaluations`]: () =>
        ok([
          summary({ state: "running", title: titles.exam }),
          summary({ id: id("evaluation", 2), mode: "poll", state: "closed", title: titles.poll }),
        ]),
      [`PATCH /app/api/evaluations/${EVALUATION_ID}`]: (call) => {
        titles = { ...titles, exam: (call.body as { title: string }).title };
        return ok({});
      },
      [`PATCH /app/api/evaluations/${id("evaluation", 2)}`]: (call) => {
        titles = { ...titles, poll: (call.body as { title: string }).title };
        return ok({});
      },
    });
    renderWithProviders(<ClassroomActivities classroomId={CLASSROOM} navigate={vi.fn()} doors={{ onNew: vi.fn() }} />);

    await user.click(await screen.findByRole("button", { name: /Quiz 3/ }));
    await user.click(await screen.findByRole("menuitem", { name: "Rename" }));
    const dialog = await screen.findByRole("dialog", { name: "Rename evaluation: Quiz 3" });
    const field = within(dialog).getByRole("textbox", { name: "Title" });
    const submit = within(dialog).getByRole("button", { name: "Rename" });
    // Prefilled, and nothing to save until it changes; blanks are refused by the schema.
    expect(field).toHaveValue("Quiz 3");
    expect(submit).toBeDisabled();
    await user.clear(field);
    await user.type(field, "   ");
    expect(submit).toBeDisabled();
    await user.clear(field);
    await user.type(field, "  Quiz 3 (retake)  {Enter}");
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    expect(calls).toContainEqual({
      url: `/app/api/evaluations/${EVALUATION_ID}`,
      method: "PATCH",
      body: { title: "Quiz 3 (retake)" },
    });
    expect(await screen.findByText("Quiz 3 (retake)")).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: /A very long poll/ }));
    await user.click(await screen.findByRole("menuitem", { name: "Rename" }));
    const pollDialog = await screen.findByRole("dialog", { name: /Rename evaluation: A very long/ });
    const pollField = within(pollDialog).getByRole("textbox", { name: "Title" });
    await user.clear(pollField);
    await user.type(pollField, "Short poll");
    await user.click(within(pollDialog).getByRole("button", { name: "Rename" }));
    expect(await screen.findByText("Short poll")).toBeInTheDocument();
  });

  it("keeps the dialog open and says the server's refusal", async () => {
    const user = userEvent.setup();
    mockFetch({
      ...list([summary({ title: "Quiz 3" })]),
      [`PATCH /app/api/evaluations/${EVALUATION_ID}`]: { status: 409, body: { message: "Refused by the server" } },
    });
    renderWithProviders(<ClassroomActivities classroomId={CLASSROOM} navigate={vi.fn()} doors={{ onNew: vi.fn() }} />);
    await user.click(await screen.findByRole("button", { name: /Quiz 3/ }));
    await user.click(await screen.findByRole("menuitem", { name: "Rename" }));
    const dialog = await screen.findByRole("dialog", { name: /Rename evaluation/ });
    await user.type(within(dialog).getByRole("textbox", { name: "Title" }), " bis");
    await user.click(within(dialog).getByRole("button", { name: "Rename" }));
    expect(await screen.findByText("Refused by the server")).toBeInTheDocument();
    expect(screen.getByRole("dialog", { name: /Rename evaluation/ })).toBeInTheDocument();
  });
});
