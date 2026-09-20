/**
 * In-browser mock of the portal API, for design work without a backend
 * (`VITE_MOCK=1 pnpm dev`, or `pnpm dev:mock`). Never part of a production
 * build: main.tsx only imports this module behind the env flag, and Vite
 * drops the dead branch.
 *
 * The persona comes from `?as=teacher|student|admin` (remembered in this
 * browser). Every endpoint the web app calls is served from the in-memory
 * state below; mutations edit that state so the flows feel real, and a page
 * reload starts over.
 *
 * Scene flags, remembered the same way (`?empty=1`, `?empty=0` to clear):
 *
 *  - `empty` — nothing anywhere: no courses, no classrooms, no roster, no
 *    teachers, so every empty state is reachable;
 *  - `fail`  — every GET under /app/api answers 500 (except /app/api/me and
 *    /app/api/config, so the shell still renders), for the error states;
 *  - `slow`  — 2.5 s of latency on every call, for the loading states;
 *  - `many`  — 8 courses, 30 classrooms, a 120-student roster on the first
 *    one and 70 questions in the first pool, for long lists, the sidebar and
 *    the cursor pagination of the pool table.
 *
 * The pool half (WP7) carries real French content about C programming and
 * electronics, questions of all four types, their published versions, the
 * preview and the `try` grading — `code` answering the same
 * `runner_unavailable` a machine without a container engine answers.
 */
import {
  clozeStudentTemplate,
  describeBlank,
  matchBlank,
  parseCloze,
  splitTemplate,
} from "@quiz/domain";
import type {
  AdminTeacher,
  ClassroomDetail,
  CourseSummary,
  Me,
  PublicConfig,
  RosterEntry,
  StudentClassroom,
} from "@quiz/contracts";

type Role = Me["role"];

const ROLE_KEY = "quiz-mock-role";
const params = new URLSearchParams(window.location.search);
let urlDirty = false;
const asParam = params.get("as");
if (asParam === "teacher" || asParam === "student" || asParam === "admin") {
  localStorage.setItem(ROLE_KEY, asParam);
  params.delete("as");
  urlDirty = true;
}
const role: Role = (localStorage.getItem(ROLE_KEY) as Role | null) ?? "teacher";

/** Scene flags: read from the URL, then remembered like the persona. */
const FLAG_NAMES = ["empty", "fail", "slow", "many"] as const;
type FlagName = (typeof FLAG_NAMES)[number];
const flags = {} as Record<FlagName, boolean>;
for (const name of FLAG_NAMES) {
  const key = `quiz-mock-${name}`;
  const raw = params.get(name);
  if (raw !== null) {
    if (raw === "0" || raw === "false") localStorage.removeItem(key);
    else localStorage.setItem(key, "1");
    params.delete(name);
    urlDirty = true;
  }
  flags[name] = localStorage.getItem(key) === "1";
}
if (urlDirty) {
  const q = params.toString();
  window.history.replaceState(null, "", window.location.pathname + (q ? `?${q}` : ""));
}

/** Latency of every mocked call: enough to see a skeleton under `?slow=1`. */
const LATENCY = () => (flags.slow ? 2500 : 120 + Math.random() * 180);

const H = 3_600_000;
const D = 24 * H;
const now = Date.now();
const iso = (offsetMs: number) => new Date(now + offsetMs).toISOString();

// --- Deterministic pseudo-random (stable screenshots across reloads) ---
let seed = 42;
const rand = () => {
  seed = (seed * 1664525 + 1013904223) % 4294967296;
  return seed / 4294967296;
};
const pick = <T,>(xs: T[]): T => xs[Math.floor(rand() * xs.length)]!;

const FIRST = [
  "Marie", "Lucas", "Léa", "Noah", "Emma", "Gabriel", "Chloé", "Louis", "Camille", "Hugo",
  "Manon", "Nathan", "Zoé", "Ethan", "Alice", "Théo", "Inès", "Jules", "Sarah", "Adam",
  "Julie", "Maxime", "Eva", "Arthur", "Nina", "Samuel", "Lina", "Rafael", "Clara", "Elias",
];
const LAST = [
  "Dupont", "Martin", "Rochat", "Favre", "Bovet", "Chappuis", "Monnier", "Perret", "Girard",
  "Roulet", "Blanc", "Mercier", "Gauthier", "Bonvin", "Delacroix", "Morel", "Vuille",
  "Jaquet", "Berger", "Pittet", "Currat", "Ducret", "Nicollier", "Rey", "Sauter", "Zwahlen",
];

const slug = (s: string) =>
  s.toLowerCase().normalize("NFD").replace(/[^a-z]/g, "");

function makeStudents(n: number, claimedRatio: number, prefix: string): RosterEntry[] {
  const out: RosterEntry[] = [];
  const used = new Set<string>();
  for (let i = 0; i < n; i += 1) {
    let prenom = pick(FIRST);
    let nom = pick(LAST);
    while (used.has(`${prenom}${nom}`)) {
      prenom = pick(FIRST);
      nom = pick(LAST);
    }
    used.add(`${prenom}${nom}`);
    const claimed = rand() < claimedRatio;
    out.push({
      id: `${prefix}-s${i + 1}`,
      nom,
      prenom,
      email: `${slug(prenom)}.${slug(nom)}@heig-vd.ch`,
      status: claimed ? "claimed" : "pending",
      conflictFlag: claimed && rand() < 0.04,
      staff: false,
      // One student in ten carries an accommodation: enough that the column
      // is never a wall of dashes, rare enough that it stays exceptional.
      timeBonusPercent: rand() < 0.1 ? pick([25, 33, 50]) : 0,
      note: null,
      lastLoginAt: claimed ? iso(-rand() * 20 * D) : null,
      avatarUrl: null,
      userId: claimed ? `${prefix}-u${i + 1}` : null,
    });
  }
  return out;
}

interface Room {
  id: string;
  name: string;
  period: string;
  courseId: string;
  createdAt: string;
  archivedAt: string | null;
  roster: RosterEntry[];
}

interface Course {
  id: string;
  name: string;
  code: string;
  createdAt: string;
  staff: CourseSummary["staff"];
}

const ME_TEACHER = {
  userId: "u-me",
  givenName: "Prof",
  familyName: "Démo",
  email: "teacher@heig-vd.ch",
  avatarUrl: null,
};

const courses: Course[] = [
  {
    id: "c1",
    name: "Programmation C",
    code: "PRG1",
    createdAt: iso(-400 * D),
    staff: [
      ME_TEACHER,
      {
        userId: "u2",
        givenName: "Pierre",
        familyName: "Roulet",
        email: "pierre.roulet@heig-vd.ch",
        avatarUrl: null,
      },
    ],
  },
  {
    id: "c2",
    name: "Systèmes embarqués",
    code: "EMB",
    createdAt: iso(-200 * D),
    staff: [ME_TEACHER],
  },
];

const rooms: Room[] = [
  {
    id: "r1",
    name: "PRG1-2026",
    period: "2026-A",
    courseId: "c1",
    createdAt: iso(-40 * D),
    archivedAt: null,
    roster: makeStudents(24, 0.85, "r1"),
  },
  {
    id: "r2",
    name: "PRG1-2025",
    period: "2025-A",
    courseId: "c1",
    createdAt: iso(-400 * D),
    archivedAt: null,
    roster: makeStudents(18, 1, "r2"),
  },
  {
    id: "r3",
    name: "EMB-2026",
    period: "2026-A",
    courseId: "c2",
    createdAt: iso(-30 * D),
    archivedAt: null,
    roster: makeStudents(12, 0.6, "r3"),
  },
];

const teachers: AdminTeacher[] = [
  {
    id: "t1",
    email: "ada.lovelace@heig-vd.ch",
    givenName: "Ada",
    familyName: "Lovelace",
    signedUp: true,
    courses: 3,
    lastLoginAt: iso(-2 * H),
    grantedAt: iso(-400 * D),
  },
  {
    id: "t2",
    email: "grace.hopper@heig-vd.ch",
    givenName: "Grace",
    familyName: "Hopper",
    signedUp: true,
    courses: 1,
    lastLoginAt: iso(-30 * D),
    grantedAt: iso(-390 * D),
  },
  {
    id: "t3",
    email: "linus.t@heig-vd.ch",
    givenName: null,
    familyName: null,
    signedUp: false,
    courses: 0,
    lastLoginAt: null,
    grantedAt: iso(-1 * D),
  },
];

/** `?many=1`: 8 courses, 30 classrooms, and 120 students on the first one. */
function inflate() {
  rooms[0]!.roster = makeStudents(120, 0.8, "r1");
  const topics = ["Strings", "Structs", "Recursion", "Sorting", "Files", "Makefiles", "Tests", "Pointers"];
  for (let i = courses.length; i < 8; i += 1) {
    courses.push({
      id: `c${i + 1}`,
      name: `Course ${i + 1} — ${topics[i % topics.length]}`,
      code: `C${i + 1}`,
      createdAt: iso(-(20 + i) * D),
      staff: [ME_TEACHER],
    });
  }
  for (let i = rooms.length; i < 30; i += 1) {
    const course = courses[i % courses.length]!;
    rooms.push({
      id: `r${i + 1}`,
      name: `${course.code}-${2020 + (i % 7)}`,
      period: `${2020 + (i % 7)}-A`,
      courseId: course.id,
      createdAt: iso(-(20 + i) * D),
      archivedAt: null,
      roster: makeStudents(6 + (i % 20), 0.7, `r${i + 1}`),
    });
  }
}

