/**
 * The `group` module's payloads (ADR-070, F-PROJ-06; merge task M3-15a):
 * a classroom's group sets, their groups, a student's place, the random
 * formation, on the course's `staffAccess`. Lot 2 (M3-17, F-PROJ-22): a
 * set opened to its students until a date, their writes (create and name a
 * group, join, leave, rename their own) and their view of the classroom's
 * sets ({@link StudentGroupSet}), the group module's student exit
 * (N-SEC-20).
 *
 * Words (ADR-070 §1): a **group** (fr *groupe*), a **group set** (fr
 * *répartition*), never a "team". A student is a roster line
 * (`enrollmentId`), claimed or not; a staff seat (ADR-018) is never placed.
 */
import { z } from "zod";

import { GROUP_REMAINDERS, slugify } from "@quiz/domain";

const Name = (max: number) =>
  z
    .string()
    .trim()
    .min(1)
    .max(max)
    .refine((name) => slugify(name) !== "", "the name has no letter nor digit");

/** A set's name: free text; the default is "Groups of <date> <time>" in the creator's language. */
export const GroupSetName = Name(200);
/** A group's name: free text, unique in its set; a slug must be left of it (its repository, M3-15b). */
export const GroupName = Name(100);
/** A set's maximum group size: advisory for the staff (a warning, never a refusal), binding for the students (lot 2). */
export const GroupMaxSize = z.number().int().min(1).max(50);

/** `POST /app/api/classrooms/:id/group-sets`: both optional. */
export const GroupSetCreate = z.strictObject({
  name: GroupSetName.optional(),
  maxSize: GroupMaxSize.nullable().optional(),
});
export type GroupSetCreate = z.infer<typeof GroupSetCreate>;

/**
 * `PATCH /app/api/group-sets/:id`: a rename, its maximum size (null: none),
 * or its opening to the students (F-PROJ-22): `openUntil` a date opens it
 * until then by the server's clock (a date already past leaves it closed),
 * null closes it. Open, the set needs a maximum size (`422
 * max_size_required`).
 */
export const GroupSetPatch = z
  .strictObject({
    name: GroupSetName.optional(),
    maxSize: GroupMaxSize.nullable().optional(),
    openUntil: z.iso.datetime().nullable().optional(),
  })
  .refine((b) => b.name !== undefined || b.maxSize !== undefined || b.openUntil !== undefined, { message: "Nothing to update" });
export type GroupSetPatch = z.infer<typeof GroupSetPatch>;

/** `POST /app/api/group-sets/:id/groups`: the name, by default "Group k" with the first free k. */
export const GroupCreate = z.strictObject({ name: GroupName.optional() });
export type GroupCreate = z.infer<typeof GroupCreate>;

/** `PATCH /app/api/group-sets/:id/groups/:gid`. */
export const GroupRename = z.strictObject({ name: GroupName });
export type GroupRename = z.infer<typeof GroupRename>;

/**
 * A write's confirmation of its GitHub consequences (ADR-070 §6): the
 * `digest` of the `409 needs_confirmation` it answers ({@link GroupConsequences}).
 */
export const GroupConfirm = z.string().regex(/^[0-9a-f]{64}$/);

/**
 * `PUT /app/api/group-sets/:id/members/:eid`: the student into a group of
 * the set (moved out of the one they were in), or out of every group (null).
 * `confirm`: the digest of the consequences the staff confirmed (ADR-070 §6).
 */
export const GroupMemberPut = z.strictObject({ groupId: z.uuid().nullable(), confirm: GroupConfirm.optional() });
export type GroupMemberPut = z.infer<typeof GroupMemberPut>;

export const GroupRemainder = z.enum(GROUP_REMAINDERS);
export type GroupRemainder = z.infer<typeof GroupRemainder>;

/**
 * `POST /app/api/group-sets/:id/random` (ADR-070 §3): the students in no
 * group cut into new groups of `size`, from 1 to their number; the
 * remainder goes to smaller or to larger groups. Groups already formed are
 * never touched.
 */
export const GroupRandomForm = z.strictObject({
  size: z.number().int().min(1).max(500),
  remainder: GroupRemainder,
});
export type GroupRandomForm = z.infer<typeof GroupRandomForm>;

export const GroupParams = z.object({ id: z.uuid(), gid: z.uuid() });
export type GroupParams = z.infer<typeof GroupParams>;
export const GroupMemberParams = z.object({ id: z.uuid(), eid: z.uuid() });
export type GroupMemberParams = z.infer<typeof GroupMemberParams>;

/** A student of a set: a roster line, claimed (`claimed`) or not. Never an e-mail nor a GitHub login. */
export const GroupStudent = z.object({
  enrollmentId: z.uuid(),
  nom: z.string(),
  prenom: z.string(),
  claimed: z.boolean(),
});
export type GroupStudent = z.infer<typeof GroupStudent>;

