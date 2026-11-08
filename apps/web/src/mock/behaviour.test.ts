// @vitest-environment jsdom
/**
 * The mock's write behaviour: what a page sends and reads back from the fake
 * backend, beside the GET sweep of `contract.test.ts`. Each case drives the
 * very `window.fetch` the app calls and parses the answer, success or
 * refusal, with the schema the page parses it with, so a scene of the
 * screenshot script cannot show a flow the real API would not answer.
 *
 * The cases share one mock, in the order written: a write here is what the
 * next case reads (the new project is last, as the project counts above it
 * would otherwise move).
 */
import {
  AdminConceptList,
  AssistReply,
  Concept,
  ConceptCycle,
  AliasCollision,
  ConceptExists,
  ConceptSuggestions,
  ConceptDuplicatesAi,
  ConceptFill,
  ConceptRelationCandidates,
  ConceptRelationProposals,
  ConceptWriteRefusal,
  NotificationSettings,
  PROJECT_ACCEPT_REFUSALS,
  ProjectAcceptance,
  ProjectCreate,
  ProjectDetail,
  ProjectDistributionAccess,
  ProjectGradingRepo,
  ProjectGradingView,
  ProjectCommitGraph,
  CriterionCiLog,
  PointsOutOfRange,
  ProjectInvitationResent,
  ProjectRefusal,
  ProjectReleaseRefusal,
  ProjectReleaseResult,
  ProjectRepoProtection,
  ProjectRepoScores,
  ProjectSummary,
  StudentProject,
  GradebookErrorCode,
  GradebookStaff,
  GroupConsequences,
  GroupErrorCode,
  GroupSetDetail,
  GroupSetSummary,
} from "@quiz/contracts";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

// jsdom has no `fetch`; the mock wraps whatever is there and only defers to
// it for a URL outside `/app/`, which this test never asks for.
if (typeof window.fetch !== "function") {
  window.fetch = (() => Promise.reject(new Error("no network in this test"))) as typeof fetch;
}

// The scene flags the GET sweep runs under, so both files read the same seed.
localStorage.setItem("quiz-mock-journal", "1");
localStorage.setItem("quiz-mock-projects", "1");
localStorage.setItem("quiz-mock-codespace", "1");
localStorage.setItem("quiz-mock-groups", "1");
await import("./index");
const { flags } = await import("./runtime");
const {
  STUDENT_PROJECT_ACCEPT,
  STUDENT_PROJECT_SOON,
  STUDENT_PROJECT_OPEN,
  STUDENT_PROJECT_FROZEN,
  STUDENT_PROJECT_PAST,
} = await import("./student");

interface Issue {
  code: string;
  format?: string;
  path: PropertyKey[];
  message: string;
}
interface Schema {
  safeParse: (v: unknown) => { success: boolean; error?: { issues: Issue[] } };
}

const get = async (path: string): Promise<unknown> => {
  const res = await fetch(path);
  expect(res.status, `GET ${path}`).toBe(200);
  return res.json() as Promise<unknown>;
};

/** A schema's issues, a hand-written `uuid` excepted (the header of `contract.test.ts` says why). */
const issuesOf = (schema: Schema, value: unknown): string[] => {
  const parsed = schema.safeParse(value);
  if (parsed.success) return [];
  return (parsed.error?.issues ?? [])
    .filter((i) => !(i.code === "invalid_format" && i.format === "uuid"))
    .map((i) => `${i.path.join(".") || "<root>"}: ${i.message}`);
};

interface Ref {
  id: string;
}
const pools = (await get("/app/api/pools")) as Ref[];
const questionIds: string[] = [];
for (const pool of pools) {
  const page = (await get(`/app/api/pools/${pool.id}/questions`)) as { items: Ref[] };
  questionIds.push(...page.items.map((q) => q.id));
}
const courses = (await get("/app/api/courses")) as (Ref & { classrooms: Ref[] })[];
const classroomId = courses[0]!.classrooms[0]!.id;
/** The repositories PRG1-2026's organization may hand out (M3-11, `?projects=1`). */
const sourceNames = ((await get(`/app/api/classrooms/${classroomId}/projects/sources`)) as { name: string }[]).map(
  (s) => s.name,
);
/** PRG1-2024, archived: out of the courses' lists, its group set and gradebook read-only. */
const ARCHIVED_ROOM = "r6";

describe("the mock's projects (?projects=1)", () => {
  it("serves one project per state, on PRG1-2026 and in the Activities", async () => {
    const own = (await get(`/app/api/classrooms/${classroomId}/projects`)) as { state: string; phase: string }[];
    // `?groups=1` adds a draft group project (M3-16a), a published and a stopped one (M3-16b).
    // ADR-127 adds a scheduled one, its phase its state.
    expect(own.map((p) => p.state).sort()).toEqual(["draft", "draft", "draft", "locked", "locked", "locked", "locked", "published", "published", "scheduled"]);
    expect(own.find((p) => p.state === "scheduled")!.phase).toBe("scheduled");
    // The locked ones refine (ADR-104): one released, two frozen and awaiting their release (the stopped group project among them),
    // one under the `commit` strategy whose scores are not final: its deadline passed, nothing locked (#958).
    expect(own.filter((p) => p.state === "locked").map((p) => p.phase).sort()).toEqual(["deadline_passed", "graded", "graded", "released"]);
    const all = (await get("/app/api/activities")) as { kind: string }[];
    expect(all.filter((a) => a.kind === "project")).toHaveLength(10);
  });
});