/** `?empty=1`: keep the app addressable, but strip every collection. */
function strip() {
  courses.length = 0;
  rooms.length = 0;
  teachers.length = 0;
}

if (flags.many) inflate();
if (flags.empty) strip();

// --- Session ---

let me: Me | null = {
  id: "u-me",
  email: role === "student" ? "lea.rochat@heig-vd.ch" : `${role}@heig-vd.ch`,
  givenName: role === "student" ? "Léa" : role === "admin" ? "Admin" : "Prof",
  familyName: role === "student" ? "Rochat" : "Démo",
  role,
  lastLoginAt: iso(-3 * H),
  avatarUrl: null,
  hasUploadedAvatar: false,
  locale: null,
  dateFormat: null,
};

// --- Views ---

const courseSummary = (c: Course): CourseSummary => ({
  id: c.id,
  name: c.name,
  code: c.code,
  createdAt: c.createdAt,
  staff: c.staff,
  classrooms: rooms
    .filter((r) => r.courseId === c.id && !r.archivedAt)
    .map((r) => ({
      id: r.id,
      name: r.name,
      period: r.period,
      courseId: c.id,
      courseName: c.name,
      courseCode: c.code,
      createdAt: r.createdAt,
      archivedAt: r.archivedAt,
      students: r.roster.filter((s) => !s.staff).length,
      claimed: r.roster.filter((s) => !s.staff && s.status === "claimed").length,
    })),
});

const classroomDetail = (r: Room): ClassroomDetail => {
  const c = courses.find((x) => x.id === r.courseId)!;
  return {
    id: r.id,
    name: r.name,
    period: r.period,
    archivedAt: r.archivedAt,
    course: { id: c.id, name: c.name, code: c.code },
    roster: r.roster,
  };
};

const studentRooms = (): StudentClassroom[] =>
  rooms.slice(0, 2).map((r) => {
    const c = courses.find((x) => x.id === r.courseId)!;
    return {
      id: r.id,
      name: r.name,
      period: r.period,
      courseName: c.name,
      courseCode: c.code,
      teachers: c.staff.map((s) => `${s.givenName} ${s.familyName}`),
      timeBonusPercent: r.id === "r1" ? 25 : 0,
    };
  });

// --- Router ---

class MockError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

/** A 422 that carries the issue list, as `PUT /draft` and publication do. */
class MockValidation extends MockError {
  constructor(
    message: string,
    readonly details: { path: string[]; code: string; message: string }[],
  ) {
    super(422, message);
  }
}

type Handler = (m: RegExpMatchArray, body: Record<string, unknown>, url: URL) => unknown;
const routes: { method: string; re: RegExp; h: Handler }[] = [];
const on = (method: string, path: string, h: Handler) =>
  routes.push({ method, re: new RegExp(`^${path.replace(/:(\w+)/g, "(?<$1>[^/]+)")}$`), h });

const courseOr404 = (id: string) => {
  const c = courses.find((x) => x.id === id);
  if (!c) throw new MockError(404, "Course not found");
  return c;
};
const roomOr404 = (id: string) => {
  const r = rooms.find((x) => x.id === id);
  if (!r) throw new MockError(404, "Classroom not found");
  return r;
};
let seq = 100;
const nextId = (p: string) => `${p}${(seq += 1)}`;

on("GET", "/app/api/config", (): PublicConfig => ({ devLogin: true }));

on("GET", "/app/api/me", () => {
  if (!me) throw new MockError(401, "Signed out");
  return me;
});
on("PATCH", "/app/api/me", (_m, body) => {
  if (me) me = { ...me, ...(body as Partial<Me>) };
  return me;
});
on("PUT", "/app/api/me/avatar", () => undefined);
on("DELETE", "/app/api/me/avatar", () => undefined);
on("POST", "/app/auth/logout", () => {
  me = null;
  return undefined;
});

// --- Courses ---

on("GET", "/app/api/courses", () => courses.map(courseSummary));
on("POST", "/app/api/courses", (_m, body) => {
  const c: Course = {
    id: nextId("c"),
    name: String(body.name),
    code: String(body.code).toUpperCase(),
    createdAt: iso(0),
    staff: [ME_TEACHER],
  };
  courses.push(c);
  return courseSummary(c);
});
on("PATCH", "/app/api/courses/:id", (m, body) => {
  const c = courseOr404(m.groups!.id!);
  if (typeof body.name === "string") c.name = body.name;
  if (typeof body.code === "string") c.code = body.code.toUpperCase();
  return courseSummary(c);
});
on("DELETE", "/app/api/courses/:id", (m) => {
  const i = courses.findIndex((c) => c.id === m.groups!.id);
  if (i >= 0) {
    const [c] = courses.splice(i, 1);
    for (let k = rooms.length - 1; k >= 0; k -= 1) {
      if (rooms[k]!.courseId === c!.id) rooms.splice(k, 1);
    }
  }
  return undefined;
});
on("POST", "/app/api/courses/:id/staff", (m, body) => {
  const c = courseOr404(m.groups!.id!);
  const email = String(body.email);
  if (c.staff.some((s) => s.email === email)) throw new MockError(409, "Already on the staff");
  const [prenom = "New", nom = "Member"] = email.split("@")[0]!.split(".");
  c.staff.push({
    userId: nextId("u"),
    givenName: prenom,
    familyName: nom,
    email,
    avatarUrl: null,
  });
  return undefined;
});
on("DELETE", "/app/api/courses/:id/staff/:uid", (m) => {
  const c = courseOr404(m.groups!.id!);
  c.staff = c.staff.filter((s) => s.userId !== m.groups!.uid);
  return undefined;
});
on("POST", "/app/api/courses/:id/classrooms", (m, body) => {
  const c = courseOr404(m.groups!.id!);
  const r: Room = {
    id: nextId("r"),
    name: String(body.name),
    period: String(body.period ?? ""),
    courseId: c.id,
    createdAt: iso(0),
    archivedAt: null,
    roster: [],
  };
  rooms.push(r);
  return r;
});

// --- Classrooms ---

on("GET", "/app/api/classrooms/:id", (m) => classroomDetail(roomOr404(m.groups!.id!)));
on("PATCH", "/app/api/classrooms/:id", (m, body) => {
  const r = roomOr404(m.groups!.id!);
  if (typeof body.name === "string") r.name = body.name;
  if (typeof body.period === "string") r.period = body.period;
  return classroomDetail(r);
});
on("DELETE", "/app/api/classrooms/:id", (m) => {
  const i = rooms.findIndex((r) => r.id === m.groups!.id);
  if (i >= 0) rooms.splice(i, 1);
  return undefined;
});
on("POST", "/app/api/classrooms/:id/archive", (m) => {
  roomOr404(m.groups!.id!).archivedAt = iso(0);
  return undefined;
});
on("POST", "/app/api/classrooms/:id/unarchive", (m) => {
  roomOr404(m.groups!.id!).archivedAt = null;
  return undefined;
});
on("POST", "/app/api/classrooms/:id/self-enroll", (m) => {
  const r = roomOr404(m.groups!.id!);
  if (me && !r.roster.some((s) => s.email === me!.email)) {
    r.roster.push({
      id: nextId("s"),
      nom: me.familyName,
      prenom: me.givenName,
      email: me.email,
      status: "claimed",
      conflictFlag: false,
      staff: true,
      timeBonusPercent: 0,
      note: null,
      lastLoginAt: iso(0),
      avatarUrl: null,
      userId: me.id,
    });
  }
  return undefined;
});

// --- Roster ---

on("POST", "/app/api/classrooms/:id/roster", (m, body) => {
  const r = roomOr404(m.groups!.id!);
  const rowsIn = (body.rows as (string | null)[][] | undefined) ?? [];
  for (const row of rowsIn.slice(1)) {
    const [nom, prenom, email, bonus] = row;
    if (!nom || !prenom || !email) continue;
    r.roster.push({
      id: nextId("s"),
      nom,
      prenom,
      email,
      status: "pending",
      conflictFlag: false,
      staff: false,
      timeBonusPercent: Number(bonus ?? 0) || 0,
      note: null,
      lastLoginAt: null,
      avatarUrl: null,
      userId: null,
    });
  }
  if (rowsIn.length === 0) {
    // CSV text: add three placeholder students so the flow shows something.
    r.roster.push(...makeStudents(3, 0, nextId("s")));
  }
  return { rows: Math.max(rowsIn.length - 1, 3), inserted: Math.max(rowsIn.length - 1, 3), updated: 0 };
});
on("PATCH", "/app/api/classrooms/:id/roster/:eid", (m, body) => {
  const r = roomOr404(m.groups!.id!);
  const s = r.roster.find((x) => x.id === m.groups!.eid);
  if (s) Object.assign(s, body);
  return undefined;
});
on("DELETE", "/app/api/classrooms/:id/roster/:eid", (m) => {
  const r = roomOr404(m.groups!.id!);
  r.roster = r.roster.filter((x) => x.id !== m.groups!.eid);
  return undefined;
});
on("POST", "/app/api/classrooms/:id/roster/:eid/unclaim", (m) => {
  const r = roomOr404(m.groups!.id!);
  const s = r.roster.find((x) => x.id === m.groups!.eid);
  if (s) Object.assign(s, { status: "pending", conflictFlag: false, userId: null });
  return undefined;
});

// --- Student ---

on("GET", "/app/api/student/classrooms", () => studentRooms());

