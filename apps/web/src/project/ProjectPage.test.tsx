import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import type { ProjectDetail, ProjectRepoScores, ProjectRepoView } from "@quiz/contracts";

import {
  AHEAD,
  BASE,
  CLASSROOM_ID,
  makeCheckpoint,
  makeDraft,
  makeGroup,
  makeProject,
  makeRepo,
  makeRunList,
  PAST,
  row,
} from "../test/project-fixtures";
import { fail, makeQueryClient, mockFetch, noContent, ok, renderWithProviders, type RouteHandler } from "../test/render";
import { TOURS } from "../coach/catalog";
import { ProjectPage } from "./ProjectPage";

/*
 * The project page (F-PROJ-13, M3-12): its states, the one primary action the
 * server names — Publish a button, Release and Sync a sentence, none no
 * accent —, Publish's 409 with its names, archive and delete with their
 * confirmations, the edits as one PATCH each, the reopen asked first, the
 * table's flags, the row's sheet with its runs and its deadline and lock,
 * the checkpoints, the refetch rules, and the French of it all; a group
 * project's rows per group, its drift and *Resync* (M3-16b).
 */

const ROOM = `/app/api/classrooms/${CLASSROOM_ID}`;
/** A group set of the classroom (ADR-070), a uuid as `ProjectPatch` takes one. */
const SET = "0190d3c4-0000-7000-8000-00000000f001";

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
    expect((await screen.findAllByText("PRG1-2026"))[0]).toBeInTheDocument();
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
    routes(makeProject({ rows: [], counts: { students: 0, accepted: 0, groups: 0, live: 0, frozen: 0, toVerify: 0, alerts: 0 } }));
    const { navigate } = renderPage();
    expect(await screen.findByText("No student in the roster")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Add students" }));
    expect(navigate).toHaveBeenCalledWith({ view: "classroom", id: CLASSROOM_ID, tab: "roster" });
  });

  // M3-14j (pilot): a roster of no student but the teacher's test repository (ADR-077) is a table of that one row, counted nowhere.
  it("draws the teacher's test repository when no student is in the roster", async () => {
    const counts = { students: 0, accepted: 0, groups: 0, live: 0, frozen: 0, toVerify: 0, alerts: 0 };
    const teacherRow = { ...makeProject().rows[0]!, repo: makeRepo(1), staff: true };
    routes(makeProject({ rows: [teacherRow], counts }));
    renderPage();
    const region = await screen.findByRole("region", { name: "Repositories" });
    expect(within(region).queryByText("No student in the roster")).toBeNull();
    const rows = within(region.querySelector("table")!).getAllByRole("row").slice(1);
    expect(rows).toHaveLength(1);
    expect(within(rows[0]!).getByText("Teacher")).toBeInTheDocument();
  });
});

// M3-14m (pilot finding 16): the staff cell counts as the student's card does; GitHub's total is the tooltip.
describe("the last commit's count", () => {
  const withRepo = (over: Partial<ProjectRepoView>) => routes(makeProject({ rows: [row(1, makeRepo(1, over))] }));
  const countCell = async (text: string) => {
    renderPage();
    return await screen.findByText(text);
  };

  it("shows the student's count, and GitHub's total, the App's included, in its tooltip", async () => {
    withRepo({ commits: 3, live: { commitCount: 4, checksPassed: 1, checksTotal: 1, stale: false } });
    const cell = await countCell("3 commits");
    await userEvent.hover(cell);
    expect(await screen.findByText("4 on GitHub, the App's included")).toBeInTheDocument();
  });

  it("says one commit in the singular and hints that GitHub's total may be out of date", async () => {
    withRepo({ commits: 1, live: { commitCount: 2, checksPassed: null, checksTotal: null, stale: true } });
    const cell = await countCell("1 commit");
    await userEvent.hover(cell);
    expect(await screen.findByText("2 on GitHub, the App's included (may be out of date)")).toBeInTheDocument();
  });

  it("keeps the count, with no word about GitHub, when the live cache holds no value", async () => {
    withRepo({ commits: 5, live: null });
    const cell = await countCell("5 commits");
    await userEvent.hover(cell);
    expect(screen.queryByText(/on GitHub/)).toBeNull();
  });
});