// `?pjcriteria=1` (ADR-106 §8), for these scenes only: two projects graded by criteria, one frozen awaiting its validation, one open.
describe("the mock's grading by criteria (?pjcriteria=1)", () => {
  beforeAll(() => {
    flags.pjcriteria = true;
  });
  afterAll(() => {
    flags.pjcriteria = false;
  });
  const send = async (path: string, method: string, body?: unknown) => {
    const res = await fetch(path, { method, body: body === undefined ? undefined : JSON.stringify(body) });
    return { status: res.status, body: (await res.json()) as unknown };
  };

  it("grades by criteria (ADR-106 §8): a teacher's points, Validate, the refusals and the release gate", async () => {
    const own = (await get(`/app/api/classrooms/${classroomId}/projects`)) as { id: string; title: string; state: string }[];
    const id = own.find((p) => p.title === "Labo 00 — par critères")!.id;
    const raw = await get(`/app/api/projects/${id}/grading`);
    expect(issuesOf(ProjectGradingView, raw)).toEqual([]);
    const view = raw as ProjectGradingView;
    const todo = view.repos.find((r) => r.frozen && !r.validation.validated)!;
    expect(todo.validation.missing).toEqual(["git.commits"]);
    // ADR-119 §8: the history (a merge, two declared authors) and a criterion's CI output, read on demand.
    const history = ProjectCommitGraph.parse(await get(`/app/api/projects/${id}/repos/${todo.id}/commits`));
    if (history.status !== "ok") throw new Error(history.status);
    expect(history.commits.some((c) => c.parents.length > 1)).toBe(true);
    expect(new Set(history.commits.filter((c) => c.mark === null).map((c) => c.authorName)).size).toBe(2);
    const logged = todo.table.find((r) => r.ciLog)!;
    const output = CriterionCiLog.parse(await get(`/app/api/projects/${id}/repos/${todo.id}/criteria/${logged.criterionId}/ci-log`));
    expect(output.log).toContain("tests passed");
    // The release waits for every repository's validation.
    const blocked = await send(`/app/api/projects/${id}/release`, "POST");
    expect(ProjectReleaseRefusal.parse(blocked.body)).toMatchObject({ error: "not_validated" });
    const refused = await send(`/app/api/projects/${id}/repos/${todo.id}/validate`, "POST");
    expect([refused.status, (refused.body as { error: string }).error]).toEqual([409, "criteria_incomplete"]);
    const out = await send(`/app/api/projects/${id}/repos/${todo.id}/criteria/git.commits`, "PUT", { points: 5 });
    expect(out.status).toBe(422);
    expect(PointsOutOfRange.parse(out.body)).toMatchObject({ min: 0, max: 1 });
    const graded = await send(`/app/api/projects/${id}/repos/${todo.id}/criteria/git.commits`, "PUT", { points: 0 });
    expect(graded.status).toBe(200);
    expect(ProjectGradingRepo.parse(graded.body).validation).toMatchObject({ missing: [], validated: false });
    const validated = await send(`/app/api/projects/${id}/repos/${todo.id}/validate`, "POST");
    expect(ProjectGradingRepo.parse(validated.body)).toMatchObject({ validation: { validated: true }, total: { max: 20 } });
    // The rest, as proposed: each still lacks its teacher-only criterion, named.
    const rest = await send(`/app/api/projects/${id}/validate`, "POST");
    expect([rest.status, (rest.body as { error: string }).error]).toEqual([409, "criteria_incomplete"]);
  });

  it("gives the student's open, frozen and released projects their criteria table (ADR-106 §9)", async () => {
    const tableOf = async (id: string) => {
      const raw = await get(`/app/api/student/projects/${id}`);
      expect(issuesOf(StudentProject, raw)).toEqual([]);
      return (raw as StudentProject).criteria!;
    };
    const open = await tableOf(STUDENT_PROJECT_OPEN);
    expect(open.some((r) => r.rationale !== undefined)).toBe(false);
    const frozen = await tableOf(STUDENT_PROJECT_FROZEN);
    expect([frozen.some((r) => r.rationale !== undefined), frozen.filter((r) => r.state === "empty").length]).toEqual([true, 1]);
    const released = await tableOf(STUDENT_PROJECT_PAST);
    expect(released.every((r) => r.state === "validated")).toBe(true);
    expect(released.reduce((sum, r) => sum + (r.points ?? 0), 0)).toBe(18);
  });
});

describe("the mock's notification address (F-NOTIF-01)", () => {
  const put = async (body: unknown) => {
    const res = await fetch("/app/api/notifications/email", { method: "PUT", body: JSON.stringify(body) });
    return { status: res.status, body: (await res.json()) as unknown };
  };

  it("answers a choice with the settings, null with the default, and refuses a foreign address", async () => {
    const before = NotificationSettings.parse(await get("/app/api/notifications/settings")).email;
    const other = before.options.find((o) => !o.institutional)!.email;
    const chosen = await put({ email: other });
    expect(issuesOf(NotificationSettings, chosen.body)).toEqual([]);
    expect((chosen.body as NotificationSettings).email.address).toBe(other);
    const refused = await put({ email: "someone@else.ch" });
    expect([refused.status, (refused.body as { error: string }).error]).toEqual([400, "email_not_known"]);
    const reset = (await put({ email: null })).body as NotificationSettings;
    expect(reset.email).toEqual(before);
  });
});