// --- Admin ---

on("GET", "/app/api/admin/teachers", () => teachers);
on("POST", "/app/api/admin/teachers", (_m, body) => {
  teachers.push({
    id: nextId("t"),
    email: String(body.email),
    givenName: null,
    familyName: null,
    signedUp: false,
    courses: 0,
    lastLoginAt: null,
    grantedAt: iso(0),
  });
  return undefined;
});
on("DELETE", "/app/api/admin/teachers/:gid", (m) => {
  const i = teachers.findIndex((x) => x.id === m.groups!.gid);
  if (i >= 0) teachers.splice(i, 1);
  return undefined;
});

// --- Pools, categories, questions (WP7) ------------------------------------
//
// The mock carries real French content — C programming and electronics, the
// two courses above — because an empty-looking pool proves nothing about the
// screen that shows it. Student views go through the SAME pure functions the
// server uses (`@quiz/domain`), so the preview and the try panel show what a
// student would actually receive.

interface MockVersion {
  number: number;
  publishedAt: string;
  publishedBy: string | null;
  changeNote: string | null;
  deprecatedAt: string | null;
  deprecationNote: string | null;
  config: Record<string, unknown>;
  explanation: string;
  configVersion: number;
}

interface MockQuestion {
  id: string;
  poolId: string;
  type: "mcq" | "short" | "cloze" | "code";
  internalName: string;
  categoryId: string | null;
  difficulty: number;
  shuffleable: boolean;
  randomizable: boolean;
  tags: string[];
  deletedAt: string | null;
  updatedAt: string;
  draft: { config: Record<string, unknown>; explanation: string };
  versions: MockVersion[];
}

interface MockPool {
  id: string;
  name: string;
  visibility: "private" | "shared" | "public";
  ownerId: string;
  isPersonal: boolean;
  createdAt: string;
}

interface MockCategory {
  id: string;
  poolId: string;
  parentId: string | null;
  name: string;
  position: number;
}

const pools: MockPool[] = [
  { id: "p1", name: "Programmation C", visibility: "private", ownerId: "u-me", isPersonal: false, createdAt: iso(-300 * D) },
  { id: "p2", name: "Systèmes embarqués", visibility: "private", ownerId: "u-me", isPersonal: false, createdAt: iso(-120 * D) },
];

const categories: MockCategory[] = [
  { id: "k1", poolId: "p1", parentId: null, name: "Pointeurs", position: 0 },
  { id: "k2", poolId: "p1", parentId: "k1", name: "Arithmétique", position: 0 },
  { id: "k3", poolId: "p1", parentId: "k1", name: "Allocation dynamique", position: 1 },
  { id: "k4", poolId: "p1", parentId: null, name: "Tableaux", position: 1 },
  { id: "k5", poolId: "p1", parentId: null, name: "Fichiers", position: 2 },
  { id: "k6", poolId: "p2", parentId: null, name: "Capteurs", position: 0 },
  { id: "k7", poolId: "p2", parentId: null, name: "Bus I²C", position: 1 },
];

/** `course_pools`: which pools a course draws from. */
const coursePools: Record<string, string[]> = { c1: ["p1"], c2: ["p2"] };

const mcqConfig = (
  prompt: string,
  choices: [string, boolean][],
  over: Record<string, unknown> = {},
) => ({
  configVersion: 1,
  prompt,
  choices: choices.map(([text, correct]) => ({ text, correct })),
  mode: "single",
  policy: "all_or_nothing",
  penalty: 1,
  allowNegative: false,
  shuffleChoices: true,
  ...over,
});

const shortNumber = (prompt: string, value: number, unit?: string) => ({
  configVersion: 1,
  prompt,
  kind: "number",
  ...(unit ? { placeholder: unit } : {}),
  matchers: [
    {
      kind: "number",
      value,
      tolerance: 0,
      toleranceMode: "abs",
      unitRequired: false,
      points: 1,
      ...(unit ? { unit } : {}),
    },
  ],
});

const codeConfig = (
  prompt: string,
  template: string,
  cases: { name: string; stdin: string; expected: string; visible: boolean }[],
  reference = "",
) => ({
  configVersion: 1,
  prompt,
  language: "c",
  template,
  files: [],
  action: "run",
  compileArgs: "-Wall -Werror",
  limits: { timeMs: 2000, memoryMb: 128, outputKb: 64 },
  runsPerMinute: 10,
  allOrNothing: false,
  referenceSolution: reference,
  tests: {
    mode: "io",
    compare: { trimTrailing: true, ignoreCase: false, numeric: null },
    cases: cases.map((c) => ({ ...c, points: 1, timeMs: null })),
  },
});

const SUM_TEMPLATE = `/* @@lock */
#include <stddef.h>
#include <stdio.h>

int somme(const int *t, size_t n) {
/* @@endlock */
    /* à compléter : l'opérateur [] est interdit */
    return 0;
/* @@lock */
}

int main(void) {
    int t[5] = {10, 20, 30, 40, 50};
    printf("%d\\n", somme(t, 5));
    return 0;
}
/* @@endlock */
`;

let questionSeq = 0;
function makeQuestion(
  init: Omit<MockQuestion, "id" | "versions" | "draft" | "deletedAt" | "updatedAt"> & {
    config: Record<string, unknown>;
    explanation?: string;
    published?: { number: number; changeNote: string; daysAgo: number }[];
    draftChanges?: boolean;
  },
): MockQuestion {
  const { config, explanation = "", published = [], draftChanges = false, ...rest } = init;
  questionSeq += 1;
  const versions: MockVersion[] = published.map((v) => ({
    number: v.number,
    publishedAt: iso(-v.daysAgo * D),
    publishedBy: "u-me",
    changeNote: v.changeNote,
    deprecatedAt: null,
    deprecationNote: null,
    config,
    explanation,
    configVersion: 1,
  }));
  return {
    ...rest,
    id: `q${questionSeq}`,
    deletedAt: null,
    updatedAt: iso(-(draftChanges ? 1 : (published.at(-1)?.daysAgo ?? 30)) * D),
    draft: { config, explanation },
    versions,
  };
}

