/**
 * 5b'. The group sets (ADR-070, M3-15a's routes, M3-16a's screens): a
 * classroom's sets, one set with its groups and its students in no group,
 * and every write of the staff — create, rename, maximum size, duplicate,
 * delete (`409 set_in_use`), a group created, renamed (`409
 * duplicate_name`), deleted, a student moved, the random formation (`409
 * nobody_to_place`, `422 size_out_of_range`); an archived classroom's sets
 * answer `409 classroom_archived` to every write. All checked by
 * `contract.test.ts`.
 *
 * Above `project.ts`, which reads it: a project names a set, and the
 * projects that name one are what a set says it is used by. That answer is
 * the project section's, handed in through {@link provideSetUses} so the
 * graph stays acyclic — and so is a move's GitHub consequences
 * ({@link provideMoveConsequences}, M3-16b): a move touching a group with
 * a repository in a following project answers `409 needs_confirmation`
 * until it is sent again with the digest ({@link mockDigest}).
 *
 * Scene flag `?groups=1`: PRG1-2026 (`r1`) has three sets — "Binômes des
 * labos", everyone in a pair, named by a draft group project; "Projet
 * final", five groups (one above its maximum of 4, one empty) and eight
 * students in no group; and an empty one, just created. PRG1-2024 (`r6`,
 * archived) has one, read-only. With `?many=1` the pairs of PRG1-2026 are
 * sixty: the board of a class of 120. Without the flag no classroom has a
 * set, so the default scenes are what they were.
 *
 * The students' side (F-PROJ-22, M3-17): "Projet final" is open to the
 * students for three days, and the student persona is one of its eight
 * students in no group (`ME_LINE`); their view of the classroom's sets,
 * their four writes (`set_closed`, `group_full`, `duplicate_name`), and the
 * Activities row and the Groups tab, which `student.ts` reads (as it reads
 * the projects through `poll.ts`).
 */
import {
  GroupConsequences,
  GroupCreate,
  GroupMemberPut,
  GroupRandomForm,
  GroupRename,
  GroupSetCreate,
  GroupSetPatch,
  StudentGroupCreate,
  StudentGroupJoin,
  type GroupConsequence,
  type GroupMemberName,
  type GroupSetDetail,
  type GroupSetSummary,
  type GroupSetUse,
  type GroupStudent,
  type RosterEntry,
  type StudentGroupSet,
  type StudentGroupSetCard,
  type StudentGroupSets,
} from "@quiz/contracts";
import { defaultGroupName, defaultSetName, duplicateSetName, formRandomGroups, type NameLocale } from "@quiz/domain";

import { classroomRoster, rooms, studentRooms } from "./org";
import { D, flags, H, iso, MockError, MockPayload, on, rand, refuse, role } from "./runtime";

/** The seeded sets' ids: uuids, as a project's `groupSetId` must be (`ProjectPatch`). */
export const SET_PAIRS = "5e7a0000-0000-4000-8000-000000000001";
const SET_FINAL = "5e7a0000-0000-4000-8000-000000000002";
const SET_EMPTY = "5e7a0000-0000-4000-8000-000000000003";
const SET_ARCHIVED = "5e7a0000-0000-4000-8000-000000000004";

interface MockGroup {
  id: string;
  name: string;
  position: number;
  /** Enrollment ids. */
  members: string[];
}

interface MockSet {
  id: string;
  classroomId: string;
  name: string;
  maxSize: number | null;
  createdAt: string;
  /** Open to the students until then (F-PROJ-22); null: closed. */
  openUntil: string | null;
  groups: MockGroup[];
}

const SETS: MockSet[] = [];

/** A group's id: a uuid, as `GroupMemberPut` parses one. */
let groupSeq = 0;
const groupId = () => `6a0b0000-0000-4000-8000-${String((groupSeq += 1)).padStart(12, "0")}`;
let setSeq = 100;
const setId = () => `5e7a0000-0000-4000-8000-${String((setSeq += 1)).padStart(12, "0")}`;

