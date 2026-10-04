import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import type { ProjectDetail } from "@quiz/contracts";

import {
  AHEAD,
  BASE,
  CLASSROOM_ID,
  makeCheckpoint,
  makeDraft,
  makeProject,
  makeRepo,
  makeRunList,
  PAST,
  row,
} from "../test/project-fixtures";
import { fail, makeQueryClient, mockFetch, noContent, ok, renderWithProviders, type RouteHandler } from "../test/render";
import { ProjectPage } from "./ProjectPage";

/*
 * The project page (F-PROJ-13, M3-12): its states, the one primary action the
 * server names — Publish a button, Release and Sync a sentence, none no
 * accent —, Publish's 409 with its names, archive and delete with their
 * confirmations, the edits as one PATCH each, the reopen asked first, the
 * table's flags, the row's sheet with its runs and its deadline and lock,
 * the checkpoints, the refetch rules, and the French of it all.
 */

const ROOM = `/app/api/classrooms/${CLASSROOM_ID}`;

/** The page's routes: `project` is the detail served, or a reply / handler of its own. */
function routes(project: ProjectDetail | RouteHandler, extra: Record<string, RouteHandler> = {}) {
  const detail: RouteHandler =
    typeof project === "function" ? project : "status" in project ? project : ok(project);
  return mockFetch({
    [`GET ${BASE}`]: detail,
    [`GET ${ROOM}`]: ok({ id: CLASSROOM_ID, name: "PRG1-2026", course: { id: "c1", code: "PRG1", name: "C" }, roster: [] }),
    [`GET ${ROOM}/projects/sources/prg1-labo-02-pointeurs`]: ok({
      name: "prg1-labo-02-pointeurs",
      defaultBranch: "main",
      branches: ["main"],
      tree: [],
      truncated: false,
      suggestedProtected: ["criteria.yml", "README.md", ".github/workflows/grading.yml"],
    }),
    [`GET ${BASE}/checkpoints`]: ok([]),
    ...extra,
  });
}

function renderPage(locale: "en" | "fr" = "en") {
  const navigate = vi.fn();
  const queryClient = makeQueryClient();
  renderWithProviders(<ProjectPage id={makeProject().id} navigate={navigate} />, { locale, queryClient });
  return { navigate, queryClient };
}

const status = () => screen.getByTestId("project-status").textContent;
const writes = (calls: { method: string; url: string; body: unknown }[]) => calls.filter((c) => c.method !== "GET");

describe("the page's states", () => {
  it("shows a skeleton, then the project", async () => {
    routes(makeProject());
    renderPage();
    expect(screen.queryByRole("heading", { level: 1 })).toBeNull();
    expect(await screen.findByRole("heading", { level: 1, name: /Labo 2 — pointeurs/ })).toBeInTheDocument();
    expect(screen.getByText("published")).toBeInTheDocument();
    expect(await screen.findByText("PRG1-2026")).toBeInTheDocument();
  });

  it("says a 404 is a project that does not exist, or is not the caller's, as the classroom does", async () => {
    routes(fail(404, { message: "Not found" }));
    renderPage();
    expect(await screen.findByText("This project does not exist, or it is not open to you.")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Retry/ })).toBeInTheDocument();
  });

  it("keeps a heading and offers a retry when the read fails", async () => {
    routes(fail(500, { message: "boom" }));
    renderPage();
    expect(await screen.findByRole("heading", { level: 1, name: "Project" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Retry/ })).toBeInTheDocument();
  });

  it("shows the empty roster with the way to add students", async () => {
    routes(makeProject({ rows: [], counts: { students: 0, accepted: 0, live: 0, frozen: 0, toVerify: 0, alerts: 0 } }));
    const { navigate } = renderPage();
    expect(await screen.findByText("No student in the roster")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Add students" }));
    expect(navigate).toHaveBeenCalledWith({ view: "classroom", id: CLASSROOM_ID, tab: "roster" });
  });
});

