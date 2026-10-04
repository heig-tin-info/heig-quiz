import { describe, expect, it } from "vitest";

import type { StudentProject, StudentProjectCard } from "@quiz/contracts";

import { ApiError } from "../api";
import { en } from "../i18n/en";
import type { TFunction } from "../i18n";
import {
  factsOfCard,
  factsOfProject,
  invitationHref,
  needsStudentAction,
  projectActionKind,
  REREAD_REFUSALS,
  studentRefusalCode,
  studentRefusalMessage,
} from "./projectRow";

/*
 * The rules of the student's project row (M3-13, `docs/merge/05-web.md`
 * §5.3): which one action each state offers, how a card's deleted repository
 * is told, and the words of the refusals.
 */

const NOW = Date.parse("2026-10-04T10:00:00Z");
const DAY = 86_400_000;
const at = (days: number) => new Date(NOW + days * DAY).toISOString();

const card = (over: Partial<StudentProjectCard> = {}): StudentProjectCard => ({
  kind: "project",
  id: "p1",
  title: "Labo 1",
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

const t = ((key: string) => (en as Record<string, string>)[key] ?? key) as unknown as TFunction;

describe("projectActionKind", () => {
  it("offers Accept to a linked student of an open project without a repository", () => {
    expect(projectActionKind(factsOfCard(card()), NOW)).toBe("accept");
  });

  it("asks for the GitHub account first, open or not yet started", () => {
    expect(projectActionKind(factsOfCard(card({ githubLinked: false })), NOW)).toBe("link");
    expect(projectActionKind(factsOfCard(card({ githubLinked: false, startAt: at(2) })), NOW)).toBe("link");
  });

  it("offers nothing before the start to a linked student", () => {
    expect(projectActionKind(factsOfCard(card({ startAt: at(2), deadlineAt: at(10) })), NOW)).toBe("notStarted");
  });

  it("leads to the invitation while it is pending, to the repository once accepted", () => {
    expect(projectActionKind(factsOfCard(card({ status: "in_progress", invitation: "pending", ...REPO })), NOW)).toBe("invitation");
    expect(projectActionKind(factsOfCard(card({ status: "in_progress", invitation: "accepted", ...REPO })), NOW)).toBe("open");
    // Locked or released: the repository stays reachable, read-only.
    expect(projectActionKind(factsOfCard(card({ status: "locked", invitation: "accepted", ...REPO })), NOW)).toBe("open");
    expect(projectActionKind(factsOfCard(card({ status: "released", invitation: "accepted", ...REPO })), NOW)).toBe("open");
  });

  it("reads a card in progress that names no repository as one GitHub lost", () => {
    const facts = factsOfCard(card({ status: "in_progress" }));
    expect(facts.repo).toEqual({ state: "deleted" });
    expect(projectActionKind(facts, NOW)).toBe("deleted");
  });

  it("says a closed project without a repository was never accepted", () => {
    expect(projectActionKind(factsOfCard(card({ status: "locked", deadlineAt: at(-1) })), NOW)).toBe("notAccepted");
    expect(projectActionKind(factsOfCard(card({ status: "released", deadlineAt: at(-7) })), NOW)).toBe("notAccepted");
  });

  it("ranks a project for the accent only while the student has a step to take", () => {
    expect(needsStudentAction(card(), NOW)).toBe(true);
    expect(needsStudentAction(card({ githubLinked: false }), NOW)).toBe(true);
    expect(needsStudentAction(card({ status: "in_progress", invitation: "pending", ...REPO }), NOW)).toBe(true);
    expect(needsStudentAction(card({ status: "in_progress", invitation: "accepted", ...REPO }), NOW)).toBe(false);
    expect(needsStudentAction(card({ status: "in_progress" }), NOW)).toBe(false);
  });

  it("reads the page's payload the same way, the repository's own flags included", () => {
    const base: StudentProject = {
      kind: "project",
      id: "p1",
      title: "Labo 1",
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
        deleted: true,
        locked: false,
        lastCommit: null,
        ciStatus: "none",
        run: null,
        score: null,
      },
      release: null,
      serverNow: at(0),
    };
    expect(factsOfProject(base).repo).toEqual({ state: "deleted" });
    expect(projectActionKind(factsOfProject(base), NOW)).toBe("deleted");
    expect(projectActionKind(factsOfProject({ ...base, repo: { ...base.repo!, deleted: false, invitation: "pending" } }), NOW)).toBe("invitation");
    expect(projectActionKind(factsOfProject({ ...base, repo: null, status: "to_accept" }), NOW)).toBe("accept");
  });

  it("points the invitation at GitHub's invitations page of the repository", () => {
    expect(invitationHref("https://github.com/heig/labo-1-lea")).toBe("https://github.com/heig/labo-1-lea/invitations");
  });
});

describe("the refusals of Accept and Resend", () => {
  const refused = (status: number, error: string) => new ApiError(status, { error, message: error });

  it("words every refusal of Accept for the student", () => {
    expect(studentRefusalMessage(refused(409, "not_started"), t)).toBe("This project has not started yet.");
    expect(studentRefusalMessage(refused(409, "deadline_passed"), t)).toMatch(/can no longer be accepted/);
    expect(studentRefusalMessage(refused(409, "no_group"), t)).toMatch(/no group/);
    // The same words as the row's line and the page's card: one wording per state.
    expect(studentRefusalMessage(refused(409, "github_not_linked"), t)).toBe("Link your GitHub account to accept it");
    expect(studentRefusalMessage(refused(409, "github_account_stale"), t)).toMatch(/Link it again/);
    expect(studentRefusalMessage(refused(409, "provision_in_progress"), t)).toMatch(/being created/);
    expect(studentRefusalMessage(refused(502, "provision_failed"), t)).toMatch(/Try again/);
    // The three only the staff can resolve all say to ask them.
    for (const code of ["app_not_installed", "distribution_missing", "repo_name_taken"]) {
      expect(studentRefusalMessage(refused(409, code), t)).toBe("Your repository could not be created. Ask your teacher.");
    }
  });

  it("words the refusals of the student's Resend", () => {
    expect(studentRefusalMessage(refused(429, "resend_too_soon"), t)).toMatch(/less than a minute ago/);
    expect(studentRefusalMessage(refused(409, "invitation_not_pending"), t)).toMatch(/no longer pending/);
    expect(studentRefusalMessage(refused(409, "repo_unavailable"), t)).toMatch(/not available/);
    expect(studentRefusalMessage(refused(502, "invite_failed"), t)).toMatch(/could not send/);
  });

  it("falls back to the server's message, then to the saving error, for what it does not know", () => {
    expect(studentRefusalCode(refused(409, "something_new"))).toBeNull();
    expect(studentRefusalMessage(refused(409, "something_new"), t)).toBe("something_new");
    expect(studentRefusalMessage(new TypeError("offline"), t)).toBe("Could not save this change.");
  });

  it("re-reads instead of resending when the server is already at it, or the invitation moved on", () => {
    expect([...REREAD_REFUSALS].sort()).toEqual(["invitation_not_pending", "provision_in_progress"]);
  });
});
