import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { StudentActivityGroup } from "@quiz/domain";
import type { Me, StudentProjectCard } from "@quiz/contracts";

import type { Locale } from "../i18n";
import { makeMe } from "../test/fixtures";
import { fail, makeQueryClient, mockFetch, ok, renderWithProviders } from "../test/render";
import { meKey, studentHomeKey } from "../queryKeys";
import { ProjectRow } from "./ProjectRow";

/*
 * The student's project row (M3-13): its title opening the project's page,
 * the one action of each state of `docs/merge/05-web.md` §5.3, the Accept
 * flow with its wait, its re-read and its refusals, and the readers who get
 * no button at all — a teacher in the student view (ADR-018) and an
 * impersonation session (ADR-034).
 */

const NOW = Date.now();
const DAY = 86_400_000;
const at = (days: number) => new Date(NOW + days * DAY).toISOString();

const card = (over: Partial<StudentProjectCard> = {}): StudentProjectCard => ({
  kind: "project",
  id: "p1",
  title: "Labo 1 — Pointeurs",
  classroomId: "r1",
  classroomName: "PRG1-2026",
  courseCode: "PRG1",
  startAt: at(-3),
  deadlineAt: at(6),
  status: "to_accept",
  invitation: null,
  githubLinked: true,
  repoFullName: null,
  repoUrl: null,
  ...over,
});
const REPO = { repoFullName: "heig/labo-1-lea", repoUrl: "https://github.com/heig/labo-1-lea" };
const ACCEPT = "POST /app/api/student/projects/p1/accept";

const student: Me = makeMe({ id: "u1", role: "student" });

function render(
  c: StudentProjectCard,
  {
    me = student,
    primary = true,
    group = "open",
    locale = "en",
  }: { me?: Me; primary?: boolean; group?: StudentActivityGroup; locale?: Locale } = {},
) {
  const navigate = vi.fn();
  const queryClient = makeQueryClient();
  queryClient.setQueryData(meKey, me);
  // A home in the cache: what a write must invalidate.
  queryClient.setQueryData(studentHomeKey, { polls: [], open: [], upcoming: [], past: [], serverNow: at(0) });
  const r = renderWithProviders(<ProjectRow card={c} group={group} now={NOW} navigate={navigate} primary={primary} />, {
    locale,
    route: "/classrooms/r1",
    queryClient,
  });
  return { ...r, navigate };
}

/** The row's action link, the title's excluded. */
const actionLink = (name: string | RegExp) => screen.queryByRole("link", { name });

afterEach(() => sessionStorage.clear());

describe("the title", () => {
  it("is the door to the project's page: a real address, navigated in the app", async () => {
    mockFetch({});
    const { navigate } = render(card());
    const title = await screen.findByRole("link", { name: "Labo 1 — Pointeurs" });
    expect(title).toHaveAttribute("href", "/projects/p1");
    await userEvent.click(title);
    expect(navigate).toHaveBeenCalledWith({ view: "project", id: "p1" });
  });
});

describe("the one action by state", () => {
  it("leads an unlinked student to link their GitHub account, back to this page", async () => {
    mockFetch({});
    render(card({ githubLinked: false }));
    const link = await screen.findByRole("link", { name: "Link GitHub" });
    expect(link).toHaveAttribute("href", "/app/auth/github/link?return=%2Fclassrooms%2Fr1");
    expect(link).not.toHaveAttribute("target");
    expect(link).toHaveClass("bg-accent");
    expect(screen.getByText(/to accept · .* · Link your GitHub account to accept it$/)).toBeInTheDocument();
  });

  it("offers Accept to a linked student of an open project", async () => {
    mockFetch({});
    render(card());
    expect(await screen.findByRole("button", { name: "Accept" })).toHaveClass("bg-accent");
    expect(actionLink(/GitHub|repository|invitation/)).toBeNull();
  });

  it("opens the pending invitation on GitHub, in a new tab", async () => {
    mockFetch({});
    render(card({ status: "in_progress", invitation: "pending", ...REPO }));
    const link = await screen.findByRole("link", { name: "Open the invitation" });
    expect(link).toHaveAttribute("href", "https://github.com/heig/labo-1-lea/invitations");
    expect(link).toHaveAttribute("target", "_blank");
    expect(link).toHaveClass("bg-accent");
    expect(screen.getByText(/Invitation pending on GitHub$/)).toBeInTheDocument();
  });

  it("opens a ready repository as a secondary link, never the accent", async () => {
    mockFetch({});
    render(card({ status: "in_progress", invitation: "accepted", ...REPO }), { primary: true });
    const link = await screen.findByRole("link", { name: "Open repository" });
    expect(link).toHaveAttribute("href", "https://github.com/heig/labo-1-lea");
    expect(link).not.toHaveClass("bg-accent");
  });

  it("keeps a locked repository reachable, and offers nothing for one never accepted or deleted", async () => {
    mockFetch({});
    const { unmount } = render(card({ status: "locked", invitation: "accepted", ...REPO }), { group: "past" });
    expect(await screen.findByRole("link", { name: "Open repository" })).toBeInTheDocument();
    unmount();

    const r2 = render(card({ status: "locked", deadlineAt: at(-1) }), { group: "past" });
    expect(await screen.findByText("locked · Not accepted before the deadline")).toBeInTheDocument();
    expect(screen.queryByRole("button")).toBeNull();
    expect(actionLink(/GitHub|repository|invitation/)).toBeNull();
    r2.unmount();

    render(card({ status: "in_progress" }));
    expect(await screen.findByText(/in progress · .* · Repository deleted on GitHub: ask your teacher$/)).toBeInTheDocument();
    expect(screen.queryByRole("button")).toBeNull();
  });

  it("draws no button in Coming up, and says when the project starts", async () => {
    mockFetch({});
    render(card({ startAt: at(2), deadlineAt: at(9) }), { group: "upcoming" });
    expect(await screen.findByText(/^Starts in /)).toBeInTheDocument();
    expect(screen.queryByRole("button")).toBeNull();
  });

  it("is secondary when the page says another card is the most urgent", async () => {
    mockFetch({});
    render(card(), { primary: false });
    expect(await screen.findByRole("button", { name: "Accept" })).not.toHaveClass("bg-accent");
  });

  it("speaks French", async () => {
    mockFetch({});
    render(card(), { locale: "fr" });
    expect(await screen.findByRole("button", { name: "Accepter" })).toBeInTheDocument();
    expect(screen.getByText("Projet")).toBeInTheDocument();
  });
});