describe("the one primary action", () => {
  it("is Publish, as a button, for a draft — and the header says the students see nothing yet", async () => {
    routes(makeDraft());
    renderPage();
    expect(await screen.findByRole("button", { name: /Publish/ })).toBeInTheDocument();
    expect(status()).toMatch(/^Draft: the students see nothing yet/);
  });

  it("is a sentence, not a button, for release and for sync (their routes come with M3-08b and M3-07)", async () => {
    routes(makeProject({ state: "locked", primaryAction: "release" }));
    renderPage();
    await screen.findByRole("heading", { level: 1 });
    expect(screen.queryByRole("button", { name: /Publish|Release|Sync/ })).toBeNull();
    expect(status()).toBe("Every repository is frozen: the scores are final and ready to be released.");
  });

  it("is nothing for an open project: the header states the situation", async () => {
    routes(makeProject());
    renderPage();
    await screen.findByRole("heading", { level: 1 });
    expect(screen.queryByRole("button", { name: /Publish/ })).toBeNull();
    expect(status()).toMatch(/^Open until /);
    // The counts, under the sentence.
    expect(screen.getByText(/2 students · 1 accepted · 0 of 1 frozen/)).toBeInTheDocument();
  });

  it("publishes, then refreshes the page and the lists", async () => {
    const { calls } = routes(makeDraft(), { [`POST ${BASE}/publish`]: ok({ id: makeProject().id }) });
    renderPage();
    await userEvent.click(await screen.findByRole("button", { name: /Publish/ }));
    await waitFor(() => expect(writes(calls)).toEqual([expect.objectContaining({ method: "POST", url: `${BASE}/publish` })]));
    expect(await screen.findByText("Project published")).toBeInTheDocument();
    // The page is read again; the classroom's lists and the Activities are
    // invalidated (refetched where mounted, which here they are not).
    await waitFor(() => expect(calls.filter((c) => c.url === BASE && c.method === "GET").length).toBeGreaterThan(1));
  });

  it("lists the students in no group when Publish is refused (409 unassigned_students)", async () => {
    routes(makeDraft(), {
      [`POST ${BASE}/publish`]: fail(409, {
        error: "unassigned_students",
        message: "2 student(s) in no group",
        students: [
          { enrollmentId: "e1", nom: "Dupont", prenom: "Alice" },
          { enrollmentId: "e2", nom: "Martin", prenom: "Benoît" },
        ],
      }),
    });
    renderPage();
    await userEvent.click(await screen.findByRole("button", { name: /Publish/ }));
    const alert = (await screen.findByText("Cannot publish: 2 students are in no group")).closest<HTMLElement>(
      "[role=status]",
    )!;
    expect(within(alert).getByText("Dupont Alice")).toBeInTheDocument();
    expect(within(alert).getByText("Martin Benoît")).toBeInTheDocument();
    // The names, no link (the groups' page comes with M3-16).
    expect(within(alert).queryByRole("link")).toBeNull();
  });
});

describe("the overflow menu", () => {
  it("archives after a confirmation, and restores an archived project without one", async () => {
    const { calls } = routes(makeProject(), { [`POST ${BASE}/archive`]: ok({}) });
    renderPage();
    await screen.findByRole("heading", { level: 1 });
    await userEvent.click(screen.getByRole("button", { name: "More actions" }));
    await userEvent.click(screen.getByRole("menuitem", { name: "Archive" }));
    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).getByText("Archive “Labo 2 — pointeurs”?")).toBeInTheDocument();
    await userEvent.click(within(dialog).getByRole("button", { name: "Archive" }));
    await waitFor(() => expect(writes(calls).map((c) => c.url)).toEqual([`${BASE}/archive`]));
  });

  it("restores an archived project, whose header says so and offers no action", async () => {
    const { calls } = routes(makeProject({ archivedAt: PAST }), { [`POST ${BASE}/unarchive`]: ok({}) });
    renderPage();
    await screen.findByRole("heading", { level: 1 });
    expect(status()).toBe("Archived.");
    await userEvent.click(screen.getByRole("button", { name: "More actions" }));
    await userEvent.click(screen.getByRole("menuitem", { name: "Restore" }));
    await waitFor(() => expect(writes(calls).map((c) => c.url)).toEqual([`${BASE}/unarchive`]));
  });

  it("deletes once the name is typed, says GitHub keeps the repositories, and goes back to the classroom", async () => {
    const { calls } = routes(makeProject(), { [`DELETE ${BASE}`]: noContent() });
    const { navigate } = renderPage();
    await screen.findByRole("heading", { level: 1 });
    await userEvent.click(screen.getByRole("button", { name: "More actions" }));
    await userEvent.click(screen.getByRole("menuitem", { name: "Delete project" }));
    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).getByText(/Nothing is deleted on GitHub/)).toBeInTheDocument();
    const confirm = within(dialog).getByRole("button", { name: "Delete" });
    expect(confirm).toBeDisabled();
    await userEvent.type(within(dialog).getByRole("textbox"), "Labo 2 — pointeurs");
    await userEvent.click(confirm);
    await waitFor(() => expect(writes(calls)).toEqual([expect.objectContaining({ method: "DELETE", url: BASE })]));
    await waitFor(() => expect(navigate).toHaveBeenCalledWith({ view: "classroom", id: CLASSROOM_ID }));
  });
});

