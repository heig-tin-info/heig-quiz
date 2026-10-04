/**
 * 5c. The projects (F-PROJ-01, F-PROJ-03, F-PROJ-13; M3-10, M3-12): a
 * classroom's projects as the staff's lists read them
 * (`ProjectActivitySummary`), one project's page (`ProjectDetail`), a
 * repository's runs (`GradeRunList`), the review checkpoints, and every
 * write the page makes — rename, deadline, strategy and protected files
 * (`PATCH`), publish, archive, restore, delete, a repository's own deadline,
 * its lock and unlock, the teacher's score, the release, a pending
 * invitation resent, the protection re-enabled (M3-12b, M3-12c) —, all
 * checked by `contract.test.ts`.
 * `GET /classrooms/:id/projects` is served here; the Activities section's
 * rows are added by `poll.ts`, which serves `GET /activities`, through
 * {@link projectActivities}.
 *
 * Scene flag `?projects=1`: PRG1-2026 (`r1`, connected to GitHub in
 * `github.ts`) has three projects, one per state — a draft starting next
 * week (every row "not accepted"), a published one due next week whose rows
 * walk every state a repository can be in, and one locked at last week's
 * deadline, every repository frozen, released five days ago with one score
 * changed since (the server then names Release as the primary action) and
 * the "score is the grade" scale falling back on scores out of 100.
 * `?unassigned=1`: publishing the draft is refused `409 unassigned_students`
 * with three names. `?unreleased=1`: the locked project is not released yet,
 * so Release is its one action. Without `?projects=1` no classroom has a project, so the
 * default scenes are what they were. The other classrooms are not connected:
 * "New ▾ › Project" there leads to the Settings' connect sheet.
 *
 * The page's first read of a project says `liveStale: true` — the live
 * state of its repositories was not all read in time —, the next ones not:
 * the page's one early refetch is seen once per project.
 */
import {
  PROJECT_DEFAULTS,
  ProjectPatch,
  ReviewCheckpointCreate,
  ScoreOverride,
  type GradeRunList,
  type GradeRunView,
  type ProjectActivitySummary,
  type ProjectDetail,
  type ProjectDetailRow,
  type ProjectInvitationResent,
  type ProjectReleaseResult,
  type ProjectRepoDeadlineState,
  type ProjectRepoProtection,
  type ProjectRepoReview,
  type ProjectRepoScores,
  type ProjectRepoView,
  type ProjectSummary,
  type ReviewCheckpoint,
  type RosterEntry,
} from "@quiz/contracts";
import {
  changedAfterRelease,
  checkpointDueAt,
  checkpointRefusal,
  editableProjectFields,
  projectPrimaryAction,
  resolveFinalScore,
  reviewState,
  scoreGrade,
  teacherScoreMax,
} from "@quiz/domain";

import { classroomRoster, courses, rooms } from "./org";
import { D, flags, H, iso, MockError, MockPayload, nextId, now, on, role } from "./runtime";

/** PRG1-2026's organization, as `github.ts` names it (which this section, above it, cannot read). */
const ORG = "heig-tin-info";
const PROTECTED = ["criteria.yml", "README.md", ".github/workflows/grading.yml"];

/** A repository of the mock, mutable: what the page's writes change. */
interface MockRepo {
  id: string;
  enrollmentId: string | null;
  student: RosterEntry;
  fullName: string;
  provisionStatus: ProjectRepoView["provisionStatus"];
  provisionError: string | null;
  invitationStatus: ProjectRepoView["invitationStatus"];
  acceptedAt: string;
  lastCommit: { sha: string; at: string | null } | null;
  ciStatus: ProjectRepoView["ciStatus"];
  live: ProjectRepoView["live"];
  deadlineAt: string | null;
  deadlineAppliedAt: string | null;
  frozenAt: string | null;
  locked: boolean;
  archived: boolean;
  staffLock: boolean | null;
  degraded: boolean;
  teacher: ProjectRepoView["scores"]["teacher"];
  released: ProjectRepoView["released"];
  protectionSuspended: boolean;
  deleted: boolean;
  runs: GradeRunView[];
  /** The three slots, by run id. */
  currentRunId: string | null;
  frozenRunId: string | null;
  reviewRunId: string | null;
  /** The final review's ledger row (`trigger = deadline`): claimed, and confirmed by GitHub or not. */
  dispatch: { sha: string; dispatchedAt: string | null } | null;
  /** When the staff last resent the invitation (F-PROJ-07): once a minute. */
  resentAt: number | null;
}

interface MockProject {
  summary: ProjectSummary;
  classroom: { id: string; name: string; courseCode: string };
  releasedAt: string | null;
  repos: MockRepo[];
  checkpoints: ReviewCheckpoint[];
  /** The page read it once already: the live state is warm. */
  read: boolean;
}