const questions: MockQuestion[] = [
  makeQuestion({
    poolId: "p1",
    type: "code",
    internalName: "ptr-arith-01",
    categoryId: "k2",
    difficulty: 3,
    shuffleable: false,
    randomizable: false,
    tags: ["pointeurs", "arithmetique"],
    config: codeConfig(
      "Écrivez la fonction `somme` qui retourne la somme des `n` premiers éléments de `t`.\n\nL'opérateur d'indexation `[]` est **interdit** : utilisez l'arithmétique des pointeurs.",
      SUM_TEMPLATE,
      [
        { name: "cas nominal", stdin: "", expected: "150", visible: true },
        { name: "tableau vide", stdin: "", expected: "0", visible: false },
        { name: "valeurs négatives", stdin: "", expected: "-6", visible: false },
      ],
      "    int s = 0;\n    for (const int *p = t; p < t + n; p++) s += *p;\n    return s;\n",
    ),
    explanation:
      "`p + 1` avance d'un `int`, soit `sizeof(int)` octets. La boucle s'arrête quand le pointeur atteint `t + n`.",
    published: [
      { number: 1, changeNote: "Première version", daysAgo: 60 },
      { number: 2, changeNote: "Ajout d'un cas caché sur le tableau vide", daysAgo: 20 },
      { number: 3, changeNote: "Énoncé reformulé", daysAgo: 2 },
    ],
    draftChanges: true,
  }),
  makeQuestion({
    poolId: "p1",
    type: "mcq",
    internalName: "ptr-null-check",
    categoryId: "k1",
    difficulty: 2,
    shuffleable: true,
    randomizable: false,
    tags: ["pointeurs", "securite"],
    config: mcqConfig(
      "Soit `int *p;` déclaré dans une fonction, sans initialisation. Que vaut `p` ?",
      [
        ["`NULL`", false],
        ["Une valeur indéterminée : le lire est un comportement indéfini", true],
        ["`0` sur toute machine conforme à C17", false],
        ["L'adresse de la fonction englobante", false],
      ],
    ),
    explanation:
      "Une variable automatique n'est pas initialisée : `p` contient ce qui traînait sur la pile.",
    published: [{ number: 1, changeNote: "Première version", daysAgo: 21 }],
  }),
  makeQuestion({
    poolId: "p1",
    type: "short",
    internalName: "sizeof-ptr-64",
    categoryId: "k1",
    difficulty: 1,
    shuffleable: false,
    randomizable: false,
    tags: ["pointeurs", "sizeof"],
    config: shortNumber(
      "Sur une machine 64 bits (LP64), que vaut `sizeof(int *)` ? Répondez en octets.",
      8,
      "octets",
    ),
    explanation: "Une adresse tient sur 64 bits, soit 8 octets, quel que soit le type pointé.",
    published: [{ number: 1, changeNote: "Première version", daysAgo: 40 }],
  }),
  makeQuestion({
    poolId: "p1",
    type: "cloze",
    internalName: "malloc-tableau",
    categoryId: "k3",
    difficulty: 3,
    shuffleable: true,
    randomizable: false,
    tags: ["memoire", "pointeurs"],
    config: {
      configVersion: 1,
      text: "Pour allouer un tableau de `n` entiers on écrit `int *t = {{malloc|calloc}}(n * sizeof({{int}}));`, puis on libère la mémoire avec {{=free|delete|dispose}}.",
      caseSensitive: false,
      shuffleOptions: true,
    },
    explanation: "`malloc` renvoie `void *` ; en C la conversion est implicite et le cast est inutile.",
    published: [{ number: 1, changeNote: "Première version", daysAgo: 12 }],
  }),
  makeQuestion({
    poolId: "p1",
    type: "mcq",
    internalName: "array-decay",
    categoryId: "k4",
    difficulty: 3,
    shuffleable: true,
    randomizable: false,
    tags: ["tableaux", "pointeurs"],
    config: mcqConfig(
      "Dans `void f(int t[10])`, que vaut `sizeof(t)` à l'intérieur de `f` sur une machine 64 bits ?",
      [
        ["40, la taille du tableau", false],
        ["8, la taille d'un pointeur", true],
        ["10, le nombre d'éléments", false],
        ["4, la taille d'un `int`", false],
      ],
    ),
    explanation: "Un paramètre tableau se convertit en pointeur : `int t[10]` y est exactement `int *t`.",
    published: [{ number: 1, changeNote: "Première version", daysAgo: 30 }],
    draftChanges: true,
  }),
  makeQuestion({
    poolId: "p1",
    type: "mcq",
    internalName: "fopen-modes",
    categoryId: "k5",
    difficulty: 2,
    shuffleable: true,
    randomizable: false,
    tags: ["fichiers"],
    config: mcqConfig(
      "Quel mode de `fopen` ouvre un fichier en écriture **sans** effacer son contenu ?",
      [
        ['`"w"`', false],
        ['`"a"`', true],
        ['`"r"`', false],
        ['`"w+"`', false],
      ],
    ),
    explanation: "`\"a\"` écrit à la fin ; `\"w\"` tronque le fichier à l'ouverture.",
    published: [{ number: 1, changeNote: "Première version", daysAgo: 55 }],
  }),
  makeQuestion({
    poolId: "p1",
    type: "code",
    internalName: "strcpy-overflow",
    categoryId: "k4",
    difficulty: 4,
    shuffleable: false,
    randomizable: false,
    tags: ["tableaux", "securite"],
    config: codeConfig(
      "Le programme ci-dessous déborde d'un tampon. Corrigez-le sans changer la taille de `dest`.",
      "#include <stdio.h>\n#include <string.h>\n\nint main(void) {\n    char dest[8];\n    const char *src = \"bonjour tout le monde\";\n    strcpy(dest, src);\n    printf(\"%s\\n\", dest);\n    return 0;\n}\n",
      [{ name: "troncature", stdin: "", expected: "bonjour", visible: true }],
    ),
    explanation: "`strncpy` ne termine pas toujours la chaîne : il faut écrire le `\\0` soi-même.",
  }),
  makeQuestion({
    poolId: "p2",
    type: "short",
    internalName: "loi-ohm-led",
    categoryId: "k6",
    difficulty: 1,
    shuffleable: false,
    randomizable: false,
    tags: ["electronique", "resistances"],
    config: shortNumber(
      "Une LED rouge (chute de 2,0 V) est alimentée en 5,0 V à travers une résistance de 200 Ω. Quel courant la traverse, en mA ?",
      15,
      "mA",
    ),
    explanation: "I = (5,0 − 2,0) / 200 = 15 mA.",
    published: [{ number: 1, changeNote: "Première version", daysAgo: 18 }],
  }),
  makeQuestion({
    poolId: "p2",
    type: "mcq",
    internalName: "i2c-adressage",
    categoryId: "k7",
    difficulty: 2,
    shuffleable: true,
    randomizable: false,
    tags: ["i2c", "bus"],
    config: mcqConfig(
      "Sur un bus I²C en adressage 7 bits, combien de périphériques distincts peut-on adresser au maximum ?",
      [
        ["128, moins les adresses réservées", true],
        ["127, l'adresse 0 étant interdite", false],
        ["256", false],
        ["Autant que de fils SDA disponibles", false],
      ],
    ),
    explanation: "7 bits donnent 128 adresses, dont seize sont réservées par la spécification.",
    published: [{ number: 1, changeNote: "Première version", daysAgo: 9 }],
  }),
  makeQuestion({
    poolId: "p2",
    type: "cloze",
    internalName: "adc-resolution",
    categoryId: "k6",
    difficulty: 3,
    shuffleable: true,
    randomizable: false,
    tags: ["can", "mesure"],
    config: {
      configVersion: 1,
      text: "Un convertisseur analogique-numérique de {{#12}} bits découpe sa pleine échelle en {{#4096}} paliers. Sous 3,3 V, un palier vaut environ {{#0.8:0.05}} mV.",
      caseSensitive: false,
      shuffleOptions: true,
    },
    explanation: "2^12 = 4096 paliers ; 3,3 V / 4096 ≈ 0,8 mV.",
  }),
];

/** `?many=1`: a pool long enough to need the cursor and the "load more" row. */
function inflatePool() {
  const topics = [
    ["boucles", "Une boucle `for` qui compte à rebours"],
    ["chaines", "Longueur d'une chaîne sans `strlen`"],
    ["structs", "Taille d'une structure alignée"],
    ["recursion", "Factorielle récursive"],
    ["makefile", "Une règle implicite de `make`"],
    ["bits", "Masquage d'un bit de poids faible"],
  ];
  for (let i = 0; i < 60; i += 1) {
    const [tag, title] = topics[i % topics.length]!;
    questions.push(
      makeQuestion({
        poolId: "p1",
        type: (["mcq", "short", "cloze", "code"] as const)[i % 4]!,
        internalName: `${tag}-${String(i + 1).padStart(2, "0")}`,
        categoryId: categories[i % 5]!.id,
        difficulty: (i % 5) + 1,
        shuffleable: true,
        randomizable: false,
        tags: [tag!],
        config:
          i % 4 === 0
            ? mcqConfig(`${title} — que se passe-t-il ?`, [
                ["Le programme compile et affiche la bonne valeur", true],
                ["Le programme ne compile pas", false],
              ])
            : i % 4 === 1
              ? shortNumber(`${title} — combien d'itérations ?`, 10 + i)
              : i % 4 === 2
                ? {
                    configVersion: 1,
                    text: `${title} : le compteur vaut {{#${i}}} à la sortie.`,
                    caseSensitive: false,
                    shuffleOptions: true,
                  }
                : codeConfig(`${title}`, SUM_TEMPLATE, [
                    { name: "cas nominal", stdin: "", expected: "150", visible: true },
                  ]),
        published: [{ number: 1, changeNote: "Première version", daysAgo: (i % 40) + 1 }],
      }),
    );
  }
}

/** `?empty=1`: one pool with nothing in it, so the empty states are reachable. */
function stripPool() {
  questions.length = 0;
  categories.length = 0;
  pools.length = 0;
  for (const key of Object.keys(coursePools)) coursePools[key] = [];
}

if (flags.many) inflatePool();
if (flags.empty) stripPool();

// --- Views -----------------------------------------------------------------

const liveQuestions = (poolId: string) => questions.filter((q) => q.poolId === poolId);

const poolSummary = (pool: MockPool) => ({
  ...pool,
  questionCount: liveQuestions(pool.id).filter((q) => !q.deletedAt).length,
});

interface TreeNode extends MockCategory {
  children: TreeNode[];
}

const categoryTree = (poolId: string): TreeNode[] => {
  const nodes = new Map<string, TreeNode>();
  const rows = categories
    .filter((c) => c.poolId === poolId)
    .sort((a, b) => a.position - b.position);
  for (const row of rows) nodes.set(row.id, { ...row, children: [] });
  const roots: TreeNode[] = [];
  for (const row of rows) {
    const node = nodes.get(row.id)!;
    const parent = row.parentId ? nodes.get(row.parentId) : undefined;
    if (parent) parent.children.push(node);
    else roots.push(node);
  }
  return roots;
};

const poolTags = (poolId: string) =>
  [...new Set(liveQuestions(poolId).flatMap((q) => q.tags))].sort();

const questionRow = (q: MockQuestion) => ({
  id: q.id,
  type: q.type,
  internalName: q.internalName,
  difficulty: q.difficulty,
  tags: q.tags,
  categoryId: q.categoryId,
  latestNumber: q.versions.at(-1)?.number ?? null,
  hasDraftChanges:
    q.versions.length === 0 ||
    JSON.stringify(q.versions.at(-1)!.config) !== JSON.stringify(q.draft.config),
  updatedAt: q.updatedAt,
  deprecated: q.versions.at(-1)?.deprecatedAt !== null && q.versions.length > 0,
  deletedAt: q.deletedAt,
});

const questionMeta = (q: MockQuestion) => ({
  id: q.id,
  poolId: q.poolId,
  type: q.type,
  internalName: q.internalName,
  categoryId: q.categoryId,
  difficulty: q.difficulty,
  shuffleable: q.shuffleable,
  randomizable: q.randomizable,
  tags: q.tags,
  createdBy: "u-me",
  originQuestionId: null,
  deletedAt: q.deletedAt,
  updatedAt: q.updatedAt,
});

const versionRow = (v: MockVersion) => ({
  number: v.number,
  publishedAt: v.publishedAt,
  publishedBy: v.publishedBy,
  changeNote: v.changeNote,
  deprecatedAt: v.deprecatedAt,
  deprecationNote: v.deprecationNote,
});