describe("the settings", () => {
  it("renames in place through one PATCH", async () => {
    const { calls } = routes(makeProject(), { [`PATCH ${BASE}`]: ok({}) });
    renderPage();
    await userEvent.click(await screen.findByRole("button", { name: "Rename project: Labo 2 — pointeurs" }));
    const input = screen.getByRole("textbox", { name: "Name" });
    await userEvent.clear(input);
    await userEvent.type(input, "Labo 2 — pointeurs et tableaux{Enter}");
    await waitFor(() =>
      expect(writes(calls)).toEqual([
        expect.objectContaining({ method: "PATCH", url: BASE, body: { name: "Labo 2 — pointeurs et tableaux" } }),
      ]),
    );
  });

  it("writes the deadline when the field is left, the strategy on change, the protected files on a tick", async () => {
    const { calls } = routes(makeProject(), { [`PATCH ${BASE}`]: ok({}) });
    renderPage();
    const deadline = await screen.findByLabelText("Deadline");
    fireEvent.change(deadline, { target: { value: "2099-06-01T23:59" } });
    fireEvent.blur(deadline);
    await waitFor(() => expect(writes(calls)).toHaveLength(1));
    expect(writes(calls)[0]!.body).toEqual({ deadlineAt: new Date("2099-06-01T23:59").toISOString() });

    await userEvent.click(screen.getByRole("radio", { name: "Mark" }));
    await waitFor(() => expect(writes(calls)).toHaveLength(2));
    expect(writes(calls)[1]!.body).toEqual({ deadlineStrategy: "commit" });

    // The source's suggestions are offered; README.md is not protected today.
    await userEvent.click(await screen.findByRole("checkbox", { name: "README.md" }));
    await waitFor(() => expect(writes(calls)).toHaveLength(3));
    expect(writes(calls)[2]!.body).toEqual({
      protectedFiles: ["criteria.yml", ".github/workflows/grading.yml", "README.md"],
    });
  });

  it("draws what the server does not let change as disabled", async () => {
    routes(makeProject({ state: "locked", editable: ["name", "deadlineAt", "protectedFiles"] }));
    renderPage();
    await screen.findByRole("heading", { level: 1 });
    expect(screen.getByRole("radio", { name: "Lock" })).toBeDisabled();
    expect(screen.getByLabelText("Deadline")).toBeEnabled();
  });

  it("says a past deadline under the field, and puts the stored one back", async () => {
    const stored = makeProject();
    routes(stored, { [`PATCH ${BASE}`]: fail(422, { error: "deadline_past", message: "The deadline has passed" }) });
    renderPage();
    const deadline = await screen.findByLabelText("Deadline");
    fireEvent.change(deadline, { target: { value: "2020-01-01T10:00" } });
    fireEvent.blur(deadline);
    expect(await screen.findByText("This deadline has already passed.")).toBeInTheDocument();
    expect(deadline).not.toHaveValue("2020-01-01T10:00");
  });

  it("asks before a deadline that reopens the project, naming the repositories it reaches", async () => {
    const applied = makeRepo(1, { deadlineAppliedAt: PAST, frozenAt: PAST, locked: true, effectiveDeadlineAt: PAST });
    const { calls } = routes(
      makeProject({
        state: "locked",
        deadlineAt: PAST,
        deadlineAppliedAt: PAST,
        rows: [row(1, applied), row(2, makeRepo(2, { deadlineAppliedAt: PAST, effectiveDeadlineAt: PAST }))],
        editable: ["name", "deadlineAt", "protectedFiles"],
      }),
      { [`PATCH ${BASE}`]: ok({}) },
    );
    renderPage();
    const deadline = await screen.findByLabelText("Deadline");
    fireEvent.change(deadline, { target: { value: "2099-06-01T23:59" } });
    fireEvent.blur(deadline);
    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).getByText("Reopen the project?")).toBeInTheDocument();
    expect(within(dialog).getByText(/lifts the locks of 2 repositories/)).toBeInTheDocument();
    // Declined: nothing written, the stored deadline back.
    await userEvent.click(within(dialog).getByRole("button", { name: "Cancel" }));
    expect(writes(calls)).toHaveLength(0);
    expect(deadline).not.toHaveValue("2099-06-01T23:59");
    // Accepted: the one PATCH.
    fireEvent.change(deadline, { target: { value: "2099-06-01T23:59" } });
    fireEvent.blur(deadline);
    await userEvent.click(within(await screen.findByRole("dialog")).getByRole("button", { name: "Reopen" }));
    await waitFor(() => expect(writes(calls)).toHaveLength(1));
    expect(writes(calls)[0]!.body).toEqual({ deadlineAt: new Date("2099-06-01T23:59").toISOString() });
  });
});