// Last: the create adds a draft to PRG1-2026's projects, which the checks above count.
describe("the mock's new project (M3-11)", () => {
  const post = async (classroom: string, body: unknown) => {
    const res = await fetch(`/app/api/classrooms/${classroom}/projects`, {
      method: "POST",
      body: JSON.stringify(body),
    });
    return { status: res.status, body: (await res.json()) as unknown };
  };
  const body = (sourceRepo: string) =>
    ProjectCreate.parse({ name: "Labo 4", sourceRepo, deadlineAt: new Date(Date.now() + 7 * 86_400_000).toISOString() });

  it("creates a draft the classroom's projects then list", { timeout: 10_000 }, async () => {
    const created = await post(classroomId, body(sourceNames[0]!));
    expect(created.status).toBe(200);
    expect(issuesOf(ProjectSummary, created.body)).toEqual([]);
    const own = (await get(`/app/api/classrooms/${classroomId}/projects`)) as { id: string }[];
    expect(own.map((p) => p.id)).toContain((created.body as { id: string }).id);
  });

  it("refuses with the bodies the form reads", async () => {
    const other = courses.flatMap((c) => c.classrooms).find((r) => r.id !== classroomId)!.id;
    const notConnected = await post(other, body(sourceNames[0]!));
    expect(notConnected.status).toBe(409);
    expect(ProjectRefusal.parse(notConnected.body).error).toBe("not_connected");
    const unknown = await post(classroomId, body("no-such-repo"));
    expect(unknown.status).toBe(422);
    expect(ProjectRefusal.parse(unknown.body).error).toBe("source_not_found");
  });
});

describe("the mock's student project writes (M3-13)", () => {
  const post = async (path: string) => {
    const res = await fetch(path, { method: "POST" });
    return { status: res.status, body: (await res.json()) as unknown };
  };

  it("answers Accept with the student's own repository (ProjectAcceptance), and refuses with a code of Accept's list", async () => {
    const soon = await post(`/app/api/student/projects/${STUDENT_PROJECT_SOON}/accept`);
    expect(soon.status).toBe(409);
    expect(PROJECT_ACCEPT_REFUSALS).toContain((soon.body as { error: string }).error);
    // `?refused=1`, as the runtime remembers it: the one refusal only the staff can resolve.
    flags.refused = true;
    try {
      const refused = await post(`/app/api/student/projects/${STUDENT_PROJECT_ACCEPT}/accept`);
      expect(refused.status).toBe(409);
      expect(refused.body).toMatchObject({ error: "repo_name_taken" });
    } finally {
      flags.refused = false;
    }
    const made = await post(`/app/api/student/projects/${STUDENT_PROJECT_ACCEPT}/accept`);
    expect(made.status).toBe(200);
    expect(issuesOf(ProjectAcceptance, made.body)).toEqual([]);
    expect(made.body).toMatchObject({ status: "ok", invitationStatus: "pending" });
    // The card now names the repository, with its invitation pending: the row's next state.
    const view = (await get(`/app/api/student/projects/${STUDENT_PROJECT_ACCEPT}`)) as StudentProject;
    expect(view.repo).toMatchObject({ invitation: "pending", fullName: (made.body as { fullName: string }).fullName });
  });

  it("answers the student's Resend (ProjectInvitationResent), once a minute — on the project accepted above (the invited one runs under SEB here: nobody is invited)", async () => {
    const sent = await post(`/app/api/student/projects/${STUDENT_PROJECT_ACCEPT}/invite`);
    expect(sent.status).toBe(200);
    expect(issuesOf(ProjectInvitationResent, sent.body)).toEqual([]);
    const again = await post(`/app/api/student/projects/${STUDENT_PROJECT_ACCEPT}/invite`);
    expect(again.status).toBe(429);
    expect(again.body).toMatchObject({ error: "resend_too_soon" });
  });
});