const SEEDS: { id: string; title: string; state: ProjectSummary["state"]; start: number; deadline: number }[] = [
  { id: "pj-draft", title: "Labo 3 — listes chaînées", state: "draft", start: 7 * D, deadline: 21 * D },
  { id: "pj-published", title: "Labo 2 — pointeurs", state: "published", start: -7 * D, deadline: 7 * D },
  { id: "pj-locked", title: "Labo 1 — premiers pas en C", state: "locked", start: -35 * D, deadline: -7 * D },
];

const slug = (title: string) => title.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
const sha = (n: number) => (0x9a3f1c00 + n * 0x1f3d7).toString(16).padStart(8, "0").repeat(5).slice(0, 40);

/** One run of `grading.yml`, as the ingestion stored it. */
function run(
  repo: string,
  n: number,
  at: number,
  over: Partial<GradeRunView> = {},
): GradeRunView {
  return {
    id: `${repo}-run-${n}`,
    workflowRunId: 7_000_000 + n,
    runAttempt: 1,
    kind: "ci",
    conclusion: "success",
    headBranch: "main",
    headSha: sha(n),
    points: 8,
    max: 10,
    testsPassed: 8,
    testsTotal: 10,
    parseStatus: "ok",
    parseDetail: null,
    afterDeadline: false,
    toVerify: false,
    completedAt: iso(at),
    ...over,
  };
}

/**
 * The repositories of a seeded project: one per claimed student but every
 * tenth (not accepted), each variant decided by the student's rank so the
 * screenshots never move; a locked project's are all frozen and locked.
 */