describe("the repositories", () => {
  const flagged = makeProject({
    rows: [
      row(1, makeRepo(1)),
      row(2, makeRepo(2, { flags: { ...makeRepo(2).flags, protectionSuspended: true, toVerify: true } })),
      row(3, makeRepo(3, { flags: { ...makeRepo(3).flags, multiple: true } })),
      row(4, makeRepo(4, { flags: { ...makeRepo(4).flags, malformed: "::notice title=GRADE::huit/10" } })),
      row(5, makeRepo(5, { degraded: true, archived: true, locked: true })),
      row(6, makeRepo(6, { flags: { ...makeRepo(6).flags, changedAfterRelease: true } })),
      row(7, makeRepo(7, { flags: { ...makeRepo(7).flags, deleted: true } })),
      row(8, makeRepo(8, { deadlineAt: AHEAD, invitationStatus: "pending", lastCommit: null, ciStatus: "none" })),
      row(9, null),
      row(10, null, { claimed: false }),
      { student: { ...makeProject().rows[0]!.student, enrollmentId: null, nom: "Ancien", prenom: "Élève" }, repo: makeRepo(11) },
    ],
  });

  it("draws one row per student with the repository's state as tags", async () => {
    routes(flagged);
    renderPage();
    const table = (await screen.findByRole("region", { name: "Repositories" })).querySelector("table")!;
    const rows = within(table).getAllByRole("row").slice(1);
    expect(rows).toHaveLength(11);
    const text = (i: number) => rows[i]!.textContent!;
    expect(text(1)).toMatch(/protected files in conflict/);
    expect(text(1)).toMatch(/to verify/);
    expect(text(2)).toMatch(/several GRADE annotations/);
    expect(text(3)).toMatch(/malformed score/);
    expect(text(4)).toMatch(/locked by archiving/);
    expect(text(5)).toMatch(/modified after publication/);
    expect(text(6)).toMatch(/deleted on GitHub/);
    expect(rows[6]!.className).toMatch(/text-fg-faint/);
    expect(text(7)).toMatch(/own deadline/);
    expect(text(7)).toMatch(/invitation pending/);
    expect(text(8)).toMatch(/not accepted/);
    expect(text(9)).toMatch(/seat not claimed/);
    expect(text(10)).toMatch(/left the roster/);
    // The healthy row carries its score, grade and source.
    expect(text(0)).toMatch(/8\/10/);
    expect(text(0)).toMatch(/5\.0/);
  });

  it("warns once on the scale when a grade fell back, and says when GitHub's state is refreshing", async () => {
    routes(
      makeProject({
        liveStale: true,
        rows: [
          row(1, makeRepo(1, { scores: { ...makeRepo(1).scores, final: { points: 80, max: 100, source: "ci", toVerify: false, grade: { grade: 5, fellBack: true } } } })),
          row(2, makeRepo(2, { scores: { ...makeRepo(2).scores, final: { points: 60, max: 100, source: "ci", toVerify: false, grade: { grade: 4, fellBack: true } } } })),
        ],
      }),
    );
    renderPage();
    expect(await screen.findAllByText("Some grades use the linear scale")).toHaveLength(1);
    expect(screen.getByText("Refreshing GitHub's state…")).toBeInTheDocument();
  });

  it("opens a row's sheet with its runs, the slots marked, and writes a deadline and a lock from it", async () => {
    const repo = makeRepo(1);
    // The server's page follows the lock: the refetch after it reads the locked row.
    let locked = false;
    const { calls } = routes(() => ok(makeProject({ rows: [row(1, locked ? { ...repo, locked: true, staffLock: true } : repo), row(2, null)] })), {
      [`GET ${BASE}/repos/${repo.id}/runs`]: ok(
        makeRunList({
          runs: [
            { ...makeRunList().runs[0]!, afterDeadline: true, id: "run-3", completedAt: AHEAD },
            ...makeRunList().runs,
          ],
          currentGradeRunId: "run-2",
        }),
      ),
      [`PUT ${BASE}/repos/${repo.id}/deadline`]: ok({ ...repo, deadlineAt: AHEAD }),
      [`POST ${BASE}/repos/${repo.id}/lock`]: () => {
        locked = true;
        return ok({ ...repo, locked: true, staffLock: true });
      },
    });
    renderPage();
    await userEvent.click(await screen.findByRole("row", { name: /Martin Benoît/ }));
    const sheet = await screen.findByRole("dialog");
    expect(within(sheet).getByRole("heading", { name: "Martin Benoît" })).toBeInTheDocument();
    const runRows = (await within(sheet).findAllByRole("row")).slice(1);
    expect(runRows).toHaveLength(3);
    expect(runRows[0]!.textContent).toMatch(/after the deadline/);
    expect(runRows[1]!.textContent).toMatch(/current/);
    expect(runRows[2]!.textContent).not.toMatch(/current/);
    expect(runRows[2]!.textContent).toMatch(/4\/10/);
    // GitHub's conclusion worded, never raw.
    expect(runRows[1]!.textContent).toMatch(/success/);
    // Nothing of M3-08b yet: no score form, no resend, no re-enable.
    expect(within(sheet).queryByRole("button", { name: /Resend|Re-enable|Set the score/ })).toBeNull();

    const own = within(sheet).getByLabelText("Own deadline");
    fireEvent.change(own, { target: { value: "2099-06-01T23:59" } });
    fireEvent.blur(own);
    await waitFor(() => expect(writes(calls)).toHaveLength(1));
    expect(writes(calls)[0]).toMatchObject({
      method: "PUT",
      url: `${BASE}/repos/${repo.id}/deadline`,
      body: { deadlineAt: new Date("2099-06-01T23:59").toISOString() },
    });
    await userEvent.click(within(sheet).getByRole("button", { name: /Lock now/ }));
    await waitFor(() => expect(writes(calls)).toHaveLength(2));
    expect(writes(calls)[1]).toMatchObject({ method: "POST", url: `${BASE}/repos/${repo.id}/lock` });
    // The answer is laid over the row: the sheet now offers the unlock.
    expect(await within(sheet).findByRole("button", { name: /Unlock/ })).toBeInTheDocument();
  });

  it("offers no deadline nor lock on a deleted repository, and says why", async () => {
    const repo = makeRepo(1, { flags: { ...makeRepo(1).flags, deleted: true } });
    routes(makeProject({ rows: [row(1, repo)] }), { [`GET ${BASE}/repos/${repo.id}/runs`]: ok(makeRunList({ runs: [] })) });
    renderPage();
    await userEvent.click(await screen.findByRole("row", { name: /Martin Benoît/ }));
    const sheet = await screen.findByRole("dialog");
    expect(within(sheet).getByText(/No action on this repository/)).toBeInTheDocument();
    expect(within(sheet).getByRole("button", { name: /Lock now/ })).toBeDisabled();
    expect(within(sheet).getByLabelText("Own deadline")).toBeDisabled();
    expect(await within(sheet).findByText("No run yet")).toBeInTheDocument();
  });
});