describe("the mock's project writes (M3-12b, M3-12c)", () => {
  const send = async (path: string, method: string, body?: unknown) => {
    const res = await fetch(path, { method, body: body === undefined ? undefined : JSON.stringify(body) });
    return { status: res.status, body: (await res.json()) as unknown };
  };
  /** The locked project, every repository frozen: the one the teacher's score and the release apply to. */
  const locked = async () => {
    const own = (await get(`/app/api/classrooms/${classroomId}/projects`)) as { id: string; state: string }[];
    const id = own.find((p) => p.state === "locked")!.id;
    const detail = (await get(`/app/api/projects/${id}`)) as ProjectDetail;
    return { id, detail };
  };
  const published = async () => {
    const own = (await get(`/app/api/classrooms/${classroomId}/projects`)) as { id: string; state: string }[];
    const id = own.find((p) => p.state === "published")!.id;
    const detail = (await get(`/app/api/projects/${id}`)) as ProjectDetail;
    return { id, detail };
  };

  it("answers the teacher's score with the row's scores (ProjectRepoScores), and the release with its result", async () => {
    const { id, detail } = await locked();
    const row = detail.rows.find((r) => r.repo !== null && r.repo.scores.scoreMax !== null && !r.repo.flags.deleted)!;
    const scored = await send(`/app/api/projects/${id}/repos/${row.repo!.id}/score`, "PATCH", { points: 1, comment: "seen" });
    expect(scored.status).toBe(200);
    expect(issuesOf(ProjectRepoScores, scored.body)).toEqual([]);
    expect((scored.body as ProjectRepoScores).scores.teacher).toMatchObject({ points: 1, max: row.repo!.scores.scoreMax });
    const released = await send(`/app/api/projects/${id}/release`, "POST");
    expect(released.status).toBe(200);
    expect(issuesOf(ProjectReleaseResult, released.body)).toEqual([]);
  });

  it("refuses the release of an open project with the body the page parses (ProjectReleaseRefusal)", async () => {
    const { id } = await published();
    const refused = await send(`/app/api/projects/${id}/release`, "POST");
    expect(refused.status).toBe(409);
    expect(issuesOf(ProjectReleaseRefusal, refused.body)).toEqual([]);
    expect(refused.body).toMatchObject({ error: "not_frozen" });
  });

  it("refuses a release over a score to verify, naming the repository by a uuid the contract accepts", async () => {
    const { id, detail } = await locked();
    // The repository whose frozen run is to verify, settled by the teacher's score: clear it, the release is refused.
    const settled = detail.rows.find((r) => r.repo?.flags.toVerify && r.repo.scores.final?.source === "teacher")!;
    expect((await send(`/app/api/projects/${id}/repos/${settled.repo!.id}/score`, "PATCH", { points: null })).status).toBe(200);
    const refused = await send(`/app/api/projects/${id}/release`, "POST");
    expect(refused.status).toBe(409);
    // Strict: the ids must be uuids, as the page's `releaseRefusal` parses them.
    expect(ProjectReleaseRefusal.parse(refused.body)).toEqual({
      error: "to_verify",
      message: expect.any(String),
      repos: [settled.repo!.id],
    });
    // Settled again — with the teacher's own maximum, since no scored run holds it: the release goes through.
    const back = await send(`/app/api/projects/${id}/repos/${settled.repo!.id}/score`, "PATCH", { points: 72, max: 100 });
    expect(back.status).toBe(200);
    expect((await send(`/app/api/projects/${id}/release`, "POST")).status).toBe(200);
  });

  it("resends a pending invitation (ProjectInvitationResent) and re-enables a protection (ProjectRepoProtection)", async () => {
    const { id, detail } = await published();
    const pending = detail.rows.find((r) => r.repo?.invitationStatus === "pending")!;
    const resent = await send(`/app/api/projects/${id}/repos/${pending.repo!.id}/invite`, "POST");
    expect(resent.status).toBe(200);
    expect(issuesOf(ProjectInvitationResent, resent.body)).toEqual([]);
    expect((await send(`/app/api/projects/${id}/repos/${pending.repo!.id}/invite`, "POST")).status).toBe(429);
    const suspended = detail.rows.find((r) => r.repo?.flags.protectionSuspended)!;
    const reenabled = await send(`/app/api/projects/${id}/repos/${suspended.repo!.id}/protection`, "POST");
    expect(reenabled.status).toBe(200);
    expect(issuesOf(ProjectRepoProtection, reenabled.body)).toEqual([]);
    expect((reenabled.body as ProjectRepoProtection).reenabledAt).not.toBeNull();
  });

  it("invites the caller on the distribution, then finds them in (ProjectDistributionAccess, #899)", async () => {
    const { id } = await published();
    const first = await send(`/app/api/projects/${id}/distribution/access`, "POST");
    expect(first.status).toBe(200);
    expect(issuesOf(ProjectDistributionAccess, first.body)).toEqual([]);
    expect((first.body as ProjectDistributionAccess).status).toBe("pending");
    const second = await send(`/app/api/projects/${id}/distribution/access`, "POST");
    expect((second.body as ProjectDistributionAccess).status).toBe("accepted");
  });
});

