/**
 * The project page's fixtures (F-PROJ-13, M3-12): a project detail as
 * `GET /app/api/projects/:id` answers it, a repository row in every state a
 * test needs, a run of its history and a checkpoint. Every field set, so a
 * test overrides the one it is about.
 */
import type {
  GradeRunList,
  GradeRunView,
  ProjectDetail,
  ProjectDetailGroup,
  ProjectDetailRow,
  ProjectRepoView,
  ProjectStudent,
  ReviewCheckpoint,
} from "@quiz/contracts";

export const PROJECT_ID = "0190d3c4-0000-7000-8000-0000000000p1";
export const CLASSROOM_ID = "0190d3c4-0000-7000-8000-0000000000c1";
export const BASE = `/app/api/projects/${PROJECT_ID}`;

/** A fortnight ahead, and a week ago: a deadline still open, and one already applied. */
export const AHEAD = new Date(Date.now() + 14 * 86_400_000).toISOString();
export const PAST = new Date(Date.now() - 7 * 86_400_000).toISOString();

export function makeStudent(n: number, over: Partial<ProjectStudent> = {}): ProjectStudent {
  return {
    enrollmentId: `0190d3c4-0000-7000-8000-00000000e${String(n).padStart(3, "0")}`,
    userId: `0190d3c4-0000-7000-8000-00000000u${String(n).padStart(3, "0")}`,
    nom: ["Dupont", "Martin", "Rochat", "Favre"][n % 4]!,
    prenom: ["Alice", "Benoît", "Chloé", "David"][n % 4]!,
    email: `student${n}@heig-vd.ch`,
    claimed: true,
    githubLogin: `student-${n}`,
    ...over,
  };
}

export function makeRepo(n: number, over: Partial<ProjectRepoView> = {}): ProjectRepoView {
  return {
    // A real uuid: the release's `to_verify` body names repositories by `z.uuid()` ids.
    id: `0190d3c4-0000-7000-8000-00000000a${String(n).padStart(3, "0")}`,
    fullName: `heig-tin-info/labo-2-student-${n}`,
    deadlineAt: null,
    effectiveDeadlineAt: AHEAD,
    deadlineAppliedAt: null,
    frozenAt: null,
    locked: false,
    archived: false,
    staffLock: null,
    degraded: false,
    provisionStatus: "ok",
    provisionError: null,
    invitationStatus: "accepted",
    acceptedAt: PAST,
    lastCommit: { sha: "9a3f1c7e2b4d6f8a0c1e3b5d7f9a1c3e5b7d9f1a", at: PAST },
    ciStatus: "pass",
    live: { commitCount: 12, checksPassed: 1, checksTotal: 1, stale: false },
    scores: {
      current: { runId: "run-2", points: 8, max: 10, grade: { grade: 5, fellBack: false } },
      frozen: null,
      review: null,
      teacher: null,
      final: { points: 8, max: 10, source: "ci", toVerify: false, grade: { grade: 5, fellBack: false } },
      scoreMax: 10,
    },
    review: { status: "pending", reason: null, askedAt: null, sha: null, runId: null },
    sync: { pr: null, outcome: null, at: null },
    released: null,
    flags: {
      protectionSuspended: false,
      toVerify: false,
      multiple: false,
      malformed: null,
      deleted: false,
      changedAfterRelease: false,
    },
    accessToRevoke: false,
    ...over,
  };
}

export const row = (
  n: number,
  repo: ProjectRepoView | null,
  student: Partial<ProjectStudent> = {},
  group: ProjectDetailGroup | null = null,
): ProjectDetailRow => ({
  student: makeStudent(n, student),
  repo,
  group,
});

/** A copy group of a group project's page (M3-16b), following its set unless `stopped`. */
export const makeGroup = (n: number, stopped = false): ProjectDetailGroup => ({
  id: `0190d3c4-0000-7000-8000-00000000b${String(n).padStart(3, "0")}`,
  name: `Groupe ${n}`,
  stopped,
});

export function makeProject(over: Partial<ProjectDetail> = {}): ProjectDetail {
  const rows = over.rows ?? [row(1, makeRepo(1)), row(2, null)];
  const accepted = rows.filter((r) => r.repo !== null).length;
  return {
    id: PROJECT_ID,
    classroomId: CLASSROOM_ID,
    name: "Labo 2 — pointeurs",
    slug: "labo-2-pointeurs",
    state: "published",
    publishMode: "manual",
    startAt: PAST,
    deadlineAt: AHEAD,
    durationMinutes: null,
    graceMinutes: 30,
    sourceStrategy: "squash",
    deadlineStrategy: "lock",
    gradingMode: "auto",
    gradingScale: { kind: "linear", rounding: "nearest" },
    branches: ["main"],
    protectedFiles: ["criteria.yml", ".github/workflows/grading.yml"],
    groupMode: false,
    groupSetId: null,
    source: { fullName: "heig-tin-info/prg1-labo-02-pointeurs" },
    distribution: { fullName: "heig-tin-info/labo-2-pointeurs-squashed" },
    deadlineAppliedAt: null,
    archivedAt: null,
    createdAt: PAST,
    accepted: accepted > 0,
    editable: ["name", "deadlineAt", "deadlineStrategy", "protectedFiles"],
    releasedAt: null,
    groupsDrifted: false,
    groupSyncPending: false,
    primaryAction: "none",
    sync: { ahead: null, inProgress: false, syncedAt: null, last: null },
    counts: { students: rows.length, accepted, groups: 0, live: accepted, frozen: 0, toVerify: 0, alerts: 0 },
    liveStale: false,
    rows,
    ...over,
  };
}

/** A draft: nothing accepted, Publish the primary action, everything editable. */
export const makeDraft = (over: Partial<ProjectDetail> = {}): ProjectDetail =>
  makeProject({
    state: "draft",
    startAt: AHEAD,
    primaryAction: "publish",
    accepted: false,
    rows: [row(1, null), row(2, null)],
    editable: [
      "name",
      "publishMode",
      "startAt",
      "deadlineAt",
      "durationMinutes",
      "graceMinutes",
      "deadlineStrategy",
      "gradingMode",
      "gradingScale",
      "protectedFiles",
      "groupMode",
      "groupSetId",
    ],
    ...over,
  });

export function makeRun(n: number, over: Partial<GradeRunView> = {}): GradeRunView {
  return {
    id: `run-${n}`,
    workflowRunId: 7_000_000 + n,
    runAttempt: 1,
    kind: "ci",
    conclusion: "success",
    headBranch: "main",
    headSha: `${n}a3f1c7e2b4d6f8a0c1e3b5d7f9a1c3e5b7d9f1a`,
    points: 8,
    max: 10,
    testsPassed: 8,
    testsTotal: 10,
    parseStatus: "ok",
    parseDetail: null,
    afterDeadline: false,
    toVerify: false,
    completedAt: PAST,
    ...over,
  };
}

export const makeRunList = (over: Partial<GradeRunList> = {}): GradeRunList => ({
  currentGradeRunId: "run-2",
  frozenGradeRunId: null,
  reviewGradeRunId: null,
  runs: [makeRun(2), makeRun(1, { points: 4, testsPassed: 4 })],
  ...over,
});

export const makeCheckpoint = (n: number, over: Partial<ReviewCheckpoint> = {}): ReviewCheckpoint => ({
  id: `0190d3c4-0000-7000-8000-00000000cp${String(n).padStart(2, "0")}`,
  name: `milestone-${n}`,
  dueAt: new Date(Date.now() + 7 * 86_400_000).toISOString(),
  offsetDays: -7,
  dispatchedAt: null,
  ...over,
});
