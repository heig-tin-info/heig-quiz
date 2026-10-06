import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { Me, StudentProject } from "@quiz/contracts";

import type { Locale } from "../i18n";
import { makeMe } from "../test/fixtures";
import { fail, makeQueryClient, mockFetch, ok, renderWithProviders } from "../test/render";
import { meKey } from "../queryKeys";
import { TOURS } from "../coach/catalog";
import { StudentProjectPage } from "./StudentProjectPage";

/*
 * The student's project page (F-PROJ-15, M3-13): its states, the facts it
 * shows — the repository and its invitation with the student's Resend, the
 * evaluated commit and its run, the indicative score, the frozen score, the
 * release — the one action it shares with the row, and the server's clock
 * (invariant 5) every gate and countdown reads.
 */

const NOW = Date.now();
const DAY = 86_400_000;
const at = (days: number) => new Date(NOW + days * DAY).toISOString();
const SHA = "9a3f1c7e2b4d6f8a0c1e3b5d7f9a1c3e5b7d9f1a";
const URL = "GET /app/api/student/projects/p1";
const INVITE = "POST /app/api/student/projects/p1/invite";

const project = (over: Partial<StudentProject> = {}): StudentProject => ({
  kind: "project",
  seat: "student",
  id: "p1",
  title: "Labo 1 — Pointeurs",
  classroomId: "r1",
  classroomName: "PRG1-2026",
  courseCode: "PRG1",
  startAt: at(-3),
  deadlineAt: at(6),
  status: "in_progress",
  githubLinked: true,
  gradingMode: "auto",
  repo: {
    fullName: "heig/labo-1-lea",
    url: "https://github.com/heig/labo-1-lea",
    invitation: "accepted",
    deleted: false,
    locked: false,
    lastCommit: { sha: SHA, at: at(-0.1) },
    commits: 3,
    ciStatus: "pass",
    run: { sha: SHA, url: "https://github.com/heig/labo-1-lea/actions/runs/42", conclusion: "success", completedAt: at(-0.1) },
    score: { points: 34, max: 40, grade: { grade: 5.3, fellBack: false }, frozen: false },
  },
  release: null,
  serverNow: at(0),
  ...over,
});

const student: Me = makeMe({ id: "u1", role: "student" });

/** How many times the page read the project. */
const reads = (calls: { method: string; url: string }[]) =>
  calls.filter((c) => c.method === "GET" && c.url === "/app/api/student/projects/p1").length;

function render({ me = student, locale = "en" }: { me?: Me; locale?: Locale } = {}) {
  const navigate = vi.fn();
  const queryClient = makeQueryClient();
  queryClient.setQueryData(meKey, me);
  const r = renderWithProviders(<StudentProjectPage id="p1" navigate={navigate} />, { locale, route: "/projects/p1", queryClient });
  return { ...r, navigate };
}

afterEach(() => sessionStorage.clear());

describe("the page's states", () => {
  it("shows a skeleton while it loads", () => {
    mockFetch({});
    render();
    expect(document.querySelector(".animate-pulse")).not.toBeNull();
  });

  it("reads a 404 as a project that does not exist, with the way back", async () => {
    mockFetch({ [URL]: fail(404, { message: "Not found" }) });
    const { navigate } = render();
    expect(await screen.findByRole("heading", { level: 1, name: /does not exist/ })).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Back to my activities" }));
    expect(navigate).toHaveBeenCalledWith({ view: "home" });
  });

  it("shows the error with a retry", async () => {
    mockFetch({ [URL]: fail(500, { message: "boom" }) });
    render();
    expect(await screen.findByText("boom")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /retry/i })).toBeInTheDocument();
  });
});