describe("the mock's group sets (M3-16a, ?groups=1)", () => {
  const send = async (path: string, method: string, body?: unknown) => {
    const res = await fetch(path, { method, body: body === undefined ? undefined : JSON.stringify(body) });
    return { status: res.status, body: res.status === 204 ? null : ((await res.json()) as unknown) };
  };
  const sets = async (room: string) => (await get(`/app/api/classrooms/${room}/group-sets`)) as GroupSetSummary[];
  /** The refusal's code, parsed by the contract's closed list. */
  const refusal = (body: unknown) => GroupErrorCode.parse((body as { error?: unknown }).error);

  it("answers every write of a set with the set (GroupSetDetail), and its refusals with the bodies the pages read", async () => {
    const created = await send(`/app/api/classrooms/${classroomId}/group-sets`, "POST", {});
    expect(issuesOf(GroupSetDetail, created.body)).toEqual([]);
    const set = created.body as GroupSetDetail;
    const base = `/app/api/group-sets/${set.set.id}`;
    const withGroup = (await send(`${base}/groups`, "POST", {})).body as GroupSetDetail;
    expect(issuesOf(GroupSetDetail, withGroup)).toEqual([]);
    const group = withGroup.groups[0]!;
    const student = withGroup.unplaced[0]!;
    const moved = (await send(`${base}/members/${student.enrollmentId}`, "PUT", { groupId: group.id })).body as GroupSetDetail;
    expect(moved.groups[0]!.members.map((s) => s.enrollmentId)).toEqual([student.enrollmentId]);
    // A second group of the same name, a size above the students left: refused, worded by the page.
    const taken = await send(`${base}/groups`, "POST", { name: group.name });
    expect(taken.status).toBe(409);
    expect(refusal(taken.body)).toBe("duplicate_name");
    const tooBig = await send(`${base}/random`, "POST", { size: 500, remainder: "smaller" });
    expect(tooBig.status).toBe(422);
    expect(refusal(tooBig.body)).toBe("size_out_of_range");
    const formed = (await send(`${base}/random`, "POST", { size: 3, remainder: "smaller" })).body as GroupSetDetail;
    expect(formed.unplaced).toEqual([]);
    const nobody = await send(`${base}/random`, "POST", { size: 3, remainder: "smaller" });
    expect(refusal(nobody.body)).toBe("nobody_to_place");
    expect((await send(base, "DELETE")).status).toBe(204);
  });

  it("refuses to delete a set a project follows, naming it (set_in_use)", async () => {
    const pairs = (await sets(classroomId)).find((s) => s.usedBy.length > 0)!;
    const refused = await send(`/app/api/group-sets/${pairs.id}`, "DELETE");
    expect(refused.status).toBe(409);
    expect(refused.body).toMatchObject({ error: "set_in_use", projects: pairs.usedBy.map(({ id, name }) => ({ id, name })) });
  });

  // M3-16b: the group projects on the pairs — one stopped and drifted, one following with repositories.
  const STOPPED = "/app/api/projects/0190d3c4-0000-7000-8000-0000000000b6";
  /** Parsed strictly, uuids included: the page parses the body before it opens its dialog. */
  const strictly = (body: unknown) => GroupConsequences.safeParse(body).error?.issues ?? [];

  it("drifts a stopped group project: its resync names the frozen repositories and an arrival without one, then is owed (M3-16b)", async () => {
    const before = (await get(STOPPED)) as ProjectDetail;
    expect([before.groupsDrifted, before.groupSyncPending, before.primaryAction]).toEqual([true, false, "release"]);
    expect(before.rows.every((r) => r.group !== null && r.group.stopped)).toBe(true);
    const asked = await send(`${STOPPED}/groups/resync`, "POST", {});
    expect([asked.status, refusal(asked.body)]).toEqual([409, "needs_confirmation"]);
    expect(strictly(asked.body)).toEqual([]);
    const { consequences, digest } = asked.body as GroupConsequences;
    expect(new Set(consequences.filter((c) => c.frozen).map((c) => c.repo)).size).toBe(3);
    expect(consequences.filter((c) => c.acceptClosed).map((c) => [c.kind, c.repo])).toEqual([["join", null]]);
    expect((await send(`${STOPPED}/groups/resync`, "POST", { confirm: digest })).status).toBe(204);
    const after = (await get(STOPPED)) as ProjectDetail;
    expect([after.groupsDrifted, after.groupSyncPending]).toEqual([false, true]);
    const release = await send(`${STOPPED}/release`, "POST");
    expect([release.status, (release.body as { error: string }).error]).toEqual([409, "group_sync_pending"]);
  });

  it("asks to confirm a move reaching a following project's repository, and applies it with the digest (M3-16b)", async () => {
    const pairs = (await sets(classroomId)).find((s) => s.usedBy.some((u) => u.follows && u.name.startsWith("Mini")))!;
    const base = `/app/api/group-sets/${pairs.id}`;
    const detail = (await get(base)) as GroupSetDetail;
    const [first, second] = detail.groups;
    const line = first!.members[0]!.enrollmentId;
    const asked = await send(`${base}/members/${line}`, "PUT", { groupId: second!.id });
    expect([asked.status, refusal(asked.body)]).toEqual([409, "needs_confirmation"]);
    expect(strictly(asked.body)).toEqual([]);
    const { consequences, digest } = asked.body as GroupConsequences;
    expect(consequences.map((c) => [c.kind, c.groupName, c.repo !== null])).toEqual([
      ["lose", first!.name, true],
      ["join", second!.name, true],
    ]);
    const moved = await send(`${base}/members/${line}`, "PUT", { groupId: second!.id, confirm: digest });
    expect(moved.status).toBe(200);
    expect((moved.body as GroupSetDetail).groups[1]!.members.map((s) => s.enrollmentId)).toContain(line);
  });

  it("keeps an archived classroom's sets read-only (classroom_archived)", async () => {
    const [set] = await sets(ARCHIVED_ROOM);
    const detail = (await get(`/app/api/group-sets/${set!.id}`)) as GroupSetDetail;
    expect(detail.set.readOnly).toBe(true);
    const refused = await send(`/app/api/group-sets/${set!.id}/groups`, "POST", {});
    expect(refusal(refused.body)).toBe("classroom_archived");
  });
});

describe("the mock's gradebook (M5-04)", () => {
  const send = async (path: string, method: string, body?: unknown) => {
    const res = await fetch(path, { method, body: body === undefined ? undefined : JSON.stringify(body) });
    return { status: res.status, body: res.status === 204 ? null : ((await res.json()) as unknown) };
  };
  const table = async (room = classroomId) => (await get(`/app/api/classrooms/${room}/gradebook`)) as GradebookStaff;
  const refusal = (body: unknown) => GradebookErrorCode.parse((body as { error?: unknown }).error);
  const marks = (t: GradebookStaff, column: GradebookStaff["columns"][number], eid: string) =>
    `/app/api/classrooms/${t.classroomId}/gradebook/columns/${column.kind}/${column.activityId}/marks/${eid}`;

  it("has its columns and its claimed students on PRG1-2026, an absence a1.0, an excused student and a column not released; none elsewhere", async () => {
    const t = await table();
    expect(t.columns.map((c) => c.released)).toContain(false);
    expect(t.rows.length).toBeGreaterThan(5);
    const kinds = new Set(t.rows.flatMap((r) => Object.values(r.cells).map((c) => c.kind)));
    expect([...kinds].sort()).toEqual(["absent", "empty", "excused", "grade"]);
    // Nothing of an unreleased column but a staff mark; and it is out of the mean.
    const unreleased = t.columns.find((c) => !c.released)!;
    const shown = t.rows.map((r) => r.cells[unreleased.activityId]!).filter((c) => c.kind !== "empty");
    expect(shown.every((c) => c.source === "mark")).toBe(true);
    expect((await table("r2")).columns).toEqual([]);
  });

  it("refuses a mark over a real grade without override (409), then takes it; clears it; refuses a score above its maximum (422)", async () => {
    const t = await table();
    const column = t.columns.find((c) => c.released && c.mode === "exam")!;
    const row = t.rows.find((r) => r.cells[column.activityId]!.hasGrade)!;
    const url = marks(t, column, row.enrollmentId);
    const refused = await send(url, "PUT", { kind: "absent" });
    expect([refused.status, refusal(refused.body)]).toEqual([409, "grade_exists"]);
    const over = await send(url, "PUT", { kind: "absent", override: true });
    expect(issuesOf(GradebookStaff, over.body)).toEqual([]);
    const marked = (over.body as GradebookStaff).rows.find((r) => r.enrollmentId === row.enrollmentId)!.cells[column.activityId]!;
    expect(marked).toMatchObject({ kind: "absent", grade: 1, source: "mark", hasGrade: true });
    const high = await send(url, "PUT", { kind: "score", points: 25, max: 20 });
    expect([high.status, refusal(high.body)]).toEqual([422, "score_above_max"]);
    const cleared = (await send(url, "DELETE")).body as GradebookStaff;
    expect(cleared.rows.find((r) => r.enrollmentId === row.enrollmentId)!.cells[column.activityId]!.mark).toBeNull();
  });

  it("answers the column and mean settings with the table, the mean following the weights and the counted flag", async () => {
    const t = await table();
    const column = t.columns.find((c) => c.kind === "evaluation" && c.released)!;
    const path = `/app/api/classrooms/${t.classroomId}/gradebook/columns/${column.kind}/${column.activityId}`;
    const patched = (await send(path, "PATCH", { weight: 45, counts: false })).body as GradebookStaff;
    expect(issuesOf(GradebookStaff, patched)).toEqual([]);
    expect(patched.columns.find((c) => c.activityId === column.activityId)).toMatchObject({ weight: 45, counts: false });
    expect((await send(path, "PATCH", { weight: 101 })).status).toBe(400);
    const off = (await send(`/app/api/classrooms/${t.classroomId}/gradebook`, "PATCH", { meanPublished: false })).body as GradebookStaff;
    expect(off.meanPublished).toBe(false);
  });

  it("is read-only on the archived classroom (409 classroom_archived)", async () => {
    const t = await table(ARCHIVED_ROOM);
    expect(t.archived).toBe(true);
    const refused = await send(`/app/api/classrooms/${ARCHIVED_ROOM}/gradebook`, "PATCH", { meanPublished: true });
    expect([refused.status, refusal(refused.body)]).toEqual([409, "classroom_archived"]);
  });
});