function seedRepos(seed: (typeof SEEDS)[number], project: ProjectSummary, roster: RosterEntry[]): MockRepo[] {
  if (seed.state === "draft") return [];
  const locked = seed.state === "locked";
  const deadline = Date.parse(project.deadlineAt);
  const repos: MockRepo[] = [];
  const claimed = roster.filter((s) => s.status === "claimed");
  claimed.forEach((student, i) => {
    if (i % 10 === 0) return;
    const id = `${seed.id}-r${i + 1}`;
    const name = `${ORG}/${project.slug}-${(student.githubLogin ?? `${student.prenom}-${student.nom}`).toLowerCase()}`;
    const variant = i % 12;
    const runs: GradeRunView[] = [];
    const base: MockRepo = {
      id,
      enrollmentId: student.id,
      student,
      fullName: name,
      provisionStatus: "ok",
      provisionError: null,
      invitationStatus: "accepted",
      acceptedAt: iso(seed.start + i * H),
      lastCommit: { sha: sha(i * 7 + 1), at: iso(seed.start + (i + 1) * 6 * H) },
      ciStatus: "pass",
      live: { commitCount: 3 + i, checksPassed: 1, checksTotal: 1, stale: false },
      deadlineAt: null,
      deadlineAppliedAt: locked ? project.deadlineAt : null,
      frozenAt: locked ? iso(seed.deadline + 30 * 60_000) : null,
      locked,
      archived: false,
      staffLock: null,
      degraded: false,
      teacher: null,
      released: null,
      protectionSuspended: false,
      deleted: false,
      runs,
      currentRunId: null,
      frozenRunId: null,
      reviewRunId: null,
      dispatch: null,
      resentAt: null,
    };
    const scored = (n: number, at: number, over: Partial<GradeRunView> = {}) => {
      const r = run(id, n, at, over);
      runs.unshift(r);
      return r;
    };
    // A first run a day in, a better one later: the current score is the latest.
    scored(1, seed.start + D, { points: 4, max: 10, testsPassed: 4, headSha: sha(i * 7) });
    const latest = scored(2, seed.start + (i + 1) * 6 * H + 20 * 60_000, { points: 6 + (i % 5), testsPassed: 6 + (i % 5) });
    base.currentRunId = latest.id;
    switch (variant) {
      case 1:
        if (!locked) Object.assign(base, { provisionStatus: "pending", invitationStatus: "none", lastCommit: null, ciStatus: "none", live: null, runs: [], currentRunId: null });
        break;
      case 2:
        if (!locked) Object.assign(base, { invitationStatus: "pending", lastCommit: null, ciStatus: "none", live: { commitCount: 1, checksPassed: null, checksTotal: null, stale: true }, runs: [], currentRunId: null });
        break;
      case 3:
        base.ciStatus = "fail";
        latest.conclusion = "failure";
        latest.points = 3;
        latest.testsPassed = 3;
        break;
      case 4:
        base.protectionSuspended = !locked;
        latest.toVerify = true;
        break;
      case 5:
        scored(3, seed.start + (i + 2) * 6 * H, { points: null, max: null, parseStatus: "multiple", parseDetail: "2 GRADE annotations" });
        break;
      case 6:
        scored(3, seed.start + (i + 2) * 6 * H, { points: null, max: null, parseStatus: "malformed", parseDetail: "::notice title=GRADE::huit/10" });
        break;
      case 7:
        base.deleted = true;
        base.live = null;
        break;
      case 8:
        if (!locked) base.deadlineAt = iso(seed.deadline + 7 * D);
        break;
      case 9:
        Object.assign(base, { locked: true, staffLock: true });
        break;
      case 10:
        base.degraded = true;
        if (locked) base.archived = true;
        break;
      case 11:
        scored(3, seed.start + (i + 3) * 6 * H, { kind: "review", points: 7, max: 10, testsPassed: null, testsTotal: null, headSha: latest.headSha });
        break;
      default:
        break;
    }
    if (locked && !base.deleted) {
      base.frozenRunId = base.currentRunId;
      // The final review, claimed at the definitive freeze (F-PROJ-11); none on a degraded lock.
      // On `i === 2` GitHub's acceptance was never recorded: "not confirmed", never sent again.
      if (!base.archived && base.currentRunId) {
        base.dispatch = { sha: latest.headSha, dispatchedAt: i === 2 ? null : iso(seed.deadline + 31 * 60_000) };
        if (i !== 2) {
          const review = scored(9, seed.deadline + 40 * 60_000, { kind: "review", points: 60 + (i % 7) * 5, max: 100, testsPassed: null, testsTotal: null, headSha: latest.headSha });
          base.reviewRunId = review.id;
        }
      }
      // A late push: in the history, never the frozen score.
      if (i % 4 === 1) scored(8, seed.deadline + 2 * H, { points: 10, max: 10, testsPassed: 10, afterDeadline: true, headSha: sha(i * 7 + 2) });
      // The teacher's score settles the repository whose frozen run is to verify (variant 4, F-PROJ-14 amended):
      // written with the review's maximum, the scored run the final score would otherwise come from.
      if (i === 4) base.teacher = { points: 72, max: 100, comment: "Excellent travail sur la gestion mémoire.", gradedAt: iso(-6 * D) };
      // Released five days ago at the final score of the day; on `i === 5` the review came in after it.
      // `?unreleased=1`: not released yet — Release is the page's one action.
      if (!flags.unreleased) {
        const frozenRun = runs.find((r) => r.id === base.frozenRunId)!;
        const final = finalOf(base);
        base.released =
          i === 5 ? { points: frozenRun.points, max: frozenRun.max } : { points: final?.points ?? null, max: final?.max ?? null };
      }
    }
    repos.push(base);
  });
  // One repository whose student left the roster since.
  const gone: RosterEntry = {
    ...claimed[0]!,
    id: "gone",
    nom: "Ancien",
    prenom: "Élève",
    email: "eleve.ancien@heig-vd.ch",
    githubLogin: "eleve-ancien",
  };
  repos.push({
    id: `${seed.id}-gone`,
    enrollmentId: null,
    student: gone,
    fullName: `${ORG}/${project.slug}-eleve-ancien`,
    provisionStatus: "ok",
    provisionError: null,
    invitationStatus: "accepted",
    acceptedAt: iso(seed.start + 2 * H),
    lastCommit: { sha: sha(99), at: iso(seed.start + 3 * D) },
    ciStatus: "pass",
    live: null,
    deadlineAt: null,
    deadlineAppliedAt: locked ? project.deadlineAt : null,
    frozenAt: locked ? iso(seed.deadline + 30 * 60_000) : null,
    locked,
    archived: false,
    staffLock: null,
    degraded: false,
    teacher: null,
    released: null,
    protectionSuspended: false,
    deleted: false,
    runs: [run(`${seed.id}-gone`, 1, seed.start + 3 * D, { points: 5, testsPassed: 5 })],
    currentRunId: `${seed.id}-gone-run-1`,
    frozenRunId: locked ? `${seed.id}-gone-run-1` : null,
    reviewRunId: null,
    dispatch: locked ? { sha: sha(99), dispatchedAt: iso(seed.deadline + 31 * 60_000) } : null,
    resentAt: null,
  });
  return repos;
}

/** A slot's score, from the run it names. */
function slot(repo: MockRepo, id: string | null) {
  const r = id ? repo.runs.find((x) => x.id === id) : undefined;
  return r ? { runId: r.id, points: r.points, max: r.max } : null;
}

const runOf = (repo: MockRepo, id: string | null) => (id ? (repo.runs.find((x) => x.id === id) ?? null) : null);

/** The slots a final score is resolved from: the review's, the frozen, the current run. */
const slotRuns = (repo: MockRepo) => ({
  reviewScore: runOf(repo, repo.reviewRunId),
  frozenScore: runOf(repo, repo.frozenRunId),
  score: runOf(repo, repo.currentRunId),
});