/** What the editor loads: the meta, the draft, the versions and the latest one. */
const questionDetail = (q: MockQuestion) => ({
  meta: questionMeta(q),
  draft: {
    config: q.draft.config,
    explanation: q.draft.explanation,
    configVersion: 1,
    updatedAt: q.updatedAt,
    valid: draftIssues(q).length === 0,
  },
  versions: q.versions.map(versionRow),
  latestPublished: q.versions.length ? versionRow(q.versions.at(-1)!) : null,
});

/**
 * A deliberately small stand-in for `configSchema.parse` (decision D16): it
 * catches the mistakes a teacher actually makes on these screens, so the
 * "publication refused" path is reachable in the mock.
 */
function draftIssues(q: MockQuestion): { path: string[]; code: string; message: string }[] {
  const config = q.draft.config as Record<string, unknown>;
  const out: { path: string[]; code: string; message: string }[] = [];
  const prompt = typeof config.prompt === "string" ? config.prompt : "";
  if (q.type !== "cloze" && prompt.trim() === "") {
    out.push({ path: ["prompt"], code: "too_small", message: "String must contain at least 1 character(s)" });
  }
  if (q.type === "mcq") {
    const choices = (config.choices ?? []) as { text: string; correct: boolean }[];
    if (!choices.some((c) => c.correct)) {
      out.push({ path: ["choices"], code: "custom", message: "mcq.no_correct_choice" });
    }
    if (config.mode === "single" && choices.filter((c) => c.correct).length > 1) {
      out.push({ path: ["choices"], code: "custom", message: "mcq.single_needs_one" });
    }
    choices.forEach((choice, i) => {
      if (choice.text.trim() === "") {
        out.push({
          path: ["choices", String(i), "text"],
          code: "too_small",
          message: "String must contain at least 1 character(s)",
        });
      }
    });
  }
  if (q.type === "cloze") {
    const parse = parseCloze(String(config.text ?? ""));
    if (parse.blanks.length === 0) {
      out.push({ path: ["text"], code: "custom", message: "cloze.no_blank" });
    }
  }
  return out;
}

/** `toStudent`, as the server's registry would do it (seed 0, no shuffle). */
function studentView(q: MockQuestion, config: Record<string, unknown>): unknown {
  switch (q.type) {
    case "mcq": {
      const choices = (config.choices ?? []) as { text: string }[];
      return {
        prompt: config.prompt,
        choices: choices.map((c, id) => ({ id, text: c.text })),
        mode: config.mode,
        ...(config.maxSelections === undefined ? {} : { maxSelections: config.maxSelections }),
      };
    }
    case "short":
      return {
        prompt: config.prompt,
        kind: config.kind,
        ...(config.placeholder === undefined ? {} : { placeholder: config.placeholder }),
      };
    case "cloze": {
      const parse = parseCloze(String(config.text ?? ""));
      return clozeStudentTemplate(parse, 0, q.id, false);
    }
    case "code": {
      const cases = ((config.tests as { cases?: CodeCaseLike[] })?.cases ?? []) as CodeCaseLike[];
      const visible = cases.filter((c) => c.visible);
      const hidden = cases.filter((c) => !c.visible);
      return {
        prompt: config.prompt,
        language: config.language,
        segments: splitTemplate(String(config.template ?? ""), "c"),
        limits: config.limits,
        runsPerMinute: config.runsPerMinute,
        visibleCases: visible.map((c) => ({
          name: c.name,
          stdin: c.stdin,
          expected: c.expected,
          points: c.points,
        })),
        hiddenCount: hidden.length,
        hiddenPoints: hidden.reduce((sum, c) => sum + c.points, 0),
        filesPreview: [],
        allOrNothing: config.allOrNothing === true,
      };
    }
  }
}

interface CodeCaseLike {
  name: string;
  stdin: string;
  expected: string;
  visible: boolean;
  points: number;
}

/**
 * `POST /try`, in the browser. Grading is deliberately naive — it exists so
 * the panel has something true to render — and `code` answers the same
 * `runner_unavailable` a machine without a container engine answers
 * (decision D14).
 */
function tryAnswer(q: MockQuestion, config: Record<string, unknown>, answer: unknown): unknown {
  if (q.type === "code") return { status: "runner_unavailable", reason: "not_configured" };
  if (q.type === "mcq") {
    const choices = (config.choices ?? []) as { text: string; correct: boolean }[];
    const correct = choices.flatMap((c, i) => (c.correct ? [i] : []));
    const selected = ((answer as { selected?: number[] } | null)?.selected ?? []).slice().sort();
    const hits = selected.filter((i) => correct.includes(i)).length;
    const wrong = selected.filter((i) => !correct.includes(i)).length;
    const exact = hits === correct.length && wrong === 0;
    const fraction = config.policy === "partial" ? Math.max(0, (hits - wrong) / correct.length) : exact ? 1 : 0;
    return {
      status: "graded",
      points: Math.round(fraction * 100) / 100,
      maxPoints: 1,
      details: {
        policy: config.policy,
        correct,
        selected,
        c: hits,
        w: wrong,
        C: correct.length,
        W: choices.length - correct.length,
        fraction,
        truncated: false,
      },
      solution: { correct },
    };
  }
  if (q.type === "short") {
    const matchers = (config.matchers ?? []) as { kind: string; value?: unknown }[];
    const text = String((answer as { text?: string } | null)?.text ?? "").trim().replace(",", ".");
    const index = matchers.findIndex((m) =>
      m.kind === "number" ? Number(text) === Number(m.value) : text.toLowerCase() === String(m.value).toLowerCase(),
    );
    return {
      status: "graded",
      points: index >= 0 ? 1 : 0,
      maxPoints: 1,
      details: {
        matchedIndex: index >= 0 ? index : null,
        matchedKind: index >= 0 ? matchers[index]!.kind : null,
        normalized: text,
        fraction: index >= 0 ? 1 : 0,
      },
      solution: { expected: matchers.map((m) => String(m.value)) },
    };
  }
  const parse = parseCloze(String(config.text ?? ""));
  const given = ((answer as { blanks?: (string | null)[] } | null)?.blanks ?? []) as (string | null)[];
  const perBlank = parse.blanks.map((blank, i) => ({
    index: blank.index,
    weight: blank.weight,
    kind: blank.kind,
    ok: matchBlank(blank, given[i] ?? null, config.caseSensitive === true),
    given: given[i] ?? null,
    expected: describeBlank(blank),
  }));
  const earned = perBlank.filter((b) => b.ok).reduce((sum, b) => sum + b.weight, 0);
  const total = parse.blanks.reduce((sum, b) => sum + b.weight, 0) || 1;
  return {
    status: "graded",
    points: Math.round((earned / total) * 100) / 100,
    maxPoints: 1,
    details: { perBlank, earned, total, fraction: earned / total },
    solution: { blanks: parse.blanks.map((b) => ({ index: b.index, expected: describeBlank(b) })) },
  };
}

// --- Routes ----------------------------------------------------------------

const poolOr404 = (id: string) => {
  const pool = pools.find((p) => p.id === id);
  if (!pool) throw new MockError(404, "Pool not found");
  return pool;
};
const questionOr404 = (id: string) => {
  const q = questions.find((x) => x.id === id);
  if (!q) throw new MockError(404, "Question not found");
  return q;
};

on("GET", "/app/api/pools", () => pools.map(poolSummary));
on("POST", "/app/api/pools", (_m, body) => {
  const pool: MockPool = {
    id: nextId("p"),
    name: String(body.name),
    visibility: "private",
    ownerId: "u-me",
    isPersonal: false,
    createdAt: iso(0),
  };
  pools.push(pool);
  return poolSummary(pool);
});
on("GET", "/app/api/pools/:id", (m) => {
  const pool = poolOr404(m.groups!.id!);
  return {
    pool,
    categories: categoryTree(pool.id),
    tags: poolTags(pool.id),
    questionCount: liveQuestions(pool.id).filter((q) => !q.deletedAt).length,
  };
});
on("PATCH", "/app/api/pools/:id", (m, body) => {
  const pool = poolOr404(m.groups!.id!);
  if (typeof body.name === "string") pool.name = body.name;
  return poolSummary(pool);
});
on("DELETE", "/app/api/pools/:id", (m) => {
  const i = pools.findIndex((p) => p.id === m.groups!.id);
  if (i >= 0) pools.splice(i, 1);
  return undefined;
});
on("GET", "/app/api/pools/:id/tags", (m) => poolTags(poolOr404(m.groups!.id!).id));

on("POST", "/app/api/pools/:id/categories", (m, body) => {
  const pool = poolOr404(m.groups!.id!);
  const parentId = (body.parentId as string | null | undefined) ?? null;
  const category: MockCategory = {
    id: nextId("k"),
    poolId: pool.id,
    parentId,
    name: String(body.name),
    position: categories.filter((c) => c.poolId === pool.id && c.parentId === parentId).length,
  };
  categories.push(category);
  return category;
});
on("PATCH", "/app/api/categories/:id", (m, body) => {
  const category = categories.find((c) => c.id === m.groups!.id);
  if (!category) throw new MockError(404, "Category not found");
  if (typeof body.name === "string") category.name = body.name;
  if (body.parentId !== undefined) category.parentId = body.parentId as string | null;
  if (typeof body.position === "number") category.position = body.position;
  return category;
});
on("PUT", "/app/api/pools/:id/categories/order", (m, body) => {
  const pool = poolOr404(m.groups!.id!);
  for (const item of (body.items ?? []) as { id: string; parentId: string | null; position: number }[]) {
    const category = categories.find((c) => c.id === item.id && c.poolId === pool.id);
    if (category) {
      category.parentId = item.parentId;
      category.position = item.position;
    }
  }
  return categoryTree(pool.id);
});
on("DELETE", "/app/api/categories/:id", (m) => {
  const id = m.groups!.id!;
  const gone = new Set([id]);
  let grew = true;
  while (grew) {
    grew = false;
    for (const c of categories) {
      if (c.parentId && gone.has(c.parentId) && !gone.has(c.id)) {
        gone.add(c.id);
        grew = true;
      }
    }
  }
  for (let i = categories.length - 1; i >= 0; i -= 1) {
    if (gone.has(categories[i]!.id)) categories.splice(i, 1);
  }
  for (const q of questions) if (q.categoryId && gone.has(q.categoryId)) q.categoryId = null;
  return undefined;
});