/** The language a default name is written in: the reader's, as the server takes the creator's. */
const nameLocale = (): NameLocale => (document.documentElement.lang.startsWith("fr") ? "fr" : "en");

/** Groups cut from `students` in order, `sizes` long, named "Groupe k". */
function cut(students: RosterEntry[], sizes: number[]): MockGroup[] {
  let at = 0;
  return sizes.map((n, i) => {
    const members = students.slice(at, at + n).map((s) => s.id);
    at += n;
    return { id: groupId(), name: `Groupe ${i + 1}`, position: i, members };
  });
}

if (flags.groups) {
  const r1 = classroomRoster("r1");
  SETS.push(
    {
      id: SET_PAIRS,
      classroomId: "r1",
      name: "Binômes des labos",
      maxSize: 2,
      createdAt: iso(-20 * D),
      openUntil: null,
      groups: cut(r1, Array.from({ length: Math.floor(r1.length / 2) }, () => 2)),
    },
    {
      id: SET_FINAL,
      classroomId: "r1",
      name: "Projet final",
      maxSize: 4,
      createdAt: iso(-3 * D),
      // Open to the students for three days (M3-17).
      openUntil: iso(3 * D),
      // Four, four, five (above the maximum), three, and an empty group; the rest in none.
      groups: [...cut(r1, [4, 4, 5, 3]), { id: groupId(), name: "Groupe 5", position: 4, members: [] }],
    },
    { id: SET_EMPTY, classroomId: "r1", name: defaultSetName(new Date(Date.now() - H), "fr"), maxSize: null, createdAt: iso(-H), openUntil: null, groups: [] },
    {
      id: SET_ARCHIVED,
      classroomId: "r6",
      name: "Binômes 2024",
      maxSize: 2,
      createdAt: iso(-700 * D),
      openUntil: null,
      groups: cut(classroomRoster("r6"), Array.from({ length: 10 }, () => 2)),
    },
  );
}

/** What a set says it is used by: the project section's answer (`project.ts`). */
let usesOf: (setId: string) => GroupSetUse[] = () => [];
export function provideSetUses(fn: (setId: string) => GroupSetUse[]): void {
  usesOf = fn;
}

/** What a move of `enrollmentId` from `from` to `to` (group ids, null: none) does on GitHub: the project section's answer. */
type MoveConsequences = (setId: string, enrollmentId: string, from: string | null, to: string | null) => GroupConsequence[];
let consequencesOf: MoveConsequences = () => [];
export function provideMoveConsequences(fn: MoveConsequences): void {
  consequencesOf = fn;
}

/**
 * The digest of some consequences (ADR-070 §6): 64 hex characters, as
 * `GroupConfirm` parses them — an FNV-1a of their canonical list, not the
 * API's SHA-256, but as stable: the same consequences, the same digest.
 */
export function mockDigest(consequences: readonly GroupConsequence[]): string {
  const canonical = consequences.map((c) => `${c.projectId}:${c.groupId}:${c.enrollmentId}:${c.kind}`).sort().join("|");
  let hash = 0x811c9dc5;
  const words: string[] = [];
  for (let round = 0; round < 8; round += 1) {
    for (const ch of `${round}${canonical}`) hash = Math.imul(hash ^ ch.charCodeAt(0), 0x01000193) >>> 0;
    words.push(hash.toString(16).padStart(8, "0"));
  }
  return words.join("");
}

/** `409 needs_confirmation` with the consequences and their digest, as the group routes and the resync answer it. */
export const confirmationNeeded = (consequences: GroupConsequence[]) =>
  refuse(409, "needs_confirmation", "This change has consequences on GitHub: confirm them", GroupConsequences.parse({ consequences, digest: mockDigest(consequences) }));

/** A roster line's id as a consequence names it: a uuid, as `GroupConsequence` parses one (the mock's lines are `r1-s3`). */
export const lineUuid = (enrollmentId: string): string => {
  let n = 0;
  for (const ch of enrollmentId) n = (n * 31 + ch.charCodeAt(0)) % 1_000_000_000_000;
  return `0190d3c4-0000-7000-8000-${String(n).padStart(12, "0")}`;
};

