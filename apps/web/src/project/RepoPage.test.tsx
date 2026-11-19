import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import type { ProjectDetail, ProjectRepoScores, ProjectRepoView } from "@quiz/contracts";

import {
  AHEAD,
  BASE,
  frozenProject,
  frozenRepo,
  makeGroup,
  makeProject,
  makeRepo,
  makeRunList,
  PAST,
  PROJECT_ID,
  row,
} from "../test/project-fixtures";
import { fail, mockFetch, ok, renderWithProviders, type RecordedCall, type Reply, type RouteHandler } from "../test/render";
import { RepoPage } from "./RepoPage";

/*
 * One repository of a project, its own page (ADR-137, amending F-PROJ-13):
 * read from the project's page and found by its row; its primary by state
 * (none during the project, Grade under criteria once frozen, the teacher's
 * score under the CI's), its previous and next without the staff's test
 * repository, its members with their commits and the unattributed ones,
 * its weekly heatmap, its runs, and the writes the former sheet held —
 * deadline, lock, teacher's score, Resend, protection.
 */

const write = (calls: RecordedCall[]) => calls.filter((c) => c.method !== "GET");
const runs = (repo: { id: string }, list = makeRunList({ runs: [] })) => ({ [`GET ${BASE}/repos/${repo.id}/runs`]: ok(list) });
const series = (n: number, weekStart = "2026-11-09") => ({ n, weeks: n === 0 ? [] : [{ weekStart, n }] });

/** The project's read (a reply, or a handler following the writes), and whatever else the test stubs. */
function routes(project: ProjectDetail | Reply | RouteHandler, extra: Record<string, RouteHandler> = {}) {
  const detail: RouteHandler = typeof project === "function" || "status" in project ? project : ok(project);
  return mockFetch({ [`GET ${BASE}`]: detail, ...extra });
}

function renderPage(rowId: string, { locale = "en", route = "/" }: { locale?: "en" | "fr"; route?: string } = {}) {
  const navigate = vi.fn();
  renderWithProviders(<RepoPage projectId={PROJECT_ID} rowId={rowId} navigate={navigate} />, { locale, route });
  return { navigate };
}

const header = async () => (await screen.findByRole("heading", { level: 1 })).closest("header")!;
/** The header's accent buttons: the page's primary, at most one. */
const primaries = async () => within(await header()).queryAllByRole("button").filter((b) => /bg-accent\b/.test(b.className));

describe("the page's states", () => {
  it("shows a skeleton, then the repository, named by its student", async () => {
    const repo = makeRepo(1);
    routes(makeProject({ rows: [row(1, repo)] }), runs(repo));
    renderPage(repo.id);
    expect(document.querySelector(".animate-pulse")).not.toBeNull();
    expect(await screen.findByRole("heading", { level: 1, name: /Martin Benoît/ })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /heig-tin-info\/labo-2-student-1/ })).toBeInTheDocument();
    expect(within(await header()).getByText("open")).toBeInTheDocument();
  });

  it("says a row the project does not hold as a missing record, with the way back to the repositories", async () => {
    routes(makeProject());
    const { navigate } = renderPage("0190d3c4-0000-7000-8000-00000000dead", { route: "/?filter=ciFail" });
    expect(await screen.findByRole("heading", { level: 1, name: "Repository not found" })).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Back to repositories" }));
    expect(navigate).toHaveBeenCalledWith({ view: "project", id: PROJECT_ID, tab: "repositories", filter: "ciFail" });
  });

  it("says a project that is not the caller's as the project page does, and offers a retry on a failure", async () => {
    routes(fail(404, { error: "not_found" }));
    renderPage(makeRepo(1).id);
    expect(await screen.findByText("This project does not exist, or it is not open to you.")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Retry/ })).toBeInTheDocument();
  });
});

