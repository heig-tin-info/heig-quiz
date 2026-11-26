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
  workspace: null,
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
  criteria: null,
  contestationClosesAt: null,
  contestations: [],
  repo: {
    fullName: "heig/labo-1-lea",
    url: "https://github.com/heig/labo-1-lea",
    invitation: "accepted",
    deleted: false,
    locked: false,
    group: false,
    lastCommit: { sha: SHA, at: at(-0.1) },
    commits: 3,
    collected: false,
    ciStatus: "pass",
    run: { sha: SHA, url: "https://github.com/heig/labo-1-lea/actions/runs/42", conclusion: "success", completedAt: at(-0.1) },
    score: { points: 34, max: 40, grade: { grade: 5.3 }, frozen: false },
  },
  release: null,
  projectUpdate: null,
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

afterEach(() => {
  sessionStorage.clear();
  vi.unstubAllGlobals();
});

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

describe("the teacher's update (ADR-132 §10)", () => {
  it("shows the latest sync's message as plain text, with its date, and nothing without one", async () => {
    const text = "Test 3 fixed: see **criteria.yml**.\n<b>Nothing</b> to change.";
    mockFetch({ [URL]: ok(project({ projectUpdate: { text, at: at(-1) } })) });
    render();
    const block = await screen.findByTestId("sproj-teacher-update");
    expect(within(block).getByText("Update from your teacher")).toBeInTheDocument();
    // A text node, never Markdown nor HTML.
    expect(within(block).getByText((_, el) => el?.tagName === "P" && el.textContent === text)).toBeInTheDocument();
    expect(block.querySelector("b, strong")).toBeNull();
  });

  it("is absent without a message", async () => {
    mockFetch({ [URL]: ok(project()) });
    render();
    await screen.findByRole("heading", { level: 1 });
    expect(screen.queryByTestId("sproj-teacher-update")).toBeNull();
  });

  it("says it in French", async () => {
    mockFetch({ [URL]: ok(project({ projectUpdate: { text: "Corrigé.", at: at(-1) } })) });
    render({ locale: "fr" });
    expect(await screen.findByText("Mise à jour de l'équipe enseignante")).toBeInTheDocument();
  });
});