/** The groups of set `id` as they stand (id, name, members' roster lines): a following project's copy. */
export const setGroupsOf = (id: string): { id: string; name: string; members: string[] }[] =>
  (SETS.find((s) => s.id === id)?.groups ?? [])
    .slice()
    .sort((a, b) => a.position - b.position)
    .map((g) => ({ id: g.id, name: g.name, members: [...g.members] }));

/** Whether `setId` is a set of `classroomId`: a project may only name one of its own classroom's. */
export const isSetOf = (classroomId: string, id: string): boolean =>
  SETS.some((s) => s.id === id && s.classroomId === classroomId);

/** The claimed students of the classroom in no group of `id`: whom a group project's publish refuses over. */
export function unplacedClaimed(id: string): RosterEntry[] {
  const set = SETS.find((s) => s.id === id);
  if (!set) return [];
  const placed = new Set(set.groups.flatMap((g) => g.members));
  return classroomRoster(set.classroomId).filter((s) => s.status === "claimed" && !placed.has(s.id));
}

// ---------------------------------------------------------------- views

const studentView = (s: RosterEntry): GroupStudent => ({
  enrollmentId: s.id,
  nom: s.nom,
  prenom: s.prenom,
  claimed: s.status === "claimed",
});
const byName = (a: RosterEntry, b: RosterEntry) => `${a.nom} ${a.prenom}`.localeCompare(`${b.nom} ${b.prenom}`);

/** An archived classroom's sets are read-only, and never open. */
const archivedRoom = (set: MockSet): boolean => (rooms.find((r) => r.id === set.classroomId)?.archivedAt ?? null) !== null;
/** Open to the students now: `openUntil` ahead, the classroom not archived. */
const isOpen = (set: MockSet): boolean => set.openUntil !== null && Date.parse(set.openUntil) > Date.now() && !archivedRoom(set);

function detailOf(set: MockSet): GroupSetDetail {
  const students = classroomRoster(set.classroomId).slice().sort(byName);
  const placed = new Set(set.groups.flatMap((g) => g.members));
  return {
    set: {
      id: set.id,
      classroomId: set.classroomId,
      name: set.name,
      maxSize: set.maxSize,
      createdAt: set.createdAt,
      readOnly: archivedRoom(set),
      openUntil: set.openUntil,
      open: isOpen(set),
    },
    groups: set.groups
      .slice()
      .sort((a, b) => a.position - b.position)
      .map((g) => ({
        id: g.id,
        name: g.name,
        position: g.position,
        members: students.filter((s) => g.members.includes(s.id)).map(studentView),
      })),
    unplaced: students.filter((s) => !placed.has(s.id)).map(studentView),
    usedBy: usesOf(set.id),
  };
}

function summaryOf(set: MockSet): GroupSetSummary {
  const students = classroomRoster(set.classroomId);
  const placed = set.groups.reduce((sum, g) => sum + g.members.length, 0);
  return {
    id: set.id,
    name: set.name,
    maxSize: set.maxSize,
    groups: set.groups.length,
    placed,
    unplaced: students.length - placed,
    createdAt: set.createdAt,
    openUntil: set.openUntil,
    open: isOpen(set),
    usedBy: usesOf(set.id),
  };
}

// ---------------------------------------------------------------- loaders and refusals

/** A classroom of the staff persona, or the 404 of a missing one (a student reads the same 404). */
function staffRoom(id: string) {
  const room = rooms.find((r) => r.id === id);
  if (role === "student" || !room) throw new MockError(404, "Not found");
  return room;
}

/** A set of the staff persona, or the 404 of a missing one. */
function setOr404(id: string): MockSet {
  const set = SETS.find((s) => s.id === id);
  if (role === "student" || !set) throw new MockError(404, "Not found");
  return set;
}

/** A set to write: an archived classroom's are read-only. */
function writable(id: string): MockSet {
  const set = setOr404(id);
  if (rooms.find((r) => r.id === set.classroomId)?.archivedAt) {
    throw refuse(409, "classroom_archived", "The classroom is archived: its group sets are read-only");
  }
  return set;
}