describe("the one primary action", () => {
  it("is Publish, as a button, for a draft — and the header says the students see nothing yet", async () => {
    routes(makeDraft());
    renderPage();
    expect(await screen.findByRole("button", { name: /Publish/ })).toBeInTheDocument();
    expect(status()).toMatch(/^Draft: the students see nothing yet/);
  });

  it("is Sync, as a button, when the source is ahead (F-PROJ-12, M3-07): one POST, a toast, the page refreshed", async () => {
    const ahead = { pushedAt: PAST, commits: 3 };
    const { calls } = routes(makeProject({ primaryAction: "sync", sync: { ahead, inProgress: false, syncedAt: null, last: null } }), {
      [`POST ${BASE}/sync`]: ok({ requestedAt: PAST }),
    });
    renderPage();
    const button = await screen.findByRole("button", { name: "Sync" });
    expect(screen.queryByRole("button", { name: /Publish|Release/ })).toBeNull();
    expect(status()).toBe("The source repository is ahead of the students' copies: a sync is due.");
    expect(screen.getByText(/source 3 commits ahead/)).toBeInTheDocument();
    await userEvent.click(button);
    await waitFor(() => expect(writes(calls)).toEqual([expect.objectContaining({ method: "POST", url: `${BASE}/sync` })]));
    expect(await screen.findByText(/^Sync started/)).toBeInTheDocument();
    await waitFor(() => expect(calls.filter((c) => c.url === BASE && c.method === "GET").length).toBeGreaterThan(1));
  });

  it("offers Sync beside Publish on a draft whose source is ahead, says what the last sync did, and shows the pass under way", async () => {
    routes(
      makeDraft({
        sync: { ahead: { pushedAt: PAST, commits: null }, inProgress: false, syncedAt: null, last: null },
      }),
    );
    renderPage();
    expect(await screen.findByRole("button", { name: "Sync" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Publish/ })).toBeInTheDocument();
    expect(screen.getByText(/source ahead/)).toBeInTheDocument();
  });

  it("says the last sync's counts, and 'Syncing…' while the pass runs", async () => {
    routes(
      makeProject({
        primaryAction: "none",
        sync: { ahead: { pushedAt: PAST, commits: 1 }, inProgress: true, syncedAt: PAST, last: { opened: 2, updated: 1, upToDate: 3, failed: 0, skipped: 1 } },
      }),
    );
    renderPage();
    const button = await screen.findByRole("button", { name: /Syncing…/ });
    expect(button).toBeDisabled();
    expect(screen.getByTestId("project-sync-last").textContent).toMatch(/^Last sync .*: 2 pull requests opened, 1 updated, 3 up to date, 0 failed, 1 skipped\.$/);
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
          { enrollmentId: "0190d3c4-0000-7000-8000-00000000e001", nom: "Dupont", prenom: "Alice" },
          { enrollmentId: "0190d3c4-0000-7000-8000-00000000e002", nom: "Martin", prenom: "Benoît" },
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
    // No set to place them in: no link.
    expect(within(alert).queryByRole("link")).toBeNull();
  });
});

describe("the teacher's tour (M7-01)", () => {
  it("finds every step's anchor on a draft whose source is ahead, with a repository to open", async () => {
    routes(
      makeDraft({
        rows: [row(1, makeRepo(1)), row(2, null)],
        sync: { ahead: { pushedAt: PAST, commits: 2 }, inProgress: false, syncedAt: null, last: null },
      }),
    );
    renderPage();
    await screen.findByRole("button", { name: "Sync" });
    const tour = TOURS.find((t) => t.id === "project")!;
    expect(tour.audience).toBe("teacher");
    for (const step of tour.steps) expect(document.querySelector(step.target), step.id).not.toBeNull();
  });

  it("points the primary step at Sync when Sync is the primary action, and keeps one anchor each", async () => {
    routes(makeProject({ primaryAction: "sync", sync: { ahead: { pushedAt: PAST, commits: 1 }, inProgress: false, syncedAt: null, last: null } }));
    renderPage();
    const button = await screen.findByRole("button", { name: "Sync" });
    expect(document.querySelectorAll('[data-coach="project.primary"]')).toHaveLength(1);
    expect(button).toHaveAttribute("data-coach", "project.primary");
    expect(document.querySelector('[data-coach="project.sync"]')).toBeNull();
  });
});