/** The final score as the server resolves it: the teacher's (with its own maximum), else the review's, else the frozen (or current) one. */
function finalOf(repo: MockRepo) {
  return resolveFinalScore({
    teacherPoints: repo.teacher?.points ?? null,
    teacherMax: repo.teacher?.max ?? null,
    ...slotRuns(repo),
  });
}

/** The final review's state (`reviewState` of `@quiz/domain`), from the repository and its ledger row. */
function reviewOf(p: MockProject, r: MockRepo): ProjectRepoReview {
  const state = reviewState({
    gradingMode: p.summary.gradingMode,
    frozenAt: r.frozenAt ? new Date(r.frozenAt) : null,
    frozenGradeRunId: r.frozenRunId,
    reviewGradeRunId: r.reviewRunId,
    archivedAt: r.archived ? new Date(r.frozenAt ?? now) : null,
    protectionSuspendedAt: r.protectionSuspended ? new Date(now - H) : null,
    dispatch: r.dispatch
      ? { sha: r.dispatch.sha, dispatchedAt: r.dispatch.dispatchedAt ? new Date(r.dispatch.dispatchedAt) : null }
      : null,
  });
  return { ...state, askedAt: state.askedAt?.toISOString() ?? null };
}

const PROJECTS = new Map<string, MockProject>();

/** The seeded projects of `r1`, built once `?projects=1` asks for them. */
function seeded(): MockProject[] {
  const room = rooms.find((r) => r.id === "r1");
  if (!flags.projects || !room || room.archivedAt !== null) return [];
  const course = courses.find((c) => c.id === room.courseId);
  for (const seed of SEEDS) {
    if (PROJECTS.has(seed.id)) continue;
    const name = slug(seed.title);
    const summary: ProjectSummary = {
      id: seed.id,
      classroomId: room.id,
      name: seed.title,
      slug: name,
      state: seed.state,
      publishMode: seed.id === "pj-draft" ? "scheduled" : "manual",
      startAt: iso(seed.start),
      deadlineAt: iso(seed.deadline),
      durationMinutes: null,
      graceMinutes: PROJECT_DEFAULTS.graceMinutes,
      sourceStrategy: "squash",
      deadlineStrategy: "lock",
      gradingMode: "auto",
      gradingScale: seed.state === "locked" ? { kind: "score_is_grade", rounding: "nearest" } : { kind: "linear", rounding: "nearest" },
      branches: ["main"],
      protectedFiles: PROTECTED,
      groupMode: false,
      groupMaxSize: null,
      source: { fullName: `${ORG}/${name.replace(/^labo-(\d)-.*$/, "prg1-labo-0$1")}-${name.split("-").slice(2).join("-")}` },
      distribution: { fullName: `${ORG}/${name}-squashed` },
      deadlineAppliedAt: seed.state === "locked" ? iso(seed.deadline) : null,
      archivedAt: null,
      createdAt: iso(seed.start - 2 * D),
      accepted: seed.state !== "draft",
      editable: [],
    };
    summary.editable = editableProjectFields({ state: summary.state, deadlineAt: new Date(summary.deadlineAt) }, new Date(now));
    const project: MockProject = {
      summary,
      classroom: { id: room.id, name: room.name, courseCode: course?.code ?? "" },
      releasedAt: seed.state === "locked" && !flags.unreleased ? iso(-5 * D) : null,
      repos: seedRepos(seed, summary, classroomRoster(room.id)),
      checkpoints: [],
      read: false,
    };
    const deadline = new Date(summary.deadlineAt);
    project.checkpoints =
      seed.state === "published"
        ? [
            { id: `${seed.id}-cp1`, name: "milestone-1", dueAt: checkpointDueAt(deadline, -7).toISOString(), offsetDays: -7, dispatchedAt: iso(-1 * H) },
            { id: `${seed.id}-cp2`, name: "milestone-2", dueAt: checkpointDueAt(deadline, -2).toISOString(), offsetDays: -2, dispatchedAt: null },
          ]
        : seed.state === "locked"
          ? [
              { id: `${seed.id}-cp1`, name: "mid-term", dueAt: checkpointDueAt(deadline, -7).toISOString(), offsetDays: -7, dispatchedAt: iso(seed.deadline - 7 * D + 60_000) },
              // The deadline was moved earlier after this one was set: void.
              { id: `${seed.id}-cp2`, name: "final-check", dueAt: iso(seed.deadline + D), offsetDays: null, dispatchedAt: null },
            ]
          : [];
    PROJECTS.set(seed.id, project);
  }
  return SEEDS.map((s) => PROJECTS.get(s.id)!);
}

/** The projects created in this page's life (M3-11's form, `projectNew.ts`), any classroom. */
const CREATED: MockProject[] = [];