function parsed<T>(schema: { safeParse: (v: unknown) => { success: true; data: T } | { success: false; error: { message: string } } }, raw: unknown): T {
  const result = schema.safeParse(raw);
  if (!result.success) throw new MockPayload(400, { error: "validation", message: result.error.message });
  return result.data;
}

const groupOr404 = (set: MockSet, gid: string): MockGroup => {
  const group = set.groups.find((g) => g.id === gid);
  if (!group) throw new MockError(404, "Not found");
  return group;
};
const nextPosition = (set: MockSet) => Math.max(-1, ...set.groups.map((g) => g.position)) + 1;
const takenNames = (set: MockSet) => new Set(set.groups.map((g) => g.name));

// ---------------------------------------------------------------- sets

on("GET", "/app/api/classrooms/:id/group-sets", (m) => {
  const room = staffRoom(m.groups!.id!);
  return SETS.filter((s) => s.classroomId === room.id).map(summaryOf);
});

on("POST", "/app/api/classrooms/:id/group-sets", (m, raw) => {
  const room = staffRoom(m.groups!.id!);
  if (room.archivedAt) throw refuse(409, "classroom_archived", "The classroom is archived: its group sets are read-only");
  const body = parsed(GroupSetCreate, raw);
  const set: MockSet = {
    id: setId(),
    classroomId: room.id,
    name: body.name ?? defaultSetName(new Date(), nameLocale()),
    maxSize: body.maxSize ?? null,
    createdAt: iso(0),
    openUntil: null,
    groups: [],
  };
  SETS.push(set);
  return detailOf(set);
});

on("GET", "/app/api/group-sets/:id", (m) => detailOf(setOr404(m.groups!.id!)));

on("PATCH", "/app/api/group-sets/:id", (m, raw) => {
  const set = writable(m.groups!.id!);
  const body = parsed(GroupSetPatch, raw);
  const openUntil = body.openUntil === undefined ? set.openUntil : body.openUntil;
  const maxSize = body.maxSize === undefined ? set.maxSize : body.maxSize;
  if (openUntil !== null && Date.parse(openUntil) > Date.now() && maxSize === null) {
    throw refuse(422, "max_size_required", "A group set open to its students needs a maximum size");
  }
  if (body.name !== undefined) set.name = body.name;
  set.maxSize = maxSize;
  set.openUntil = openUntil;
  return detailOf(set);
});

on("DELETE", "/app/api/group-sets/:id", (m) => {
  const set = writable(m.groups!.id!);
  const holding = usesOf(set.id).filter((u) => !u.archived).map(({ id, name }) => ({ id, name }));
  if (holding.length > 0) throw refuse(409, "set_in_use", `${holding.length} project(s) follow this group set`, { projects: holding });
  SETS.splice(SETS.indexOf(set), 1);
  return undefined;
});

on("POST", "/app/api/group-sets/:id/duplicate", (m) => {
  const source = writable(m.groups!.id!);
  const copy: MockSet = {
    ...source,
    id: setId(),
    name: duplicateSetName(source.name, nameLocale()),
    createdAt: iso(0),
    openUntil: null,
    groups: source.groups.map((g) => ({ ...g, id: groupId(), members: [...g.members] })),
  };
  SETS.push(copy);
  return detailOf(copy);
});

// ---------------------------------------------------------------- groups

on("POST", "/app/api/group-sets/:id/groups", (m, raw) => {
  const set = writable(m.groups!.id!);
  const body = parsed(GroupCreate, raw);
  const name = body.name ?? defaultGroupName(takenNames(set), nameLocale());
  if (takenNames(set).has(name)) throw refuse(409, "duplicate_name", `A group "${name}" already exists in this set`);
  set.groups.push({ id: groupId(), name, position: nextPosition(set), members: [] });
  return detailOf(set);
});

on("PATCH", "/app/api/group-sets/:id/groups/:gid", (m, raw) => {
  const set = writable(m.groups!.id!);
  const group = groupOr404(set, m.groups!.gid!);
  const { name } = parsed(GroupRename, raw);
  if (set.groups.some((g) => g !== group && g.name === name)) {
    throw refuse(409, "duplicate_name", `A group "${name}" already exists in this set`);
  }
  group.name = name;
  return detailOf(set);
});