describe("a reader who is not the student", () => {
  it("gives a teacher in the student view the real actions: a row exists only for a seat (ADR-077)", async () => {
    sessionStorage.setItem("quiz-view-as", "student");
    mockFetch({});
    render(card({ githubLinked: false }), { me: makeMe({ role: "teacher" }) });
    expect(await screen.findByRole("link", { name: "Link GitHub" })).toBeInTheDocument();
    expect(screen.queryByText(/Read-only view/)).toBeNull();
  });

  it("gives an impersonation session no button either, whatever the state", async () => {
    mockFetch({});
    const me = makeMe({
      role: "student",
      session: { kind: "impersonation", evaluationId: null, readOnly: true, superPowersUntil: null, superPowersAvailable: false },
    });
    render(card({ status: "in_progress", invitation: "pending", ...REPO }), { me });
    expect(await screen.findByText(/Read-only view/)).toBeInTheDocument();
    expect(actionLink("Open the invitation")).toBeNull();
  });
});

describe("Accept", () => {
  it("says it takes up to a minute while it waits", async () => {
    const { fetchMock } = mockFetch({});
    // The POST never answers: what the student reads meanwhile.
    fetchMock.mockImplementation(() => new Promise<Response>(() => {}));
    render(card());
    await userEvent.click(await screen.findByRole("button", { name: "Accept" }));
    const waiting = await screen.findByRole("button", { name: /Creating your repository… \(up to a minute\)/ });
    expect(waiting).toBeDisabled();
  });

  it("re-reads the student's pages once the repository is made, and says what to do next", async () => {
    const { calls } = mockFetch({
      [ACCEPT]: ok({ status: "ok", fullName: "heig/labo-1-lea", invitationStatus: "pending" }),
    });
    const { queryClient } = render(card());
    await userEvent.click(await screen.findByRole("button", { name: "Accept" }));
    expect(await screen.findByText("Your repository is ready: accept the invitation GitHub sent you.")).toBeInTheDocument();
    expect(calls.filter((c) => c.method === "POST").map((c) => c.url)).toEqual(["/app/api/student/projects/p1/accept"]);
    await waitFor(() => expect(queryClient.getQueryState(studentHomeKey)?.isInvalidated).toBe(true));
  });

  it("re-reads instead of resending when another Accept is under way", async () => {
    mockFetch({ [ACCEPT]: fail(409, { error: "provision_in_progress", message: "x" }) });
    const { queryClient } = render(card());
    await userEvent.click(await screen.findByRole("button", { name: "Accept" }));
    expect(await screen.findByText("Your repository is being created. One moment…")).toBeInTheDocument();
    await waitFor(() => expect(queryClient.getQueryState(studentHomeKey)?.isInvalidated).toBe(true));
    // Still Accept: a click resends nothing the server did not refuse.
    expect(screen.getByRole("button", { name: "Accept" })).toBeInTheDocument();
  });

  it("turns into Relink GitHub when the linked account is stale", async () => {
    mockFetch({ [ACCEPT]: fail(409, { error: "github_account_stale", message: "x" }) });
    render(card());
    await userEvent.click(await screen.findByRole("button", { name: "Accept" }));
    expect(await screen.findByText(/Your GitHub account was not found/)).toBeInTheDocument();
    const relink = await screen.findByRole("link", { name: "Relink GitHub" });
    expect(relink).toHaveAttribute("href", "/app/auth/github/link?return=%2Fclassrooms%2Fr1");
    expect(screen.queryByRole("button", { name: "Accept" })).toBeNull();
  });

  it.each([
    ["not_started", 409, "This project has not started yet."],
    ["deadline_passed", 409, "The deadline has passed: this project can no longer be accepted."],
    ["github_not_linked", 409, "Link your GitHub account to accept it"],
    ["no_group", 409, "You are in no group of this project. Ask your teacher."],
    ["app_not_installed", 409, "Your repository could not be created. Ask your teacher."],
    ["distribution_missing", 409, "Your repository could not be created. Ask your teacher."],
    ["repo_name_taken", 409, "Your repository could not be created. Ask your teacher."],
    ["provision_failed", 502, "GitHub did not answer. Try again in a moment."],
  ])("words the refusal %s", async (code, status, message) => {
    mockFetch({ [ACCEPT]: fail(status, { error: code, message: code }) });
    render(card());
    await userEvent.click(await screen.findByRole("button", { name: "Accept" }));
    expect(await screen.findByText(message)).toBeInTheDocument();
    // The button stays: a refusal the student can act on is retried here.
    expect(screen.getByRole("button", { name: "Accept" })).toBeInTheDocument();
  });
});