/**
 * A project naming the set (ADR-070 §4): `follows` — its copy still
 * follows the set (its groups have not stopped); `archived` — it does not
 * hold the set against a deletion.
 */
export const GroupSetUse = z.object({
  id: z.uuid(),
  name: z.string(),
  archived: z.boolean(),
  follows: z.boolean(),
});
export type GroupSetUse = z.infer<typeof GroupSetUse>;

/**
 * A set in its classroom's list (`GET /app/api/classrooms/:id/group-sets`,
 * ADR-070 §7): its number of groups, the students placed and not placed
 * (staff seats never counted), the projects that name it.
 */
export const GroupSetSummary = z.object({
  id: z.uuid(),
  name: z.string(),
  maxSize: z.number().int().nullable(),
  groups: z.number().int(),
  placed: z.number().int(),
  unplaced: z.number().int(),
  createdAt: z.iso.datetime(),
  /** Opened to the students until then (F-PROJ-22); null: never opened, or closed. */
  openUntil: z.iso.datetime().nullable(),
  /** Open to the students now, by the server's clock (`openUntil` ahead, the classroom not archived). */
  open: z.boolean(),
  usedBy: z.array(GroupSetUse),
});
export type GroupSetSummary = z.infer<typeof GroupSetSummary>;

/**
 * One set (`GET /app/api/group-sets/:id`, and the answer of every write
 * on it): its groups in their order with their members, the students in
 * no group, the projects that name it. `readOnly`: its classroom is
 * archived, every write answers `409 classroom_archived`.
 */
export const GroupSetDetail = z.object({
  set: z.object({
    id: z.uuid(),
    classroomId: z.uuid(),
    name: z.string(),
    maxSize: z.number().int().nullable(),
    createdAt: z.iso.datetime(),
    readOnly: z.boolean(),
    /** As in {@link GroupSetSummary}. */
    openUntil: z.iso.datetime().nullable(),
    open: z.boolean(),
  }),
  groups: z.array(z.object({ id: z.uuid(), name: z.string(), position: z.number().int(), members: z.array(GroupStudent) })),
  unplaced: z.array(GroupStudent),
  usedBy: z.array(GroupSetUse),
});
export type GroupSetDetail = z.infer<typeof GroupSetDetail>;

/**
 * One GitHub consequence of a set's write (ADR-070 §6; merge task
 * M3-15b-2): a student (a roster line, by name) who loses (`lose`) the
 * repository of a following project's copy group, or joins it (`join`).
 * `repo` is the repository's full name, null while its first provisioning
 * runs. Named even when GitHub will have nothing to do — no account
 * invited, the App gone — since it changes whose repository and grade it
 * is (product owner, 2026-10-05).
 */
export const GroupConsequence = z.object({
  projectId: z.uuid(),
  projectName: z.string(),
  groupId: z.uuid(),
  groupName: z.string(),
  repo: z.string().nullable(),
  enrollmentId: z.uuid(),
  nom: z.string(),
  prenom: z.string(),
  kind: z.enum(["lose", "join"]),
});
export type GroupConsequence = z.infer<typeof GroupConsequence>;

/**
 * The details of `needs_confirmation`: the consequences the write ADDS to
 * those already waiting for GitHub, and their `digest` (SHA-256, hex, of
 * their canonical list), to send back as `confirm`.
 */
export const GroupConsequences = z.object({ consequences: z.array(GroupConsequence), digest: GroupConfirm });
export type GroupConsequences = z.infer<typeof GroupConsequences>;

/**
 * The refusals of the group routes, `{ error, message, ...details }`,
 * worded by the web app (statuses in the API's `modules/group/errors.ts`):
 *   - `classroom_archived` (409) — any write on a set of an archived
 *     classroom (its sets are read-only);
 *   - `set_in_use` (409) — deleting a set a project that is not archived
 *     names (`projects`: id and name of each);
 *   - `duplicate_name` (409) — a group's name already taken in its set;
 *   - `nobody_to_place` (409) — a random formation with every student of
 *     the set already in a group;
 *   - `size_out_of_range` (422) — a random formation's size above the
 *     number of students to place;
 *   - `has_repo` (409) — deleting a group whose following copy in a
 *     project has a repository (`projects`: id and name of each); emptying
 *     it is allowed, member by member. A rename follows (the slug, hence
 *     the repository's name, is fixed);
 *   - `needs_confirmation` (409) — a write with GitHub consequences sent
 *     without the digest of them, or with a stale one (another write
 *     changed them meanwhile): {@link GroupConsequences}. Sent again with
 *     `confirm: <digest>`, it is applied, the GitHub side by the
 *     `group.sync` job (M3-15b-2);
 *   - `max_size_required` (422) — opening a set with no maximum size, or
 *     clearing it while the set is open (F-PROJ-22);
 *   - and a student's write (F-PROJ-22, M3-17): `set_closed` (409) — the
 *     set is not open any more (its `openUntil` passed, by the server's
 *     clock, no grace); `set_frozen` (409) — a group of the set has a
 *     repository in a project, so its groups are the staff's alone;
 *     `group_full` (409) — the group holds the maximum size, or more.
 * A group, a student or a set out of reach is the 404 of a missing one.
 */