on("GET", "/app/api/pools/:id/questions", (m, _body, url) => {
  const pool = poolOr404(m.groups!.id!);
  const params = url.searchParams;
  const list = params.getAll("type").flatMap((v) => v.split(","));
  const tags = params.getAll("tag").flatMap((v) => v.split(","));
  const difficulties = params.getAll("difficulty").flatMap((v) => v.split(",")).map(Number);
  const q = (params.get("q") ?? "").trim().toLowerCase();
  const categoryId = params.get("categoryId");
  const includeDeleted = params.get("includeDeleted") === "1";
  const limit = Number(params.get("limit") ?? 25);
  const cursor = params.get("cursor");

  const matching = liveQuestions(pool.id)
    .filter((question) => includeDeleted || question.deletedAt === null)
    .filter((question) => list.length === 0 || list.includes(question.type))
    .filter((question) => tags.length === 0 || question.tags.some((x) => tags.includes(x)))
    .filter((question) => difficulties.length === 0 || difficulties.includes(question.difficulty))
    .filter((question) => categoryId === null || question.categoryId === categoryId)
    .filter(
      (question) =>
        q === "" ||
        question.internalName.toLowerCase().includes(q) ||
        JSON.stringify(question.draft.config).toLowerCase().includes(q),
    )
    .sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : -1));
  const start = cursor ? matching.findIndex((x) => x.id === cursor) + 1 : 0;
  const page = matching.slice(start, start + limit);
  const next = start + limit < matching.length ? page.at(-1)!.id : null;
  return { items: page.map(questionRow), nextCursor: next };
});

on("POST", "/app/api/pools/:id/questions", (m, body) => {
  const pool = poolOr404(m.groups!.id!);
  const type = String(body.type) as MockQuestion["type"];
  const created = makeQuestion({
    poolId: pool.id,
    type,
    internalName: String(body.internalName),
    categoryId: (body.categoryId as string | null | undefined) ?? null,
    difficulty: 3,
    shuffleable: true,
    randomizable: false,
    tags: [],
    config: emptyConfig(type),
  });
  created.updatedAt = iso(0);
  questions.push(created);
  return questionDetail(created);
});

/** The `emptyDraft()` of each type, as the API would pre-fill it. */
function emptyConfig(type: MockQuestion["type"]): Record<string, unknown> {
  switch (type) {
    case "mcq":
      return mcqConfig("…", [
        ["…", true],
        ["…", false],
      ]);
    case "short":
      return {
        configVersion: 1,
        prompt: "…",
        kind: "text",
        matchers: [{ kind: "exact", value: "…", caseSensitive: false, trim: true, collapseSpaces: true, points: 1 }],
      };
    case "cloze":
      return { configVersion: 1, text: "… {{…}} …", caseSensitive: false, shuffleOptions: true };
    case "code":
      return codeConfig(
        "Décrivez l'exercice ici.",
        "#include <stdio.h>\n\nint main(void) {\n    /* votre code */\n    return 0;\n}\n",
        [{ name: "cas 1", stdin: "", expected: "", visible: true }],
      );
  }
}

on("GET", "/app/api/questions/:id", (m) => questionDetail(questionOr404(m.groups!.id!)));
on("PATCH", "/app/api/questions/:id", (m, body) => {
  const q = questionOr404(m.groups!.id!);
  if (typeof body.internalName === "string") q.internalName = body.internalName;
  if (body.categoryId !== undefined) q.categoryId = body.categoryId as string | null;
  if (typeof body.difficulty === "number") q.difficulty = body.difficulty;
  if (typeof body.shuffleable === "boolean") q.shuffleable = body.shuffleable;
  if (Array.isArray(body.tags)) q.tags = body.tags as string[];
  q.updatedAt = iso(0);
  return questionMeta(q);
});
on("PUT", "/app/api/questions/:id/draft", (m, body) => {
  const q = questionOr404(m.groups!.id!);
  q.draft = {
    config: (body.config ?? {}) as Record<string, unknown>,
    explanation: typeof body.explanation === "string" ? body.explanation : q.draft.explanation,
  };
  q.updatedAt = iso(0);
  const issues = draftIssues(q);
  return { updatedAt: q.updatedAt, valid: issues.length === 0, issues };
});
on("POST", "/app/api/questions/:id/publish", (m, body) => {
  const q = questionOr404(m.groups!.id!);
  const issues = draftIssues(q);
  if (issues.length > 0) {
    throw new MockValidation("Fix the draft before publishing", issues);
  }
  const version: MockVersion = {
    number: (q.versions.at(-1)?.number ?? 0) + 1,
    publishedAt: iso(0),
    publishedBy: "u-me",
    changeNote: typeof body.changeNote === "string" ? body.changeNote : null,
    deprecatedAt: null,
    deprecationNote: null,
    config: q.draft.config,
    explanation: q.draft.explanation,
    configVersion: 1,
  };
  q.versions.push(version);
  return versionRow(version);
});
on("GET", "/app/api/questions/:id/versions", (m) =>
  questionOr404(m.groups!.id!).versions.map(versionRow),
);
on("GET", "/app/api/questions/:id/versions/:number", (m) => {
  const q = questionOr404(m.groups!.id!);
  const version = q.versions.find((v) => v.number === Number(m.groups!.number));
  if (!version) throw new MockError(404, "Version not found");
  return { ...versionRow(version), config: version.config, explanation: version.explanation, configVersion: 1 };
});
on("POST", "/app/api/questions/:id/versions/:number/restore", (m) => {
  const q = questionOr404(m.groups!.id!);
  const version = q.versions.find((v) => v.number === Number(m.groups!.number));
  if (!version) throw new MockError(404, "Version not found");
  q.draft = { config: version.config, explanation: version.explanation };
  q.updatedAt = iso(0);
  return questionDetail(q);
});
on("POST", "/app/api/questions/:id/versions/:number/deprecate", (m, body) => {
  const q = questionOr404(m.groups!.id!);
  const version = q.versions.find((v) => v.number === Number(m.groups!.number));
  if (!version) throw new MockError(404, "Version not found");
  version.deprecatedAt = iso(0);
  version.deprecationNote = String(body.note ?? "");
  return versionRow(version);
});
on("DELETE", "/app/api/questions/:id", (m) => {
  const q = questionOr404(m.groups!.id!);
  q.deletedAt = iso(0);
  return undefined;
});
on("POST", "/app/api/questions/:id/copy", (m, body) => {
  const q = questionOr404(m.groups!.id!);
  const copy = makeQuestion({
    poolId: String(body.targetPoolId ?? q.poolId),
    type: q.type,
    internalName: `${q.internalName}-copie`,
    categoryId: q.categoryId,
    difficulty: q.difficulty,
    shuffleable: q.shuffleable,
    randomizable: q.randomizable,
    tags: [...q.tags],
    config: q.draft.config,
    explanation: q.draft.explanation,
  });
  copy.updatedAt = iso(0);
  questions.push(copy);
  return questionDetail(copy);
});
on("POST", "/app/api/questions/:id/preview", (m, body) => {
  const q = questionOr404(m.groups!.id!);
  const source = body.source ?? "draft";
  const config =
    source === "draft"
      ? q.draft.config
      : (q.versions.find((v) => v.number === Number(source))?.config ?? q.draft.config);
  const issues = draftIssues(q);
  if (source === "draft" && issues.length > 0) {
    throw new MockValidation("This version cannot be rendered", issues);
  }
  return { student: studentView(q, config), itemPoints: 1 };
});
on("POST", "/app/api/questions/:id/try", (m, body) => {
  const q = questionOr404(m.groups!.id!);
  const source = body.source ?? "draft";
  const config =
    source === "draft"
      ? q.draft.config
      : (q.versions.find((v) => v.number === Number(source))?.config ?? q.draft.config);
  return tryAnswer(q, config, body.answer);
});
on("POST", "/app/api/pools/:id/assets", (m) => {
  poolOr404(m.groups!.id!);
  const id = nextId("a");
  return { id, url: `/app/api/assets/${id}`, mime: "image/png", bytes: 12_345, width: 640, height: 360 };
});