/** A project the new project form created, a draft on the lists from now on. */
export function addMockProject(summary: ProjectSummary, classroom: MockProject["classroom"]): void {
  const project: MockProject = { summary, classroom, releasedAt: null, repos: [], checkpoints: [], read: false };
  CREATED.push(project);
  PROJECTS.set(summary.id, project);
}

const activityOf = (p: MockProject): ProjectActivitySummary => ({
  kind: "project",
  id: p.summary.id,
  title: p.summary.name,
  state: p.summary.state,
  classroom: p.classroom,
  startAt: p.summary.startAt,
  deadlineAt: p.summary.deadlineAt,
});

/** Every project the staff persona's lists show: none without `?projects=1`, but those created; the archive aside. */
export function projectActivities(archived = false): ProjectActivitySummary[] {
  return [...seeded(), ...CREATED]
    .filter((p) => (p.summary.archivedAt !== null) === archived)
    .map(activityOf);
}

/** A classroom's projects, for its staff; anyone else reads the 404 of a missing classroom. */
on("GET", "/app/api/classrooms/:id/projects", (m, _b, url) => {
  const id = m.groups!.id!;
  if (role === "student" || !rooms.some((r) => r.id === id)) throw new MockError(404, "Not found");
  return projectActivities(url.searchParams.get("archived") === "1").filter((p) => p.classroom.id === id);
});

/** One project of the staff persona, or the 404 of a missing one (a student reads the same 404, invariant 6). */
function projectOr404(id: string): MockProject {
  seeded();
  const p = PROJECTS.get(id);
  if (role === "student" || !p) throw new MockError(404, "Not found");
  return p;
}

const refuse = (status: number, error: string, message: string, extra: Record<string, unknown> = {}) =>
  new MockPayload(status, { error, message, ...extra });

/** A live repository: provisioned, not deleted, its project not archived (`LIVE` of `deadline.ts`). */
const isLive = (p: MockProject, r: MockRepo) => r.provisionStatus === "ok" && !r.deleted && p.summary.archivedAt === null;

function deadlineState(p: MockProject, r: MockRepo): ProjectRepoDeadlineState {
  return {
    id: r.id,
    fullName: r.fullName,
    deadlineAt: r.deadlineAt,
    effectiveDeadlineAt: r.deadlineAt ?? p.summary.deadlineAt,
    deadlineAppliedAt: r.deadlineAppliedAt,
    frozenAt: r.frozenAt,
    locked: r.locked,
    archived: r.archived,
    staffLock: r.staffLock,
    degraded: r.degraded,
  };
}

function repoView(p: MockProject, r: MockRepo): ProjectRepoView {
  const scale = p.summary.gradingScale;
  const graded = (s: { runId: string; points: number | null; max: number | null } | null) =>
    s ? { ...s, grade: scoreGrade(s.points, s.max, scale) } : null;
  const final = finalOf(r);
  const latest = r.runs[0];
  return {
    ...deadlineState(p, r),
    provisionStatus: r.provisionStatus,
    provisionError: r.provisionError,
    invitationStatus: r.invitationStatus,
    acceptedAt: r.acceptedAt,
    lastCommit: r.lastCommit,
    ciStatus: r.ciStatus,
    live: p.read ? r.live : null,
    scores: {
      current: graded(slot(r, r.currentRunId)),
      frozen: graded(slot(r, r.frozenRunId)),
      review: graded(slot(r, r.reviewRunId)),
      teacher: r.teacher,
      final: final ? { ...final, grade: scoreGrade(final.points, final.max, scale) } : null,
    },
    review: reviewOf(p, r),
    released: r.released,
    flags: {
      protectionSuspended: r.protectionSuspended,
      toVerify: [r.currentRunId, r.frozenRunId, r.reviewRunId].some((id) => r.runs.find((x) => x.id === id)?.toVerify),
      multiple: r.runs.some((x) => x.parseStatus === "multiple"),
      malformed: latest?.parseStatus === "malformed" ? latest.parseDetail : null,
      deleted: r.deleted,
      changedAfterRelease: r.released !== null && changedAfterRelease(true, final, r.released),
    },
  };
}