describe("a project in progress", () => {
  it("names the project, its classroom once, its deadline, the repository and the last commit", async () => {
    mockFetch({ [URL]: ok(project()) });
    const { navigate } = render();
    expect(await screen.findByRole("heading", { level: 1, name: "Labo 1 — Pointeurs" })).toBeInTheDocument();
    expect(screen.getByText("in progress")).toBeInTheDocument();
    expect(screen.getByText(/^Due [^·]+ · .* left$/)).toBeInTheDocument();
    // Once in the page, plus the phone's way back in the trail (hidden from `sm` up).
    expect(screen.getAllByText("PRG1-2026")).toHaveLength(2);
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
    expect(screen.getByText(/From the latest graded commit, indicative until the scores are released\./)).toBeInTheDocument();
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
    expect(screen.getByText(/Frozen at the deadline, indicative until/)).toBeInTheDocument();
    expect(screen.getByText("Evaluated commit")).toBeInTheDocument();
    expect(screen.getByText("locked")).toBeInTheDocument();
    expect(screen.getByText("Read-only since the deadline")).toBeInTheDocument();
    // A passed deadline is said once, with no countdown.
    expect(screen.getByText(/^Closed /)).toBeInTheDocument();
    expect(screen.queryByText("Grade")).toBeNull();
    expect(screen.queryByText(/collected/)).toBeNull();
  });

  it("says the workspace was collected at the deadline and what is not handed in, never a push (ADR-130 §7)", async () => {
    const p = project({
      status: "locked",
      deadlineAt: at(-1),
      workspace: { mode: "online", devices: "any" },
      repo: { ...project().repo!, locked: true, collected: true, lastCommit: { sha: SHA, at: null }, score: { points: 30, max: 40, grade: null, frozen: true } },
    });
    mockFetch({ [URL]: ok(p) });
    const { unmount } = render();
    expect(await screen.findByText("Your workspace was collected at the deadline: changes made after it are not handed in.")).toBeInTheDocument();
    // Said once, in the repository card, outside SEB: not again beside Open workspace.
    expect(within(screen.getByTestId("sproj-workspace")).queryByText(/collected/)).toBeNull();
    // The commit beside it is the evaluated one, which may be the platform's: never "your push".
    expect(screen.getByText("Evaluated commit")).toBeInTheDocument();
    expect(screen.queryByText("Last commit")).toBeNull();
    expect(screen.queryByText("Your push has been received.")).toBeNull();
    unmount();
    render({ locale: "fr" });
    expect(await screen.findByText("Votre espace de travail a été relevé à l'échéance : les modifications faites ensuite ne sont pas rendues.")).toBeInTheDocument();
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

  it("words a resend asked too soon, and re-reads when the student already has access", async () => {
    mockFetch({ [URL]: ok(pending()), [INVITE]: fail(429, { error: "resend_too_soon", message: "x" }) });
    const { unmount } = render();
    await userEvent.click(await screen.findByRole("button", { name: "Resend the invitation" }));
    expect(await screen.findByText(/sent less than a minute ago/)).toBeInTheDocument();
    unmount();

    const { calls } = mockFetch({ [URL]: ok(pending()), [INVITE]: fail(409, { error: "invitation_not_pending", message: "x" }) });
    render();
    await userEvent.click(await screen.findByRole("button", { name: "Resend the invitation" }));
    expect(await screen.findByText("You already have access to the repository.")).toBeInTheDocument();
    await waitFor(() => expect(reads(calls)).toBe(2));
  });

  it("offers the Resend on the student's own invitation only: none once theirs is accepted, whoever else is out (ADR-070, 2026-11-19)", async () => {
    mockFetch({ [URL]: ok(project()) });
    render();
    await screen.findByRole("heading", { level: 1 });
    expect(screen.queryByText("Invitation pending on GitHub")).toBeNull();
    expect(screen.queryByRole("button", { name: "Resend the invitation" })).toBeNull();
  });
});

describe("without a repository", () => {
  it("offers Accept as the page's one accent, and says what Accept gives", async () => {
    mockFetch({ [URL]: ok(project({ status: "to_accept", repo: null })) });
    render();
    expect(await screen.findByRole("button", { name: "Accept" })).toHaveClass("bg-accent");
    expect(screen.getByText(/Accept the project: your repository is created within a minute/)).toBeInTheDocument();
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
    // Not started (a scheduled project too, ADR-127): the start, no "to accept" badge, as on the card.
    expect(screen.getByText(/^Starts in /)).toBeInTheDocument();
    expect(screen.queryByText("to accept")).toBeNull();
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
      release: { at: at(-5), points: 36, max: 40, grade: { grade: 5.5 }, comment: "Bon travail,\nattention aux fuites.", adjustmentComment: null },
    });
    mockFetch({ [URL]: ok(p) });
    render();
    expect(await screen.findByText("Result")).toBeInTheDocument();
    expect(screen.getByText(/^Published on /)).toBeInTheDocument();
    expect(screen.getByText("Final score")).toBeInTheDocument();
    expect(screen.getByText("36 / 40")).toBeInTheDocument();
    expect(screen.getByText("5.5")).toBeInTheDocument();
    const note = screen.getByText("Your teacher's comment").closest("div")!;
    expect(within(note).getByText(/Bon travail,\s*attention aux fuites\./)).toBeInTheDocument();
    expect(screen.queryByText("Score at the deadline")).toBeNull();
    expect(screen.queryByText(/indicative/)).toBeNull();
    expect(screen.getByText("scores published")).toBeInTheDocument();
  });

  it("shows an adjusted grade's justification after the teacher's comment, never its delta (ADR-135)", async () => {
    const p = project({
      status: "released",
      deadlineAt: at(-7),
      repo: { ...project().repo!, locked: true, score: { points: 30, max: 40, grade: null, frozen: true } },
      release: { at: at(-5), points: 36, max: 40, grade: { grade: 5.8 }, comment: "Bon travail.", adjustmentComment: "Défense orale convaincante." },
    });
    mockFetch({ [URL]: ok(p) });
    render();
    expect(await screen.findByText("5.8")).toBeInTheDocument();
    const adjusted = screen.getByText("Grade adjusted").closest("div")!;
    expect(within(adjusted).getByTestId("sproj-adjustment")).toHaveTextContent("Défense orale convaincante.");
    // After the teacher's comment.
    const note = screen.getByText("Your teacher's comment");
    expect(note.compareDocumentPosition(adjusted) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it("writes a dash for a release that found no score", async () => {
    mockFetch({
      [URL]: ok(project({ status: "released", repo: null, release: { at: at(-5), points: null, max: null, grade: null, comment: null, adjustmentComment: null } })),
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
    expect(await screen.findByText(/Read-only: you hold no seat in this classroom.*Join as student/)).toBeInTheDocument();
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
    expect(screen.getByText(/does not count/)).toBeInTheDocument();
    expect(screen.queryByText(/Read-only/)).toBeNull();
  });

  it("keeps an impersonation of a student read-only", async () => {
    const me = makeMe({
      role: "student",
      session: { kind: "impersonation", evaluationId: null, projectId: null, readOnly: true, superPowersUntil: null, superPowersAvailable: false },
    });
    mockFetch({ [URL]: ok(project({ repo: { ...project().repo!, invitation: "pending" } })) });
    render({ me });
    expect(await screen.findByText(/Read-only: student actions disabled/)).toBeInTheDocument();
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

describe("the online workspace (ADR-047, M6-06)", () => {
  const START = "POST /app/api/projects/p1/workspace/start";

  it("opens the workspace through the start route: a POST, then the portal's address (audit L7)", async () => {
    const launch = "https://code.example/launch?token=abc";
    const { calls } = mockFetch({ [URL]: ok(project({ workspace: { mode: "online", devices: "any" } })), [START]: ok({ url: launch }) });
    render();
    const open = await screen.findByRole("button", { name: "Open workspace" });
    expect(screen.queryByRole("link", { name: "Open workspace" })).toBeNull();
    const assign = vi.fn();
    vi.stubGlobal("location", { ...window.location, assign });
    await userEvent.click(open);
    await waitFor(() => expect(assign).toHaveBeenCalledWith(launch));
    expect(calls.filter((c) => c.method === "POST").map((c) => c.url)).toEqual(["/app/api/projects/p1/workspace/start"]);
  });

  it("at the students' choice, makes the repository the page's one accent and the workspace the fallback (ADR-149 §6)", async () => {
    mockFetch({ [URL]: ok(project({ workspace: { mode: "hybrid", devices: "any" } })) });
    render();
    const open = await screen.findByRole("button", { name: "Open workspace" });
    expect(open).not.toHaveClass("bg-accent");
    expect(screen.getByRole("link", { name: "Open repository" })).toHaveClass("bg-accent");
    expect(document.querySelectorAll(".bg-accent")).toHaveLength(1);
    const section = screen.getByTestId("sproj-workspace");
    expect(within(section).getByText("No tools installed? Work in your browser.")).toBeInTheDocument();
    expect(within(section).getByText(/unless your last push came from a personal machine/)).toBeInTheDocument();
  });

  it("words the start route's refusal in place", async () => {
    mockFetch({
      [URL]: ok(project({ workspace: { mode: "online", devices: "any" } })),
      [START]: fail(409, { error: "closed", message: "closed" }),
    });
    render();
    await userEvent.click(await screen.findByRole("button", { name: "Open workspace" }));
    expect(await screen.findByText("The deadline has passed: the workspace no longer opens.")).toBeInTheDocument();
    expect(window.location.search).toBe("?workspace=closed");
  });

  it("hands a Safe Exam Browser workspace over to SEB: the project's `.seb`, through its steps (D21)", async () => {
    mockFetch({ [URL]: ok(project({ workspace: { mode: "online_seb", devices: "seb" } })) });
    render();
    expect(await screen.findByText("This workspace opens only in Safe Exam Browser.")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Open workspace" })).toBeNull();
    await userEvent.click(screen.getByRole("button", { name: "Open in Safe Exam Browser" }));
    const dialog = await screen.findByRole("dialog", { name: "Open this workspace in Safe Exam Browser" });
    const assign = vi.fn();
    vi.stubGlobal("location", { ...window.location, assign });
    await userEvent.click(within(dialog).getByRole("button", { name: "Download the file" }));
    expect(assign).toHaveBeenCalledWith("/app/api/projects/p1/seb");
  });

  // ADR-089, amendment point 2: Kiosk only serves no `.seb`; the student is sent to a station.
  it("at Kiosk only, offers no `.seb` and sends the student to a station", async () => {
    mockFetch({ [URL]: ok(project({ workspace: { mode: "online_seb", devices: "kiosk" } })) });
    render();
    expect(await screen.findByText(/opens only on a school kiosk station\. Scan the station's QR code/)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Open in Safe Exam Browser" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Open workspace" })).toBeNull();
  });

  it("at SEB or kiosk, says both paths and offers the `.seb`", async () => {
    mockFetch({ [URL]: ok(project({ workspace: { mode: "online_seb", devices: "either" } })) });
    render();
    expect(await screen.findByText("This workspace opens in Safe Exam Browser or on a school kiosk station.")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Open in Safe Exam Browser" })).toBeInTheDocument();
  });

  it("inside SEB, on the project's own session, opens the workspace as the page's one action", async () => {
    const me = makeMe({
      role: "student",
      session: { kind: "seb", evaluationId: null, projectId: "p1", readOnly: false, superPowersUntil: null, superPowersAvailable: false },
    });
    mockFetch({ [URL]: ok(project({ workspace: { mode: "online_seb", devices: "seb" } })) });
    render({ me });
    const open = await screen.findByRole("button", { name: "Open workspace" });
    expect(open.className).toMatch(/bg-accent/);
    // SEB's task bar is hidden: its quit link is on the page, secondary.
    const quit = screen.getByRole("link", { name: "Quit Safe Exam Browser" });
    expect(quit).toHaveAttribute("href", "/seb/quit");
    expect(quit.className).not.toMatch(/bg-accent/);
    // GitHub is out of SEB's reach: no repository action in the header, no repository card.
    expect(screen.queryByRole("link", { name: "Open repository" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Open in Safe Exam Browser" })).toBeNull();
    expect(screen.queryByText("My repository")).toBeNull();
    expect(screen.queryByText("heig/labo-1-lea")).toBeNull();
    expect(screen.queryByRole("link", { name: /See the run on GitHub/ })).toBeNull();
  });

  it("inside SEB or at a station, says the collection beside Open workspace, the repository card being hidden (ADR-130 §7)", async () => {
    const collected = project({
      status: "locked",
      deadlineAt: at(-1),
      workspace: { mode: "online_seb", devices: "either" },
      repo: { ...project().repo!, invitation: null, locked: true, collected: true, lastCommit: { sha: SHA, at: null } },
    });
    for (const kind of ["seb", "kiosk"] as const) {
      const me = makeMe({
        role: "student",
        session: { kind, evaluationId: null, projectId: "p1", readOnly: false, superPowersUntil: null, superPowersAvailable: false },
      });
      mockFetch({ [URL]: ok(collected) });
      const { unmount } = render({ me });
      const section = await screen.findByTestId("sproj-workspace");
      expect(within(section).getByText("Your workspace was collected at the deadline: changes made after it are not handed in."), kind).toBeInTheDocument();
      expect(screen.queryByText("My repository"), kind).toBeNull();
      expect(screen.getAllByText(/was collected at the deadline/), kind).toHaveLength(1);
      unmount();
    }
    // Not collected: nothing said.
    const me = makeMe({ role: "student", session: { kind: "seb", evaluationId: null, projectId: "p1", readOnly: false, superPowersUntil: null, superPowersAvailable: false } });
    mockFetch({ [URL]: ok(project({ ...collected, repo: { ...collected.repo!, collected: false } })) });
    render({ me });
    expect(await screen.findByTestId("sproj-workspace")).toBeInTheDocument();
    expect(screen.queryByText(/was collected at the deadline/)).toBeNull();
  });

  it("offers no invitation under Safe Exam Browser, outside SEB either (ADR-047 §2)", async () => {
    mockFetch({ [URL]: ok(project({ workspace: { mode: "online_seb", devices: "seb" }, repo: { ...project().repo!, invitation: null } })) });
    render();
    expect(await screen.findByRole("button", { name: "Open in Safe Exam Browser" })).toHaveClass("bg-accent");
    expect(screen.queryByRole("link", { name: "Quit Safe Exam Browser" })).toBeNull();
    expect(screen.getByText("heig/labo-1-lea")).toBeInTheDocument();
    expect(screen.queryByText("Invitation pending on GitHub")).toBeNull();
    expect(screen.queryByRole("button", { name: "Resend the invitation" })).toBeNull();
    expect(screen.queryByRole("link", { name: "Open the invitation" })).toBeNull();
  });

  it("shows nothing of a workspace on a project worked in the student's own tools", async () => {
    mockFetch({ [URL]: ok(project()) });
    render();
    await screen.findByRole("heading", { level: 1, name: "Labo 1 — Pointeurs" });
    expect(screen.queryByTestId("sproj-workspace")).toBeNull();
  });

  it("words the start route's refusal it was sent back with, and ignores any other value", async () => {
    mockFetch({ [URL]: ok(project({ workspace: { mode: "online", devices: "any" } })) });
    const navigate = vi.fn();
    const queryClient = makeQueryClient();
    queryClient.setQueryData(meKey, student);
    const view = renderWithProviders(<StudentProjectPage id="p1" navigate={navigate} />, {
      route: "/projects/p1?workspace=closed",
      queryClient,
    });
    expect(await screen.findByText("The deadline has passed: the workspace no longer opens.")).toBeInTheDocument();
    view.unmount();

    renderWithProviders(<StudentProjectPage id="p1" navigate={navigate} />, { route: "/projects/p1?workspace=bogus", queryClient });
    await screen.findByRole("button", { name: "Open workspace" });
    expect(screen.queryByText("The workspace did not open")).toBeNull();
  });
});

describe("the criteria table (ADR-106 §9, L-02f)", () => {
  const XSS = "<script>alert(1)</script> <b>bold</b>";
  type Row = NonNullable<StudentProject["criteria"]>[number];
  const row = (over: Partial<Row>): Row => ({
    criterionId: "rendu.tests",
    section: "rendu",
    description: "Tests pass",
    max: 4,
    points: null,
    state: "empty",
    locked: false,
    contestable: false,
    ...over,
  });
  const criteria = (final: boolean): Row[] => [
    row({ criterionId: "rendu.tests", description: "Tests pass", points: 2.5, state: final ? "validated" : "indicative" }),
    row({ criterionId: "code.jalon", description: "Milestone", points: 1.5, state: final ? "validated" : "indicative", locked: true, rationale: XSS }),
    row(final ? { criterionId: "git.commits", description: "Commits", points: 1, state: "validated" } : { criterionId: "git.commits", description: "Commits" }),
  ];

  it("marks the unvalidated rows indicative, an empty one with a dash, a locked one with a lock, and shows a rationale as text", async () => {
    mockFetch({ [URL]: ok(project({ gradingMode: "criteria", criteria: criteria(false) })) });
    render();
    expect(await screen.findByRole("heading", { name: "Criteria" })).toBeInTheDocument();
    expect(screen.getByText("Provisional, until validated")).toBeInTheDocument();
    const table = screen.getByRole("table", { name: "Criteria" });
    const [, tests, jalon, commits] = within(table).getAllByRole("row");
    expect(within(tests!).getByText("indicative")).toBeInTheDocument();
    expect(within(tests!).getByText("2.5")).toBeInTheDocument();
    expect(within(jalon!).getByRole("img", { name: /locked/ })).toBeInTheDocument();
    expect(within(commits!).getByText("—")).toBeInTheDocument();
    expect(within(commits!).queryByText("indicative")).toBeNull();
    // Unfolded, the rationale as a text node: no element of its markup reaches the page.
    expect(within(jalon!).getByText(XSS)).toBeInTheDocument();
    expect(document.querySelector("script, b")).toBeNull();
    // No action of its own, not even a fold: the page's one action is the header's.
    expect(within(table).queryAllByRole("button")).toEqual([]);
  });

  it("draws the CI's score as its share of the criteria's total, without a grade (product owner, 2026-11-18)", async () => {
    const base = project();
    const rows = [row({ max: 8 }), row({ criterionId: "code.style", max: 10 }), row({ criterionId: "penalty", max: -3 }), row({ criterionId: "bonus", max: 0, bonus: 2 })];
    mockFetch({
      [URL]: ok(project({ gradingMode: "criteria", criteria: rows, repo: { ...base.repo!, score: { points: 6, max: 8, grade: null, frozen: false } } })),
    });
    render();
    expect(await screen.findByText("CI score")).toBeInTheDocument();
    expect(screen.getByText("6 / 8")).toBeInTheDocument();
    // The total: the positive maxima, no penalty, no bonus.
    expect(screen.getByText("out of 18 points")).toBeInTheDocument();
    expect(screen.getByRole("img", { name: "Awarded: 6 · Missed: 2 · Graded by the AI or your teacher: 10" })).toBeInTheDocument();
    expect(screen.getByText("10 points graded by the AI or your teacher. No grade before the scores are released.")).toBeInTheDocument();
    expect(screen.queryByText("Grade")).toBeNull();
    expect(screen.getByText("AI or teacher")).toBeInTheDocument();
    expect(screen.queryByText(/indicative until the scores are released/)).toBeNull();
  });

  it("names the frozen CI score, and no grey part when the CI grades the whole", async () => {
    const base = project();
    mockFetch({
      [URL]: ok(
        project({
          gradingMode: "criteria",
          criteria: [row({ max: 7 }), row({ criterionId: "rendu.style", max: 1 })],
          status: "locked",
          repo: { ...base.repo!, locked: true, score: { points: 7, max: 8, grade: null, frozen: true } },
        }),
      ),
    });
    render({ locale: "fr" });
    expect(await screen.findByText("Score de la CI à l'échéance")).toBeInTheDocument();
    expect(screen.getByRole("img", { name: "Obtenu : 7 · Manqué : 1" })).toBeInTheDocument();
    expect(screen.queryByText("IA ou équipe enseignante")).toBeNull();
    expect(screen.getByText("Pas de note avant la publication des scores.")).toBeInTheDocument();
  });

  it("says final once every row is validated, without the indicative badge", async () => {
    mockFetch({ [URL]: ok(project({ gradingMode: "criteria", criteria: criteria(true), status: "released" })) });
    render();
    expect(await screen.findByText("Final")).toBeInTheDocument();
    const table = screen.getByRole("table", { name: "Criteria" });
    expect(within(table).queryByText("indicative")).toBeNull();
  });
});

describe("a criterion's contestation (ADR-139 §13)", () => {
  type Row = NonNullable<StudentProject["criteria"]>[number];
  type Filed = StudentProject["contestations"][number];
  const FILE = "POST /app/api/student/projects/p1/criteria/rendu.tests/contestation";
  const row = (over: Partial<Row> & Pick<Row, "criterionId" | "description">): Row => ({
    section: "rendu",
    max: 4,
    points: 3,
    state: "validated",
    locked: false,
    contestable: false,
    ...over,
  });
  const filed = (over: Partial<Filed> & Pick<Filed, "criterionId" | "criterionDescription">): Filed => ({
    pointsAtFiling: 3,
    maxAtFiling: 4,
    bonusAtFiling: null,
    state: "open",
    reason: "My reason",
    filedAt: at(-2),
    reply: null,
    resolvedAt: null,
    ...over,
  });
  const released = (over: Partial<StudentProject> = {}): StudentProject =>
    project({
      gradingMode: "criteria",
      status: "released",
      release: { at: at(-5), points: 12, max: 16, grade: { grade: 4.5 }, comment: null, adjustmentComment: null },
      criteria: [
        row({ criterionId: "rendu.tests", description: "Tests pass", contestable: true }),
        row({ criterionId: "code.memoire", description: "Memory freed" }),
        row({ criterionId: "code.style", description: "Readable code" }),
        row({ criterionId: "rapport.analyse", description: "Design explained" }),
      ],
      contestationClosesAt: at(2),
      contestations: [
        filed({ criterionId: "code.memoire", criterionDescription: "Memory freed", reason: "The buffer is freed in main." }),
        filed({ criterionId: "code.style", criterionDescription: "Readable code", state: "accepted", reply: "Right, the names are fine.", resolvedAt: at(-1) }),
        filed({ criterionId: "rapport.analyse", criterionDescription: "Design explained", state: "refused", reply: "The conclusion names it only.", resolvedAt: at(-1) }),
        filed({ criterionId: "rapport.ortho", criterionDescription: "Spelling", pointsAtFiling: 0.5, maxAtFiling: 1 }),
      ],
      ...over,
    });

  it("offers Contest on a contestable criterion only, and files the reason with the group's sentence", async () => {
    const answer = filed({ criterionId: "rendu.tests", criterionDescription: "Tests pass", reason: "Test 3 expects the wrong rounding." });
    let sent = false;
    // A group's repository (ADR-139 §13): the dialog says the contestation is the group's.
    const after = released({ repo: { ...project().repo!, group: true } });
    const { calls } = mockFetch({
      // The read after the filing holds it, as the server's would.
      [URL]: () => ok(sent ? { ...after, contestations: [answer, ...after.contestations], criteria: after.criteria!.map((r) => ({ ...r, contestable: false })) } : after),
      [FILE]: () => {
        sent = true;
        return ok(answer);
      },
    });
    render();
    const table = await screen.findByRole("table", { name: "Criteria" });
    expect(screen.getByText(/^Contestations open until/)).toBeInTheDocument();
    // One offer, named after its criterion; the contested ones have none.
    const buttons = within(table).getAllByRole("button", { name: /^Contest criterion/ });
    expect(buttons.map((b) => b.getAttribute("aria-label"))).toEqual(["Contest criterion “Tests pass”"]);
    await userEvent.click(buttons[0]!);
    const dialog = await screen.findByRole("dialog", { name: "Contest criterion “Tests pass”" });
    expect(within(dialog).getByText("This contestation is your group's: every member reads it and its reply.")).toBeInTheDocument();
    expect(within(dialog).getByRole("button", { name: "Send" })).toBeDisabled();
    await userEvent.type(within(dialog).getByRole("textbox", { name: "Reason" }), "Test 3 expects the wrong rounding.");
    await userEvent.click(within(dialog).getByRole("button", { name: "Send" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(calls.find((c) => c.method === "POST")?.body).toEqual({ reason: "Test 3 expects the wrong rounding." });
    // The record replaced the button at once, and holds the focus the button had.
    await waitFor(() => expect(within(table).queryByRole("button", { name: /^Contest criterion/ })).toBeNull());
    // (The phone's list draws the same record, hidden on a desktop: either one holds it here, jsdom showing both.)
    expect(document.activeElement?.textContent).toBe("Contestation awaiting an answer");
    expect(within(table).getByText("Test 3 expects the wrong rounding.")).toBeInTheDocument();
  });

  it("shows each record: awaiting, accepted with its reply and no promise of a grade, refused, and one on a criterion removed since", async () => {
    mockFetch({ [URL]: ok(released()) });
    render();
    const table = await screen.findByRole("table", { name: "Criteria" });
    expect(within(table).getByText("The buffer is freed in main.")).toBeInTheDocument();
    expect(within(table).getByText("Contestation accepted")).toBeInTheDocument();
    expect(within(table).getByText("Right, the names are fine.")).toBeInTheDocument();
    expect(within(table).getByText("Any new points stay indicative until the scores are released again.")).toBeInTheDocument();
    expect(within(table).getByText("Contestation refused")).toBeInTheDocument();
    expect(within(table).getByText("The conclusion names it only.")).toBeInTheDocument();
    // The removed criterion is not a row: listed after the table, as it read when contested.
    const removed = screen.getByTestId("sproj-contest-removed");
    expect(within(removed).getByText("Criteria no longer graded")).toBeInTheDocument();
    expect(within(removed).getByText("Spelling")).toBeInTheDocument();
    expect(within(removed).getByText("When contested: 0.5 / 1")).toBeInTheDocument();
    expect(within(table).queryByText("Spelling")).toBeNull();
  });

  it("words the refusals in a criterion's terms", async () => {
    mockFetch({
      [URL]: ok(released()),
      [FILE]: fail(409, { error: "not_contestable", message: "x", reason: "pending" }),
    });
    render();
    const table = await screen.findByRole("table", { name: "Criteria" });
    await userEvent.click(within(table).getByRole("button", { name: "Contest criterion “Tests pass”" }));
    const dialog = await screen.findByRole("dialog");
    await userEvent.type(within(dialog).getByRole("textbox", { name: "Reason" }), "Why");
    await userEvent.click(within(dialog).getByRole("button", { name: "Send" }));
    expect(await within(dialog).findByText("This criterion is being graded again.")).toBeInTheDocument();
  });

  it("words a closed window in a project's terms", async () => {
    mockFetch({ [URL]: ok(released()), [FILE]: fail(409, { error: "contestation_closed", message: "x" }) });
    render();
    const table = await screen.findByRole("table", { name: "Criteria" });
    await userEvent.click(within(table).getByRole("button", { name: "Contest criterion “Tests pass”" }));
    const dialog = await screen.findByRole("dialog");
    await userEvent.type(within(dialog).getByRole("textbox", { name: "Reason" }), "Why");
    await userEvent.click(within(dialog).getByRole("button", { name: "Send" }));
    expect(await within(dialog).findByText("Contestations are closed for this project.")).toBeInTheDocument();
  });

  it("offers nothing to an impersonation, which reads the records", async () => {
    const me = makeMe({
      role: "student",
      session: { kind: "impersonation", evaluationId: null, projectId: null, readOnly: true, superPowersUntil: null, superPowersAvailable: false },
    });
    mockFetch({ [URL]: ok(released()) });
    render({ me });
    const table = await screen.findByRole("table", { name: "Criteria" });
    expect(within(table).getByText("The buffer is freed in main.")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /^Contest criterion/ })).toBeNull();
  });

  it("lands on the criteria from the answer's bell (?at=criteria), once", async () => {
    const scroll = vi.fn();
    Element.prototype.scrollIntoView = scroll;
    mockFetch({ [URL]: ok(released()) });
    const queryClient = makeQueryClient();
    queryClient.setQueryData(meKey, student);
    renderWithProviders(<StudentProjectPage id="p1" navigate={vi.fn()} />, { route: "/projects/p1?at=criteria", queryClient });
    await screen.findByRole("table", { name: "Criteria" });
    await waitFor(() => expect(scroll).toHaveBeenCalledTimes(1));
    expect(window.location.search).toBe("");
  });

  it("says nothing of a group on an individual repository", async () => {
    mockFetch({ [URL]: ok(released()) });
    render();
    const table = await screen.findByRole("table", { name: "Criteria" });
    await userEvent.click(within(table).getByRole("button", { name: /^Contest criterion/ }));
    const dialog = await screen.findByRole("dialog", { name: /^Contest criterion/ });
    expect(within(dialog).queryByText(/your group/)).toBeNull();
  });

});
