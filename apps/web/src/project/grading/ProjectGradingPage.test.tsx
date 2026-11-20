import { cleanup, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import type { CourseRole, CriteriaTableRow, ProjectContestations, ProjectGradingRepo, ProjectGradingView, ProjectStaffContestation } from "@quiz/contracts";

import { coursesKey } from "../../queryKeys";
import { makeCourseSummary } from "../../test/fixtures";
import { fail, makeQueryClient, mockFetch, ok, renderWithProviders, type RouteHandler } from "../../test/render";
import { ProjectGradingPage } from "./ProjectGradingPage";

/*
 * The grading screen of a project graded by criteria (ADR-106 §8, L-02e):
 * its states, a rationale shown as text, the one primary action —
 * Validate held while a criterion has no points, then Validate, then Next,
 * then Release —, a teacher's points written in place, ← / →, and French.
 */

const ID = "0190d3c4-0000-7000-8000-0000000000c1";
const CLASSROOM = "0190d3c4-0000-7000-8000-0000000000aa";
const BASE = `/app/api/projects/${ID}`;
const XSS = "<script>alert(1)</script>";

const line = (over: Partial<CriteriaTableRow> & Pick<CriteriaTableRow, "criterionId">): CriteriaTableRow => ({
  section: "rapport",
  description: over.criterionId,
  max: 4,
  points: 3,
  state: "proposed",
  locked: false,
  source: "llm",
  ...over,
});

function repo(id: string, label: string, over: Partial<ProjectGradingRepo> = {}): ProjectGradingRepo {
  return {
    id,
    label,
    group: false,
    frozen: true,
    validation: { validated: false, missing: ["git.commits"], proposed: ["rendu.tests", "rapport.reponses"] },
    table: [
      line({ criterionId: "rendu.tests", description: "Tests pass", section: "rendu", max: 12, points: 9, source: "auto", locked: true }),
      line({ criterionId: "rapport.reponses", description: "Answers", rationale: XSS }),
      { criterionId: "git.commits", section: "git", description: "Clean history", max: 1, points: null, state: "empty", locked: false },
    ],
    evidence: {
      status: "ok",
      reason: null,
      targetSha: "9a3f1c7e2b4d6f8a0c1e3b5d7f9a1c3e5b7d9f1a",
      distributionSha: "d",
      casesPassed: 9,
      casesTotal: 12,
      build: { exitCode: 0, timedOut: false },
      test: { exitCode: 1, timedOut: false },
      createdAt: "2026-10-09T22:50:00.000Z",
    },
    total: null,
    grade: null,
    adjustment: null,
    pass: null,
    ...over,
  };
}

const A = "0190d3c4-0000-7000-8000-000000000001";
const B = "0190d3c4-0000-7000-8000-000000000002";
const view = (repos: ProjectGradingRepo[], project: Partial<ProjectGradingView["project"]> = {}): ProjectGradingView => ({
  project: { id: ID, classroomId: CLASSROOM, name: "Labo 00", deadlineAt: "2026-10-09T22:00:00.000Z", schemaVersion: 2, released: false, ...project },
  repos,
});

/** No contestation, the window not applying: what an unreleased project answers (ADR-139 §13). */
const NO_CONTESTATIONS: ProjectContestations = { applies: false, closesAt: null, openByRepo: {}, contestations: [] };

function routes(grading: RouteHandler, extra: Record<string, RouteHandler> = {}) {
  return mockFetch({
    [`GET ${BASE}/grading`]: grading,
    [`GET ${BASE}/contestations`]: ok(NO_CONTESTATIONS),
    [`GET /app/api/classrooms/${CLASSROOM}`]: ok({ id: CLASSROOM, name: "PRG1-2026", course: { id: "c1", code: "PRG1", name: "C" }, roster: [] }),
    ...extra,
  });
}

/** The page, its reader the course's owner unless `role` says otherwise (the course list already read; `null`: not known, the list failing). */
function renderPage(locale: "en" | "fr" = "en", role: CourseRole | null = "owner") {
  const navigate = vi.fn();
  const queryClient = makeQueryClient();
  if (role) queryClient.setQueryData(coursesKey, [makeCourseSummary({ id: "c1", myRole: role })]);
  renderWithProviders(<ProjectGradingPage id={ID} navigate={navigate} />, { locale, queryClient });
  return { navigate };
}

describe("the grading screen's states", () => {
  it("shows the repository's criteria, a rationale as text, and holds Validate while a criterion has no points", async () => {
    routes(ok(view([repo(A, "Bernasconi Zoé"), repo(B, "Rossi Luca")])));
    renderPage();
    const table = await screen.findByRole("table", { name: "Criteria of Bernasconi Zoé" });
    expect(within(table).getByText("Tests pass")).toBeInTheDocument();
    // The maximum and the points awarded are one column, one pill (F-PROJ-25 as amended).
    expect(within(table).getAllByRole("columnheader").map((h) => h.textContent)).toEqual(["Criterion", "Points", "Source", "State"]);
    const tests = within(table).getByRole("spinbutton", { name: "Tests pass", description: "points out of 12" });
    expect(tests).toHaveValue(9);
    expect(tests.closest("td")).toHaveTextContent("/ 12");
    // No points yet: an empty pill, its placeholder a dash.
    const none = within(table).getByRole("spinbutton", { name: "Clean history", description: "points out of 1" });
    expect(none).toHaveValue(null);
    expect(none).toHaveAttribute("placeholder", "—");
    // A milestone's lock beside the state, on its row only (ADR-106 §5).
    const locks = within(table).getAllByRole("img", { name: /^Locked by a checkpoint/ });
    expect(locks).toHaveLength(1);
    expect(locks[0]!.closest("tr")).toHaveTextContent("Tests pass");
    expect(screen.getByText("Tests: 9 of 12 passed")).toBeInTheDocument();
    // The missing teacher-only criterion is named above the table, Validate held.
    expect(screen.getByText("Give these criteria points first, 0 included:")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Validate/ })).toBeDisabled();
    // A rationale is text: the script is shown, never run nor parsed.
    await userEvent.click(within(table).getAllByRole("button", { name: "Rationale" })[1]!);
    expect(within(table).getByText(XSS)).toBeInTheDocument();
    expect(document.querySelector("script")).toBeNull();
  });

  it("says when nothing is frozen yet", async () => {
    routes(ok(view([repo(A, "Bernasconi Zoé", { frozen: false })])));
    renderPage();
    expect(await screen.findByText("Nothing to grade yet")).toBeInTheDocument();
  });

  it("names a failed load", async () => {
    routes(fail(500, { message: "boom" }));
    renderPage();
    expect(await screen.findByText("The grading screen could not be loaded")).toBeInTheDocument();
  });
});