function detailOf(p: MockProject): ProjectDetail {
  const roster = classroomRoster(p.summary.classroomId);
  const byEnrollment = new Map(p.repos.filter((r) => r.enrollmentId).map((r) => [r.enrollmentId!, r]));
  const rows: ProjectDetailRow[] = [
    ...roster
      .slice()
      .sort((a, b) => `${a.nom} ${a.prenom}`.localeCompare(`${b.nom} ${b.prenom}`))
      .map((s) => {
        const repo = byEnrollment.get(s.id);
        return {
          student: {
            enrollmentId: s.id,
            userId: s.userId,
            nom: s.nom,
            prenom: s.prenom,
            email: s.email,
            claimed: s.status === "claimed",
            githubLogin: s.githubLogin,
          },
          repo: repo ? repoView(p, repo) : null,
        };
      }),
    ...p.repos
      .filter((r) => r.enrollmentId === null)
      .map((r) => ({
        student: {
          enrollmentId: null,
          userId: r.student.userId,
          nom: r.student.nom,
          prenom: r.student.prenom,
          email: r.student.email,
          claimed: true,
          githubLogin: r.student.githubLogin,
        },
        repo: repoView(p, r),
      })),
  ];
  const live = p.repos.filter((r) => isLive(p, r));
  const views = rows.map((r) => r.repo).filter((r): r is ProjectRepoView => r !== null);
  const counts = {
    students: roster.length,
    accepted: p.repos.length,
    live: live.length,
    frozen: live.filter((r) => r.frozenAt !== null).length,
    toVerify: views.filter((r) => r.flags.toVerify).length,
    alerts: views.filter((r) => r.flags.multiple || r.flags.protectionSuspended).length,
  };
  const detail: ProjectDetail = {
    ...p.summary,
    releasedAt: p.releasedAt,
    primaryAction: projectPrimaryAction({
      state: p.summary.state,
      archived: p.summary.archivedAt !== null,
      gradingMode: p.summary.gradingMode,
      sourceAhead: false,
      live: counts.live,
      frozen: counts.frozen,
      unverified: live.filter((r) => finalOf(r)?.toVerify === true).length,
      released: p.releasedAt !== null,
      changedAfterRelease: views.filter((r) => r.flags.changedAfterRelease).length,
    }),
    counts,
    // Stale only when there was live state to read.
    liveStale: !p.read && live.length > 0,
    rows,
  };
  p.read = true;
  return detail;
}

on("GET", "/app/api/projects/:id", (m) => detailOf(projectOr404(m.groups!.id!)));

/** The patch rules of `lifecycle.ts`: a field outside `editable` is refused, a past deadline too; a later one reopens. */
on("PATCH", "/app/api/projects/:id", (m, raw) => {
  const p = projectOr404(m.groups!.id!);
  const parsed = ProjectPatch.safeParse(raw);
  if (!parsed.success) throw new MockPayload(400, { error: "validation", message: parsed.error.message });
  const body = parsed.data;
  const s = p.summary;
  for (const [field, value] of Object.entries(body)) {
    if (value === undefined || JSON.stringify(value) === JSON.stringify((s as Record<string, unknown>)[field])) continue;
    if (!s.editable.includes(field as ProjectSummary["editable"][number])) {
      const code = field === "publishMode" || field === "durationMinutes" ? "publish_mode_frozen" : field === "deadlineStrategy" ? "strategy_frozen" : "not_draft";
      throw refuse(409, code, `${field} cannot change now`);
    }
  }
  if (body.deadlineAt !== undefined) {
    if (Date.parse(body.deadlineAt) <= now) throw refuse(422, "deadline_past", "The deadline has passed");
    // The reopen (F-PROJ-09): the project and the repositories at its deadline.
    if (s.state === "locked") {
      s.state = "published";
      s.deadlineAppliedAt = null;
      for (const r of p.repos) {
        if (r.deadlineAt !== null || !isLive(p, r)) continue;
        r.deadlineAppliedAt = null;
        r.frozenAt = null;
        r.frozenRunId = null;
        r.reviewRunId = null;
        r.staffLock = null;
        r.locked = false;
        r.archived = false;
      }
    }
    s.deadlineAt = body.deadlineAt;
    s.durationMinutes = null;
    for (const c of p.checkpoints) {
      if (c.offsetDays !== null && c.dispatchedAt === null) c.dueAt = checkpointDueAt(new Date(s.deadlineAt), c.offsetDays).toISOString();
    }
  }
  if (body.name !== undefined) s.name = body.name;
  if (body.deadlineStrategy !== undefined) s.deadlineStrategy = body.deadlineStrategy;
  if (body.protectedFiles !== undefined) s.protectedFiles = body.protectedFiles;
  if (body.graceMinutes !== undefined) s.graceMinutes = body.graceMinutes;
  if (body.gradingMode !== undefined) s.gradingMode = body.gradingMode;
  if (body.gradingScale !== undefined) s.gradingScale = body.gradingScale;
  s.editable = editableProjectFields({ state: s.state, deadlineAt: new Date(s.deadlineAt) }, new Date(now));
  return s;
});