describe("the mock's assistant drives the interface (ADR-080 P2b)", () => {
  it("answers 'show me the questions of the pool …' with the pool to open, searched", async () => {
    const res = await fetch("/app/api/assist/ask", {
      method: "POST",
      body: JSON.stringify({
        message: "Montre-moi les questions de la banque Programmation C, seulement tag:pointeurs",
        context: { route: "/", helpTopic: null, locale: "fr" },
      }),
    });
    expect(res.status).toBe(200);
    const reply = (await res.json()) as AssistReply;
    expect(issuesOf(AssistReply, reply)).toEqual([]);
    expect(reply.actions).toEqual([{ kind: "open_screen", screen: "pool", ids: { id: "p1" }, params: { q: "#pointeurs" } }]);
    expect(reply.exchange.answer).toContain("**Programmation C**");
  });
});

describe("the mock's concept creation (ADR-081, third addendum §5)", () => {
  const post = async (body: unknown) => {
    const res = await fetch("/app/api/concepts", { method: "POST", body: JSON.stringify(body) });
    return { status: res.status, body: (await res.json()) as Record<string, unknown> };
  };

  it("creates a proposed concept in the creator's language, and answers a taken key with its holder", async () => {
    const created = await post({ lang: "en", label: "Linked list", qualifier: "" });
    expect(issuesOf(Concept, created.body)).toEqual([]);
    expect(created.body).toMatchObject({ status: "proposed", labels: { fr: null, en: "Linked list" } });
    const listed = (await get("/app/api/concepts")) as { concepts: { id: string }[] };
    expect(listed.concepts.map((c) => c.id)).toContain(created.body.id);

    const taken = await post({ lang: "en", label: "linked list" });
    expect(taken.status).toBe(409);
    expect(issuesOf(ConceptExists, taken.body)).toEqual([]);
  });

  it("refuses the key of a dropped tag with 422 concept_dropped and its reason", async () => {
    const dropped = await post({ lang: "fr", label: "C01" });
    expect(dropped.status).toBe(422);
    expect(issuesOf(ConceptWriteRefusal, dropped.body)).toEqual([]);
    expect((dropped.body as ConceptWriteRefusal).errors[0]).toEqual({
      input: "C01",
      error: "concept_dropped",
      reason: "organisational",
    });
    // A qualifier tells a concept apart from the dropped tag.
    expect((await post({ lang: "fr", label: "C01", qualifier: "langage" })).status).toBe(200);
  });
});

describe("the mock's Suggest concepts (ADR-081 sixth addendum §6)", () => {
  it("answers the contract's ConceptSuggestions, with a did-you-mean and a new label, for a question it knows", async () => {
    const res = await fetch(`/app/api/questions/${questionIds[0]}/suggest-concepts`, { method: "POST", body: JSON.stringify({ config: {} }) });
    expect(res.status).toBe(200);
    const out = ConceptSuggestions.parse(await res.json());
    expect(out.existing.length).toBeGreaterThan(0);
    expect(out.created).toHaveLength(1);
    expect(out.existing.some((e) => e.asked !== undefined)).toBe(true);
  });
});