describe("grading", () => {
  it("writes a teacher's points when the field is left, then validates, then goes on to the next", async () => {
    const graded = repo(A, "Bernasconi Zoé", {
      validation: { validated: false, missing: [], proposed: ["rendu.tests", "rapport.reponses", "git.commits"] },
    });
    const validated = repo(A, "Bernasconi Zoé", { validation: { validated: true, missing: [], proposed: [] }, total: { points: 12, max: 17 } });
    const { calls } = routes(ok(view([repo(A, "Bernasconi Zoé"), repo(B, "Rossi Luca")])), {
      [`PUT ${BASE}/repos/${A}/criteria/git.commits`]: ok(graded),
      [`POST ${BASE}/repos/${A}/validate`]: ok(validated),
    });
    renderPage();
    const input = await screen.findByRole("spinbutton", { name: "Clean history", description: "points out of 1" });
    // Out of range: said on the field, never sent.
    await userEvent.type(input, "3{Enter}");
    expect(input).toHaveAttribute("aria-invalid", "true");
    await userEvent.clear(input);
    await userEvent.type(input, "0{Enter}");
    await waitFor(() => expect(calls.some((c) => c.method === "PUT")).toBe(true));
    expect(calls.filter((c) => c.method === "PUT").map((c) => c.body)).toEqual([{ points: 0 }]);
    await waitFor(() => expect(screen.getByRole("button", { name: /^Validate$/ })).toBeEnabled());
    await userEvent.click(screen.getByRole("button", { name: /^Validate$/ }));
    expect(await screen.findByText("Total 12 / 17")).toBeInTheDocument();
    // Validated: the primary turns into Next (the bar's chevron bears the same name).
    expect(screen.getAllByRole("button", { name: "Next repository" })).toHaveLength(2);
  });

  it("walks the repositories with → and leads to the release once every one is validated", async () => {
    const done = (id: string, label: string) => repo(id, label, { validation: { validated: true, missing: [], proposed: [] } });
    routes(ok(view([done(A, "Bernasconi Zoé"), done(B, "Rossi Luca")])));
    const { navigate } = renderPage();
    await screen.findByRole("table", { name: "Criteria of Bernasconi Zoé" });
    await userEvent.keyboard("{ArrowRight}");
    expect(await screen.findByRole("table", { name: "Criteria of Rossi Luca" })).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: /Release scores/ }));
    expect(navigate).toHaveBeenCalledWith({ view: "project", id: ID });
  });

  it("shows the latest CI pass's trace to the staff: the files replaced, their paths on demand, the rows a failure kept (ADR-132 §6)", async () => {
    const pass = {
      replaced: { count: 3, paths: ["criteria.yml", "tests/check.sh"] },
      kept: [
        { criterionId: "rendu.tests", reason: "no_result" as const },
        { criterionId: "git.commits", reason: "no_result" as const },
      ],
    };
    routes(ok(view([repo(A, "Bernasconi Zoé", { pass }), repo(B, "Rossi Luca", { pass: { replaced: { count: 0, paths: [] }, kept: [] } })])));
    renderPage();
    const fold = await screen.findByRole("button", { name: "3 files replaced by the distribution's version" });
    expect(screen.queryByText("tests/check.sh")).toBeNull();
    await userEvent.click(fold);
    expect(screen.getByText("tests/check.sh")).toBeInTheDocument();
    expect(screen.getByText("and 1 more")).toBeInTheDocument();
    expect(screen.getByText("No new result for Tests pass, Clean history (No CI result): their earlier rows stay")).toBeInTheDocument();
    // The rail flags the repository whose latest pass kept earlier rows, and only it.
    const rail = screen.getByRole("navigation", { name: "Repositories" });
    expect(within(rail).getByRole("button", { name: /^Question 1,.*earlier rows kept/ })).toBeInTheDocument();
    expect(within(rail).getByRole("button", { name: /^Question 2,/ })).not.toHaveAccessibleName(/earlier rows kept/);
    // Nothing replaced and nothing kept: no line.
    await userEvent.keyboard("{ArrowRight}");
    await screen.findByRole("table", { name: "Criteria of Rossi Luca" });
    expect(screen.queryByText(/replaced by the distribution's version/)).toBeNull();
  });

  it("says what a Regrade does: a schema-2 project's copy, a schema-3 one's, and once released the acknowledgement it sends", async () => {
    const regraded = (project: Partial<ProjectGradingView["project"]>, reply = ok({ repos: 1 })) => {
      const result = routes(ok(view([repo(A, "Bernasconi Zoé")], project)), { [`POST ${BASE}/repos/${A}/regrade`]: reply });
      renderPage();
      return result;
    };
    const confirmRegrade = async () => {
      await userEvent.click(await screen.findByRole("button", { name: "More actions" }));
      await userEvent.click(screen.getByRole("menuitem", { name: "Regrade this repository" }));
      return screen.findByRole("dialog");
    };

    regraded({ schemaVersion: 2 });
    const v2 = await confirmRegrade();
    expect(v2).toHaveTextContent("Validated rows and teachers' rows stay.");
    cleanup();

    regraded({ schemaVersion: 3 });
    const v3 = await confirmRegrade();
    expect(v3).toHaveTextContent("validated ones included");
    expect(v3).not.toHaveTextContent("The project is released.");
    cleanup();

    const { calls } = regraded({ schemaVersion: 3, released: true });
    const dialog = await confirmRegrade();
    expect(dialog).toHaveTextContent("Students keep the released grade until you release again");
    await userEvent.click(within(dialog).getByRole("button", { name: "Regrade" }));
    await waitFor(() => expect(calls.some((c) => c.method === "POST")).toBe(true));
    expect(calls.filter((c) => c.method === "POST").map((c) => c.body)).toEqual([{ releasedAcknowledged: true }]);
    cleanup();

    // A released schema-2 project: the old copy, the acknowledgement sent all the same (the server ignores it there).
    const v2Released = regraded({ schemaVersion: 2, released: true });
    const old = await confirmRegrade();
    expect(old).not.toHaveTextContent("The project is released.");
    await userEvent.click(within(old).getByRole("button", { name: "Regrade" }));
    await waitFor(() => expect(v2Released.calls.some((c) => c.method === "POST")).toBe(true));
    expect(v2Released.calls.filter((c) => c.method === "POST").map((c) => c.body)).toEqual([{ releasedAcknowledged: true }]);
    cleanup();

    // Released meanwhile in another tab: refused, the screen re-reads the project.
    const stale = regraded({ schemaVersion: 3 }, fail(409, { error: "regrade_released", message: "released" }));
    const refused = await confirmRegrade();
    await userEvent.click(within(refused).getByRole("button", { name: "Regrade" }));
    expect(await screen.findByText("The project is released: confirm the regrade again to replace validated rows.")).toBeInTheDocument();
    await waitFor(() => expect(stale.calls.filter((c) => c.method === "GET" && c.url.endsWith("/grading"))).toHaveLength(2));
  });

  it("speaks French", async () => {
    routes(ok(view([repo(A, "Bernasconi Zoé")])));
    renderPage("fr");
    expect(await screen.findByRole("table", { name: "Critères de Bernasconi Zoé" })).toBeInTheDocument();
    expect(screen.getByText("Tests : 9 sur 12 réussis")).toBeInTheDocument();
  });
});