on("POST", "/app/api/projects/:id/publish", (m) => {
  const p = projectOr404(m.groups!.id!);
  const s = p.summary;
  if (s.state !== "draft") throw refuse(409, "not_draft", "Only a draft is published");
  if (s.distribution === null) throw refuse(409, "distribution_missing", "The distribution repository is not built");
  if (flags.unassigned) {
    // `ProjectUnassigned` wants uuids; the mock's roster ids are not, so each student gets one of its rank.
    const students = classroomRoster(s.classroomId)
      .filter((x) => x.status === "claimed")
      .slice(0, 3)
      .map((x, i) => ({ enrollmentId: `0190d3c4-0000-7000-8000-${String(i + 1).padStart(12, "0")}`, nom: x.nom, prenom: x.prenom }));
    throw refuse(409, "unassigned_students", `${students.length} student(s) in no group`, { students });
  }
  s.state = "published";
  if (s.publishMode === "manual") s.startAt = iso(0);
  s.editable = editableProjectFields({ state: s.state, deadlineAt: new Date(s.deadlineAt) }, new Date(now));
  return s;
});

const setArchived = (id: string, on: boolean) => {
  const p = projectOr404(id);
  p.summary.archivedAt = on ? iso(0) : null;
  return p.summary;
};
on("POST", "/app/api/projects/:id/archive", (m) => setArchived(m.groups!.id!, true));
on("POST", "/app/api/projects/:id/unarchive", (m) => setArchived(m.groups!.id!, false));

on("DELETE", "/app/api/projects/:id", (m) => {
  const p = projectOr404(m.groups!.id!);
  PROJECTS.delete(p.summary.id);
  const created = CREATED.indexOf(p);
  const seed = SEEDS.findIndex((s) => s.id === p.summary.id);
  if (created >= 0) CREATED.splice(created, 1);
  if (seed >= 0) SEEDS.splice(seed, 1);
  return undefined;
});

/** A repository the deadline and lock routes act on, or `409 repo_unavailable`. */
function liveRepoOr409(m: RegExpMatchArray): [MockProject, MockRepo] {
  const p = projectOr404(m.groups!.id!);
  const r = p.repos.find((x) => x.id === m.groups!.rid);
  if (!r) throw new MockError(404, "Not found");
  if (!isLive(p, r)) throw refuse(409, "repo_unavailable", "The repository is not available");
  return [p, r];
}

on("PUT", "/app/api/projects/:id/repos/:rid/deadline", (m, body) => {
  const [p, r] = liveRepoOr409(m);
  const at = body.deadlineAt as string | null;
  if (at !== null && Date.parse(at) <= now) throw refuse(422, "deadline_past", "The deadline has passed");
  const effective = Date.parse(at ?? p.summary.deadlineAt);
  if (r.deadlineAppliedAt !== null && effective > now) {
    r.deadlineAppliedAt = null;
    r.frozenAt = null;
    r.frozenRunId = null;
    r.reviewRunId = null;
    r.locked = r.staffLock ?? false;
    r.archived = false;
  }
  r.deadlineAt = at;
  return deadlineState(p, r);
});

const setLock = (m: RegExpMatchArray, on: boolean) => {
  const [p, r] = liveRepoOr409(m);
  r.staffLock = on;
  r.locked = on;
  if (!on) r.archived = false;
  return deadlineState(p, r);
};
on("POST", "/app/api/projects/:id/repos/:rid/lock", (m) => setLock(m, true));
on("POST", "/app/api/projects/:id/repos/:rid/unlock", (m) => setLock(m, false));

/**
 * The teacher's score (F-PROJ-14, M3-08b): after the definitive freeze on a
 * graded project; its maximum the scored run's, else the teacher's own
 * (`teacherScoreMax`); null clears it. Answers the row's scores, laid over it.
 */
on("PATCH", "/app/api/projects/:id/repos/:rid/score", (m, raw) => {
  const p = projectOr404(m.groups!.id!);
  const r = p.repos.find((x) => x.id === m.groups!.rid);
  if (!r) throw new MockError(404, "Not found");
  const parsed = ScoreOverride.safeParse(raw);
  if (!parsed.success) throw new MockPayload(400, { error: "validation", message: parsed.error.message });
  if (p.summary.gradingMode !== "auto") throw refuse(409, "grading_none", "The project is not graded");
  if (r.frozenAt === null) throw refuse(409, "not_frozen", "The repository is not frozen yet");
  const body = parsed.data;
  if (body.points === null) {
    r.teacher = null;
  } else {
    // A run to verify is no scored run: the teacher gives their own maximum.
    const run = resolveFinalScore(slotRuns(r));
    const max = teacherScoreMax(body.points, body.max, run && !run.toVerify ? run.max : null);
    if ("refusal" in max) throw refuse(422, max.refusal, "The score is refused");
    r.teacher = { points: body.points, max: max.max, comment: body.comment?.trim() || null, gradedAt: iso(0) };
  }
  const view = repoView(p, r);
  const scores: ProjectRepoScores = { scores: view.scores, released: view.released, changedAfterRelease: view.flags.changedAfterRelease };
  return scores;
});