/**
 * The details of `set_in_use` and `has_repo`: EVERY project concerned, by
 * id and name (the projects naming the set; the following projects whose
 * copy the write would reach on GitHub).
 */
export const GroupRefusalProjects = z.object({ projects: z.array(z.object({ id: z.uuid(), name: z.string() })) });
export type GroupRefusalProjects = z.infer<typeof GroupRefusalProjects>;

export const GROUP_REFUSALS = [
  "classroom_archived",
  "set_in_use",
  "duplicate_name",
  "nobody_to_place",
  "size_out_of_range",
  "has_repo",
  "needs_confirmation",
  "max_size_required",
  "set_closed",
  "set_frozen",
  "group_full",
] as const;
export const GroupErrorCode = z.enum(GROUP_REFUSALS);
export type GroupErrorCode = z.infer<typeof GroupErrorCode>;

// ---------------------------------------------------------------- the students' side (F-PROJ-22, M3-17)

/** A classmate as a student reads them: the first and last names, nothing else (N-SEC-20). */
export const GroupMemberName = z.object({ nom: z.string(), prenom: z.string() });
export type GroupMemberName = z.infer<typeof GroupMemberName>;

/**
 * One set as a student reads it (`GET /app/api/classrooms/:id/group-sets/student`,
 * and the answer of every student write), the group module's student exit
 * (ADR-070 §8, N-SEC-20). A set reaches a student while it is OPEN, or
 * while a published project of the classroom that is not archived names it.
 *
 * - Open: every group (its name, its size, its members' names) and the
 *   students in no group (`unplaced`).
 * - Closed: their own group alone, if any (the projects follow it), and no
 *   `unplaced`.
 *
 * Never a roster line's id, a claim, an e-mail, a GitHub login, the projects
 * that name the set. `writable`: the caller may write now — open, no group
 * of the set with a repository, the classroom not archived, their own portal
 * session on a claimed student seat (so never a teacher in the student
 * view, nor an impersonation). `myGroupId`: the caller's group, null when in
 * none. `serverNow`: the server's clock, to count down to `openUntil` and
 * read the set again when it passes.
 */
export const StudentGroupSet = z.object({
  set: z.object({
    id: z.uuid(),
    name: z.string(),
    maxSize: z.number().int().nullable(),
    openUntil: z.iso.datetime().nullable(),
    open: z.boolean(),
  }),
  serverNow: z.iso.datetime(),
  writable: z.boolean(),
  myGroupId: z.uuid().nullable(),
  groups: z.array(z.object({ id: z.uuid(), name: z.string(), size: z.number().int(), members: z.array(GroupMemberName) })),
  unplaced: z.array(GroupMemberName).optional(),
});
export type StudentGroupSet = z.infer<typeof StudentGroupSet>;

/** The classroom's sets a student reads, the oldest first. */
export const StudentGroupSets = z.array(StudentGroupSet);
export type StudentGroupSets = z.infer<typeof StudentGroupSets>;

/**
 * `POST /app/api/group-sets/:id/student/groups`: a new group, named "Group k"
 * (fr "Groupe k") by default in the student's language, with its creator
 * moved in (out of the group they were in).
 */
export const StudentGroupCreate = z.strictObject({ name: GroupName.optional() });
export type StudentGroupCreate = z.infer<typeof StudentGroupCreate>;

/** `PUT /app/api/group-sets/:id/student/membership`: the caller into a group of the set, below its maximum size. */
export const StudentGroupJoin = z.strictObject({ groupId: z.uuid() });
export type StudentGroupJoin = z.infer<typeof StudentGroupJoin>;

/**
 * An open set in the student's Activities (F-ORG-14, F-ORG-15): "Form your
 * group until …", in Open now, leading to the classroom's Groups tab. Never
 * the urgent accent, never a notification.
 */
export const StudentGroupSetCard = z.object({
  id: z.uuid(),
  classroomId: z.uuid(),
  classroomName: z.string(),
  courseCode: z.string(),
  name: z.string(),
  openUntil: z.iso.datetime(),
  /** The caller's group's name, null when in none. */
  myGroup: z.string().nullable(),
});
export type StudentGroupSetCard = z.infer<typeof StudentGroupSetCard>;