describe("contestations and the owner's writes on a released project (ADR-139 §13)", () => {
  const RELEASED = { released: true, schemaVersion: 3 as const };
  const contestation = (over: Partial<ProjectStaffContestation> & Pick<ProjectStaffContestation, "id" | "criterionId">): ProjectStaffContestation => ({
    repoId: A,
    criterionDescription: over.criterionId,
    pointsAtFiling: 3,
    maxAtFiling: 4,
    bonusAtFiling: null,
    state: "open",
    reason: "Question 6 is answered on page 3.",
    filedAt: "2026-11-15T10:00:00.000Z",
    reply: null,
    resolvedAt: null,
    counted: true,
    inSnapshot: true,
    ...over,
  });
  const OPEN = "0190d3c4-0000-7000-8000-0000000cc001";
  const GONE = "0190d3c4-0000-7000-8000-0000000cc002";
  const DONE = "0190d3c4-0000-7000-8000-0000000cc003";
  const list = (...contestations: ProjectStaffContestation[]): ProjectContestations => ({
    applies: true,
    closesAt: "2030-01-01T00:00:00.000Z",
    openByRepo: { [A]: contestations.filter((c) => c.state === "open").length },
    contestations,
  });
  const validated = () => repo(A, "Bernasconi Zoé", { validation: { validated: true, missing: [], proposed: [] } });

  it("gives the owner the answer: the reason, new points with a reply, and Accept", async () => {
    const answered = { contestation: contestation({ id: OPEN, criterionId: "rapport.reponses", state: "accepted" }), repo: null };
    const other = repo(B, "Rossi Luca", { validation: { validated: true, missing: [], proposed: [] } });
    const { calls } = routes(ok(view([validated(), other], RELEASED)), {
      [`GET ${BASE}/contestations`]: ok(list(contestation({ id: OPEN, criterionId: "rapport.reponses", criterionDescription: "Answers" }))),
      [`POST ${BASE}/contestations/${OPEN}/resolve`]: ok(answered),
    });
    renderPage();
    const table = await screen.findByRole("table", { name: "Criteria of Bernasconi Zoé" });
    // The contested criterion's row carries the mark; the rail flags the repository.
    expect(within(table).getByText("contested")).toBeInTheDocument();
    const rail = screen.getByRole("navigation", { name: "Repositories" });
    expect(within(rail).getByRole("button", { name: /^Question 1,.*1 open contestation/ })).toBeInTheDocument();
    expect(within(rail).getByRole("button", { name: /^Question 2,/ })).not.toHaveAccessibleName(/contestation/);
    const card = await screen.findByRole("region", { name: "Contestation of “Answers”" });
    expect(within(card).getByText("Question 6 is answered on page 3.")).toBeInTheDocument();
    expect(within(card).getByText("When contested: 3 / 4")).toBeInTheDocument();
    // New points need a reply: said on the field, nothing sent.
    await userEvent.click(within(card).getByRole("switch", { name: "Change the points" }));
    const points = within(card).getByRole("spinbutton", { name: "Points" });
    await userEvent.clear(points);
    await userEvent.type(points, "9");
    expect(within(card).getByText("From 0 to 4")).toBeInTheDocument();
    await userEvent.clear(points);
    await userEvent.type(points, "3.5");
    await userEvent.click(within(card).getByRole("button", { name: "Accept" }));
    expect(within(card).getAllByText("Required to refuse or to change the points.").length).toBeGreaterThan(0);
    expect(calls.some((c) => c.method === "POST")).toBe(false);
    await userEvent.type(within(card).getByRole("textbox", { name: "Reply" }), "Right, page 3 answers it.");
    await userEvent.type(within(card).getByRole("textbox", { name: "Rationale" }), " Question 6 is answered.");
    await userEvent.click(within(card).getByRole("button", { name: "Accept" }));
    await waitFor(() => expect(calls.some((c) => c.method === "POST")).toBe(true));
    expect(calls.find((c) => c.method === "POST")?.body).toEqual({
      verdict: "accepted",
      reply: "Right, page 3 answers it.",
      points: 3.5,
      rationale: "<script>alert(1)</script> Question 6 is answered.",
    });
  });

  it("offers only Refuse on a criterion that left the snapshot, and says why", async () => {
    const { calls } = routes(ok(view([validated()], RELEASED)), {
      [`GET ${BASE}/contestations`]: ok(list(contestation({ id: GONE, criterionId: "rapport.ortho", criterionDescription: "Spelling", inSnapshot: false, counted: false }))),
      [`POST ${BASE}/contestations/${GONE}/resolve`]: fail(409, { error: "not_open", message: "x" }),
    });
    renderPage();
    const card = await screen.findByRole("region", { name: "Contestation of “Spelling”" });
    expect(within(card).getByText("This criterion left the project's criteria: the contestation can only be refused.")).toBeInTheDocument();
    expect(within(card).getByText("This repository does not count for the grade.")).toBeInTheDocument();
    expect(within(card).queryByRole("button", { name: "Accept" })).toBeNull();
    expect(within(card).queryByRole("switch")).toBeNull();
    await userEvent.type(within(card).getByRole("textbox", { name: "Reply" }), "The criterion is gone.");
    await userEvent.click(within(card).getByRole("button", { name: "Refuse" }));
    await waitFor(() => expect(calls.some((c) => c.method === "POST")).toBe(true));
    expect(calls.find((c) => c.method === "POST")?.body).toEqual({ verdict: "refused", reply: "The criterion is gone." });
    // Answered meanwhile: worded, and the screen reads again.
    expect(await within(card).findByText("This contestation already has its answer.")).toBeInTheDocument();
  });

  it("words a criterion's refusals of the answer", async () => {
    routes(ok(view([validated()], RELEASED)), {
      [`GET ${BASE}/contestations`]: ok(list(contestation({ id: OPEN, criterionId: "rapport.reponses", criterionDescription: "Answers" }))),
      [`POST ${BASE}/contestations/${OPEN}/resolve`]: fail(409, { error: "criterion_removed", message: "x" }),
    });
    renderPage();
    const card = await screen.findByRole("region", { name: "Contestation of “Answers”" });
    await userEvent.click(within(card).getByRole("button", { name: "Accept" }));
    expect(await within(card).findByText("This criterion left the project's criteria: refuse the contestation.")).toBeInTheDocument();
  });

  it("shows an answered contestation as read, with no answer to give", async () => {
    routes(ok(view([validated()], RELEASED)), {
      [`GET ${BASE}/contestations`]: ok(
        list(contestation({ id: DONE, criterionId: "rapport.reponses", criterionDescription: "Answers", state: "refused", reply: "No.", resolvedAt: "2026-11-16T10:00:00.000Z" })),
      ),
    });
    renderPage();
    const card = await screen.findByRole("region", { name: "Contestation of “Answers”" });
    expect(within(card).getByText("Contestation refused")).toBeInTheDocument();
    expect(within(card).getByText("No.")).toBeInTheDocument();
    expect(within(card).queryByRole("button", { name: "Refuse" })).toBeNull();
    expect(within(screen.getByRole("table", { name: "Criteria of Bernasconi Zoé" })).getByText("refused")).toBeInTheDocument();
  });

  it("holds nothing for a reader whose role is not known yet: no lock, Validate and the points writable, no answer offered", async () => {
    routes(ok(view([repo(A, "Bernasconi Zoé", { validation: { validated: false, missing: [], proposed: ["rendu.tests"] } })], RELEASED)), {
      [`GET ${BASE}/contestations`]: ok(list(contestation({ id: OPEN, criterionId: "rapport.reponses", criterionDescription: "Answers" }))),
    });
    renderPage("en", null);
    const table = await screen.findByRole("table", { name: "Criteria of Bernasconi Zoé" });
    expect(screen.queryByText("The grades are released: only the person who runs the course can change them now.")).toBeNull();
    expect(screen.getByRole("button", { name: /^Validate$/ })).toBeEnabled();
    expect(within(table).getAllByRole("spinbutton").length).toBeGreaterThan(0);
    const card = await screen.findByRole("region", { name: "Contestation of “Answers”" });
    expect(within(card).queryByRole("button", { name: "Refuse" })).toBeNull();
    expect(within(card).queryByText("The answer is the course's Teacher role's.")).toBeNull();
  });

  it("holds every criterion write of a released project for an assistant, who reads the contestation and who answers it", async () => {
    routes(ok(view([repo(A, "Bernasconi Zoé", { validation: { validated: false, missing: [], proposed: ["rendu.tests"] } })], RELEASED)), {
      [`GET ${BASE}/contestations`]: ok(list(contestation({ id: OPEN, criterionId: "rapport.reponses", criterionDescription: "Answers" }))),
    });
    renderPage("en", "assistant");
    const table = await screen.findByRole("table", { name: "Criteria of Bernasconi Zoé" });
    const sentence = "The grades are released: only the person who runs the course can change them now.";
    expect(screen.getAllByText(sentence).length).toBeGreaterThan(0);
    // The points are text, Validate held, the menu's writes disabled with the same sentence.
    expect(within(table).queryByRole("spinbutton")).toBeNull();
    expect(screen.getByRole("button", { name: /^Validate$/ })).toBeDisabled();
    await userEvent.click(screen.getByRole("button", { name: "More actions" }));
    for (const name of [/^Validate the rest/, /^Regrade this repository/, /^Regrade every repository/]) {
      expect(screen.getByRole("menuitem", { name })).toHaveAttribute("aria-disabled", "true");
    }
    await userEvent.keyboard("{Escape}");
    const card = screen.getByRole("region", { name: "Contestation of “Answers”" });
    expect(within(card).getByText("The answer is the course's Teacher role's.")).toBeInTheDocument();
    expect(within(card).queryByRole("button", { name: "Refuse" })).toBeNull();
  });
});