describe("the review checkpoints", () => {
  it("lists them with their status, void included, and deletes one after a confirmation", async () => {
    const { calls } = routes(makeProject(), {
      [`GET ${BASE}/checkpoints`]: ok([
        makeCheckpoint(1, { dispatchedAt: PAST }),
        makeCheckpoint(2, { name: "late", dueAt: new Date(Date.now() + 30 * 86_400_000).toISOString(), offsetDays: null }),
        makeCheckpoint(3, { name: "soon" }),
      ]),
      [`DELETE ${BASE}/checkpoints/${makeCheckpoint(3).id}`]: noContent(),
    });
    renderPage();
    const region = await screen.findByRole("region", { name: "Review checkpoints" });
    expect(await within(region).findByText("sent", { exact: false })).toBeInTheDocument();
    expect(within(region).getByText("void")).toBeInTheDocument();
    expect(within(region).getByText("scheduled")).toBeInTheDocument();
    // The two J−7 checkpoints say so; the dated one does not.
    expect(within(region).getAllByText(/D−7/)).toHaveLength(2);
    // A sent checkpoint has no delete; the others do.
    expect(within(region).queryByRole("button", { name: "Delete checkpoint milestone-1" })).toBeNull();
    await userEvent.click(within(region).getByRole("button", { name: "Delete checkpoint soon" }));
    await userEvent.click(within(await screen.findByRole("dialog")).getByRole("button", { name: "Delete" }));
    await waitFor(() => expect(writes(calls).map((c) => c.method)).toEqual(["DELETE"]));
    expect(await screen.findByText("Checkpoint deleted")).toBeInTheDocument();
  });

  it("adds one as days before the deadline, sent as a negative offset", async () => {
    const { calls } = routes(makeProject(), { [`POST ${BASE}/checkpoints`]: ok(makeCheckpoint(1)) });
    renderPage();
    await userEvent.click(await screen.findByRole("button", { name: "Add a checkpoint" }));
    const dialog = await screen.findByRole("dialog");
    const create = within(dialog).getByRole("button", { name: "Create" });
    expect(create).toBeDisabled();
    await userEvent.type(within(dialog).getByRole("textbox", { name: "Name" }), "milestone-1");
    const days = within(dialog).getByRole("spinbutton", { name: "Days before the deadline" });
    await userEvent.clear(days);
    await userEvent.type(days, "5");
    await userEvent.click(create);
    await waitFor(() => expect(writes(calls)).toHaveLength(1));
    expect(writes(calls)[0]!.body).toEqual({ name: "milestone-1", offsetDays: -5 });
    expect(await screen.findByText("Checkpoint added")).toBeInTheDocument();
  });

  it("says a dispatched checkpoint cannot be deleted (409), and a date past the deadline on add (422)", async () => {
    routes(makeProject(), {
      [`GET ${BASE}/checkpoints`]: ok([makeCheckpoint(1)]),
      [`DELETE ${BASE}/checkpoints/${makeCheckpoint(1).id}`]: fail(409, { error: "checkpoint_dispatched", message: "" }),
      [`POST ${BASE}/checkpoints`]: fail(422, { error: "due_after_deadline", message: "" }),
    });
    renderPage();
    const region = await screen.findByRole("region", { name: "Review checkpoints" });
    await userEvent.click(await within(region).findByRole("button", { name: "Delete checkpoint milestone-1" }));
    await userEvent.click(within(await screen.findByRole("dialog")).getByRole("button", { name: "Delete" }));
    expect(await screen.findByText(/already sent to some repositories/)).toBeInTheDocument();

    await userEvent.click(screen.getByRole("button", { name: "Add a checkpoint" }));
    const dialog = await screen.findByRole("dialog");
    await userEvent.type(within(dialog).getByRole("textbox", { name: "Name" }), "late");
    await userEvent.click(within(dialog).getByRole("button", { name: "Create" }));
    expect(await within(dialog).findByText("The date must come before the project's deadline.")).toBeInTheDocument();
  });

  it("is not drawn for a project graded none: no review is ever dispatched", async () => {
    routes(makeProject({ gradingMode: "none" }));
    renderPage();
    await screen.findByRole("heading", { level: 1 });
    expect(screen.queryByRole("region", { name: "Review checkpoints" })).toBeNull();
  });
});