on("DELETE", "/app/api/group-sets/:id/groups/:gid", (m) => {
  const set = writable(m.groups!.id!);
  const group = groupOr404(set, m.groups!.gid!);
  set.groups.splice(set.groups.indexOf(group), 1);
  return detailOf(set);
});

/** A student into a group of the set, or out of every group (`groupId: null`). */
on("PUT", "/app/api/group-sets/:id/members/:eid", (m, raw) => {
  const set = writable(m.groups!.id!);
  const eid = decodeURIComponent(m.groups!.eid!);
  if (!classroomRoster(set.classroomId).some((s) => s.id === eid)) throw new MockError(404, "Not found");
  const { groupId: target, confirm } = parsed(GroupMemberPut, raw);
  const into = target === null ? null : groupOr404(set, target);
  // M3-16b: a move reaching a group repository of a following project is confirmed first (ADR-070 §6).
  const from = set.groups.find((g) => g.members.includes(eid))?.id ?? null;
  const consequences = from === target ? [] : consequencesOf(set.id, eid, from, target);
  if (consequences.length > 0 && confirm !== mockDigest(consequences)) throw confirmationNeeded(consequences);
  for (const g of set.groups) g.members = g.members.filter((x) => x !== eid);
  into?.members.push(eid);
  return detailOf(set);
});

/** ADR-070 §3: the students in no group, shuffled and cut into new groups. */
on("POST", "/app/api/group-sets/:id/random", (m, raw) => {
  const set = writable(m.groups!.id!);
  const body = parsed(GroupRandomForm, raw);
  const placed = new Set(set.groups.flatMap((g) => g.members));
  const free = classroomRoster(set.classroomId).filter((s) => !placed.has(s.id)).map((s) => s.id);
  if (free.length === 0) throw refuse(409, "nobody_to_place", "Every student of the set is in a group");
  if (body.size > free.length) throw refuse(422, "size_out_of_range", `A size from 1 to ${free.length}`, { max: free.length });
  const names = takenNames(set);
  let position = nextPosition(set);
  for (const members of formRandomGroups(free, body.size, body.remainder, (max) => Math.floor(rand() * max))) {
    const name = defaultGroupName(names, nameLocale());
    names.add(name);
    set.groups.push({ id: groupId(), name, position: (position += 1) - 1, members });
  }
  return detailOf(set);
});

// ---------------------------------------------------------------- the students' side (F-PROJ-22, M3-17)

/** The student persona's roster line in PRG1-2026: one of "Projet final"'s students in no group. */
const ME_LINE = (() => {
  const r1 = classroomRoster("r1");
  return r1[16]?.id ?? r1[0]?.id ?? "";
})();

/** The sets a student of `classroomId` reads: the open ones (no published project names a mock set). */
const visibleSets = (classroomId: string): MockSet[] => SETS.filter((s) => s.classroomId === classroomId && isOpen(s));

const nameOf = (s: RosterEntry): GroupMemberName => ({ nom: s.nom, prenom: s.prenom });
const groupOfLine = (set: MockSet, line: string): MockGroup | undefined => set.groups.find((g) => g.members.includes(line));

/** The student view of one set (the API's `StudentGroupSet`): names and sizes, nothing else. */
function studentSetOf(set: MockSet): StudentGroupSet {
  const students = classroomRoster(set.classroomId).slice().sort(byName);
  const open = isOpen(set);
  const mine = role === "student" ? groupOfLine(set, ME_LINE) : undefined;
  const shown = set.groups
    .slice()
    .sort((a, b) => a.position - b.position)
    .filter((g) => open || g === mine);
  const placed = new Set(set.groups.flatMap((g) => g.members));
  return {
    set: { id: set.id, name: set.name, maxSize: set.maxSize, openUntil: set.openUntil, open },
    writable: open && role === "student",
    myGroupId: mine?.id ?? null,
    groups: shown.map((g) => {
      const members = students.filter((s) => g.members.includes(s.id)).map(nameOf);
      return { id: g.id, name: g.name, size: members.length, members };
    }),
    ...(open ? { unplaced: students.filter((s) => !placed.has(s.id)).map(nameOf) } : {}),
  };
}