describe("the one primary action, by state (ADR-137)", () => {
  it("is none during the project: no accent in the header, the score waits for the freeze", async () => {
    const repo = makeRepo(1);
    routes(makeProject({ rows: [row(1, repo)] }), runs(repo));
    renderPage(repo.id);
    expect(await primaries()).toHaveLength(0);
    expect(screen.queryByRole("button", { name: /Grade|Enter the score/ })).toBeNull();
    expect(within(screen.getByTestId("repo-scores")).getByText("Set once the repository is frozen for good.")).toBeInTheDocument();
  });

  it("is Grade once frozen under criteria, the grading screen on this repository; the teacher's score is the rail's", async () => {
    const repo = frozenRepo(1);
    routes(frozenProject({ gradingMode: "criteria", rows: [row(1, repo)] }), runs(repo));
    const { navigate } = renderPage(repo.id);
    const [grade] = await primaries();
    expect(grade).toHaveTextContent("Grade");
    await userEvent.click(grade!);
    expect(navigate).toHaveBeenCalledWith({ view: "projectGrading", id: PROJECT_ID }, { query: { repo: repo.id } });
    expect(within(screen.getByTestId("repo-scores")).getByRole("button", { name: "Enter the score" })).toBeInTheDocument();
  });

  it("is the teacher's score once frozen under the CI's: its dialog sets it, and Grade is not offered", async () => {
    const repo = frozenRepo(1);
    const answer: ProjectRepoScores = {
      scores: {
        ...repo.scores,
        teacher: { points: 9, max: 10, comment: "Bien.", gradedAt: PAST },
        final: { points: 9, max: 10, source: "teacher", toVerify: false, grade: { grade: 5.5 } },
      },
      released: null,
      changedAfterRelease: false,
    };
    let saved = false;
    const { calls } = routes(() => ok(frozenProject({ rows: [row(1, saved ? { ...repo, scores: answer.scores } : repo)] })), {
      ...runs(repo),
      [`PATCH ${BASE}/repos/${repo.id}/score`]: () => {
        saved = true;
        return ok(answer);
      },
    });
    renderPage(repo.id);
    const [primary] = await primaries();
    expect(primary).toHaveTextContent("Enter the score");
    expect(screen.queryByRole("button", { name: "Grade" })).toBeNull();
    // Once: not again in the rail.
    expect(within(screen.getByTestId("repo-scores")).queryByRole("button")).toBeNull();
    await userEvent.click(primary!);
    const dialog = await screen.findByRole("dialog", { name: /Teacher's score/ });
    // A scored run: the maximum is its, no field for it.
    expect(within(dialog).queryByRole("spinbutton", { name: "Out of" })).toBeNull();
    expect(within(dialog).getByText("out of 10")).toBeInTheDocument();
    const save = within(dialog).getByRole("button", { name: "Save" });
    expect(save).toBeDisabled();
    await userEvent.type(within(dialog).getByRole("spinbutton", { name: "Points" }), "9");
    await userEvent.type(within(dialog).getByRole("textbox", { name: "Comment" }), "Bien.");
    await userEvent.click(save);
    await waitFor(() => expect(write(calls)).toHaveLength(1));
    expect(write(calls)[0]).toMatchObject({ method: "PATCH", url: `${BASE}/repos/${repo.id}/score`, body: { points: 9, comment: "Bien." } });
    expect(write(calls)[0]!.body).not.toHaveProperty("max");
    expect(await screen.findByText("Score saved")).toBeInTheDocument();
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    // The page reads the teacher's score as the final one, and the primary now edits it.
    expect(within(screen.getByTestId("repo-scores")).getAllByText(/9\/10/).length).toBeGreaterThan(0);
    await userEvent.click(await screen.findByRole("button", { name: "Edit the score" }));
    await userEvent.click(within(await screen.findByRole("dialog")).getByRole("button", { name: "Clear" }));
    await waitFor(() => expect(write(calls)).toHaveLength(2));
    expect(write(calls)[1]!.body).toEqual({ points: null });
  });

  it("is none on a project graded none, whose scores say why", async () => {
    const repo = frozenRepo(1);
    routes(frozenProject({ gradingMode: "none", rows: [row(1, repo)] }), runs(repo));
    renderPage(repo.id);
    expect(await primaries()).toHaveLength(0);
    expect(within(screen.getByTestId("repo-scores")).getByText("This project is not graded: no score to release.")).toBeInTheDocument();
  });
});

describe("previous and next (ADR-137)", () => {
  const staff = { ...row(9, makeRepo(9)), staff: true };
  const rows = [row(1, makeRepo(1)), row(2, makeRepo(2, { ciStatus: "fail" })), row(3, null), staff, row(4, makeRepo(4, { ciStatus: "fail" }))];

  it("walks the Repositories tab's rows, a row not accepted included, never the staff's test repository", async () => {
    routes(makeProject({ rows }), runs(makeRepo(4)));
    const { navigate } = renderPage(makeRepo(4).id);
    expect(await screen.findByTestId("repo-position")).toHaveTextContent("4 of 4");
    expect(screen.getByRole("button", { name: "Next repository" })).toBeDisabled();
    await userEvent.click(screen.getByRole("button", { name: "Previous repository" }));
    // The row before it is the student who has not accepted, by their roster line; the test repository is skipped.
    expect(navigate).toHaveBeenCalledWith(
      { view: "projectRepo", id: PROJECT_ID, rowId: rows[2]!.student.enrollmentId },
      { replace: true },
    );
  });

  it("keeps the table's filter it was opened under", async () => {
    routes(makeProject({ rows }), { ...runs(makeRepo(2)), ...runs(makeRepo(9)) });
    const { navigate } = renderPage(makeRepo(2).id, { route: "/?filter=ciFail" });
    expect(await screen.findByTestId("repo-position")).toHaveTextContent("1 of 2");
    await userEvent.click(screen.getByRole("button", { name: "Next repository" }));
    expect(navigate).toHaveBeenCalledWith({ view: "projectRepo", id: PROJECT_ID, rowId: makeRepo(4).id, filter: "ciFail" }, { replace: true });
  });

  it("draws no steps on the staff's test repository, still openable", async () => {
    routes(makeProject({ rows }), runs(makeRepo(9)));
    renderPage(makeRepo(9).id);
    expect(await screen.findByRole("heading", { level: 1, name: /Teacher/ })).toBeInTheDocument();
    expect(screen.queryByTestId("repo-position")).toBeNull();
  });
});

describe("the members (ADR-137, ADR-136, F-PROJ-07)", () => {
  const g1 = makeGroup(1);

  it("lists a group's members with their access, their commits and their share, the unattributed last; Resend for the one out", async () => {
    // 11 in all: Alice 6, Benoît 0 (no linked account), David 0 (expired), the unattributed 5.
    const repo = makeRepo(1, { fullName: "heig-tin-info/labo-2-groupe-1", unattributed: series(5) });
    const project = makeProject({
      groupMode: true,
      rows: [
        row(0, repo, {}, g1, "joined", series(6)),
        row(1, repo, { githubLogin: null }, g1, "unlinked", series(0)),
        row(3, repo, {}, g1, "expired", series(0)),
      ],
    });
    const { calls } = routes(project, { ...runs(repo), [`POST ${BASE}/repos/${repo.id}/invite`]: ok({ invitationStatus: "accepted", resentAt: PAST }) });
    renderPage(g1.id);
    expect(await screen.findByRole("heading", { level: 1, name: /Groupe 1/ })).toBeInTheDocument();
    expect(within(await header()).getByText("1/3 joined")).toBeInTheDocument();
    const members = within(screen.getByRole("region", { name: /Members/ }));
    const body = members.getAllByRole("row").slice(1) as HTMLTableRowElement[];
    expect(body.map((r) => r.cells[0]!.firstElementChild?.firstElementChild?.textContent ?? r.cells[0]!.textContent)).toEqual([
      "Dupont Alice",
      "Martin Benoît",
      "Favre David",
      "Unattributed",
    ]);
    expect(body[0]!.textContent).toMatch(/6/);
    expect(body[0]!.textContent).not.toMatch(/invitation|no GitHub/);
    expect(within(body[1]!).getAllByText("no GitHub account").length).toBeGreaterThan(0);
    expect(within(body[2]!).getAllByText("invitation expired").length).toBeGreaterThan(0);
    expect(within(body[3]!).getByText("5")).toBeInTheDocument();
    // The one out of it can be invited again: the repository's resend.
    expect(within(body[0]!).queryByRole("button", { name: "Resend" })).toBeNull();
    await userEvent.click(within(body[2]!).getByRole("button", { name: "Resend" }));
    await waitFor(() => expect(write(calls)).toEqual([expect.objectContaining({ method: "POST", url: `${BASE}/repos/${repo.id}/invite` })]));
    expect(await screen.findByText(/already has access/)).toBeInTheDocument();
    // The group follows its set.
    expect(within(screen.getByTestId("repo-facts")).getByText("Follows the group set")).toBeInTheDocument();
  });

  it("draws the weekly commits as a heatmap, each cell naming the person, the week and the count", async () => {
    const repo = makeRepo(1, { unattributed: series(2, "2026-11-02") });
    routes(makeProject({ startAt: "2026-10-26T08:00:00.000Z", deadlineAt: AHEAD, rows: [row(1, repo, {}, null, "joined", series(9))] }), runs(repo));
    renderPage(repo.id);
    const table = await screen.findByRole("table", { name: "Commits per member and per week" });
    const cells = [...table.querySelectorAll("td")];
    expect(cells.find((c) => c.title === "Martin Benoît, week of Nov 9: 9 commits")).toBeDefined();
    expect(cells.find((c) => c.title === "Unattributed, week of Nov 2: 2 commits")).toBeDefined();
    expect(cells.find((c) => c.title === "Martin Benoît, week of Oct 26: 0 commits")).toBeDefined();
  });

  it("holds one person on an individual repository, and says a repository with no commit has none", async () => {
    const repo = makeRepo(1, { commits: 0, lastCommit: null });
    routes(makeProject({ rows: [row(1, repo, {}, null, "joined", series(0))] }), runs(repo));
    renderPage(repo.id);
    const members = within(await screen.findByRole("region", { name: /Members/ }));
    expect(members.getAllByRole("row").slice(1)).toHaveLength(1);
    expect(screen.queryByTestId("repo-unattributed")).toBeNull();
    expect(screen.getByText("No commit received yet")).toBeInTheDocument();
  });

  it("shows a row not accepted yet with its members and nothing of GitHub", async () => {
    const project = makeProject({ rows: [row(1, makeRepo(1)), row(2, null, { claimed: false, githubLogin: null })] });
    routes(project);
    renderPage(project.rows[1]!.student.enrollmentId!);
    expect(await screen.findByRole("heading", { level: 1, name: /Rochat Chloé/ })).toBeInTheDocument();
    expect(within(await header()).getByText("not accepted")).toBeInTheDocument();
    expect(screen.getByText("seat not claimed")).toBeInTheDocument();
    expect(screen.queryByRole("link", { name: /heig-tin-info/ })).toBeNull();
    expect(screen.queryByRole("region", { name: "At a glance" })).toBeNull();
    expect(screen.queryByRole("region", { name: "Activity" })).toBeNull();
    expect(screen.queryByRole("region", { name: "Runs" })).toBeNull();
    expect(screen.queryByLabelText("Own deadline")).toBeNull();
  });
});

describe("the writes the former sheet held (M3-12b)", () => {
  it("lists the runs with their slots, and writes a deadline and a lock from the rail", async () => {
    const repo = makeRepo(1);
    let locked = false;
    const { calls } = routes(() => ok(makeProject({ rows: [row(1, locked ? { ...repo, locked: true, staffLock: true } : repo)] })), {
      ...runs(
        repo,
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
    renderPage(repo.id);
    const runRegion = await screen.findByRole("region", { name: "Runs" });
    const runRows = (await within(runRegion).findAllByRole("row")).slice(1);
    expect(runRows).toHaveLength(3);
    expect(runRows[0]!.textContent).toMatch(/after the deadline/);
    // A negative CI score counted 0 (M3-14n): the staff see the clamp and what the CI printed.
    expect(runRows[0]!.textContent).toMatch(/negative score, counted 0/);
    expect(runRows[0]!.textContent).toMatch(/-2\/10/);
    expect(runRows[1]!.textContent).toMatch(/current/);
    expect(runRows[2]!.textContent).toMatch(/4\/10/);
    expect(runRows[1]!.textContent).toMatch(/success/);
    // Accepted, not suspended: no Resend, no menu to re-enable.
    expect(screen.queryByRole("button", { name: /Resend/ })).toBeNull();
    expect(screen.queryByRole("button", { name: "More actions" })).toBeNull();

    const rail = within(screen.getByTestId("repo-deadline"));
    const own = rail.getByLabelText("Own deadline");
    fireEvent.change(own, { target: { value: "2099-06-01T23:59" } });
    fireEvent.blur(own);
    await waitFor(() => expect(write(calls)).toHaveLength(1));
    expect(write(calls)[0]).toMatchObject({ method: "PUT", url: `${BASE}/repos/${repo.id}/deadline`, body: { deadlineAt: new Date("2099-06-01T23:59").toISOString() } });
    await userEvent.click(rail.getByRole("button", { name: /Lock now/ }));
    await waitFor(() => expect(write(calls)).toHaveLength(2));
    expect(write(calls)[1]).toMatchObject({ method: "POST", url: `${BASE}/repos/${repo.id}/lock` });
    expect(await rail.findByRole("button", { name: /Unlock/ })).toBeInTheDocument();
  });

  it("offers no deadline nor lock on a deleted repository, and says why", async () => {
    const repo = makeRepo(1, { flags: { ...makeRepo(1).flags, deleted: true } });
    routes(makeProject({ rows: [row(1, repo)] }), runs(repo));
    renderPage(repo.id);
    const rail = within(await screen.findByTestId("repo-deadline"));
    expect(rail.getByText(/No action on this repository/)).toBeInTheDocument();
    expect(rail.getByRole("button", { name: /Lock now/ })).toBeDisabled();
    expect(rail.getByLabelText("Own deadline")).toBeDisabled();
    expect(await screen.findByText("No run yet")).toBeInTheDocument();
  });

  it("asks for the maximum when the repository has no scored run, sends it, and words the 422s and the 409s", async () => {
    const repo = frozenRepo(1, { scores: { ...makeRepo(1).scores, current: null, frozen: null, final: null, scoreMax: null } });
    let reply = fail(422, { error: "score_max_required", message: "" });
    const { calls } = routes(frozenProject({ rows: [row(1, repo)] }), { ...runs(repo), [`PATCH ${BASE}/repos/${repo.id}/score`]: () => reply });
    renderPage(repo.id);
    await userEvent.click(await screen.findByRole("button", { name: "Enter the score" }));
    const dialog = within(await screen.findByRole("dialog"));
    expect(dialog.getByText(/No scored run gives the maximum/)).toBeInTheDocument();
    const save = dialog.getByRole("button", { name: "Save" });
    await userEvent.type(dialog.getByRole("spinbutton", { name: "Points" }), "15");
    expect(save).toBeDisabled();
    await userEvent.type(dialog.getByRole("spinbutton", { name: "Out of" }), "20");
    await userEvent.click(save);
    await waitFor(() => expect(write(calls)).toHaveLength(1));
    expect(write(calls)[0]!.body).toEqual({ points: 15, max: 20, comment: "" });
    expect(await dialog.findByText(/Give the maximum: this repository has no scored run/)).toBeInTheDocument();
    reply = fail(409, { error: "not_frozen", message: "" });
    await userEvent.click(save);
    expect(await dialog.findByText("This repository is not frozen for good yet.")).toBeInTheDocument();
  });

  it("resends a pending invitation, once a minute (429 worded), and never an accepted one", async () => {
    const repo = makeRepo(1, { invitationStatus: "pending", lastCommit: null, ciStatus: "none" });
    let invitation: ProjectRepoView["invitationStatus"] = "pending";
    let reply = ok({ invitationStatus: "pending", resentAt: PAST });
    const { calls } = routes(
      () => ok(makeProject({ rows: [row(1, { ...repo, invitationStatus: invitation }, {}, null, invitation === "pending" ? "pending" : "joined")] })),
      {
        ...runs(repo),
        [`POST ${BASE}/repos/${repo.id}/invite`]: () => {
          if (reply.status === 200) invitation = (reply.body as { invitationStatus: typeof invitation }).invitationStatus;
          return reply;
        },
      },
    );
    renderPage(repo.id);
    const resend = await screen.findByRole("button", { name: "Resend" });
    await userEvent.click(resend);
    await waitFor(() => expect(write(calls)).toEqual([expect.objectContaining({ method: "POST", url: `${BASE}/repos/${repo.id}/invite` })]));
    expect(await screen.findByText("Invitation resent")).toBeInTheDocument();
    reply = fail(429, { error: "resend_too_soon", message: "" });
    await userEvent.click(resend);
    expect(await screen.findByText(/resent less than a minute ago/)).toBeInTheDocument();
    reply = ok({ invitationStatus: "accepted", resentAt: PAST });
    await userEvent.click(resend);
    expect(await screen.findByText(/already has access/)).toBeInTheDocument();
    await waitFor(() => expect(screen.queryByRole("button", { name: "Resend" })).toBeNull());
  });

  it("re-enables the protection from the overflow menu, which clears the conflict tag", async () => {
    const repo = makeRepo(1, { flags: { ...makeRepo(1).flags, protectionSuspended: true, toVerify: true } });
    let suspended = true;
    const { calls } = routes(() => ok(makeProject({ rows: [row(1, { ...repo, flags: { ...repo.flags, protectionSuspended: suspended } })] })), {
      ...runs(repo),
      [`POST ${BASE}/repos/${repo.id}/protection`]: () => {
        suspended = false;
        return ok({ reenabledAt: PAST });
      },
    });
    renderPage(repo.id);
    const tags = within(await screen.findByTestId("repo-tags"));
    expect(tags.getByText("protected files in conflict")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "More actions" }));
    const item = await screen.findByRole("menuitem", { name: /Re-enable the protection/ });
    expect(item).toHaveTextContent(/Runs already marked “to verify” stay so/);
    await userEvent.click(item);
    await waitFor(() => expect(write(calls)).toEqual([expect.objectContaining({ method: "POST", url: `${BASE}/repos/${repo.id}/protection` })]));
    expect(await screen.findByText("Protection re-enabled. Past runs stay to verify")).toBeInTheDocument();
    await waitFor(() => expect(screen.queryByText("protected files in conflict")).toBeNull());
    expect(screen.queryByRole("button", { name: "More actions" })).toBeNull();
    // The "to verify" mark stays: only the conflict went.
    expect(within(screen.getByTestId("repo-tags")).getByText("to verify")).toBeInTheDocument();
  });

  it("says the final review's detail in the scores: when it was asked, of which commit", async () => {
    const sha = "9a3f1c7e2b4d6f8a0c1e3b5d7f9a1c3e5b7d9f1a";
    const asked = frozenRepo(7, { review: { status: "asked", reason: null, askedAt: PAST, sha, runId: null } });
    const degraded = frozenRepo(5, { review: { status: "skipped", reason: "protection_suspended", askedAt: null, sha: null, runId: null } });
    routes(frozenProject({ rows: [row(7, asked), row(5, degraded)] }), { ...runs(asked), ...runs(degraded) });
    renderPage(asked.id);
    const scores = within(await screen.findByTestId("repo-scores"));
    expect(scores.getByText("Final review")).toBeInTheDocument();
    expect(scores.getByText(/^Asked on .*, of commit 9a3f1c7\./)).toBeInTheDocument();
  });

  it("places the final score in the class: its rank and the median", async () => {
    const at = (n: number, points: number) =>
      frozenRepo(n, { scores: { ...frozenRepo(n).scores, final: { points, max: 10, source: "review", toVerify: false, grade: { grade: 4 } } } });
    routes(frozenProject({ rows: [row(1, at(1, 6)), row(2, at(2, 9)), row(3, at(3, 4)), row(4, at(4, 8))] }), runs(at(1, 6)));
    renderPage(at(1, 6).id);
    const place = within(await screen.findByTestId("repo-class"));
    expect(place.getByText("Rank 3 of 4")).toBeInTheDocument();
    expect(place.getByText("Median 70%")).toBeInTheDocument();
  });
});

describe("in French", () => {
  it("reads the page, the review's state and the teacher's score in French", async () => {
    const repo = frozenRepo(1, { review: { status: "unconfirmed", reason: null, askedAt: null, sha: "abc", runId: null } });
    routes(frozenProject({ rows: [row(1, repo)] }), runs(repo));
    renderPage(repo.id, { locale: "fr" });
    expect(await screen.findByRole("region", { name: /Membres/ })).toBeInTheDocument();
    expect(screen.getByText("Revue finale")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Saisir le score" }));
    const dialog = within(await screen.findByRole("dialog"));
    expect(dialog.getByRole("button", { name: "Enregistrer" })).toBeInTheDocument();
  });
});