// The course side of `course_pools` (F-POOL-05).
on("GET", "/app/api/courses/:id", (m) => {
  const course = courseOr404(m.groups!.id!);
  return {
    course: { id: course.id, name: course.name, code: course.code },
    staff: course.staff.map((s) => ({
      userId: s.userId,
      givenName: s.givenName,
      familyName: s.familyName,
      email: s.email,
    })),
    pools: (coursePools[course.id] ?? [])
      .map((poolId) => pools.find((p) => p.id === poolId))
      .filter((p): p is MockPool => p !== undefined)
      .map(poolSummary),
    classrooms: rooms
      .filter((r) => r.courseId === course.id)
      .map((r) => ({
        id: r.id,
        name: r.name,
        period: r.period,
        archivedAt: r.archivedAt,
        joinCode: null,
        joinCodeEnabled: false,
      })),
  };
});
on("PUT", "/app/api/courses/:id/pools", (m, body) => {
  const course = courseOr404(m.groups!.id!);
  coursePools[course.id] = (body.poolIds as string[] | undefined) ?? [];
  return coursePools[course.id]!
    .map((poolId) => pools.find((p) => p.id === poolId))
    .filter((p): p is MockPool => p !== undefined)
    .map(poolSummary);
});

// --- fetch / EventSource interception ---

const realFetch = window.fetch.bind(window);
window.fetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
  const raw = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
  const url = new URL(raw, window.location.origin);
  if (!url.pathname.startsWith("/app/")) return realFetch(input, init);
  await new Promise((r) => setTimeout(r, LATENCY()));
  const method = (init?.method ?? "GET").toUpperCase();
  // `?fail=1`: every read fails, except the session and the public config —
  // the shell must still render so the failing page is the one under test.
  if (
    flags.fail &&
    method === "GET" &&
    url.pathname !== "/app/api/me" &&
    url.pathname !== "/app/api/config"
  ) {
    return new Response(JSON.stringify({ message: "Simulated failure" }), {
      status: 500,
      headers: { "content-type": "application/json" },
    });
  }
  let body: Record<string, unknown> = {};
  if (typeof init?.body === "string" && init.body.startsWith("{")) {
    try {
      body = JSON.parse(init.body) as Record<string, unknown>;
    } catch {
      body = {};
    }
  }
  for (const r of routes) {
    if (r.method !== method) continue;
    const m = url.pathname.match(r.re);
    if (!m) continue;
    try {
      const result = r.h(m, body, url);
      if (result === undefined) return new Response(null, { status: 204 });
      return new Response(JSON.stringify(result), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    } catch (e) {
      if (e instanceof MockError) {
        const payload =
          e instanceof MockValidation
            ? { error: "config_invalid", message: e.message, details: e.details }
            : { message: e.message };
        return new Response(JSON.stringify(payload), {
          status: e.status,
          headers: { "content-type": "application/json" },
        });
      }
      throw e;
    }
  }
  console.warn(`[mock] no route for ${method} ${url.pathname}`);
  return new Response(JSON.stringify({ message: "Not mocked" }), { status: 404 });
};

// SSE is a refresh hint channel; the mock simply never emits.
class MockEventSource {
  onmessage: ((e: MessageEvent) => void) | null = null;
  onopen: (() => void) | null = null;
  close() {}
}
(window as unknown as { EventSource: unknown }).EventSource = MockEventSource;

const active = FLAG_NAMES.filter((f) => flags[f]);
console.info(
  `[mock] persona: ${role} — switch with ?as=teacher|student|admin` +
    `\n[mock] scene flags: ${active.length ? active.join(", ") : "none"} — ?empty=1 ?fail=1 ?slow=1 ?many=1 (append =0 to clear)`,
);

// ---------------------------------------------------------------------------
// WP9: student player
// ---------------------------------------------------------------------------
//
// The student persona's scenes: a home with three evaluations, the lobby, a
// running attempt holding one question of every MVP type, a pause and a
// closure. One extra scene flag drives them, remembered like the others:
//
//   ?scene=lobby | running | paused | closed | extend   (running by default)
//
// `extend` is the teacher granting time: the fake stream pushes an
// `attempt.deadline` four seconds in, which is the only way to see the
// countdown jump without a backend.
//
// The ids are real UUIDs on purpose: the SSE frames are validated against
// `ServerEvent` (`packages/contracts`), which is exactly the check a hand
// written id would silently fail.
import type {
  AttemptView,
  AutosaveResponse,
  JoinResult,
  LobbyView,
  ServerEvent,
  StudentHome as StudentHomeData,
} from "@quiz/contracts";

type Wp9Scene = "lobby" | "running" | "paused" | "closed" | "extend";

const WP9_SCENE_KEY = "quiz-mock-scene";
const wp9SceneParams = new URLSearchParams(window.location.search);
const wp9Requested = wp9SceneParams.get("scene");
if (wp9Requested !== null) {
  if (wp9Requested === "" || wp9Requested === "0") localStorage.removeItem(WP9_SCENE_KEY);
  else localStorage.setItem(WP9_SCENE_KEY, wp9Requested);
  wp9SceneParams.delete("scene");
  const rest = wp9SceneParams.toString();
  window.history.replaceState(null, "", window.location.pathname + (rest ? `?${rest}` : ""));
}
const wp9Scene = (localStorage.getItem(WP9_SCENE_KEY) ?? "running") as Wp9Scene;

const WP9_EVAL = "11111111-1111-4111-8111-111111111111";
const WP9_EVAL_NEXT = "11111111-1111-4111-8111-111111111112";
const WP9_EVAL_PAST = "11111111-1111-4111-8111-111111111113";
const WP9_ATTEMPT = "22222222-2222-4222-8222-222222222222";
const WP9_PAST_ATTEMPT = "22222222-2222-4222-8222-222222222223";
const wp9Item = (n: number) => `aaaaaaaa-0000-4000-8000-00000000000${n}`;

/** The evaluation's state follows the scene; everything else is fixed. */
const wp9EvaluationState = () =>
  wp9Scene === "lobby"
    ? ("lobby" as const)
    : wp9Scene === "paused"
      ? ("paused" as const)
      : ("running" as const);

/** One question of each MVP type, in French, as `toStudent` would publish it. */
const wp9Students: Record<number, unknown> = {
  1: {
    prompt: "Quelle expression donne **l'adresse** de la variable `x` ?",
    mode: "single",
    choices: [
      { id: 0, text: "`&x`" },
      { id: 1, text: "`*x`" },
      { id: 2, text: "`x[0]`" },
      { id: 3, text: "`addr(x)`" },
    ],
  },
  2: {
    template:
      "Complétez la phrase. L'orthographe des noms propres n'est pas notée.\n\nLa loi d'⸢0⸣ relie la tension et le courant : pour un conducteur ohmique, U = ⸢1⸣ × I, où la tension U s'exprime en ⸢2⸣.",
    blanks: [
      { index: 0, weight: 1, kind: "input", numeric: false },
      { index: 1, weight: 1, kind: "input", numeric: false },
      {
        index: 2,
        weight: 1,
        kind: "select",
        options: [
          { id: 0, label: "ampères" },
          { id: 1, label: "ohms" },
          { id: 2, label: "volts" },
          { id: 3, label: "watts" },
        ],
      },
    ],
  },
  3: {
    prompt:
      "Sur une machine 64 bits compilant en LP64, combien d'octets occupe un `int` en C ?",
    kind: "number",
    placeholder: "4",
  },
  4: {
    prompt:
      // Plain text: the `code` player renders its prompt as written (its
      // props carry no markdown renderer), so no backtick survives as syntax.
      "Corrigez r_parallele pour qu'elle renvoie la résistance équivalente de deux résistances en parallèle, en ohms. Le cas d'un court-circuit doit renvoyer 0.",
    language: "c",
    segments: [
      {
        kind: "locked",
        index: null,
        text: "/* Résistance équivalente de deux résistances en parallèle, en ohms. */\n#include <stdio.h>\n",
      },
      {
        kind: "editable",
        index: 0,
        text: "double r_parallele(double r1, double r2)\n{\n    if (r1 == 0 || r2 == 0)\n        return 0;\n    return r1 * r2 / (r1 - r2);\n}\n",
      },
      {
        kind: "locked",
        index: null,
        text: 'int main(void)\n{\n    double a, b;\n    if (scanf("%lf %lf", &a, &b) != 2)\n        return 1;\n    printf("%.2f\\n", r_parallele(a, b));\n    return 0;\n}\n',
      },
    ],
    limits: { timeMs: 2000, memoryMb: 128, outputKb: 64 },
    runsPerMinute: 10,
    visibleCases: [
      { name: "deux résistances égales", stdin: "100 100", expected: "50.00", points: 1 },
      { name: "court-circuit", stdin: "0 470", expected: "0.00", points: 1 },
    ],
    hiddenCount: 3,
    hiddenPoints: 3,
    filesPreview: [],
    allOrNothing: false,
  },
};

/** The attempt's mutable half: what the student typed, and where they are. */
const wp9Answers = new Map<string, { payload: unknown; revision: number; done: boolean }>();
let wp9Position: string | null = wp9Item(1);
const WP9_BASE_DEADLINE = now + 14 * 60_000 + 32_000;
let wp9Deadline = WP9_BASE_DEADLINE;

