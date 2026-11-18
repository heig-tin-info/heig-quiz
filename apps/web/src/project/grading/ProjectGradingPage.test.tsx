import { cleanup, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import type { CriteriaTableRow, ProjectGradingRepo, ProjectGradingView } from "@quiz/contracts";

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

function routes(grading: RouteHandler, extra: Record<string, RouteHandler> = {}) {
  return mockFetch({
    [`GET ${BASE}/grading`]: grading,
    [`GET /app/api/classrooms/${CLASSROOM}`]: ok({ id: CLASSROOM, name: "PRG1-2026", course: { id: "c1", code: "PRG1", name: "C" }, roster: [] }),
    ...extra,
  });
}

function renderPage(locale: "en" | "fr" = "en") {
  const navigate = vi.fn();
  renderWithProviders(<ProjectGradingPage id={ID} navigate={navigate} />, { locale, queryClient: makeQueryClient() });
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