describe("the refetch", () => {
  it("polls every 30 s, and once 3 s after a response whose live state was stale", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      let stale = true;
      const { calls } = routes((): { status: number; body: unknown } => {
        const body = makeProject({ liveStale: stale });
        stale = false;
        return { status: 200, body };
      });
      renderPage();
      await screen.findByRole("heading", { level: 1 });
      const reads = () => calls.filter((c) => c.method === "GET" && c.url === BASE).length;
      expect(reads()).toBe(1);
      await vi.advanceTimersByTimeAsync(3_100);
      await waitFor(() => expect(reads()).toBe(2));
      // Warm now: the next one is 30 s on, not 3.
      await vi.advanceTimersByTimeAsync(10_000);
      expect(reads()).toBe(2);
      await vi.advanceTimersByTimeAsync(21_000);
      await waitFor(() => expect(reads()).toBe(3));
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("in French", () => {
  it("reads the page, its sentence and its tags in French", async () => {
    routes(makeProject({ rows: [row(1, makeRepo(1, { flags: { ...makeRepo(1).flags, toVerify: true } })), row(2, null)] }));
    renderPage("fr");
    await screen.findByRole("heading", { level: 1 });
    expect(status()).toMatch(/^Ouvert jusqu'au /);
    expect(screen.getByText("publié")).toBeInTheDocument();
    expect(screen.getByRole("region", { name: "Dépôts" })).toBeInTheDocument();
    expect(screen.getByText("à vérifier")).toBeInTheDocument();
    expect(screen.getByText("non accepté")).toBeInTheDocument();
    expect(screen.getByRole("region", { name: "Jalons de revue" })).toBeInTheDocument();
  });
});