describe("a project in progress", () => {
  it("names the project, its classroom once, its deadline, the repository and the last commit", async () => {
    mockFetch({ [URL]: ok(project()) });
    const { navigate } = render();
    expect(await screen.findByRole("heading", { level: 1, name: "Labo 1 — Pointeurs" })).toBeInTheDocument();
    expect(screen.getByText("in progress")).toBeInTheDocument();
    expect(screen.getByText(/^Due [^·]+ · .* left$/)).toBeInTheDocument();
    expect(screen.getAllByText("PRG1-2026")).toHaveLength(1);
    // The header keeps the deadline, the status and the commit, named; the CI and the score have their sections.
    expect(screen.getByText("Last commit")).toBeInTheDocument();
    expect(screen.getByText("3 commits")).toBeInTheDocument();

    const repo = screen.getByRole("link", { name: /heig\/labo-1-lea/ });
    expect(repo).toHaveAttribute("href", "https://github.com/heig/labo-1-lea");
    expect(repo).toHaveAttribute("target", "_blank");
    expect(screen.getAllByText("9a3f1c7")).toHaveLength(1);
    // The CI badge is the run's section, not the header's.
    expect(screen.getAllByText("pass")).toHaveLength(1);
    expect(screen.queryByText("PRG1")).toBeNull();
    expect(screen.queryByText(/Invitation/)).toBeNull();
    expect(screen.queryByRole("button", { name: "Resend the invitation" })).toBeNull();

    // The breadcrumb: Courses > the classroom > the project, real addresses.
    const trail = screen.getByRole("navigation", { name: "Breadcrumb" });
    const courses = within(trail).getByRole("link", { name: "Courses" });
    expect(courses).toHaveAttribute("href", "/courses");
    const room = within(trail).getByRole("link", { name: "PRG1-2026" });
    expect(room).toHaveAttribute("href", "/classrooms/r1");
    expect(within(trail).getByText("Labo 1 — Pointeurs")).toHaveAttribute("aria-current", "page");
    await userEvent.click(courses);
    expect(navigate).toHaveBeenCalledWith({ view: "studentCourses" });
    await userEvent.click(room);
    expect(navigate).toHaveBeenCalledWith({ view: "classroom", id: "r1" });
  });

  it("marks the current score indicative, links the run it comes from, and offers the repository as the only action", async () => {
    mockFetch({ [URL]: ok(project()) });
    render();
    expect(await screen.findByText("Indicative score")).toBeInTheDocument();
    expect(screen.getAllByText("34 / 40")).toHaveLength(1);
    expect(screen.getByText(/From the latest graded commit\. Indicative until your teacher publishes the scores\./)).toBeInTheDocument();
    expect(screen.getByText("Grade")).toBeInTheDocument();
    expect(screen.getByText("5.3")).toBeInTheDocument();
    expect(screen.getAllByText(/indicative/).length).toBeGreaterThan(0);
    expect(screen.getByRole("link", { name: /See the run on GitHub/ })).toHaveAttribute(
      "href",
      "https://github.com/heig/labo-1-lea/actions/runs/42",
    );
    // GitHub's raw conclusion is never printed: the CI badge says it, translated.
    expect(screen.queryByText("success")).toBeNull();
    const open = screen.getByRole("link", { name: "Open repository" });
    expect(open).not.toHaveClass("bg-accent");
    expect(document.querySelectorAll(".bg-accent")).toHaveLength(0);
  });

  it("says the frozen score is frozen at the deadline, still indicative, on the evaluated commit", async () => {
    const p = project({
      status: "locked",
      deadlineAt: at(-1),
      repo: { ...project().repo!, locked: true, score: { points: 30, max: 40, grade: null, frozen: true } },
    });
    mockFetch({ [URL]: ok(p) });
    render();
    expect(await screen.findByText("Score at the deadline")).toBeInTheDocument();
    expect(screen.getAllByText("30 / 40")).toHaveLength(1);
    expect(screen.getByText(/Frozen at the deadline\. Indicative until/)).toBeInTheDocument();
    expect(screen.getByText("Evaluated commit")).toBeInTheDocument();
    expect(screen.getByText("locked")).toBeInTheDocument();
    expect(screen.getByText("Read-only since the deadline")).toBeInTheDocument();
    // A passed deadline is said once, with no countdown.
    expect(screen.getByText(/^Closed /)).toBeInTheDocument();
    expect(screen.queryByText("Grade")).toBeNull();
  });

  it("judges the deadline on the server's clock, not the browser's (invariant 5)", async () => {
    // The browser is a day ahead of the server: the deadline in two hours has
    // not passed, so the page still counts down to it.
    const serverNow = at(-1);
    const p = project({ deadlineAt: new Date(Date.parse(serverNow) + 2 * 3_600_000).toISOString(), serverNow });
    mockFetch({ [URL]: ok(p) });
    render();
    expect(await screen.findByText(/^Due [^·]+ · .* left$/)).toBeInTheDocument();
    expect(screen.getByText("Last commit")).toBeInTheDocument();
  });

  it("shows no score section at all under grading none, and 'no score yet' without a graded run", async () => {
    mockFetch({ [URL]: ok(project({ gradingMode: "none", repo: { ...project().repo!, score: null, run: null } })) });
    const { unmount } = render();
    await screen.findByRole("heading", { level: 1 });
    expect(screen.queryByText("Score")).toBeNull();
    unmount();

    mockFetch({ [URL]: ok(project({ repo: { ...project().repo!, score: null, run: null, ciStatus: "pending" } })) });
    render();
    expect(await screen.findByText("No score yet: the CI has not graded a commit of yours.")).toBeInTheDocument();
  });
});