const wp9AttemptView = (): AttemptView => ({
  attempt: {
    id: WP9_ATTEMPT,
    // `closed` is the deadline case of F-LIVE-07: the server expired the
    // attempt while the evaluation itself is still running for the others.
    state: wp9Scene === "closed" ? "expired" : "in_progress",
    startedAt: iso(-6 * 60_000),
    deadlineAt: new Date(wp9Deadline).toISOString(),
    lastItemId: wp9Position,
    serverNow: new Date().toISOString(),
    preview: false,
  },
  evaluation: {
    id: WP9_EVAL,
    title: "Quiz 3 — Pointeurs et lois fondamentales",
    mode: "exam",
    state: wp9EvaluationState(),
    settings: {
      navigation: "free",
      presentation: "zen",
      lobby: "manual",
      shuffleItems: false,
      shuffleChoices: true,
      timing: "duration",
      showProgressBar: true,
      logVisibility: true,
      requireFullscreen: false,
    },
    feedbackPolicy: {
      when: "on_release",
      showAnswer: true,
      showKey: false,
      showExplanation: false,
      showHiddenCaseNames: true,
      showTeacherComment: true,
    },
    pausedAt: wp9Scene === "paused" ? iso(-30_000) : null,
    totalPoints: 10,
  },
  items: [1, 2, 3, 4].map((n) => {
    const stored = wp9Answers.get(wp9Item(n));
    return {
      id: wp9Item(n),
      position: n,
      points: n === 4 ? 5 : n === 3 ? 1 : 2,
      type: n === 1 ? "mcq" : n === 2 ? "cloze" : n === 3 ? "short" : "code",
      milestone: n === 3,
      student: wp9Students[n],
      answer: stored?.payload ?? null,
      revision: stored?.revision ?? 0,
      markedDone: stored?.done ?? false,
      locked: false,
    };
  }),
});

const wp9LobbyView = (): LobbyView => ({
  evaluation: {
    id: WP9_EVAL,
    title: "Quiz 3 — Pointeurs et lois fondamentales",
    state: "lobby",
    announcedDurationS: 20 * 60,
  },
  present: 18,
  enrolled: 24,
  timeBonusPercent: 33,
  serverNow: new Date().toISOString(),
});

on("GET", "/app/api/student/home", (): StudentHomeData => {
  if (flags.empty) {
    return { open: [], upcoming: [], past: [], serverNow: new Date().toISOString() };
  }
  const room = { classroomId: "r1", classroomName: "PRG1-2026", courseCode: "PRG1" };
  return {
    open: [
      {
        id: WP9_EVAL,
        title: "Quiz 3 — Pointeurs et lois fondamentales",
        mode: "exam",
        state: wp9EvaluationState(),
        ...room,
        opensAt: iso(-6 * 60_000),
        closesAt: iso(14 * 60_000),
        durationS: 20 * 60,
        attemptId: wp9Scene === "lobby" ? null : WP9_ATTEMPT,
        attemptState: wp9Scene === "lobby" ? null : "in_progress",
        deadlineAt: wp9Scene === "lobby" ? null : new Date(wp9Deadline).toISOString(),
      },
    ],
    upcoming: [
      {
        id: WP9_EVAL_NEXT,
        title: "Série 4 — Récursivité",
        mode: "exercise",
        state: "scheduled",
        ...room,
        opensAt: iso(3 * D),
        closesAt: iso(7 * D),
        durationS: null,
        attemptId: null,
        attemptState: null,
        deadlineAt: null,
      },
    ],
    past: [
      {
        id: WP9_EVAL_PAST,
        title: "Quiz 2 — Tableaux et chaînes",
        mode: "exam",
        state: "released",
        ...room,
        opensAt: iso(-8 * D),
        closesAt: iso(-8 * D + 20 * 60_000),
        durationS: 20 * 60,
        attemptId: WP9_PAST_ATTEMPT,
        attemptState: "submitted",
        deadlineAt: null,
      },
    ],
    serverNow: new Date().toISOString(),
  };
});

on("POST", "/app/api/evaluations/:id/attempt", () =>
  wp9Scene === "lobby"
    ? { kind: "lobby", view: wp9LobbyView() }
    : { kind: "attempt", view: wp9AttemptView() },
);

on("GET", "/app/api/attempts/:id", () => wp9AttemptView());

on("PUT", "/app/api/attempts/:id/answers/:itemId", (m, body): AutosaveResponse => {
  const itemId = m.groups!.itemId!;
  const revision = Number(body.revision ?? 1);
  const stored = wp9Answers.get(itemId);
  // The same last-writer-wins rule as the server: a lower revision is stale
  // and comes back with what is stored (§4.7).
  if (stored && stored.revision >= revision) {
    return {
      revision: stored.revision,
      payload: stored.payload,
      accepted: false,
      serverNow: new Date().toISOString(),
    };
  }
  wp9Answers.set(itemId, { payload: body.payload, revision, done: stored?.done ?? false });
  return { revision, accepted: true, serverNow: new Date().toISOString() };
});

on("POST", "/app/api/attempts/:id/answers/:itemId/done", (m, body) => {
  const itemId = m.groups!.itemId!;
  const stored = wp9Answers.get(itemId) ?? { payload: null, revision: 0, done: false };
  const done = body.done === true;
  wp9Answers.set(itemId, { ...stored, done });
  return { done, nextItemId: null, serverNow: new Date().toISOString() };
});

on("POST", "/app/api/attempts/:id/position", (_m, body) => {
  wp9Position = String(body.itemId);
  return undefined;
});

on("POST", "/app/api/attempts/:id/submit", () => ({
  state: "submitted",
  submittedAt: new Date().toISOString(),
  serverNow: new Date().toISOString(),
}));

on("POST", "/app/api/attempts/:id/events", () => undefined);

on("POST", "/app/api/attempts/:id/run", () => ({
  requestId: "33333333-3333-4333-8333-333333333333",
  result: {
    status: "ok",
    compile: { ok: true, stderr: "" },
    cases: [
      {
        name: "deux résistances égales",
        ok: false,
        stdout: "-inf",
        expected: "50.00",
        ms: 3,
        timedOut: false,
      },
      {
        name: "court-circuit",
        ok: true,
        stdout: "0.00",
        expected: "0.00",
        ms: 2,
        timedOut: false,
      },
    ],
  },
}));

on("POST", "/app/api/join/:code", (m): JoinResult => ({
  classroomId: "r1",
  classroomName: "PRG1-2026",
  courseCode: "PRG1",
  status: m.groups!.code!.toUpperCase() === "PRG1-2026" ? "already" : "joined",
}));

/**
 * The fake stream. It replaces the hint-only `MockEventSource` defined above
 * and keeps its behaviour for an unwatched connection, so nothing that worked
 * before changes: only `?watch=attempt:…` and `?watch=evaluation:…` grow a
 * body, and they emit the named frames of §4.8.
 */
class Wp9EventSource {
  onmessage: ((e: MessageEvent) => void) | null = null;
  onopen: (() => void) | null = null;
  onerror: (() => void) | null = null;
  private readonly listeners = new Map<string, Set<(e: MessageEvent) => void>>();
  private readonly timers: ReturnType<typeof setTimeout>[] = [];
  private beat: ReturnType<typeof setInterval> | null = null;

  constructor(url: string) {
    const watch = new URL(url, window.location.origin).searchParams.get("watch");
    setTimeout(() => {
      this.onopen?.();
      if (watch === null) return;
      this.emit({
        type: "snapshot",
        serverNow: new Date().toISOString(),
        subject: watch,
        state: watch.startsWith("attempt:") ? wp9AttemptView() : wp9LobbyView(),
      });
      if (watch.startsWith("evaluation:")) {
        this.emit({
          type: "lobby.count",
          evaluationId: WP9_EVAL,
          present: 18,
          enrolled: 24,
        });
      }
      // A running attempt gets a beat a second (§4.8), which is what keeps
      // the countdown honest on a browser with a wrong clock.
      this.beat = setInterval(
        () => this.emit({ type: "clock", serverNow: new Date().toISOString() }),
        1000,
      );
      if (wp9Scene === "extend") {
        this.timers.push(
          setTimeout(() => {
            // Assignment, not `+=`: React mounts effects twice in
            // development, so two streams open and an increment would grant
            // ten minutes instead of five.
            wp9Deadline = WP9_BASE_DEADLINE + 5 * 60_000;
            this.emit({
              type: "attempt.deadline",
              attemptId: WP9_ATTEMPT,
              deadlineAt: new Date(wp9Deadline).toISOString(),
              bonusS: 300,
              reason: "teacher_extend",
              serverNow: new Date().toISOString(),
            });
          }, 4000),
        );
      }
      if (wp9Scene === "paused") {
        this.emit({
          type: "evaluation.state",
          evaluationId: WP9_EVAL,
          state: "paused",
          pausedAt: new Date().toISOString(),
          closesAt: null,
          serverNow: new Date().toISOString(),
        });
      }
      if (wp9Scene === "closed") {
        this.emit({
          type: "attempt.closed",
          attemptId: WP9_ATTEMPT,
          evaluationId: WP9_EVAL,
          closedBy: "server",
          serverNow: new Date().toISOString(),
        });
      }
    }, 60);
  }

  private emit(event: ServerEvent): void {
    const frame = { data: JSON.stringify(event) } as MessageEvent;
    for (const fn of this.listeners.get(event.type) ?? []) fn(frame);
  }

  addEventListener(name: string, fn: (e: MessageEvent) => void): void {
    const set = this.listeners.get(name) ?? new Set();
    set.add(fn);
    this.listeners.set(name, set);
  }

  removeEventListener(name: string, fn: (e: MessageEvent) => void): void {
    this.listeners.get(name)?.delete(fn);
  }

  close(): void {
    if (this.beat !== null) clearInterval(this.beat);
    this.beat = null;
    for (const timer of this.timers) clearTimeout(timer);
    this.timers.length = 0;
    this.listeners.clear();
  }
}
(window as unknown as { EventSource: unknown }).EventSource = Wp9EventSource;

console.info(`[mock] student scene: ${wp9Scene} — ?scene=lobby|running|paused|closed|extend`);