describe("a group project's set (ADR-070, M3-16a)", () => {
  const SETS = `GET ${ROOM}/group-sets`;
  const setSummary = {
    id: SET,
    name: "Binômes",
    maxSize: 2,
    groups: 12,
    placed: 22,
    unplaced: 2,
    createdAt: PAST,
    usedBy: [],
  };

  it("chooses the draft's set with one PATCH", async () => {
    const { calls } = routes(makeDraft({ groupMode: true }), {
      [SETS]: ok([setSummary]),
      [`PATCH ${BASE}`]: ok(makeDraft({ groupMode: true, groupSetId: SET })),
    });
    renderPage();
    await screen.findByRole("option", { name: /^Binômes/ });
    await userEvent.selectOptions(screen.getByRole("combobox", { name: "Group set" }), SET);
    await waitFor(() => expect(writes(calls)).toEqual([expect.objectContaining({ method: "PATCH", body: { groupSetId: SET } })]));
  });

  it("says Choose a group set first when Publish is refused 409 no_group_set, and points at the picker", async () => {
    routes(makeDraft({ groupMode: true }), {
      [SETS]: ok([setSummary]),
      [`POST ${BASE}/publish`]: fail(409, { error: "no_group_set", message: "no set" }),
    });
    renderPage();
    await userEvent.click(await screen.findByRole("button", { name: /Publish/ }));
    expect(await screen.findByText("Choose a group set first")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Choose a group set" }));
    expect(screen.getByRole("combobox", { name: "Group set" })).toHaveFocus();
  });

  it("links the students in no group to the set's page, which comes back here", async () => {
    routes(makeDraft({ groupMode: true, groupSetId: SET }), {
      [SETS]: ok([setSummary]),
      [`POST ${BASE}/publish`]: fail(409, {
        error: "unassigned_students",
        message: "1 student(s) in no group",
        students: [{ enrollmentId: "0190d3c4-0000-7000-8000-00000000e001", nom: "Dupont", prenom: "Alice" }],
      }),
    });
    const { navigate } = renderPage();
    await userEvent.click(await screen.findByRole("button", { name: /Publish/ }));
    const link = await screen.findByRole("link", { name: "Place them in the group set" });
    await userEvent.click(link);
    expect(navigate).toHaveBeenCalledWith({
      view: "groupSet",
      classroomId: CLASSROOM_ID,
      id: SET,
      fromProject: makeProject().id,
    });
  });

  it("says whether a published project's groups still follow the set", async () => {
    routes(makeProject({ groupMode: true, groupSetId: SET, editable: [] }), {
      [SETS]: ok([{ ...setSummary, usedBy: [{ id: makeProject().id, name: "Labo 2", archived: false, follows: false }] }]),
    });
    renderPage();
    expect(await screen.findByText("Its groups stopped following the set at the deadline.")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Binômes — 12 groups · 2 not placed" })).toBeInTheDocument();
    expect(screen.queryByRole("combobox", { name: "Group set" })).toBeNull();
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
      row(1, makeRepo(1, { sync: { pr: { number: 12, state: "open" }, outcome: "opened", at: PAST } })),
      row(2, makeRepo(2, { flags: { ...makeRepo(2).flags, protectionSuspended: true, toVerify: true } })),
      row(3, makeRepo(3, { sync: { pr: null, outcome: "failed", at: PAST }, flags: { ...makeRepo(3).flags, multiple: true } })),
      row(4, makeRepo(4, { flags: { ...makeRepo(4).flags, malformed: "::notice title=GRADE::huit/10" } })),
      row(5, makeRepo(5, { degraded: true, archived: true, locked: true })),
      row(6, makeRepo(6, { flags: { ...makeRepo(6).flags, changedAfterRelease: true, clamped: true } })),
      row(7, makeRepo(7, { flags: { ...makeRepo(7).flags, deleted: true } })),
      row(8, makeRepo(8, { deadlineAt: AHEAD, invitationStatus: "pending", lastCommit: null, ciStatus: "none" })),
      row(9, null),
      row(10, null, { claimed: false }),
      { student: { ...makeProject().rows[0]!.student, enrollmentId: null, nom: "Ancien", prenom: "Élève" }, repo: makeRepo(11), group: null, staff: false },
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
    expect(text(5)).toMatch(/negative CI score counted 0/);
    expect(text(4)).not.toMatch(/negative CI score/);
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
    // The sync (M3-07): the pull request of the row, linked to GitHub; a failed sync in red.
    const pr = within(rows[0]!).getByRole("link", { name: /PR #12 open/ });
    expect(pr).toHaveAttribute("href", "https://github.com/heig-tin-info/labo-2-student-1/pull/12");
    expect(text(2)).toMatch(/sync failed/);
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
            { ...makeRunList().runs[0]!, afterDeadline: true, id: "run-3", completedAt: AHEAD, points: 0, clamped: true, parseDetail: "-2/10" },
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
    // A negative CI score counted 0 (M3-14n): the staff see the clamp and what the CI printed.
    expect(runRows[0]!.textContent).toMatch(/negative score, counted 0/);
    expect(runRows[0]!.textContent).toMatch(/-2\/10/);
    expect(runRows[1]!.textContent).not.toMatch(/negative score/);
    expect(runRows[1]!.textContent).toMatch(/current/);
    expect(runRows[2]!.textContent).not.toMatch(/current/);
    expect(runRows[2]!.textContent).toMatch(/4\/10/);
    // GitHub's conclusion worded, never raw.
    expect(runRows[1]!.textContent).toMatch(/success/);
    // Accepted, not suspended, not frozen: no resend, no re-enable, and the score waits for the freeze.
    expect(within(sheet).queryByRole("button", { name: /Resend|Re-enable|^Save$/ })).toBeNull();
    expect(within(sheet).getByText("Set once the repository is frozen for good.")).toBeInTheDocument();

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

/** A repository frozen for good a week ago, its frozen run the final score (the state the teacher's score and the release need). */
const frozenRepo = (n: number, over: Partial<ProjectRepoView> = {}) =>
  makeRepo(n, {
    deadlineAppliedAt: PAST,
    frozenAt: PAST,
    effectiveDeadlineAt: PAST,
    locked: true,
    scores: {
      ...makeRepo(n).scores,
      frozen: { runId: "run-2", points: 8, max: 10, grade: { grade: 5, fellBack: false } },
    },
    review: { status: "done", reason: null, askedAt: PAST, sha: "9a3f1c7e2b4d6f8a0c1e3b5d7f9a1c3e5b7d9f1a", runId: "run-9" },
    ...over,
  });
const frozenProject = (over: Partial<ProjectDetail> = {}) =>
  makeProject({
    state: "locked",
    deadlineAt: PAST,
    deadlineAppliedAt: PAST,
    rows: [row(1, frozenRepo(1)), row(2, null)],
    counts: { students: 2, accepted: 1, groups: 0, live: 1, frozen: 1, toVerify: 0, alerts: 0 },
    editable: ["name", "deadlineAt", "protectedFiles"],
    ...over,
  });

describe("a group project's rows, drift and resync (ADR-070 §4, M3-16b)", () => {
  const SETS = `GET ${ROOM}/group-sets`;
  const RESYNC = `${BASE}/groups/resync`;
  const g1 = makeGroup(1);
  const g2 = makeGroup(2, true);
  const repoA = makeRepo(1, { fullName: "heig-tin-info/labo-2-groupe-1", accessToRevoke: true });
  const orphan = makeRepo(3, { fullName: "heig-tin-info/labo-2-groupe-2" });
  const groupProject = (over: Partial<ProjectDetail> = {}) =>
    makeProject({
      groupMode: true,
      groupSetId: SET,
      editable: [],
      rows: [
        row(0, repoA, {}, g1),
        row(1, repoA, { githubLogin: null }, g1),
        row(2, null, {}, null),
        row(3, orphan, { enrollmentId: null }, g2),
      ],
      counts: { students: 3, accepted: 2, groups: 2, live: 2, frozen: 0, toVerify: 0, alerts: 0 },
      ...over,
    });
  const consequence = (n: number, kind: "lose" | "join", over: Record<string, unknown> = {}) => ({
    // A uuid, as `GroupConsequence` parses one (the fixture's project id is not).
    projectId: "0190d3c4-0000-7000-8000-0000000000b4",
    projectName: "Labo 2",
    groupId: g1.id,
    groupName: "Groupe 1",
    repo: "heig-tin-info/labo-2-groupe-1",
    enrollmentId: `0190d3c4-0000-7000-8000-00000000e00${n}`,
    nom: "Dupont",
    prenom: ["Alice", "Benoît", "Chloé"][n]!,
    kind,
    frozen: true,
    acceptClosed: false,
    ...over,
  });

  it("draws one row per group — its members by name and login, its repository once — then the students in none", async () => {
    routes(groupProject(), { [SETS]: ok([]) });
    renderPage();
    const table = await screen.findByRole("table");
    expect(within(table).getByRole("columnheader", { name: /Group/ })).toBeInTheDocument();
    const rows = within(table).getAllByRole("row").slice(1);
    expect(rows.map((r) => r.querySelector(".font-semibold")?.textContent)).toEqual(["Groupe 1", "Groupe 2", "Rochat Chloé"]);
    expect(within(rows[0]!).getByText(/Dupont Alice/)).toBeInTheDocument();
    expect(within(rows[0]!).getByText("student-0")).toBeInTheDocument();
    expect(within(rows[0]!).getByText(/Martin Benoît/)).toBeInTheDocument();
    expect(within(rows[0]!).getByText("access to revoke")).toBeInTheDocument();
    expect(within(rows[1]!).getByText("No member")).toBeInTheDocument();
    expect(within(rows[2]!).getByText("no group")).toBeInTheDocument();
    expect(screen.getByText(/2 groups/)).toBeInTheDocument();
    // A group's sheet: titled by the group, its members listed, whether it follows the set.
    await userEvent.click(rows[0]!);
    const sheet = await screen.findByRole("dialog", { name: "Groupe 1" });
    expect(within(sheet).getByText("Members")).toBeInTheDocument();
    expect(within(sheet).getByText("Follows the group set")).toBeInTheDocument();
  });

  it("says the drift with Resync as a secondary, hidden once released or archived", async () => {
    routes(groupProject({ groupsDrifted: true, primaryAction: "release" }), { [SETS]: ok([]) });
    renderPage();
    expect(await screen.findByText("The group set changed since these groups stopped following it")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Resync with the set" })).toBeInTheDocument();
    // The page's primary stays the server's.
    expect(screen.getByRole("button", { name: "Release scores" })).toBeInTheDocument();
  });

  it.each([
    ["released", { releasedAt: PAST }],
    ["archived", { archivedAt: PAST }],
  ])("hides the drift once %s", async (_, over) => {
    routes(groupProject({ groupsDrifted: true, ...over }), { [SETS]: ok([]) });
    renderPage();
    await screen.findByRole("table");
    expect(screen.queryByText("The group set changed since these groups stopped following it")).toBeNull();
    expect(screen.queryByRole("button", { name: "Resync with the set" })).toBeNull();
  });

  it("reads the page again on a 204 applied at once (nothing reaching GitHub), and says it", async () => {
    const { calls } = routes(groupProject({ groupsDrifted: true }), { [SETS]: ok([]), [`POST ${RESYNC}`]: noContent() });
    renderPage();
    await userEvent.click(await screen.findByRole("button", { name: "Resync with the set" }));
    expect(await screen.findByText("Groups resynced with the set.")).toBeInTheDocument();
    expect(writes(calls).map((c) => c.body)).toEqual([{}]);
    await waitFor(() => expect(calls.filter((c) => c.url === BASE && c.method === "GET").length).toBeGreaterThan(1));
  });

  it("names the frozen repositories, the arrivals without one and the rest, then confirms with the digest", async () => {
    const digest = "e".repeat(64);
    const { calls } = routes(groupProject({ groupsDrifted: true }), {
      [SETS]: ok([]),
      [`POST ${RESYNC}`]: (call) =>
        (call.body as { confirm?: string }).confirm === digest
          ? noContent()
          : fail(409, {
              error: "needs_confirmation",
              message: "x",
              digest,
              consequences: [
                consequence(0, "lose"),
                consequence(0, "join", { groupId: g2.id, groupName: "Groupe 2", repo: "heig-tin-info/labo-2-groupe-2" }),
                consequence(2, "join", { groupId: g2.id, groupName: "Groupe 3", repo: null, frozen: false, acceptClosed: true }),
              ],
            }),
    });
    renderPage();
    await userEvent.click(await screen.findByRole("button", { name: "Resync with the set" }));
    const dialog = await screen.findByRole("dialog", { name: "Resync with the group set" });
    const frozen = within(dialog).getByRole("status");
    expect(within(frozen).getByText("Frozen repositories touched after their deadline")).toBeInTheDocument();
    expect(within(frozen).getAllByRole("listitem").map((li) => li.textContent)).toEqual([
      "heig-tin-info/labo-2-groupe-1",
      "heig-tin-info/labo-2-groupe-2",
    ]);
    expect(within(dialog).getByText("Will have no repository — Accept is closed")).toBeInTheDocument();
    expect(within(dialog).getByText("Dupont Chloé")).toBeInTheDocument();
    await userEvent.click(within(dialog).getByRole("button", { name: "Resync" }));
    expect(await screen.findByText("Groups resynced with the set.")).toBeInTheDocument();
    expect(writes(calls).map((c) => c.body)).toEqual([{}, { confirm: digest }]);
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it.each([
    ["released", "The scores are released: the groups can no longer be resynced."],
    ["project_archived", "This project is archived: neither its source nor its groups can be synced."],
    ["classroom_archived", "This classroom is archived: its group sets are read-only."],
    ["no_group_set", "Choose a group set first"],
  ])("words the resync's refusal %s", async (error, words) => {
    routes(groupProject({ groupsDrifted: true }), { [SETS]: ok([]), [`POST ${RESYNC}`]: fail(409, { error, message: "x" }) });
    renderPage();
    await userEvent.click(await screen.findByRole("button", { name: "Resync with the set" }));
    expect(await screen.findByText(words)).toBeInTheDocument();
  });

  it("holds Release while a confirmed resync is applied, and says why", async () => {
    routes(groupProject({ primaryAction: "release", groupSyncPending: true }), { [SETS]: ok([]) });
    renderPage();
    expect(await screen.findByRole("button", { name: "Release scores" })).toBeDisabled();
    expect(screen.getByTestId("project-release-waits")).toHaveTextContent("The release waits for the resync of the groups to be applied on GitHub.");
    expect(screen.getByText("A resync is being applied on GitHub.")).toBeInTheDocument();
  });
});

describe("the release (F-PROJ-14, M3-12c)", () => {
  it("is the header's one button once the server names it; the confirmation says what a release does; the counts are toasted", async () => {
    const { calls } = routes(frozenProject({ primaryAction: "release" }), {
      [`POST ${BASE}/release`]: ok({ releasedAt: PAST, first: true, repos: 1, scored: 1 }),
    });
    renderPage();
    const button = await screen.findByRole("button", { name: "Release scores" });
    expect(status()).toBe("Every repository is frozen: the scores are final and ready to be released.");
    await userEvent.click(button);
    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).getByText("Release the scores?")).toBeInTheDocument();
    expect(within(dialog).getByText(/becomes the student's and the gradebook's/)).toBeInTheDocument();
    // Declined: nothing posted.
    await userEvent.click(within(dialog).getByRole("button", { name: "Cancel" }));
    expect(writes(calls)).toHaveLength(0);
    await userEvent.click(button);
    await userEvent.click(within(await screen.findByRole("dialog")).getByRole("button", { name: "Release" }));
    await waitFor(() => expect(writes(calls)).toEqual([expect.objectContaining({ method: "POST", url: `${BASE}/release` })]));
    expect(await screen.findByText("Scores released: 1 of 1 repositories have one")).toBeInTheDocument();
    await waitFor(() => expect(calls.filter((c) => c.url === BASE && c.method === "GET").length).toBeGreaterThan(1));
  });

  it("is worded as a release again once released and a score moved, and says the snapshot is rewritten", async () => {
    routes(
      frozenProject({
        primaryAction: "release",
        releasedAt: PAST,
        rows: [row(1, frozenRepo(1, { released: { points: 7, max: 10 }, flags: { ...makeRepo(1).flags, changedAfterRelease: true } }))],
      }),
    );
    renderPage();
    await userEvent.click(await screen.findByRole("button", { name: "Release again" }));
    expect(status()).toMatch(/^Scores released on .*; some changed since\. Release again/);
    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).getByText("Release the scores again?")).toBeInTheDocument();
    expect(within(dialog).getByText(/snapshot is rewritten/)).toBeInTheDocument();
    expect(within(dialog).getByRole("button", { name: "Release again" })).toBeInTheDocument();
  });

  it("offers nothing once released with no change, nor on a graded-none project", async () => {
    routes(frozenProject({ releasedAt: PAST }));
    renderPage();
    await screen.findByRole("heading", { level: 1 });
    expect(screen.queryByRole("button", { name: /Release/ })).toBeNull();
    expect(status()).toMatch(/^Scores released on /);
  });

  it("says why a release was refused: the counts of not_frozen, the names of to_verify, grading_none", async () => {
    let reply = fail(409, { error: "not_frozen", message: "", live: 2, frozen: 1 });
    routes(
      frozenProject({ primaryAction: "release", rows: [row(1, frozenRepo(1)), row(2, frozenRepo(2))] }),
      { [`POST ${BASE}/release`]: () => reply },
    );
    renderPage();
    const attempt = async () => {
      await userEvent.click(await screen.findByRole("button", { name: "Release scores" }));
      await userEvent.click(within(await screen.findByRole("dialog")).getByRole("button", { name: "Release" }));
    };
    await attempt();
    const alert = (await screen.findByText("The scores were not released")).closest<HTMLElement>("[role=status]")!;
    expect(within(alert).getByText("Not yet: 1 of 2 live repositories are frozen for good.")).toBeInTheDocument();
    reply = fail(409, { error: "to_verify", message: "", repos: [frozenRepo(2).id] });
    await attempt();
    expect(await screen.findByText(/The score of Rochat Chloé rests on a run to verify/)).toBeInTheDocument();
    reply = fail(409, { error: "grading_none", message: "" });
    await attempt();
    expect(await screen.findByText("This project is not graded: no score, no release.")).toBeInTheDocument();
  });
});

describe("the sheet's writes (M3-12b)", () => {
  const openSheet = async () => {
    await userEvent.click(await screen.findByRole("row", { name: /Martin Benoît/ }));
    return screen.findByRole("dialog");
  };
  const runsRoute = (repo: { id: string }) => ({ [`GET ${BASE}/repos/${repo.id}/runs`]: ok(makeRunList({ runs: [] })) });

  it("sets the teacher's score against the scored run's maximum, with a comment, and lays the answer over the row", async () => {
    const repo = frozenRepo(1);
    const answer: ProjectRepoScores = {
      scores: {
        ...repo.scores,
        teacher: { points: 9, max: 10, comment: "Bien.", gradedAt: PAST },
        final: { points: 9, max: 10, source: "teacher", toVerify: false, grade: { grade: 5.5, fellBack: false } },
      },
      released: null,
      changedAfterRelease: false,
    };
    // The server's page follows the write: the refetch after it reads the scored row.
    let saved = false;
    const { calls } = routes(
      () => ok(frozenProject({ rows: [row(1, saved ? { ...repo, scores: answer.scores } : repo), row(2, null)] })),
      {
        ...runsRoute(repo),
        [`PATCH ${BASE}/repos/${repo.id}/score`]: () => {
          saved = true;
          return ok(answer);
        },
      },
    );
    renderPage();
    const sheet = await openSheet();
    // A scored run: the maximum is its, no field for it.
    expect(within(sheet).queryByRole("spinbutton", { name: "Out of" })).toBeNull();
    expect(within(sheet).getByText("out of 10")).toBeInTheDocument();
    const save = within(sheet).getByRole("button", { name: "Save" });
    expect(save).toBeDisabled();
    await userEvent.type(within(sheet).getByRole("spinbutton", { name: "Points" }), "9");
    await userEvent.type(within(sheet).getByRole("textbox", { name: "Comment" }), "Bien.");
    await userEvent.click(save);
    await waitFor(() => expect(writes(calls)).toHaveLength(1));
    expect(writes(calls)[0]).toMatchObject({
      method: "PATCH",
      url: `${BASE}/repos/${repo.id}/score`,
      body: { points: 9, comment: "Bien." },
    });
    expect(writes(calls)[0]!.body).not.toHaveProperty("max");
    expect(await screen.findByText("Score saved")).toBeInTheDocument();
    // The row behind the sheet now reads the teacher's score as the final one.
    const table = screen.getByRole("region", { name: "Repositories" }).querySelector("table")!;
    expect(within(table).getAllByRole("row")[1]!.textContent).toMatch(/9\/10.*teacher/);
    // And the sheet offers Clear.
    await userEvent.click(within(sheet).getByRole("button", { name: "Clear" }));
    await waitFor(() => expect(writes(calls)).toHaveLength(2));
    expect(writes(calls)[1]!.body).toEqual({ points: null });
  });

  it("asks for the maximum when the repository has no scored run, sends it, and words the 422s and the 409s", async () => {
    // The server says the score is held to no maximum (`scoreMax` null): no scored run.
    const repo = frozenRepo(1, { scores: { ...makeRepo(1).scores, current: null, frozen: null, final: null, scoreMax: null } });
    let reply = fail(422, { error: "score_max_required", message: "" });
    const { calls } = routes(frozenProject({ rows: [row(1, repo), row(2, null)] }), {
      ...runsRoute(repo),
      [`PATCH ${BASE}/repos/${repo.id}/score`]: () => reply,
    });
    renderPage();
    const sheet = await openSheet();
    expect(within(sheet).getByText(/No scored run to take the maximum from/)).toBeInTheDocument();
    const save = within(sheet).getByRole("button", { name: "Save" });
    await userEvent.type(within(sheet).getByRole("spinbutton", { name: "Points" }), "15");
    // Points alone do not do: the maximum is required with them.
    expect(save).toBeDisabled();
    await userEvent.type(within(sheet).getByRole("spinbutton", { name: "Out of" }), "20");
    await userEvent.click(save);
    await waitFor(() => expect(writes(calls)).toHaveLength(1));
    expect(writes(calls)[0]!.body).toEqual({ points: 15, max: 20, comment: "" });
    expect(await within(sheet).findByText(/Give the maximum: this repository has no scored run/)).toBeInTheDocument();
    reply = fail(409, { error: "not_frozen", message: "" });
    await userEvent.click(save);
    expect(await within(sheet).findByText("This repository is not frozen for good yet.")).toBeInTheDocument();
    reply = fail(409, { error: "grading_none", message: "" });
    await userEvent.click(save);
    expect(await within(sheet).findByText("This project is not graded: no score, no release.")).toBeInTheDocument();
  });

  it("offers no score form on a project graded none", async () => {
    const repo = frozenRepo(1);
    routes(frozenProject({ gradingMode: "none" }), runsRoute(repo));
    renderPage();
    const sheet = await openSheet();
    expect(within(sheet).queryByRole("button", { name: "Save" })).toBeNull();
    expect(within(sheet).getByText("This project is not graded: no score, no release.")).toBeInTheDocument();
  });

  it("resends a pending invitation, once a minute (429 worded), and never an accepted one", async () => {
    const repo = makeRepo(1, { invitationStatus: "pending", lastCommit: null, ciStatus: "none" });
    let invitation: ProjectRepoView["invitationStatus"] = "pending";
    let reply = fail(429, { error: "resend_too_soon", message: "" });
    const { calls } = routes(() => ok(makeProject({ rows: [row(1, { ...repo, invitationStatus: invitation }), row(2, null)] })), {
      ...runsRoute(repo),
      [`POST ${BASE}/repos/${repo.id}/invite`]: () => {
        if (reply.status === 200) invitation = (reply.body as { invitationStatus: typeof invitation }).invitationStatus;
        return reply;
      },
    });
    reply = ok({ invitationStatus: "pending", resentAt: PAST });
    renderPage();
    const sheet = await openSheet();
    const resend = within(sheet).getByRole("button", { name: "Resend" });
    await userEvent.click(resend);
    await waitFor(() => expect(writes(calls)).toEqual([expect.objectContaining({ method: "POST", url: `${BASE}/repos/${repo.id}/invite` })]));
    expect(await screen.findByText("Invitation resent")).toBeInTheDocument();
    reply = fail(429, { error: "resend_too_soon", message: "" });
    await userEvent.click(resend);
    expect(await screen.findByText(/resent less than a minute ago/)).toBeInTheDocument();
    // Accepted meanwhile: the answer is laid over the row and the button goes.
    reply = ok({ invitationStatus: "accepted", resentAt: PAST });
    await userEvent.click(resend);
    expect(await screen.findByText(/already has access/)).toBeInTheDocument();
    await waitFor(() => expect(within(sheet).queryByRole("button", { name: "Resend" })).toBeNull());
  });

  it("re-enables the protection, which clears the conflict tag, and says past runs stay to verify", async () => {
    const repo = makeRepo(1, { flags: { ...makeRepo(1).flags, protectionSuspended: true, toVerify: true } });
    let suspended = true;
    const { calls } = routes(
      () => ok(makeProject({ rows: [row(1, { ...repo, flags: { ...repo.flags, protectionSuspended: suspended } }), row(2, null)] })),
      {
        ...runsRoute(repo),
        [`POST ${BASE}/repos/${repo.id}/protection`]: () => {
          suspended = false;
          return ok({ reenabledAt: PAST });
        },
      },
    );
    renderPage();
    const sheet = await openSheet();
    expect(within(sheet).getByText("protected files in conflict")).toBeInTheDocument();
    expect(within(sheet).getByText(/The runs marked “to verify” meanwhile stay so/)).toBeInTheDocument();
    await userEvent.click(within(sheet).getByRole("button", { name: "Re-enable the protection" }));
    await waitFor(() => expect(writes(calls)).toEqual([expect.objectContaining({ method: "POST", url: `${BASE}/repos/${repo.id}/protection` })]));
    expect(await screen.findByText("Protection re-enabled; past runs stay to verify")).toBeInTheDocument();
    await waitFor(() => expect(within(sheet).queryByText("protected files in conflict")).toBeNull());
    expect(within(sheet).queryByRole("button", { name: "Re-enable the protection" })).toBeNull();
    // The "to verify" mark stays: only the conflict went.
    expect(within(sheet).getByText("to verify")).toBeInTheDocument();
  });

  it("shows the final review's state per status in the table, and its detail in the sheet", async () => {
    const sha = "9a3f1c7e2b4d6f8a0c1e3b5d7f9a1c3e5b7d9f1a";
    const rows = [
      // Not frozen: trivially pending, no tag.
      row(1, makeRepo(1)),
      row(2, frozenRepo(2, { review: { status: "pending", reason: null, askedAt: null, sha: null, runId: null } })),
      row(3, frozenRepo(3, { review: { status: "none", reason: "no_frozen_run", askedAt: null, sha: null, runId: null } })),
      row(4, frozenRepo(4, { archived: true, degraded: true, review: { status: "skipped", reason: "archived", askedAt: null, sha: null, runId: null } })),
      row(5, frozenRepo(5, { review: { status: "skipped", reason: "protection_suspended", askedAt: null, sha: null, runId: null } }), { nom: "Keller", prenom: "Ana" }),
      row(6, frozenRepo(6, { review: { status: "unconfirmed", reason: null, askedAt: null, sha, runId: null } })),
      row(7, frozenRepo(7, { review: { status: "asked", reason: null, askedAt: PAST, sha, runId: null } }), { nom: "Ziegler", prenom: "Nora" }),
      row(8, frozenRepo(8)),
    ];
    routes(frozenProject({ rows }), runsRoute(frozenRepo(7)));
    renderPage();
    const table = (await screen.findByRole("region", { name: "Repositories" })).querySelector("table")!;
    const text = within(table).getAllByRole("row").slice(1).map((r) => r.textContent!);
    expect(text[0]).not.toMatch(/review/);
    expect(text[1]).toMatch(/review pending/);
    // The tag says "no review"; the reason is the sheet's detail line.
    expect(text[2]).toMatch(/no review/);
    expect(text[3]).toMatch(/no review/);
    expect(text[4]).toMatch(/no review/);
    expect(text[5]).toMatch(/review not confirmed/);
    expect(text[6]).toMatch(/review asked/);
    expect(text[7]).toMatch(/review done/);
    // The sheet of the asked one: when, and of which commit.
    await userEvent.click(screen.getByRole("row", { name: /Ziegler Nora/ }));
    const sheet = await screen.findByRole("dialog");
    expect(within(sheet).getByText("Final review")).toBeInTheDocument();
    expect(within(sheet).getByText(/^Asked on .*, of commit 9a3f1c7\./)).toBeInTheDocument();
    // The sheet of a degraded one: the word, and why.
    await userEvent.keyboard("{Escape}");
    await userEvent.click(screen.getByRole("row", { name: /Keller Ana/ }));
    const degraded = await screen.findByRole("dialog");
    expect(within(degraded).getByText(/^Re-enable the protected files: the review is then asked\./)).toBeInTheDocument();
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

  it("offers the release, the review's state and the teacher's score in French", async () => {
    const repo = frozenRepo(1, { review: { status: "unconfirmed", reason: null, askedAt: null, sha: "abc", runId: null } });
    routes(frozenProject({ primaryAction: "release", rows: [row(1, repo), row(2, null)] }), {
      [`GET ${BASE}/repos/${repo.id}/runs`]: ok(makeRunList({ runs: [] })),
    });
    renderPage("fr");
    await userEvent.click(await screen.findByRole("button", { name: "Publier les scores" }));
    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).getByText("Publier les scores ?")).toBeInTheDocument();
    await userEvent.click(within(dialog).getByRole("button", { name: "Annuler" }));
    expect(screen.getByText("revue non confirmée")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("row", { name: /Martin Benoît/ }));
    const sheet = await screen.findByRole("dialog");
    expect(within(sheet).getAllByText("Score de l'enseignant").length).toBeGreaterThan(0);
    expect(within(sheet).getByRole("button", { name: "Enregistrer" })).toBeInTheDocument();
    expect(within(sheet).getByText("Revue finale")).toBeInTheDocument();
  });
});