describe("the invitation", () => {
  const pending = () =>
    project({
      repo: { ...project().repo!, invitation: "pending", lastCommit: null, ciStatus: "none", run: null, score: null },
    });

  it("leads to the invitation, says it is pending, and offers the Resend", async () => {
    const { calls } = mockFetch({ [URL]: ok(pending()), [INVITE]: ok({ invitationStatus: "pending", resentAt: at(0) }) });
    render();
    const open = await screen.findByRole("link", { name: "Open the invitation" });
    expect(open).toHaveAttribute("href", "https://github.com/heig/labo-1-lea/invitations");
    expect(open).toHaveClass("bg-accent");
    expect(screen.getByText("Invitation pending on GitHub")).toBeInTheDocument();
    expect(screen.getByText("no commit yet")).toBeInTheDocument();

    await userEvent.click(screen.getByRole("button", { name: "Resend the invitation" }));
    expect(await screen.findByText(/Invitation sent again/)).toBeInTheDocument();
    // The page is re-read: the invitation's state is the server's, never assumed.
    await waitFor(() => expect(reads(calls)).toBe(2));
  });

  it("words a resend asked too soon, and re-reads when the invitation is no longer pending", async () => {
    mockFetch({ [URL]: ok(pending()), [INVITE]: fail(429, { error: "resend_too_soon", message: "x" }) });
    const { unmount } = render();
    await userEvent.click(await screen.findByRole("button", { name: "Resend the invitation" }));
    expect(await screen.findByText(/sent less than a minute ago/)).toBeInTheDocument();
    unmount();

    const { calls } = mockFetch({ [URL]: ok(pending()), [INVITE]: fail(409, { error: "invitation_not_pending", message: "x" }) });
    render();
    await userEvent.click(await screen.findByRole("button", { name: "Resend the invitation" }));
    expect(await screen.findByText("This invitation is no longer pending.")).toBeInTheDocument();
    await waitFor(() => expect(reads(calls)).toBe(2));
  });
});