/**
 * The release (F-PROJ-14, D05): every live repository frozen for good, no
 * final score left to verify; a snapshot per repository, rewritten by a
 * release again. A non-live repository's score to verify is released as none.
 */
on("POST", "/app/api/projects/:id/release", (m) => {
  const p = projectOr404(m.groups!.id!);
  if (p.summary.gradingMode !== "auto") throw refuse(409, "grading_none", "The project is not graded");
  const live = p.repos.filter((r) => isLive(p, r));
  const frozen = live.filter((r) => r.frozenAt !== null);
  if (live.length === 0 || frozen.length < live.length) {
    throw refuse(409, "not_frozen", "Some live repositories are not frozen", { live: live.length, frozen: frozen.length });
  }
  const toVerify = live.filter((r) => finalOf(r)?.toVerify).map((r) => r.id);
  if (toVerify.length > 0) throw refuse(409, "to_verify", "Some final scores are to verify", { repos: toVerify });
  const first = p.releasedAt === null;
  let scored = 0;
  for (const r of p.repos) {
    const resolved = finalOf(r);
    const final = resolved && (isLive(p, r) || !resolved.toVerify) ? resolved : null;
    r.released = { points: final?.points ?? null, max: final?.max ?? null };
    if (final) scored += 1;
  }
  p.releasedAt = iso(0);
  const result: ProjectReleaseResult = { releasedAt: p.releasedAt, first, repos: p.repos.length, scored };
  return result;
});

/** The protected files restored again (F-PROJ-08): a no-op on a repository not suspended. */
on("POST", "/app/api/projects/:id/repos/:rid/protection", (m) => {
  const [, r] = liveRepoOr409(m);
  const answer: ProjectRepoProtection = { reenabledAt: r.protectionSuspended ? iso(0) : null };
  r.protectionSuspended = false;
  return answer;
});

/** A pending invitation resent by the staff (F-PROJ-07), at most once a minute. */
on("POST", "/app/api/projects/:id/repos/:rid/invite", (m) => {
  const [, r] = liveRepoOr409(m);
  if (r.invitationStatus !== "pending") throw refuse(409, "invitation_not_pending", "The invitation is not pending");
  if (r.resentAt !== null && Date.now() - r.resentAt < 60_000) throw refuse(429, "resend_too_soon", "Resent less than a minute ago");
  r.resentAt = Date.now();
  const answer: ProjectInvitationResent = { invitationStatus: "pending", resentAt: iso(0) };
  return answer;
});

on("GET", "/app/api/projects/:id/repos/:rid/runs", (m): GradeRunList => {
  const p = projectOr404(m.groups!.id!);
  const r = p.repos.find((x) => x.id === m.groups!.rid);
  if (!r) throw new MockError(404, "Not found");
  return { currentGradeRunId: r.currentRunId, frozenGradeRunId: r.frozenRunId, reviewGradeRunId: r.reviewRunId, runs: r.runs };
});

on("GET", "/app/api/projects/:id/checkpoints", (m) => projectOr404(m.groups!.id!).checkpoints);

on("POST", "/app/api/projects/:id/checkpoints", (m, raw) => {
  const p = projectOr404(m.groups!.id!);
  const parsed = ReviewCheckpointCreate.safeParse(raw);
  if (!parsed.success) throw new MockPayload(400, { error: "validation", message: parsed.error.message });
  const body = parsed.data;
  if (p.checkpoints.some((c) => c.name === body.name)) throw refuse(409, "duplicate_checkpoint", "The name is taken");
  const deadline = new Date(p.summary.deadlineAt);
  const dueAt = body.offsetDays !== undefined ? checkpointDueAt(deadline, body.offsetDays) : new Date(body.dueAt!);
  const why = checkpointRefusal(dueAt, deadline, new Date(now));
  if (why) throw refuse(422, why, why === "due_past" ? "The date has passed" : "The date is after the deadline");
  const checkpoint: ReviewCheckpoint = {
    id: nextId("cp-"),
    name: body.name,
    dueAt: dueAt.toISOString(),
    offsetDays: body.offsetDays ?? null,
    dispatchedAt: null,
  };
  p.checkpoints.push(checkpoint);
  return checkpoint;
});

on("DELETE", "/app/api/projects/:id/checkpoints/:cid", (m) => {
  const p = projectOr404(m.groups!.id!);
  const c = p.checkpoints.find((x) => x.id === m.groups!.cid);
  if (!c) throw new MockError(404, "Not found");
  if (c.dispatchedAt !== null) throw refuse(409, "checkpoint_dispatched", "A dispatch of it was claimed");
  p.checkpoints.splice(p.checkpoints.indexOf(c), 1);
  return undefined;
});