/** The classroom's sets as the persona reads them: the read's answer, and every student write's. */
const studentSetsOf = (classroomId: string): StudentGroupSets => ({
  serverNow: new Date().toISOString(),
  sets: visibleSets(classroomId).map(studentSetOf),
});

on("GET", "/app/api/classrooms/:id/group-sets/student", (m) => {
  const id = m.groups!.id!;
  if (!rooms.some((r) => r.id === id)) throw new MockError(404, "Not found");
  return studentSetsOf(id);
});

/** A set the student persona writes: open, or the refusal the API answers. */
function studentWritable(id: string): MockSet {
  const set = SETS.find((s) => s.id === id);
  if (role !== "student" || !set || !isOpen(set)) {
    if (set && role === "student" && set.openUntil !== null) throw refuse(409, "set_closed", "This group set is closed to its students");
    throw new MockError(404, "Not found");
  }
  return set;
}
const moveMe = (set: MockSet, into: MockGroup | null) => {
  for (const g of set.groups) g.members = g.members.filter((x) => x !== ME_LINE);
  into?.members.push(ME_LINE);
};

on("POST", "/app/api/group-sets/:id/student/groups", (m, raw) => {
  const set = studentWritable(m.groups!.id!);
  const body = parsed(StudentGroupCreate, raw);
  const name = body.name ?? defaultGroupName(takenNames(set), nameLocale());
  if (takenNames(set).has(name)) throw refuse(409, "duplicate_name", `A group "${name}" already exists in this set`);
  const group: MockGroup = { id: groupId(), name, position: nextPosition(set), members: [] };
  set.groups.push(group);
  moveMe(set, group);
  return studentSetsOf(set.classroomId);
});

on("PUT", "/app/api/group-sets/:id/student/membership", (m, raw) => {
  const set = studentWritable(m.groups!.id!);
  const group = groupOr404(set, parsed(StudentGroupJoin, raw).groupId);
  if (!group.members.includes(ME_LINE)) {
    if (set.maxSize !== null && group.members.length >= set.maxSize) throw refuse(409, "group_full", "This group is full", { max: set.maxSize });
    moveMe(set, group);
  }
  return studentSetsOf(set.classroomId);
});

on("DELETE", "/app/api/group-sets/:id/student/membership", (m) => {
  const set = studentWritable(m.groups!.id!);
  moveMe(set, null);
  return studentSetsOf(set.classroomId);
});

on("PATCH", "/app/api/group-sets/:id/student/groups/:gid", (m, raw) => {
  const set = studentWritable(m.groups!.id!);
  const group = groupOr404(set, m.groups!.gid!);
  if (!group.members.includes(ME_LINE)) throw new MockError(404, "Not found");
  const { name } = parsed(GroupRename, raw);
  if (set.groups.some((g) => g !== group && g.name === name)) throw refuse(409, "duplicate_name", `A group "${name}" already exists in this set`);
  group.name = name;
  return studentSetsOf(set.classroomId);
});

/** The student's Activities rows (S3): the open sets of their classrooms (one: the classroom page). */
export const studentGroupSetCards = (classroomId?: string): StudentGroupSetCard[] =>
    studentRooms()
      .filter((room) => classroomId === undefined || room.id === classroomId)
      .flatMap((room) =>
        visibleSets(room.id).map((s) => ({
          id: s.id,
          classroomId: room.id,
          classroomName: room.name,
          courseCode: room.courseCode,
          name: s.name,
          openUntil: s.openUntil!,
          myGroup: role === "student" ? (groupOfLine(s, ME_LINE)?.name ?? null) : null,
        })),
      );

/** The classroom page's Groups tab (S1): a set reaches its students. */
export const hasStudentGroups = (classroomId: string): boolean => visibleSets(classroomId).length > 0;