describe("without a repository", () => {
  it("offers Accept as the page's one accent, and says what Accept gives", async () => {
    mockFetch({ [URL]: ok(project({ status: "to_accept", repo: null })) });
    render();
    expect(await screen.findByRole("button", { name: "Accept" })).toHaveClass("bg-accent");
    expect(screen.getByText(/Accept the project to get your repository/)).toBeInTheDocument();
    expect(screen.queryByText("Score")).toBeNull();
  });

  it("leads an unlinked student to GitHub, even before the start", async () => {
    mockFetch({ [URL]: ok(project({ status: "to_accept", repo: null, githubLinked: false, startAt: at(2) })) });
    render();
    expect(await screen.findByRole("link", { name: "Link GitHub" })).toHaveAttribute(
      "href",
      "/app/auth/github/link?return=%2Fprojects%2Fp1",
    );
    expect(screen.getByText(/^Starts in /)).toBeInTheDocument();
    expect(screen.getByText("Link your GitHub account to accept it")).toBeInTheDocument();
  });

  it("says when a project not yet started may be accepted, that one was never accepted, that a repository was deleted", async () => {
    mockFetch({ [URL]: ok(project({ status: "to_accept", repo: null, startAt: at(2) })) });
    const r1 = render();
    expect(await screen.findByText(/^You can accept this project from /)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Accept" })).toBeNull();
    r1.unmount();

    mockFetch({ [URL]: ok(project({ status: "locked", deadlineAt: at(-1), repo: null })) });
    const r2 = render();
    expect(await screen.findByText("Not accepted before the deadline")).toBeInTheDocument();
    r2.unmount();

    mockFetch({ [URL]: ok(project({ repo: { ...project().repo!, deleted: true } })) });
    render();
    expect(await screen.findByText("Repository deleted on GitHub: ask your teacher")).toBeInTheDocument();
    expect(screen.queryByRole("link", { name: /heig\/labo-1-lea/ })).toBeNull();
    expect(screen.queryByText("Score")).toBeNull();
  });
});

describe("the release", () => {
  it("shows the final score, the grade and the teacher's comment, and no indicative score any more", async () => {
    const p = project({
      status: "released",
      deadlineAt: at(-7),
      repo: { ...project().repo!, locked: true, score: { points: 30, max: 40, grade: null, frozen: true } },
      release: { at: at(-5), points: 36, max: 40, grade: { grade: 5.5, fellBack: false }, comment: "Bon travail,\nattention aux fuites." },
    });
    mockFetch({ [URL]: ok(p) });
    render();
    expect(await screen.findByText("Result")).toBeInTheDocument();
    expect(screen.getByText(/^Published on /)).toBeInTheDocument();
    expect(screen.getByText("Final score")).toBeInTheDocument();
    expect(screen.getByText("36 / 40")).toBeInTheDocument();
    expect(screen.getByText("5.5")).toBeInTheDocument();
    const note = screen.getByText("Your teacher's comment").parentElement!;
    expect(within(note).getByText(/Bon travail,\s*attention aux fuites\./)).toBeInTheDocument();
    expect(screen.queryByText("Score at the deadline")).toBeNull();
    expect(screen.queryByText(/indicative/)).toBeNull();
    expect(screen.getByText("scores published")).toBeInTheDocument();
  });

  it("writes a dash for a release that found no score", async () => {
    mockFetch({
      [URL]: ok(project({ status: "released", repo: null, release: { at: at(-5), points: null, max: null, grade: null, comment: null } })),
    });
    render();
    expect(await screen.findByText("Final score")).toBeInTheDocument();
    expect(screen.getByText("—")).toBeInTheDocument();
    expect(screen.queryByText("Your teacher's comment")).toBeNull();
  });
});

describe("a reader who is not the student", () => {
  it("gives a teacher in the student view WITHOUT a seat no action and no Resend, pointing to Join as student", async () => {
    sessionStorage.setItem("quiz-view-as", "student");
    const pending = project({ seat: null, repo: { ...project().repo!, invitation: "pending" } });
    mockFetch({ [URL]: ok(pending) });
    render({ me: makeMe({ role: "teacher" }) });
    expect(await screen.findByText(/Read-only view: you hold no seat in this classroom.*Join as student/)).toBeInTheDocument();
    expect(screen.queryByRole("link", { name: "Open the invitation" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Resend the invitation" })).toBeNull();
  });

  it("gives a teacher WITH a staff seat the real actions, and says the repository counts nowhere (ADR-077)", async () => {
    sessionStorage.setItem("quiz-view-as", "student");
    const pending = project({ seat: "staff", repo: { ...project().repo!, invitation: "pending" } });
    mockFetch({ [URL]: ok(pending) });
    render({ me: makeMe({ role: "teacher" }) });
    expect(await screen.findByRole("link", { name: "Open the invitation" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Resend the invitation" })).toBeInTheDocument();
    expect(screen.getByText(/counts nowhere/)).toBeInTheDocument();
    expect(screen.queryByText(/Read-only view/)).toBeNull();
  });

  it("keeps an impersonation of a student read-only", async () => {
    const me = makeMe({
      role: "student",
      session: { kind: "impersonation", evaluationId: null, readOnly: true, superPowersUntil: null, superPowersAvailable: false },
    });
    mockFetch({ [URL]: ok(project({ repo: { ...project().repo!, invitation: "pending" } })) });
    render({ me });
    expect(await screen.findByText(/Read-only view: the student's actions are not available/)).toBeInTheDocument();
    expect(screen.queryByRole("link", { name: "Open the invitation" })).toBeNull();
  });
});

describe("the student's tour (M7-01)", () => {
  it("finds the action, the score and the deadline on the page", async () => {
    mockFetch({ [URL]: ok(project({ status: "to_accept", repo: null })) });
    render();
    await screen.findByRole("heading", { level: 1, name: /Pointeurs/ });
    const tour = TOURS.find((t) => t.id === "sproj")!;
    expect(tour.audience).toBe("student");
    for (const step of tour.steps.filter((s) => s.id !== "sproj.score")) {
      expect(document.querySelector(step.target), step.id).not.toBeNull();
    }
  });

  it("finds the score once the repository exists", async () => {
    mockFetch({ [URL]: ok(project()) });
    render();
    await screen.findByText("Indicative score");
    expect(document.querySelector('[data-coach="sproj.score"]')).not.toBeNull();
  });
});

describe("in French", () => {
  it("translates the page", async () => {
    mockFetch({ [URL]: ok(project()) });
    render({ locale: "fr" });
    expect(await screen.findByText("Score indicatif")).toBeInTheDocument();
    expect(screen.getByText("Mon dépôt")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Ouvrir le dépôt" })).toBeInTheDocument();
    expect(screen.getAllByText("réussie").length).toBeGreaterThan(0);
    expect(screen.getByRole("navigation", { name: "Fil d'Ariane" })).toBeInTheDocument();
  });
});