describe("the mock's curation queue (ADR-081, fifth addendum)", () => {
  const call = async (method: string, path: string, body?: unknown) => {
    const res = await fetch(path, { method, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    const text = await res.text();
    return { status: res.status, body: text === "" ? null : (JSON.parse(text) as Record<string, unknown>) };
  };
  const queue = async () => {
    const res = await call("GET", "/app/api/admin/concepts");
    expect(issuesOf(AdminConceptList, res.body)).toEqual([]);
    return res.body as unknown as AdminConceptList;
  };

  it("answers the AI's probable duplicates as live concepts of the queue, writing nothing", async () => {
    const before = await queue();
    const res = await call("POST", "/app/api/admin/concepts/duplicates/ai");
    expect(res.status).toBe(200);
    expect(issuesOf(ConceptDuplicatesAi, res.body)).toEqual([]);
    const { pairs } = res.body as unknown as ConceptDuplicatesAi;
    expect(pairs.length).toBeGreaterThan(0);
    const ids = new Set(before.concepts.map((c) => c.id));
    for (const p of pairs) expect([ids.has(p.a), ids.has(p.b), p.a !== p.b]).toEqual([true, true, true]);
    expect(await queue()).toEqual(before);
  });

  it("proposes relations between live concepts of the queue, writing nothing (ADR-114)", async () => {
    const before = await queue();
    const res = await call("GET", "/app/api/admin/concepts/relations/candidates");
    expect(issuesOf(ConceptRelationCandidates, res.body)).toEqual([]);
    const { candidates } = res.body as unknown as ConceptRelationCandidates;
    const fr = new Map(before.concepts.map((c) => [c.id, c.labels.fr]));
    const named = (kind: string) =>
      candidates.filter((c) => c.kind === kind).map((c) => [fr.get(c.concept), fr.get(c.target)]);
    expect(named("broader")).toContainEqual(["Arithmétique des pointeurs", "Pointeur"]);
    const related = candidates.filter((c) => c.kind === "related");
    expect(related.length).toBeGreaterThan(0);
    for (const c of candidates) expect([fr.has(c.concept), fr.has(c.target)]).toEqual([true, true]);
    for (const c of related) expect(c.concept < c.target).toBe(true);
    // Tableau is under Pointeur already: never proposed as related to it.
    expect(named("related").map((p) => [...p].sort())).not.toContainEqual(["Pointeur", "Tableau"]);
    expect(await queue()).toEqual(before);
  });

  it("answers the model's relations on live concepts of the queue, writing nothing (ADR-114 §2)", async () => {
    const before = await queue();
    const res = await call("POST", "/app/api/admin/concepts/relations/ai", { exclude: [] });
    expect(res.status).toBe(200);
    expect(issuesOf(ConceptRelationProposals, res.body)).toEqual([]);
    const proposals = res.body as unknown as ConceptRelationProposals;
    const ids = new Set(before.concepts.map((c) => c.id));
    const named = [
      ...proposals.asked,
      ...proposals.broader.flatMap((e) => [e.concept, e.target]),
      ...proposals.related.flatMap((p) => [p.a, p.b]),
      ...proposals.tops.flatMap((t) => t.narrower),
    ];
    for (const id of named) expect(ids.has(id)).toBe(true);
    expect(proposals).toMatchObject({ remaining: 3, related: [{ reason: expect.any(String) }] });
    expect(proposals.tops).toHaveLength(1);
    expect(await queue()).toEqual(before);
  });

  it("answers the sheet's Suggest a broader concept with that concept's rows only (ADR-114 §3)", async () => {
    const before = await queue();
    const fr = new Map(before.concepts.map((c) => [c.id, c.labels.fr]));
    const hash = before.concepts.find((c) => c.labels.fr === "Hash table")!;
    const res = await call("POST", "/app/api/admin/concepts/relations/ai", { concept: hash.id });
    expect(res.status).toBe(200);
    expect(issuesOf(ConceptRelationProposals, res.body)).toEqual([]);
    const proposals = res.body as unknown as ConceptRelationProposals;
    expect(proposals.asked).toEqual([hash.id]);
    expect(proposals.broader.map((e) => [fr.get(e.concept), fr.get(e.target)])).toEqual([["Hash table", "Tableau"]]);
    expect(proposals.related).toEqual([]);
    expect(proposals.tops).toHaveLength(1);
    expect(proposals.tops[0]!.narrower).toContain(hash.id);
    // A concept with nothing to suggest gets nothing.
    const recursion = before.concepts.find((c) => c.labels.fr === "Récursivité")!;
    const none = (await call("POST", "/app/api/admin/concepts/relations/ai", { concept: recursion.id })).body as unknown as ConceptRelationProposals;
    expect([none.broader, none.tops]).toEqual([[], []]);
    expect(await queue()).toEqual(before);
  });

  it("proposes the empty fields of a concept with Fill with AI, a taken label as taken, writing nothing", async () => {
    const before = await queue();
    const twos = before.concepts.find((c) => c.labels.fr === "Complément à 2")!;
    const form = { fr: { label: "Complément à 2", qualifier: "", description: "" }, en: { label: "", qualifier: "", description: "" } };
    const res = await call("POST", `/app/api/admin/concepts/${twos.id}/fill`, form);
    expect(res.status).toBe(200);
    expect(issuesOf(ConceptFill, res.body)).toEqual([]);
    const fill = res.body as unknown as ConceptFill;
    expect(fill.fr.label).toBeNull();
    expect(fill.en.taken?.label).toBe("Two's complement");
    expect(fill.en.description).not.toBeNull();
    expect(await queue()).toEqual(before);
  });

  it("lists the proposed concepts first, with their usage", async () => {
    const all = await queue();
    expect(all.concepts[0]?.status).toBe("proposed");
    expect(all.concepts.some((c) => c.questionCount > 0)).toBe(true);
  });

  it("refuses to validate a concept missing a language, and to delete a used one", async () => {
    const all = await queue();
    const missing = all.concepts.find((c) => c.labels.en === null)!;
    const refused = await call("POST", `/app/api/admin/concepts/${missing.id}/validate`);
    expect(refused).toMatchObject({ status: 422, body: { error: "concept_label_missing" } });
    const used = all.concepts.find((c) => !c.deletable)!;
    expect((await call("DELETE", `/app/api/admin/concepts/${used.id}`)).status).toBe(409);
  });

  it("validates a complete concept and deletes an unused one", async () => {
    const all = await queue();
    const ready = all.concepts.find((c) => c.status === "proposed" && c.labels.fr !== null && c.labels.en !== null)!;
    expect((await call("POST", `/app/api/admin/concepts/${ready.id}/validate`)).status).toBe(200);
    const unused = (await queue()).concepts.find((c) => c.deletable)!;
    expect((await call("DELETE", `/app/api/admin/concepts/${unused.id}`)).status).toBe(204);
    expect((await queue()).concepts.map((c) => c.id)).not.toContain(unused.id);
  });

  it("merges into a validated concept only, moving the usage, and drops the merged one from the queue", async () => {
    const all = await queue();
    const winner = all.concepts.find((c) => c.status === "validated" && c.questionCount > 0)!;
    const loser = all.concepts.find((c) => c.status === "proposed" && c.questionCount > 0)!;
    const proposed = all.concepts.find((c) => c.status === "proposed" && c.id !== loser.id)!;
    expect(await call("POST", `/app/api/admin/concepts/${loser.id}/merge`, { into: loser.id, keepAsAlias: false })).toMatchObject({ status: 422, body: { error: "concept_merge_self" } });
    expect(await call("POST", `/app/api/admin/concepts/${loser.id}/merge`, { into: proposed.id, keepAsAlias: false })).toMatchObject({
      status: 422,
      body: { error: "concept_merge_target_not_validated" },
    });
    const merged = await call("POST", `/app/api/admin/concepts/${loser.id}/merge`, { into: winner.id, keepAsAlias: false });
    expect(merged.status).toBe(200);
    expect(issuesOf(Concept, merged.body)).toEqual([]);
    const after = (await queue()).concepts;
    expect(after.map((c) => c.id)).not.toContain(loser.id);
    expect(await call("POST", `/app/api/admin/concepts/${loser.id}/merge`, { into: winner.id, keepAsAlias: false })).toMatchObject({ status: 409, body: { error: "concept_merged" } });
  });

  it("adds, refuses and removes relations as the API does, and rewrites them on a merge", async () => {
    const find = async (fr: string, qualifier = "") => (await queue()).concepts.find((c) => c.labels.fr === fr && c.qualifiers.fr === qualifier)!;
    const pointer = await find("Pointeur");
    const leak = await find("Fuite mémoire");
    const tableau = await find("Tableau");
    const dynamic = await find("Allocation dynamique");
    const url = (c: { id: string }) => `/app/api/admin/concepts/${c.id}/relations`;
    // The seed: Fuite mémoire < Allocation dynamique < Pointeur.
    expect(issuesOf(Concept, (await queue()).concepts.find((c) => c.id === dynamic.id))).toEqual([]);
    const cycle = await call("POST", url(pointer), { kind: "broader", target: leak.id });
    expect(cycle).toMatchObject({ status: 409, body: { error: "concept_cycle" } });
    expect(issuesOf(ConceptCycle, cycle.body)).toEqual([]);
    expect((cycle.body as ConceptCycle).path).toHaveLength(4);
    expect(await call("POST", url(pointer), { kind: "broader", target: pointer.id })).toMatchObject({ status: 422, body: { error: "relation_self" } });
    expect(await call("POST", url(leak), { kind: "broader", target: dynamic.id })).toMatchObject({ status: 409, body: { error: "relation_exists" } });
    expect(await call("POST", url(leak), { kind: "related", target: pointer.id })).toMatchObject({ status: 409, body: { error: "relation_redundant" } });
    const added = await call("POST", url(tableau), { kind: "related", target: leak.id });
    expect(added.status).toBe(200);
    expect(issuesOf(Concept, added.body)).toEqual([]);
    expect((await find("Fuite mémoire")).related).toEqual([tableau.id]);
    expect((await call("DELETE", `${url(leak)}/related/${tableau.id}`)).status).toBe(200);
    expect((await call("DELETE", `${url(leak)}/related/${tableau.id}`)).status).toBe(404);
    // Merging Fuite mémoire into Pointeur would make Pointeur broader than Allocation dynamique, which is broader than Pointeur.
    const blocked = await call("POST", `/app/api/admin/concepts/${leak.id}/merge`, { into: pointer.id, keepAsAlias: false });
    expect(blocked.status).toBe(409);
    expect(blocked.body).toMatchObject({ error: "concept_merge_cycle" });
    expect(issuesOf(ConceptCycle, blocked.body)).toEqual([]);
  });

  it("adds, refuses and removes aliases as the API does, and keeps a merged label on request", async () => {
    const all = await queue();
    const pointer = all.concepts.find((c) => c.labels.fr === "Pointeur")!;
    const tableau = all.concepts.find((c) => c.labels.fr === "Tableau")!;
    const url = `/app/api/admin/concepts/${tableau.id}/aliases`;
    const collision = await call("POST", url, { alias: "pointers" });
    expect(collision.status).toBe(409);
    expect(issuesOf(AliasCollision, collision.body)).toEqual([]);
    expect((collision.body as AliasCollision).collisions[0]).toMatchObject({ via: "label", concept: { id: pointer.id } });
    expect(await call("POST", url, { alias: "array" })).toMatchObject({ status: 422, body: { error: "alias_redundant" } });
    const forced = await call("POST", url, { alias: "pointers", force: true });
    expect(forced.status).toBe(200);
    expect(issuesOf(Concept, forced.body)).toEqual([]);
    expect((forced.body as Concept).aliases).toContain("pointers");
    expect(await call("POST", url, { alias: "Pointers" })).toMatchObject({ status: 409, body: { error: "alias_exists" } });
    const removed = await call("DELETE", `${url}/pointers`);
    expect(removed.status).toBe(200);
    expect((removed.body as Concept).aliases).not.toContain("pointers");
  });
});
