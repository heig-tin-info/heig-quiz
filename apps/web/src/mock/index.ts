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
 *    teachers, no pool and no evaluation, so every empty state is reachable;
 *  - `fail`  — every GET under /app/api answers 500 (except /app/api/me and
 *    /app/api/config, so the shell still renders), for the error states;
 *  - `slow`  — 2.5 s of latency on every call, for the loading states;
 *  - `many`  — 8 courses, 30 classrooms, a 120-student roster on the first
 *    one and 70 questions in the first pool: long lists, the sidebar, the
 *    cursor pagination of the pool table and the 120 × 10 live grid;
 *  - `scene` — the student player's state, and only that one screen's:
 *    `?scene=lobby|running|paused|closed|extend` (`running` by default).
 *
 * ONE dataset, in four labelled sections:
 *
 *   1. the session, courses, classrooms, roster and administration;
 *   2. pools, categories and questions of the four types, with their
 *      versions, the preview and the `try` grading — real French content
 *      about C programming and electronics;
 *   3. evaluations in every state, over the questions of section 2, plus the
 *      live dashboard and the teacher's controls on it;
 *   4. the student's home, lobby and player.
 *
 * Sections 3 and 4 share the questions of section 2: an item of an
 * evaluation is frozen on a published version of a real question, so the
 * dashboard, the inspect panel and the teacher's preview render what the
 * pool actually holds rather than a second, parallel truth.
 *
 * Ids follow the same rule as the server. They are hand-written wherever a
 * human types them into a URL (`p1`, `q2`, `r1`, and an evaluation is also
 * addressable by its STATE — `/evaluations/running/live`), and real UUIDs
 * wherever a frame of the SSE stream carries them: those are validated in the
 * browser against `ServerEvent` and `DashboardView` (invariant 7), which a
 * made-up id silently fails.
 */
import {
  clozeStudentTemplate,
  describe,
  describeBlank,
  histogram,
  matchBlank,
  mcqFraction,
  parseCloze,
  type ClozeChoiceSet,
  splitTemplate,
  truncateSelection,
  type McqScorePolicy,
} from "@quiz/domain";
import type {
  AdminTeacher,
  AttemptView,
  AutosaveResponse,
  ClassroomDetail,
  CourseSummary,
  JoinResult,
  LobbyView,
  Me,
  PublicConfig,
  RosterEntry,
  ServerEvent,
  StudentClassroom,
  StudentHome as StudentHomeData,
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

/**
 * The student player's scene, remembered the same way. It picks what the
 * fake backend serves on ONE evaluation (section 4) and changes nothing
 * anywhere else.
 */
type Scene = "lobby" | "running" | "paused" | "closed" | "extend";
const SCENE_KEY = "quiz-mock-scene";
const sceneParam = params.get("scene");
if (sceneParam !== null) {
  if (sceneParam === "" || sceneParam === "0") localStorage.removeItem(SCENE_KEY);
  else localStorage.setItem(SCENE_KEY, sceneParam);
  params.delete("scene");
  urlDirty = true;
}
const scene = (localStorage.getItem(SCENE_KEY) ?? "running") as Scene;

if (urlDirty) {
  const q = params.toString();
  window.history.replaceState(null, "", window.location.pathname + (q ? `?${q}` : ""));
}

/** Latency of every mocked call: enough to see a skeleton under `?slow=1`. */
const LATENCY = () => (flags.slow ? 2500 : 120 + Math.random() * 180);

// --- 1. Session, courses, classrooms, roster, administration ---------------

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
  mcqPolicy: null,
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
/** The students of a classroom, staff excluded, in dashboard-row order. */
const classroomRoster = (classroomId: string): RosterEntry[] =>
  (rooms.find((r) => r.id === classroomId)?.roster ?? []).filter((s) => !s.staff);

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

// --- 2. Pools, categories, questions (WP7) --------------------------------
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
  configVersion: 2,
  prompt,
  choices: choices.map(([text, correct]) => ({ text, correct })),
  mode: "single",
  // The default: the evaluation that plays the question decides.
  policy: "inherit",
  shuffleChoices: true,
  ...over,
});

/** The v2 defaults of a `short` config, for a mock question that omits them. */
const shortConstraints = (config: Record<string, unknown>) => ({
  minLength: 0,
  maxLength: 255,
  integer: false,
  ...((config.constraints ?? {}) as Record<string, unknown>),
});

const shortPrefilter = (config: Record<string, unknown>) => {
  const p = { trim: true, lowercase: true, ...((config.prefilters ?? {}) as Record<string, unknown>) };
  return (raw: string): string => {
    let out = raw.normalize("NFC");
    if (p.trim) out = out.trim();
    if (p.lowercase) out = out.toLocaleLowerCase("fr");
    return out;
  };
};

const shortNumber = (prompt: string, value: number, unit?: string) => ({
  configVersion: 2,
  prompt,
  kind: "number",
  constraints: { min: 0, integer: true },
  prefilters: { trim: true, lowercase: true },
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
    /*
     * The question the rich cloze editor was built for: a hole inside a
     * TABLE cell, which `{{=free|delete|dispose}}` cannot be — every
     * unescaped `|` in a markdown row is a column separator — so the two
     * dropdowns of the table go through PREDEFINED CHOICE SETS instead.
     */
    config: {
      configVersion: 2,
      text:
        "Pour allouer un tableau de `n` entiers on écrit `int *t = {{malloc|calloc}}(n * sizeof({{int}}));`, " +
        "puis on libère la mémoire avec {{=free|delete|dispose}}.\n\n" +
        "| Fonction | Met la mémoire à zéro |\n" +
        "| -------- | --------------------- |\n" +
        "| `malloc` | {{2}}                 |\n" +
        "| `calloc` | {{1}}                 |",
      caseSensitive: false,
      shuffleOptions: true,
      choiceSets: [
        {
          key: "1",
          options: [
            { label: "oui", correct: true },
            { label: "non", correct: false },
          ],
        },
        {
          key: "2",
          options: [
            { label: "oui", correct: false },
            { label: "non", correct: true },
          ],
        },
      ],
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
    // The one MULTIPLE-answer question of the mock: two keys, so the scoring
    // card of the editor is shown whole — the policy, the answer limit and
    // the shuffling exception all live there and single mode hides two of
    // the three.
    config: mcqConfig(
      "Quels modes de `fopen` permettent d'écrire dans un fichier **sans** effacer son contenu ?",
      [
        ['`"a"`', true],
        ['`"a+"`', true],
        ['`"w"`', false],
        ['`"w+"`', false],
      ],
      { mode: "multiple", policy: "symmetric" },
    ),
    explanation:
      "`\"a\"` et `\"a+\"` écrivent à la fin du fichier ; `\"w\"` et `\"w+\"` le tronquent à l'ouverture.",
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
      configVersion: 2,
      text: "Un convertisseur analogique-numérique de {{#12}} bits découpe sa pleine échelle en {{#4096}} paliers. Sous 3,3 V, un palier vaut environ {{#0.8:0.05}} mV.",
      caseSensitive: false,
      shuffleOptions: true,
    },
    explanation: "2^12 = 4096 paliers ; 3,3 V / 4096 ≈ 0,8 mV.",
  }),
];

/**
 * One published version is deprecated, like one question is unpublished: the
 * amber badge of the pool table, of the evaluation's question picker and of
 * its item table is then a state of the data rather than a prop.
 */
const deprecated = questions.find((q) => q.internalName === "fopen-modes")?.versions.at(-1);
if (deprecated) {
  deprecated.deprecatedAt = iso(-3 * D);
  deprecated.deprecationNote = "Remplacée par une question sur les modes binaires.";
}

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
                    configVersion: 2,
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

/**
 * The descriptions a teacher wrote in this session, keyed `poolId\u0000tag`.
 * A few are pre-written: the tag field is about a documented vocabulary, and
 * an empty column would show none of it.
 */
const tagDescriptions = new Map<string, string>([
  ["p1\u0000pointeurs", "Adresses, déréférencement, arithmétique de pointeurs"],
  ["p1\u0000memoire", "malloc, free et la durée de vie des objets"],
  ["p1\u0000securite", "Débordements, entrées non validées, comportements indéfinis"],
  ["p1\u0000tableaux", "Tableaux, indices et leur relation aux pointeurs"],
]);

/** `GET /pools/:id/tags`: the vocabulary of the pool, with its usage counts. */
const poolTagDetails = (poolId: string) =>
  poolTags(poolId).map((tag) => ({
    tag,
    description: tagDescriptions.get(`${poolId}\u0000${tag}`) ?? "",
    count: liveQuestions(poolId).filter((q) => q.tags.includes(tag)).length,
  }));

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
    // A cap below the key set makes the full mark unreachable. The editor
    // says so at the keystroke; this is the SERVER's copy of it, so the mock
    // answers a save the way the API does.
    if (
      typeof config.maxSelections === "number" &&
      config.maxSelections < choices.filter((c) => c.correct).length
    ) {
      out.push({ path: ["maxSelections"], code: "custom", message: "mcq.max_below_correct" });
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
    const parse = parseCloze(String(config.text ?? ""), clozeSets(config));
    if (parse.blanks.length === 0) {
      out.push({ path: ["text"], code: "custom", message: "cloze.no_blank" });
    }
  }
  return out;
}

/**
 * The predefined choice sets of a `cloze` config, for `parseCloze`.
 *
 * The mock speaks the real grammar: `{{1}}` is a dropdown only when a set is
 * named "1", so every parse here is handed the same list the API would
 * (`packages/qt-cloze/src/parse.ts`).
 */
function clozeSets(config: Record<string, unknown>): ClozeChoiceSet[] {
  return Array.isArray(config.choiceSets) ? (config.choiceSets as ClozeChoiceSet[]) : [];
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
        // Not part of the key: what the FIELD takes (`toStudent` in
        // `@quiz/qt-short/server` sends the same thing).
        constraints: shortConstraints(config),
        ...(config.placeholder === undefined ? {} : { placeholder: config.placeholder }),
      };
    case "cloze": {
      const parse = parseCloze(String(config.text ?? ""), clozeSets(config));
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
/**
 * The applied MCQ policy (docs/04 §4.4): the question's own, or the
 * evaluation's when it says `inherit`, or `all_or_nothing` when there is no
 * evaluation at all — which is what the teacher's Try panel is.
 */
function mcqPolicyOf(
  config: Record<string, unknown>,
  evaluationPolicy: McqScorePolicy | null,
): McqScorePolicy {
  if (config.mode === "single") return "all_or_nothing";
  const own = config.policy;
  if (typeof own === "string" && own !== "inherit") return own as McqScorePolicy;
  return evaluationPolicy ?? "all_or_nothing";
}

function tryAnswer(
  q: MockQuestion,
  config: Record<string, unknown>,
  answer: unknown,
  evaluationPolicy: McqScorePolicy | null = null,
): unknown {
  if (q.type === "code") return { status: "runner_unavailable", reason: "not_configured" };
  if (q.type === "mcq") {
    const choices = (config.choices ?? []) as { text: string; correct: boolean }[];
    const correct = choices.flatMap((c, i) => (c.correct ? [i] : []));
    // The five formulas come from `@quiz/domain`, never reimplemented here:
    // the mock must score exactly what the server would.
    const policy = mcqPolicyOf(config, evaluationPolicy);
    const { selected, truncated } = truncateSelection(
      (answer as { selected?: number[] } | null)?.selected ?? [],
      (config.maxSelections as number | undefined) ?? null,
    );
    const score = mcqFraction({ correct, selected, choiceCount: choices.length, policy });
    return {
      status: "graded",
      points: Math.round(score.fraction * 100) / 100,
      maxPoints: 1,
      details: {
        policy,
        correct,
        selected,
        c: score.c,
        w: score.w,
        C: score.C,
        W: score.W,
        fraction: score.fraction,
        truncated,
      },
      solution: { correct },
    };
  }
  if (q.type === "short") {
    const matchers = (config.matchers ?? []) as { kind: string; value?: unknown }[];
    // The v2 prefilters, applied to the answer AND to every expected text,
    // exactly as `@quiz/qt-short` does it.
    const filter = shortPrefilter(config);
    const text = filter(String((answer as { text?: string } | null)?.text ?? ""));
    const index = matchers.findIndex((m) =>
      m.kind === "number"
        ? Number(text.replace(",", ".")) === Number(m.value)
        : text === filter(String(m.value)),
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
  const parse = parseCloze(String(config.text ?? ""), clozeSets(config));
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
on("GET", "/app/api/pools/:id/tags", (m) => poolTagDetails(poolOr404(m.groups!.id!).id));
on("PATCH", "/app/api/pools/:id/tags/:tag", (m, body) => {
  const pool = poolOr404(m.groups!.id!);
  const tag = decodeURIComponent(m.groups!.tag!).toLowerCase();
  const description = String(body.description ?? "");
  tagDescriptions.set(`${pool.id}\u0000${tag}`, description);
  return {
    tag,
    description,
    count: liveQuestions(pool.id).filter((q) => q.tags.includes(tag)).length,
  };
});

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

/**
 * The `emptyDraft()` of each type, as the API pre-fills it: the shape and the
 * defaults, with NO content. It does not validate, and that is intended —
 * decision D16 stores a draft whatever it holds.
 */
function emptyConfig(type: MockQuestion["type"]): Record<string, unknown> {
  switch (type) {
    case "mcq":
      return mcqConfig("", [
        ["", true],
        ["", false],
      ]);
    case "short":
      return {
        configVersion: 2,
        prompt: "",
        kind: "text",
        constraints: { minLength: 0, maxLength: 255, integer: false },
        prefilters: { trim: true, lowercase: true },
        matchers: [{ kind: "exact", value: "", points: 1 }],
      };
    case "cloze":
          return { configVersion: 2, text: "", caseSensitive: false, shuffleOptions: true, choiceSets: [] };
    case "code":
      return codeConfig("", "", [{ name: "", stdin: "", expected: "", visible: true }]);
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

// --- 3. Evaluations, live dashboard (WP8) ----------------------------------
//
// Everything a teacher can configure and supervise, with enough data that the
// five states of every surface are reachable without a backend: one
// evaluation per state, and a running one at 24 students × 10 questions —
// the size the grid has to stay usable at (120 × 10 under `?many=1`, which is
// the roster the classroom above grows to).
//
// The items are frozen on the questions of section 2, by design: the item
// table, the picker, the teacher's preview and the inspect panel of the
// dashboard then all render the SAME four types on the SAME French content
// the pool screens show, and there is exactly one place to edit when a
// payload changes.
//
// Ids here are real UUIDs, not "e1": the SSE client validates every frame
// against the `ServerEvent` schema of `@quiz/contracts` (invariant 7) and the
// dashboard snapshot against `DashboardView`, so the mock has to speak the
// same grammar as the server, down to the id format. The one exception is the
// `questionId` an item points at, which is the pool's own `q3` — it never
// travels on the stream.

let uuidSeq = 0;
const uuid = (): string =>
  `00000000-0000-4000-8000-${(uuidSeq += 1).toString(16).padStart(12, "0")}`;

const ADJECTIVES = ["calme", "vif", "patient", "curieux", "sobre", "franc", "alerte", "serein"];
const ANIMALS = ["héron", "renard", "lynx", "martre", "bouquetin", "chamois", "castor", "milan"];
/** Decision D20: a stable adjective+animal per row, never the student's name. */
const pseudonymOf = (index: number) =>
  `${ADJECTIVES[index % ADJECTIVES.length]} ${ANIMALS[(index * 3) % ANIMALS.length]}`;

// --- The pool, seen from an evaluation -------------------------------------
//
// Four adapters, one per thing an item needs from the question it froze: what
// the student sees, what the key is, what a student plausibly answered, and
// the glyph the grid puts in a cell. The first two go through the very
// functions of section 2 (`studentView`, and the `@quiz/domain` cloze
// helpers), so nothing is described twice.

/** The config an item is frozen on: the last published one, or the draft. */
const frozenConfig = (q: MockQuestion): Record<string, unknown> =>
  q.versions.at(-1)?.config ?? q.draft.config;

/** The questions an evaluation may draw from: published, `p1` first. */
function itemSource(): MockQuestion[] {
  const published = questions.filter((q) => q.deletedAt === null && q.versions.length > 0);
  const primary = published.filter((q) => q.poolId === "p1");
  return primary.length > 0 ? primary : published;
}

const studentConfigOf = (q: MockQuestion): unknown => studentView(q, frozenConfig(q));

/** The key, in the shape each type's `Review` reads (`solutionSchema`). */
function solutionOf(q: MockQuestion): unknown {
  const config = frozenConfig(q);
  switch (q.type) {
    case "mcq": {
      const choices = (config.choices ?? []) as { correct: boolean }[];
      return { correct: choices.flatMap((c, i) => (c.correct ? [i] : [])) };
    }
    case "short": {
      const matchers = (config.matchers ?? []) as { value?: unknown }[];
      return { expected: matchers.map((m) => String(m.value)) };
    }
    case "cloze": {
      const parse = parseCloze(String(config.text ?? ""), clozeSets(config));
      return { blanks: parse.blanks.map((b) => ({ index: b.index, expected: describeBlank(b) })) };
    }
    case "code": {
      const tests = (config.tests ?? {}) as { compare?: unknown; cases?: CodeCaseLike[] };
      return {
        referenceSolution: String(config.referenceSolution ?? ""),
        cases: (tests.cases ?? []).map((c) => ({
          name: c.name,
          stdin: c.stdin,
          expected: c.expected,
          points: c.points,
          visible: c.visible,
        })),
        compare: tests.compare,
      };
    }
  }
}

type MockBlank = ReturnType<typeof parseCloze>["blanks"][number];

/** What a student would type in one blank. A `select` stores the option INDEX. */
function blankAnswer(blank: MockBlank): string {
  switch (blank.kind) {
    case "text":
      return blank.answers[0] ?? "";
    case "number":
      return String(blank.value);
    case "select":
      return String(blank.correct[0] ?? 0);
    case "regex":
      return blank.pattern.replace(/[^\w ]/g, "");
  }
}

/**
 * One student's answer to one item. Two in three are the right one: a grid of
 * nothing but wrong answers reads as a broken mock rather than as a hard
 * question, and the teacher's eye is exactly what these screens are for.
 */
function answerOf(q: MockQuestion, seedValue: number): unknown {
  const config = frozenConfig(q);
  const wrong = seedValue % 3 === 0;
  switch (q.type) {
    case "mcq": {
      const choices = (config.choices ?? []) as { correct: boolean }[];
      const correct = Math.max(
        choices.findIndex((c) => c.correct),
        0,
      );
      const picked = wrong ? (correct + 1) % Math.max(choices.length, 1) : correct;
      return { selected: [picked] };
    }
    case "short": {
      const matchers = (config.matchers ?? []) as { value?: unknown }[];
      const expected = String(matchers[0]?.value ?? "");
      return { text: wrong ? `${expected}0` : expected };
    }
    case "cloze": {
      const parse = parseCloze(String(config.text ?? ""), clozeSets(config));
      // A blank left untouched is `null`, which is what an unfinished answer
      // looks like on the wire.
      return {
        blanks: parse.blanks.map((b, i) => ((seedValue + i) % 4 === 0 ? null : blankAnswer(b))),
      };
    }
    case "code":
      return {
        regions: splitTemplate(String(config.template ?? ""), "c")
          .filter((s) => s.kind === "editable")
          .map((s) => s.text),
        lastRun: null,
      };
  }
}

/** One glyph or two for the grid cell (what `type.summarize` returns). */
function summaryOf(q: MockQuestion, seedValue: number): string {
  const answer = answerOf(q, seedValue);
  switch (q.type) {
    case "mcq":
      return String.fromCharCode(65 + ((answer as { selected: number[] }).selected[0] ?? 0));
    case "short":
      return (answer as { text: string }).text.slice(0, 8);
    case "cloze": {
      const blanks = (answer as { blanks: (string | null)[] }).blanks;
      return `${blanks.filter((b) => b !== null).length}/${blanks.length}`;
    }
    case "code": {
      const cases = ((frozenConfig(q).tests ?? {}) as { cases?: unknown[] }).cases ?? [];
      return `${cases.length === 0 ? 0 : 1 + (seedValue % cases.length)}/${cases.length}`;
    }
  }
}

/** The pool question an item froze on, or null if the pool no longer has it. */
const itemQuestion = (item: { questionId: string }): MockQuestion | null =>
  questions.find((q) => q.id === item.questionId) ?? null;
interface MockCell {
  itemId: string;
  status: "empty" | "seen" | "in_progress" | "done";
  verdict: null;
  points: null;
  revision: number;
  summary: string | null;
}

interface MockItem {
  id: string;
  position: number;
  points: number;
  milestone: boolean;
  questionId: string;
  questionVersionId: string;
  type: string;
  internalName: string;
  versionNumber: number;
  latestVersionNumber: number | null;
  deprecated: boolean;
}

interface MockRowState {
  attemptId: string | null;
  userId: string;
  displayName: string;
  pseudonym: string;
  state: "not_started" | "in_progress" | "submitted" | "expired";
  online: boolean;
  lastSeenAt: string | null;
  deadlineAt: string | null;
  timeBonusPercent: number;
  points: null;
  maxPoints: number;
  cells: MockCell[];
}

interface MockEvaluation {
  id: string;
  classroomId: string;
  title: string;
  mode: "exam" | "exercise" | "poll";
  state:
    | "draft"
    | "scheduled"
    | "lobby"
    | "running"
    | "paused"
    | "closed"
    | "grading"
    | "released";
  settings: Record<string, unknown>;
  gradingScale: Record<string, unknown>;
  feedbackPolicy: Record<string, unknown>;
  mcqPolicy: McqScorePolicy;
  opensAt: string | null;
  closesAt: string | null;
  durationS: number | null;
  accessCode: string | null;
  ipAllowlist: string[];
  startedAt: string | null;
  pausedAt: string | null;
  closedAt: string | null;
  releasedAt: string | null;
  modifiedAfterRelease: boolean;
  createdAt: string;
  items: MockItem[];
  rows: MockRowState[];
  present: number;
}

const defaultEvaluationSettings = () => ({
  navigation: "free",
  presentation: "zen",
  lobby: "manual",
  shuffleItems: false,
  shuffleChoices: true,
  timing: "duration",
  showProgressBar: true,
  logVisibility: true,
  requireFullscreen: false,
});

/**
 * The items of an evaluation, frozen on the published questions of the pool.
 * `versionNumber` is the frozen one and `latestVersionNumber` what the pool
 * published since: one item in five is deliberately left a version behind, so
 * the stale badge and the one-click update are reachable without editing
 * anything.
 */
function makeItems(count: number): MockItem[] {
  const source = itemSource();
  if (source.length === 0) return [];
  return Array.from({ length: count }, (_, i) => {
    const q = source[i % source.length]!;
    const latest = q.versions.at(-1)!;
    // Every third item is frozen one version behind, whenever the question
    // has one: that is the stale badge and the one-click update.
    const frozen = i % 3 === 0 && latest.number > 1 ? latest.number - 1 : latest.number;
    return {
      id: uuid(),
      position: i + 1,
      points: q.type === "code" ? 3 : 1 + (i % 3),
      milestone: i === 4,
      questionId: q.id,
      questionVersionId: uuid(),
      type: q.type,
      internalName: q.internalName,
      versionNumber: frozen,
      latestVersionNumber: latest.number,
      deprecated: latest.deprecatedAt !== null,
    };
  });
}

function makeRows(e: MockEvaluation, started: boolean): MockRowState[] {
  const roster = classroomRoster(e.classroomId);
  const maxPoints = e.items.reduce((sum, i) => sum + i.points, 0);
  return roster.map((student, index) => {
    // A deterministic spread: some are ahead, some have not opened it.
    const progress = started ? Math.min(e.items.length, Math.floor(rand() * (e.items.length + 2))) : 0;
    const online = started ? rand() > 0.12 : rand() > 0.3;
    const hasAttempt = started && progress > 0;
    return {
      attemptId: hasAttempt ? uuid() : null,
      userId: uuid(),
      displayName: `${student.nom}, ${student.prenom}`,
      pseudonym: pseudonymOf(index),
      state: !hasAttempt
        ? "not_started"
        : progress >= e.items.length
          ? "submitted"
          : "in_progress",
      online,
      lastSeenAt: online ? iso(-2000) : hasAttempt ? iso(-40_000) : null,
      deadlineAt: hasAttempt ? iso(12 * 60_000 + index * 1000) : null,
      timeBonusPercent: student.timeBonusPercent,
      points: null,
      maxPoints,
      cells: e.items.map((item, i) => {
        const status: MockCell["status"] =
          i < progress - 1 ? "done" : i === progress - 1 ? "in_progress" : "empty";
        return {
          itemId: item.id,
          status,
          verdict: null,
          points: null,
          revision: status === "empty" ? 0 : 1 + i,
          summary:
            status === "done" && itemQuestion(item) !== null
              ? summaryOf(itemQuestion(item)!, index + i)
              : null,
        };
      }),
    };
  });
}

function makeEvaluation(
  classroomId: string,
  title: string,
  state: MockEvaluation["state"],
  itemCount: number,
  extra: Partial<MockEvaluation> = {},
): MockEvaluation {
  const e: MockEvaluation = {
    id: uuid(),
    classroomId,
    title,
    mode: "exam",
    state,
    settings: defaultEvaluationSettings(),
    gradingScale: { kind: "linear", rounding: "nearest" },
    feedbackPolicy: {
      when: "on_release",
      showAnswer: true,
      showKey: false,
      showExplanation: false,
      showHiddenCaseNames: true,
      showTeacherComment: true,
    },
    mcqPolicy: "all_or_nothing",
    opensAt: null,
    closesAt: null,
    durationS: 45 * 60,
    accessCode: null,
    ipAllowlist: [],
    startedAt: null,
    pausedAt: null,
    closedAt: null,
    releasedAt: null,
    modifiedAfterRelease: false,
    createdAt: iso(-10 * D),
    items: [],
    rows: [],
    present: 0,
    ...extra,
  };
  e.items = makeItems(itemCount);
  const started =
    state === "running" || state === "paused" || state === "closed" || state === "released";
  e.rows = makeRows(e, started);
  if (state === "closed" || state === "released") {
    // Nothing is in flight once the ticker has closed everything: no
    // countdown keeps running on a finished quiz.
    for (const row of e.rows) {
      if (row.state === "in_progress") row.state = "expired";
      row.deadlineAt = null;
    }
  }
  e.present = e.rows.filter((r) => r.online).length;
  return e;
}

const evaluations: MockEvaluation[] = [];
/** The classroom every seeded evaluation belongs to (`r1`, emptied or not). */
const EVAL_ROOM = "r1";

/*
 * The finished two come first and are seeded UNCONDITIONALLY. They are the
 * ones section 5 grades, and an empty grading queue or an empty results table
 * is a state of a real evaluation, not of a missing one: under `?empty=1` the
 * classroom has no roster, so they simply carry no item and no attempt.
 *
 * Being first also makes them what the state aliases `closed` and `released`
 * resolve to, which is what the screenshot script deep-links to.
 */
evaluations.push(
  makeEvaluation(EVAL_ROOM, "Quiz 0 — prise en main", "closed", 5, {
    startedAt: iso(-20 * D),
    closedAt: iso(-20 * D + H),
  }),
  makeEvaluation(EVAL_ROOM, "Test d'entrée", "released", 6, {
    startedAt: iso(-60 * D),
    closedAt: iso(-60 * D + H),
    releasedAt: iso(-59 * D),
    // Published, then a grading was adjusted: the banner the results page
    // shows when what the students read is no longer what the table says.
    modifiedAfterRelease: true,
  }),
);

function seedEvaluations() {
  const room = rooms[0];
  if (!room) return;
  evaluations.push(
    makeEvaluation(room.id, "Quiz 1 — variables et types", "draft", 4),
    makeEvaluation(room.id, "Quiz 2 — boucles", "scheduled", 6, {
      opensAt: iso(2 * D),
      closesAt: iso(2 * D + H),
    }),
    makeEvaluation(room.id, "Quiz 4 — chaînes", "lobby", 8),
    makeEvaluation(room.id, "Quiz 3 — pointeurs et tableaux", "running", 10, {
      startedAt: iso(-13 * 60_000),
      closesAt: iso(12 * 60_000),
    }),
    makeEvaluation(room.id, "Exercice — allocation dynamique", "paused", 5, {
      mode: "exercise",
      startedAt: iso(-30 * 60_000),
      closesAt: iso(8 * 60_000),
      pausedAt: iso(-60_000),
    }),
  );
}
if (!flags.empty) seedEvaluations();

/** The running evaluation is the one the fake stream keeps moving. */
const runningEvaluation = () => evaluations.find((e) => e.state === "running") ?? null;

/**
 * Mock-only affordance: an evaluation is addressable by its STATE as well as
 * by its id, so `/evaluations/running/live` and `/evaluations/lobby` are
 * stable URLs for the screenshot script and for a quick look. The real API
 * only knows uuids, and so does every id the mock puts on the wire.
 */
const aliased = new Map<string, string>();
const findEvaluation = (key: string): MockEvaluation | null => {
  const byId = evaluations.find((x) => x.id === key);
  if (byId) return byId;
  // An alias is resolved ONCE and then pinned to the evaluation it found.
  // Otherwise pausing `/evaluations/running/live` moves that evaluation out
  // of the `running` state, the next request on the same URL matches nothing,
  // and the dashboard that just issued the command gets a 404 (W17).
  const pinned = aliased.get(key);
  if (pinned !== undefined) return evaluations.find((x) => x.id === pinned) ?? null;
  const byState = evaluations.find((x) => x.state === key) ?? null;
  if (byState) aliased.set(key, byState.id);
  return byState;
};

const evaluationOr404 = (id: string) => {
  const e = findEvaluation(id);
  if (!e) throw new MockError(404, "Evaluation not found");
  return e;
};

const totalPointsOf = (e: MockEvaluation) => e.items.reduce((sum, i) => sum + i.points, 0);
const attemptCountOf = (e: MockEvaluation) => e.rows.filter((r) => r.attemptId !== null).length;

const toEvaluation = (e: MockEvaluation) => ({
  id: e.id,
  classroomId: e.classroomId,
  title: e.title,
  mode: e.mode,
  state: e.state,
  settings: e.settings,
  gradingScale: e.gradingScale,
  feedbackPolicy: e.feedbackPolicy,
  mcqPolicy: e.mcqPolicy,
  opensAt: e.opensAt,
  closesAt: e.closesAt,
  durationS: e.durationS,
  accessCode: e.accessCode,
  ipAllowlist: e.ipAllowlist,
  startedAt: e.startedAt,
  pausedAt: e.pausedAt,
  closedAt: e.closedAt,
  releasedAt: e.releasedAt,
  modifiedAfterRelease: e.modifiedAfterRelease,
  createdAt: e.createdAt,
});

const evaluationSummary = (e: MockEvaluation) => ({
  id: e.id,
  classroomId: e.classroomId,
  title: e.title,
  mode: e.mode,
  state: e.state,
  itemCount: e.items.length,
  totalPoints: totalPointsOf(e),
  attemptCount: attemptCountOf(e),
  opensAt: e.opensAt,
  closesAt: e.closesAt,
  createdAt: e.createdAt,
});

const evaluationDetail = (e: MockEvaluation) => ({
  evaluation: toEvaluation(e),
  items: e.items.map((i) => ({ ...i })),
  totalPoints: totalPointsOf(e),
  staleItems: e.items
    .filter((i) => i.latestVersionNumber !== null && i.latestVersionNumber > i.versionNumber)
    .map((i) => i.id),
  attemptCount: attemptCountOf(e),
  editable: attemptCountOf(e) === 0,
});

const dashboardView = (e: MockEvaluation, includeAnswers: boolean) => {
  const started = e.rows.filter((r) => r.attemptId !== null).length;
  return {
    evaluation: {
      id: e.id,
      state: e.state,
      startedAt: e.startedAt,
      pausedAt: e.pausedAt,
      closesAt: e.closesAt,
      serverNow: iso(0),
    },
    items: e.items.map((i) => ({
      id: i.id,
      position: i.position,
      points: i.points,
      type: i.type,
      internalName: i.internalName,
      milestone: i.milestone,
    })),
    rows: e.rows.map((r) => ({
      ...r,
      cells: r.cells.map((c) => ({ ...c, summary: includeAnswers ? c.summary : null })),
    })),
    totals: e.items.map((item) => {
      const done = e.rows.filter(
        (r) => r.cells.find((c) => c.itemId === item.id)?.status === "done",
      ).length;
      return {
        itemId: item.id,
        completion: started === 0 ? 0 : Math.round((done / started) * 100) / 100,
        successRate: null,
      };
    }),
  };
};

const attemptInspect = (e: MockEvaluation, attemptId: string) => {
  const row = e.rows.find((r) => r.attemptId === attemptId);
  if (!row) throw new MockError(404, "Attempt not found");
  return {
    attempt: {
      id: attemptId,
      userId: row.userId,
      displayName: row.displayName,
      pseudonym: row.pseudonym,
      state: row.state,
      startedAt: e.startedAt,
      deadlineAt: row.deadlineAt,
      submittedAt: row.state === "submitted" ? iso(-60_000) : null,
    },
    items: e.items.flatMap((item, i) => {
      const q = itemQuestion(item);
      if (q === null) return [];
      const cell = row.cells.find((c) => c.itemId === item.id);
      return [{
        item: {
          id: item.id,
          position: item.position,
          points: item.points,
          type: item.type,
          internalName: item.internalName,
        },
        studentConfig: studentConfigOf(q),
        answer: cell && cell.status !== "empty" ? answerOf(q, i) : null,
        revision: cell?.revision ?? 0,
        markedDone: cell?.status === "done",
        solution: solutionOf(q),
      }];
    }),
    events: [{ kind: "visibility" as const, at: iso(-120_000), details: null }],
    serverNow: iso(0),
  };
};

const previewView = (e: MockEvaluation) => ({
  attempt: {
    id: "00000000-0000-4000-8000-0000000000ff",
    state: "in_progress" as const,
    startedAt: iso(0),
    deadlineAt: iso(45 * 60_000),
    lastItemId: null,
    serverNow: iso(0),
    preview: true,
    readOnly: false,
  },
  evaluation: {
    id: e.id,
    title: e.title,
    mode: e.mode,
    state: e.state,
    settings: e.settings,
    feedbackPolicy: e.feedbackPolicy,
    pausedAt: e.pausedAt,
    totalPoints: totalPointsOf(e),
  },
  items: e.items.flatMap((item) => {
    const q = itemQuestion(item);
    if (q === null) return [];
    return [{
      id: item.id,
      position: item.position,
      points: item.points,
      type: item.type,
      milestone: item.milestone,
      student: studentConfigOf(q),
      answer: null,
      revision: 0,
      markedDone: false,
      locked: false,
    }];
  }),
});
// --- Routes: evaluations --------------------------------------------------

on("GET", "/app/api/classrooms/:id/evaluations", (m) =>
  evaluations.filter((e) => e.classroomId === m.groups!.id).map(evaluationSummary),
);
on("POST", "/app/api/classrooms/:id/evaluations", (m, body) => {
  const e = makeEvaluation(
    roomOr404(m.groups!.id!).id,
    String(body.title),
    "draft",
    0,
    {
      mode: (body.mode as MockEvaluation["mode"]) ?? "exam",
      // Seeded from the creator's preference, exactly like `createEvaluation`.
      mcqPolicy: me?.mcqPolicy ?? "all_or_nothing",
    },
  );
  evaluations.push(e);
  return toEvaluation(e);
});
on("GET", "/app/api/evaluations/:id", (m) => evaluationDetail(evaluationOr404(m.groups!.id!)));
on("PATCH", "/app/api/evaluations/:id", (m, body) => {
  const e = evaluationOr404(m.groups!.id!);
  if (typeof body.title === "string") e.title = body.title;
  if (body.settings) e.settings = { ...e.settings, ...(body.settings as object) };
  if (body.feedbackPolicy) {
    e.feedbackPolicy = { ...e.feedbackPolicy, ...(body.feedbackPolicy as object) };
    // W5-18: an exam never stores `immediate`.
    if (e.mode === "exam" && (e.feedbackPolicy as { when: string }).when === "immediate") {
      (e.feedbackPolicy as { when: string }).when = "on_release";
    }
  }
  if (body.gradingScale) e.gradingScale = body.gradingScale as Record<string, unknown>;
  if (body.mcqPolicy) e.mcqPolicy = body.mcqPolicy as McqScorePolicy;
  if ("opensAt" in body) e.opensAt = body.opensAt as string | null;
  if ("closesAt" in body) e.closesAt = body.closesAt as string | null;
  if ("durationS" in body) e.durationS = body.durationS as number | null;
  if ("accessCode" in body) e.accessCode = body.accessCode as string | null;
  return evaluationDetail(e);
});
on("DELETE", "/app/api/evaluations/:id", (m) => {
  const i = evaluations.findIndex((e) => e.id === m.groups!.id);
  if (i >= 0) evaluations.splice(i, 1);
  return undefined;
});
on("POST", "/app/api/evaluations/:id/duplicate", (m, body) => {
  const e = evaluationOr404(m.groups!.id!);
  const copy = makeEvaluation(e.classroomId, String(body.title), "draft", e.items.length, {
    mode: e.mode,
  });
  evaluations.push(copy);
  return toEvaluation(copy);
});
on("POST", "/app/api/evaluations/:id/items/update-versions", (m, body) => {
  const e = evaluationOr404(m.groups!.id!);
  const ids = (body.itemIds as string[] | undefined) ?? null;
  for (const item of e.items) {
    if (ids !== null && !ids.includes(item.id)) continue;
    if (item.latestVersionNumber !== null) item.versionNumber = item.latestVersionNumber;
  }
  return e.items.map((i) => ({ ...i }));
});
on("POST", "/app/api/evaluations/:id/items", (m, body) => {
  const e = evaluationOr404(m.groups!.id!);
  for (const questionId of (body.questionIds as string[] | undefined) ?? []) {
    const q = questions.find((x) => x.id === questionId);
    const latest = q?.versions.at(-1);
    // A question that was never published cannot be added: the picker shows
    // it disabled, and the API refuses it too (F-EVAL-03).
    if (!q || !latest) continue;
    e.items.push({
      id: uuid(),
      position: e.items.length + 1,
      points: q.type === "code" ? 3 : 1,
      milestone: false,
      questionId: q.id,
      questionVersionId: uuid(),
      type: q.type,
      internalName: q.internalName,
      versionNumber: latest.number,
      latestVersionNumber: latest.number,
      deprecated: latest.deprecatedAt !== null,
    });
  }
  return e.items.map((i) => ({ ...i }));
});
on("PATCH", "/app/api/evaluations/:id/items/:itemId", (m, body) => {
  const e = evaluationOr404(m.groups!.id!);
  const item = e.items.find((i) => i.id === m.groups!.itemId);
  if (!item) throw new MockError(404, "Item not found");
  if (typeof body.points === "number") item.points = body.points;
  if (typeof body.milestone === "boolean") item.milestone = body.milestone;
  return { ...item };
});
on("PUT", "/app/api/evaluations/:id/items/order", (m, body) => {
  const e = evaluationOr404(m.groups!.id!);
  const order = (body.itemIds as string[]) ?? [];
  e.items.sort((a, b) => order.indexOf(a.id) - order.indexOf(b.id));
  e.items.forEach((i, index) => (i.position = index + 1));
  return e.items.map((i) => ({ ...i }));
});
on("DELETE", "/app/api/evaluations/:id/items/:itemId", (m) => {
  const e = evaluationOr404(m.groups!.id!);
  e.items = e.items.filter((i) => i.id !== m.groups!.itemId);
  e.items.forEach((i, index) => (i.position = index + 1));
  return undefined;
});
on("POST", "/app/api/evaluations/:id/state", (m, body) => {
  const e = evaluationOr404(m.groups!.id!);
  e.state = body.to as MockEvaluation["state"];
  return toEvaluation(e);
});
on("POST", "/app/api/evaluations/:id/preview", (m) => previewView(evaluationOr404(m.groups!.id!)));

// --- Routes: the teacher's controls on a live evaluation -------------------

on("GET", "/app/api/evaluations/:id/dashboard", (m, _b, url) =>
  dashboardView(evaluationOr404(m.groups!.id!), url.searchParams.get("includeAnswers") === "1"),
);
on("POST", "/app/api/evaluations/:id/start", (m) => {
  const e = evaluationOr404(m.groups!.id!);
  e.state = "running";
  e.startedAt = iso(0);
  e.closesAt = iso((e.durationS ?? 2700) * 1000);
  e.rows = makeRows(e, true);
  return toEvaluation(e);
});
on("POST", "/app/api/evaluations/:id/pause", (m) => {
  const e = evaluationOr404(m.groups!.id!);
  e.state = "paused";
  e.pausedAt = iso(0);
  return toEvaluation(e);
});
on("POST", "/app/api/evaluations/:id/resume", (m) => {
  const e = evaluationOr404(m.groups!.id!);
  e.state = "running";
  e.pausedAt = null;
  return toEvaluation(e);
});
on("POST", "/app/api/evaluations/:id/close", (m) => {
  const e = evaluationOr404(m.groups!.id!);
  e.state = "closed";
  e.closedAt = iso(0);
  for (const row of e.rows) {
    if (row.state === "in_progress") row.state = "expired";
  }
  return toEvaluation(e);
});
on("POST", "/app/api/evaluations/:id/extend", (m, body) => {
  const e = evaluationOr404(m.groups!.id!);
  const ms = Number(body.minutes ?? 5) * 60_000;
  const target = body.scope === "attempt" ? String(body.attemptId) : null;
  let updated = 0;
  for (const row of e.rows) {
    if (row.deadlineAt === null) continue;
    if (target !== null && row.attemptId !== target) continue;
    row.deadlineAt = new Date(Date.parse(row.deadlineAt) + ms).toISOString();
    updated += 1;
  }
  if (target === null && e.closesAt) {
    e.closesAt = new Date(Date.parse(e.closesAt) + ms).toISOString();
  }
  return { updated, serverNow: iso(0) };
});
on("GET", "/app/api/evaluations/:id/attempts/:attemptId", (m) =>
  attemptInspect(evaluationOr404(m.groups!.id!), m.groups!.attemptId!),
);
on("POST", "/app/api/evaluations/:id/attempts/:attemptId/close", (m) => {
  const e = evaluationOr404(m.groups!.id!);
  const row = e.rows.find((r) => r.attemptId === m.groups!.attemptId);
  if (row) row.state = "expired";
  return { state: row?.state ?? "expired", serverNow: iso(0) };
});
on("POST", "/app/api/evaluations/:id/attempts/:attemptId/reopen", (m) => {
  const e = evaluationOr404(m.groups!.id!);
  const row = e.rows.find((r) => r.attemptId === m.groups!.attemptId);
  if (row) {
    row.state = "in_progress";
    row.deadlineAt = iso(10 * 60_000);
  }
  return { state: "in_progress", deadlineAt: row?.deadlineAt ?? null, serverNow: iso(0) };
});

// --- 4. The student: home, lobby and player (WP9) --------------------------
//
// The student persona's scenes: a home with three evaluations, the lobby, a
// running attempt holding one question of every MVP type, a pause and a
// closure. `?scene=` (read in section 0) picks which one the fake backend
// serves:
//
//   ?scene=lobby | running | paused | closed | extend   (running by default)
//
// `extend` is the teacher granting time: the fake stream pushes an
// `attempt.deadline` four seconds in, which is the only way to see the
// countdown jump without a backend.
//
// This one evaluation is NOT one of section 3's: it is the student's side of
// the story, with its own uuid, its own attempt and payloads written by hand
// rather than derived from a pool question — the player is the only screen
// that shows all four types at once, and the four are chosen to be read side
// by side. The teacher's evaluations stay addressable at the same time, so
// `/evaluations/running/live` and `/take/1111…` both work in one browser.
const STUDENT_EVAL = "11111111-1111-4111-8111-111111111111";
const STUDENT_EVAL_NEXT = "11111111-1111-4111-8111-111111111112";
const STUDENT_EVAL_PAST = "11111111-1111-4111-8111-111111111113";
const STUDENT_ATTEMPT = "22222222-2222-4222-8222-222222222222";
const STUDENT_PAST_ATTEMPT = "22222222-2222-4222-8222-222222222223";
const studentItem = (n: number) => `aaaaaaaa-0000-4000-8000-00000000000${n}`;

/** The evaluation's state follows the scene; everything else is fixed. */
const studentEvaluationState = () =>
  scene === "lobby"
    ? ("lobby" as const)
    : scene === "paused"
      ? ("paused" as const)
      : ("running" as const);

/** One question of each MVP type, in French, as `toStudent` would publish it. */
const studentPayloads: Record<number, unknown> = {
  // The mcq whose choices hold a FENCED BLOCK, which is what the rich editor
  // can now write into one (markdown/tiptap.ts): a lead line and a snippet,
  // rendered by `MarkdownView` inside the label of the choice.
  1: {
    prompt: "Quel extrait affiche **l'adresse** de la variable `x` ?",
    mode: "single",
    choices: [
      { id: 0, text: 'Avec l\'opérateur d\'adresse :\n\n```c\nprintf("%p\\n", (void *)&x);\n```' },
      { id: 1, text: 'Avec l\'opérateur d\'indirection :\n\n```c\nprintf("%p\\n", (void *)*x);\n```' },
      { id: 2, text: 'En convertissant la valeur :\n\n```c\nprintf("%p\\n", (void *)x);\n```' },
      { id: 3, text: 'Avec une fonction de la bibliothèque :\n\n```c\nprintf("%p\\n", addr(x));\n```' },
    ],
  },
  /*
   * Built by the REAL domain functions from a real config, sets included,
   * rather than written out by hand: the dropdown of a PREDEFINED CHOICE SET
   * — the one in the table cell, where `{{=a|b}}` cannot go — has to reach
   * the player exactly as `{{=a|b|c}}` does, and a literal payload could not
   * show that it does.
   */
  2: clozeStudentTemplate(
    parseCloze(
      "Complétez la phrase. L'orthographe des noms propres n'est pas notée.\n\n" +
        "La loi d'{{Ohm|ohm}} relie la tension et le courant : pour un conducteur ohmique, " +
        "U = {{R|la résistance}} × I, où la tension U s'exprime en {{=volts|ampères|ohms|watts}}.\n\n" +
        "| Grandeur | Unité |\n" +
        "| --- | --- |\n" +
        "| Résistance | {{1}} |\n" +
        "| Courant | {{2}} |",
      [
        {
          key: "1",
          options: [
            { label: "ohms", correct: true },
            { label: "volts", correct: false },
            { label: "ampères", correct: false },
          ],
        },
        {
          key: "2",
          options: [
            { label: "ohms", correct: false },
            { label: "volts", correct: false },
            { label: "ampères", correct: true },
          ],
        },
      ],
    ),
    0,
    "student-item-2",
    false,
  ),
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
const studentAnswers = new Map<string, { payload: unknown; revision: number; done: boolean }>();
let studentPosition: string | null = studentItem(1);
const BASE_DEADLINE = now + 14 * 60_000 + 32_000;
let studentDeadline = BASE_DEADLINE;

const studentAttemptView = (): AttemptView => ({
  attempt: {
    id: STUDENT_ATTEMPT,
    // `closed` is the deadline case of F-LIVE-07: the server expired the
    // attempt while the evaluation itself is still running for the others.
    state: scene === "closed" ? "expired" : "in_progress",
    startedAt: iso(-6 * 60_000),
    deadlineAt: new Date(studentDeadline).toISOString(),
    lastItemId: studentPosition,
    serverNow: new Date().toISOString(),
    preview: false,
    readOnly: scene === "closed",
  },
  evaluation: {
    id: STUDENT_EVAL,
    title: "Quiz 3 — Pointeurs et lois fondamentales",
    mode: "exam",
    state: studentEvaluationState(),
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
    pausedAt: scene === "paused" ? iso(-30_000) : null,
    totalPoints: 10,
  },
  items: [1, 2, 3, 4].map((n) => {
    const stored = studentAnswers.get(studentItem(n));
    return {
      id: studentItem(n),
      position: n,
      points: n === 4 ? 5 : n === 3 ? 1 : 2,
      type: n === 1 ? "mcq" : n === 2 ? "cloze" : n === 3 ? "short" : "code",
      milestone: n === 3,
      student: studentPayloads[n],
      answer: stored?.payload ?? null,
      revision: stored?.revision ?? 0,
      markedDone: stored?.done ?? false,
      locked: false,
    };
  }),
});

const studentLobbyView = (): LobbyView => ({
  evaluation: {
    id: STUDENT_EVAL,
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
        id: STUDENT_EVAL,
        title: "Quiz 3 — Pointeurs et lois fondamentales",
        mode: "exam",
        state: studentEvaluationState(),
        ...room,
        opensAt: iso(-6 * 60_000),
        closesAt: iso(14 * 60_000),
        durationS: 20 * 60,
        attemptId: scene === "lobby" ? null : STUDENT_ATTEMPT,
        attemptState: scene === "lobby" ? null : "in_progress",
        grade: null,
        deadlineAt: scene === "lobby" ? null : new Date(studentDeadline).toISOString(),
      },
    ],
    upcoming: [
      {
        id: STUDENT_EVAL_NEXT,
        title: "Série 4 — Récursivité",
        mode: "exercise",
        state: "scheduled",
        ...room,
        opensAt: iso(3 * D),
        closesAt: iso(7 * D),
        durationS: null,
        attemptId: null,
        attemptState: null,
        grade: null,
        deadlineAt: null,
      },
    ],
    past: [
      {
        id: STUDENT_EVAL_PAST,
        title: "Quiz 2 — Tableaux et chaînes",
        mode: "exam",
        state: "released",
        ...room,
        opensAt: iso(-8 * D),
        closesAt: iso(-8 * D + 20 * 60_000),
        durationS: 20 * 60,
        attemptId: STUDENT_PAST_ATTEMPT,
        attemptState: "submitted",
        grade: null,
        deadlineAt: null,
      },
    ],
    serverNow: new Date().toISOString(),
  };
});

on("POST", "/app/api/evaluations/:id/attempt", () =>
  scene === "lobby"
    ? { kind: "lobby", view: studentLobbyView() }
    : { kind: "attempt", view: studentAttemptView() },
);

// Like the API: the lobby until the evaluation starts, the attempt after.
on("GET", "/app/api/attempts/:id", () =>
  scene === "lobby"
    ? { kind: "lobby", view: studentLobbyView() }
    : { kind: "attempt", view: studentAttemptView() },
);

on("PUT", "/app/api/attempts/:id/answers/:itemId", (m, body): AutosaveResponse => {
  const itemId = m.groups!.itemId!;
  const revision = Number(body.revision ?? 1);
  const stored = studentAnswers.get(itemId);
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
  studentAnswers.set(itemId, { payload: body.payload, revision, done: stored?.done ?? false });
  return { revision, accepted: true, serverNow: new Date().toISOString() };
});

on("POST", "/app/api/attempts/:id/answers/:itemId/done", (m, body) => {
  const itemId = m.groups!.itemId!;
  const stored = studentAnswers.get(itemId) ?? { payload: null, revision: 0, done: false };
  const done = body.done === true;
  studentAnswers.set(itemId, { ...stored, done });
  return { done, nextItemId: null, serverNow: new Date().toISOString() };
});

on("POST", "/app/api/attempts/:id/position", (_m, body) => {
  studentPosition = String(body.itemId);
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
// --- 5. Grading, results and the student's feedback (WP10) ----------------
//
// The second half of an evaluation's life, layered on top of section 3 rather
// than beside it: a GRADING WORLD is derived from one evaluation of that
// section — its items, its dashboard rows — and holds what the first half has
// no use for, the answers handed in and the chain of gradings on each cell.
//
// Two of them, so both halves of the story are reachable: the `closed`
// evaluation is still being graded (proposals waiting, a few cells the runner
// never settled), and the `released` one is published and fully validated.
// Because the ids are the evaluation's own, `/evaluations/<id>/grading` opened
// from the classroom list is the same screen as the one the panel links to.
//
// The gradings are generated from a per-student ability so the histogram and
// the per-question success rates look like a real class rather than a uniform
// cloud, and the answers go through the SAME `tryAnswer` the try panel uses,
// so what the panel renders is what the type would really have produced.
//
// Scene flags: `empty` leaves the two evaluations with no item and no attempt
// at all (the empty queue and the empty results table), `many` grows the
// class with the classroom's roster.

interface MockEvalItem {
  id: string;
  position: number;
  questionId: string;
  internalName: string;
  type: string;
  points: number;
}

interface MockAttempt {
  id: string;
  userId: string;
  displayName: string;
  lastName: string;
  firstName: string;
  email: string;
  pseudonym: string;
  state: "submitted" | "expired";
  durationS: number;
  ability: number;
}

interface MockGrading {
  id: string;
  answerId: string | null;
  attemptId: string;
  itemId: string;
  points: number;
  maxPoints: number;
  source: "auto" | "llm" | "manual";
  state: "proposed" | "validated" | "superseded";
  details: unknown;
  confidence: "low" | "medium" | "high" | null;
  comment: string | null;
  gradedBy: string | null;
  gradedAt: string;
  supersedesId: string | null;
  regradeNote: string | null;
}

interface MockGradingWorld {
  /** The evaluation of section 3 this is the second half of. */
  evaluation: MockEvaluation;
  items: MockEvalItem[];
  attempts: MockAttempt[];
  /** `attemptId:itemId` -> what the student handed in (absent when blank). */
  answers: Map<string, unknown>;
  /** `attemptId:itemId` -> the chain, oldest first, at most one standing. */
  gradings: Map<string, MockGrading[]>;
}

const cellKey = (attemptId: string, itemId: string) => `${attemptId}:${itemId}`;

/** The published configuration of a mock question (its latest version). */
function publishedConfig(q: MockQuestion): Record<string, unknown> {
  return q.versions.at(-1)?.config ?? q.draft.config;
}

/** The answer a student of the given ability would have handed in. */
function mockAnswer(q: MockQuestion, config: Record<string, unknown>, ability: number): unknown {
  if (q.type === "mcq") {
    const choices = (config.choices ?? []) as { text: string; correct: boolean }[];
    const right = choices.findIndex((c) => c.correct);
    const wrong = choices.findIndex((c) => !c.correct);
    return { selected: [rand() < ability ? right : wrong] };
  }
  if (q.type === "short") {
    return { text: rand() < ability ? "8" : pick(["4", "64", "16"]) };
  }
  if (q.type === "cloze") {
    const parse = parseCloze(String(config.text ?? ""), clozeSets(config));
    return {
      blanks: parse.blanks.map((blank) => {
        const good = rand() < ability;
        switch (blank.kind) {
          case "select":
            return String(good ? (blank.correct[0] ?? 0) : ((blank.correct[0] ?? 0) + 1) % Math.max(1, blank.options.length));
          case "number":
            return String(good ? blank.value : blank.value + 1);
          case "regex":
            return good ? "int" : "float";
          default:
            return good ? (blank.answers[0] ?? "") : "delete";
        }
      }),
    };
  }
  const good = rand() < ability;
  return {
    regions: [
      good
        ? "    int s = 0;\n    for (const int *p = t; p < t + n; p++) s += *p;\n    return s;\n"
        : "    int s = 0;\n    for (size_t i = 0; i <= n; i++) s += t[i];\n    return s;\n",
    ],
    lastRun: null,
  };
}

/** `code` never reaches a runner here, so its case-by-case detail is built. */
function mockCodeDetails(config: Record<string, unknown>, ability: number) {
  const cases = ((config.tests as { cases?: CodeCaseLike[] })?.cases ?? []) as CodeCaseLike[];
  const results = cases.map((c) => {
    const ok = rand() < ability;
    return {
      name: c.name,
      visible: c.visible,
      points: c.points,
      ok,
      exitCode: 0,
      ms: 12 + Math.round(rand() * 40),
      timedOut: false,
      oom: false,
      expected: c.expected,
      actual: ok ? c.expected : "0",
      stderr: "",
    };
  });
  const earned = results.reduce((s, c) => (c.ok ? s + c.points : s), 0);
  const total = results.reduce((s, c) => s + c.points, 0) || 1;
  return {
    details: {
      runner: "ok",
      compile: { ok: true, stderr: "", ms: 180 },
      cases: results,
      earned,
      total,
      sourceSha256: "0".repeat(64),
    },
    fraction: earned / total,
    solution: {
      referenceSolution: String(config.referenceSolution ?? ""),
      cases: cases.map((c) => ({
        name: c.name,
        stdin: c.stdin,
        expected: c.expected,
        points: c.points,
        visible: c.visible,
      })),
      compare: (config.tests as { compare?: unknown })?.compare ?? {},
    },
  };
}

/**
 * Half a point is the finest grain a teacher grades at, and it keeps the
 * table free of the 7.01 a chain of fractions produces.
 */
const halfPoints = (n: number) => Math.round(n * 2) / 2;

let gradingSeq = 0;

/**
 * The grading world of one evaluation of section 3.
 *
 * It is DERIVED from that evaluation, never parallel to it: the items are its
 * items and the attempts are its dashboard rows, so an id that works in
 * `/evaluations/<id>` works in `/evaluations/<id>/grading` too, and the queue
 * grades the very questions the configuration screen lists.
 */
function buildGradingWorld(
  evaluation: MockEvaluation,
  options: { allValidated: boolean; pinnedAttemptId?: string },
): MockGradingWorld {
  const items: MockEvalItem[] = evaluation.items
    .filter((i) => questions.some((q) => q.id === i.questionId))
    .map((i) => ({
      id: i.id,
      position: i.position,
      questionId: i.questionId,
      internalName: i.internalName,
      type: i.type,
      points: i.points,
    }));

  // One attempt per dashboard row that has one. A row without an attempt is a
  // student who never opened it, and stays one: the results table lists them
  // as absent (deviation W6-10) instead of inventing a second class.
  const roster = classroomRoster(evaluation.classroomId);
  const attempts: MockAttempt[] = [];
  evaluation.rows.forEach((row, index) => {
    if (row.attemptId === null) return;
    // The student persona's own attempt is pinned on the first row, so the
    // `past` card of their home and the player's finished screen link to a
    // feedback page that really exists — on the very evaluation the teacher
    // is grading two tabs away.
    if (attempts.length === 0 && options.pinnedAttemptId) row.attemptId = options.pinnedAttemptId;
    const student = roster[index];
    attempts.push({
      id: row.attemptId,
      userId: row.userId,
      displayName: row.displayName,
      lastName: student?.nom ?? row.displayName,
      firstName: student?.prenom ?? "",
      email: student?.email ?? "",
      pseudonym: row.pseudonym,
      state: row.state === "submitted" ? "submitted" : "expired",
      durationS: 600 + Math.round(rand() * 1500),
      // A class, not a cloud: a few who have it, a few who do not, most in
      // between. The histogram below is the point of the spread.
      ability: Math.min(0.98, Math.max(0.1, 0.4 + rand() * 0.55)),
    });
  });

  const answers = new Map<string, unknown>();
  const gradings = new Map<string, MockGrading[]>();

  attempts.forEach((attempt, attemptIndex) => {
    items.forEach((item, itemIndex) => {
      const q = questions.find((x) => x.id === item.questionId)!;
      const config = publishedConfig(q);
      const key = cellKey(attempt.id, item.id);
      // Two students in thirty left this question untouched.
      const blank = rand() < 0.06;
      const answer = blank ? null : mockAnswer(q, config, attempt.ability);
      const answerId = blank ? null : `${key}-ans`;
      if (!blank) answers.set(key, answer);

      let points: number;
      let details: unknown;
      let source: MockGrading["source"] = "auto";
      let state: MockGrading["state"] = "validated";
      let confidence: MockGrading["confidence"] = null;
      let comment: string | null = null;

      if (blank) {
        points = 0;
        details = null;
      } else if (q.type === "code") {
        const built = mockCodeDetails(config, attempt.ability);
        points = halfPoints(built.fraction * item.points);
        details = built.details;
      } else {
        const graded = tryAnswer(q, config, answer, evaluation.mcqPolicy) as {
          points: number;
          details: unknown;
        };
        points = halfPoints(graded.points * item.points);
        details = graded.details;
      }

      // `code` needs the teacher's eyes in the MVP (the stub runner cannot
      // settle it on its own), and every fourth answer of the two longest
      // questions is still a proposal waiting to be validated.
      if (!options.allValidated && !blank) {
        const proposeRate = q.type === "code" ? 0.55 : itemIndex >= items.length - 2 ? 0.3 : 0.08;
        if (rand() < proposeRate) {
          state = "proposed";
          confidence = pick(["high", "high", "medium", "low"]);
          if (q.type === "code") comment = "runner_unavailable";
        }
      }

      // One cell in twenty carries the teacher's own grading, with the
      // comment F-GRADE-05 makes mandatory and the grading it replaced.
      const history: MockGrading[] = [];
      const id0 = `g${(gradingSeq += 1)}`;
      const base: MockGrading = {
        id: id0,
        answerId,
        attemptId: attempt.id,
        itemId: item.id,
        points,
        maxPoints: item.points,
        source,
        state,
        details,
        confidence,
        comment,
        gradedBy: null,
        gradedAt: iso(-2 * H + attemptIndex * 1000),
        supersedesId: null,
        regradeNote: null,
      };

      if (!blank && rand() < 0.05) {
        const bumped = Math.min(item.points, Math.round((points + 1) * 100) / 100);
        history.push({ ...base, state: "superseded" });
        history.push({
          ...base,
          id: `g${(gradingSeq += 1)}`,
          points: bumped,
          source: "manual",
          state: "validated",
          confidence: null,
          comment: "Le raisonnement est juste, la notation attendue était trop stricte.",
          gradedBy: "u-me",
          gradedAt: iso(-30 * 60_000 + attemptIndex * 1000),
          supersedesId: id0,
        });
      } else {
        history.push(base);
      }

      // Runner-pending: no standing grading at all, so the panel shows the
      // cell as still waiting (the `pending` verdict).
      if (!options.allValidated && q.type === "code" && rand() < 0.1) {
        gradings.set(key, []);
        return;
      }
      gradings.set(key, history);
    });
  });

  return { evaluation, items, attempts, answers, gradings };
}

/**
 * The two graded evaluations, keyed on the very evaluations of section 3 that
 * the classroom list shows as `closed` and `released` — there is ONE set of
 * evaluations in this mock, and this is the second half of two of them.
 */
const gradingWorlds: MockGradingWorld[] = [];
{
  const closed = evaluations.find((e) => e.state === "closed");
  const released = evaluations.find((e) => e.state === "released");
  if (closed)
    gradingWorlds.push(
      buildGradingWorld(closed, { allValidated: false, pinnedAttemptId: STUDENT_ATTEMPT }),
    );
  if (released)
    gradingWorlds.push(
      buildGradingWorld(released, { allValidated: true, pinnedAttemptId: STUDENT_PAST_ATTEMPT }),
    );
}

/** Resolves an id OR a state alias (section 3), then its grading world. */
const gradingWorldOr404 = (key: string): MockGradingWorld => {
  const evaluation = evaluationOr404(key);
  const world = gradingWorlds.find((w) => w.evaluation.id === evaluation.id);
  if (!world) throw new MockError(404, "Evaluation not graded");
  return world;
};

/** The grading that counts, or `null` while the pass has not settled the cell. */
function standingGrading(e: MockGradingWorld, attemptId: string, itemId: string): MockGrading | null {
  const chain = e.gradings.get(cellKey(attemptId, itemId)) ?? [];
  return chain.find((g) => g.state !== "superseded") ?? null;
}

const gradedTotalPointsOf = (e: MockGradingWorld) => e.items.reduce((s, i) => s + i.points, 0);

function gradeOf(points: number, total: number): number {
  return total <= 0 ? 1 : Math.min(6, Math.max(1, Math.round((1 + (5 * points) / total) * 10) / 10));
}

function attemptPoints(e: MockGradingWorld, attemptId: string): { points: number; perItem: Record<string, number> } {
  const perItem: Record<string, number> = {};
  let points = 0;
  for (const item of e.items) {
    const g = standingGrading(e, attemptId, item.id);
    if (g && g.state === "validated") {
      perItem[item.id] = g.points;
      points += g.points;
    }
  }
  return { points: Math.round(points * 100) / 100, perItem };
}

function gradingEntry(e: MockGradingWorld, attempt: MockAttempt, item: MockEvalItem, anonymous: boolean) {
  const q = questions.find((x) => x.id === item.questionId)!;
  const config = publishedConfig(q);
  const key = cellKey(attempt.id, item.id);
  const answer = e.answers.get(key) ?? null;
  const grading = standingGrading(e, attempt.id, item.id);
  const chain = e.gradings.get(key) ?? [];
  const solution =
    q.type === "code"
      ? mockCodeDetails(config, 1).solution
      : (tryAnswer(q, config, answer, e.evaluation.mcqPolicy) as { solution?: unknown }).solution ??
        null;
  return {
    answerId: answer === null ? null : `${key}-ans`,
    attemptId: attempt.id,
    itemId: item.id,
    label: anonymous ? attempt.pseudonym : attempt.displayName,
    answer,
    student: studentView(q, config),
    solution,
    grading,
    history: [...chain]
      .reverse()
      .map((g) => ({
        id: g.id,
        points: g.points,
        maxPoints: g.maxPoints,
        source: g.source,
        state: g.state,
        gradedAt: g.gradedAt,
        comment: g.comment,
        regradeNote: g.regradeNote,
      })),
  };
}

on("GET", "/app/api/evaluations/:id/grading", (m, _body, url) => {
  const e = gradingWorldOr404(m.groups!.id!);
  const by = url.searchParams.get("by") === "student" ? "student" : "question";
  const itemId = url.searchParams.get("itemId");
  const attemptId = url.searchParams.get("attemptId");
  const state = url.searchParams.get("state");
  const anonymous = url.searchParams.get("anonymous") !== "0";
  const items = itemId ? e.items.filter((i) => i.id === itemId) : e.items;
  const attempts = attemptId ? e.attempts.filter((a) => a.id === attemptId) : e.attempts;
  const pairs =
    by === "student"
      ? attempts.flatMap((a) => items.map((i) => ({ a, i })))
      : items.flatMap((i) => attempts.map((a) => ({ a, i })));

  const entries = pairs
    .map(({ a, i }) => gradingEntry(e, a, i, anonymous))
    .filter((entry) => !state || entry.grading?.state === state);

  let validated = 0;
  let proposed = 0;
  for (const { a, i } of pairs) {
    const g = standingGrading(e, a.id, i.id);
    if (g?.state === "validated") validated += 1;
    else if (g?.state === "proposed") proposed += 1;
  }
  return {
    order: by,
    items: items.map((i) => ({
      id: i.id,
      position: i.position,
      internalName: i.internalName,
      type: i.type,
      points: i.points,
    })),
    entries,
    counts: {
      total: pairs.length,
      validated,
      proposed,
      missing: pairs.length - validated - proposed,
    },
  };
});

on("GET", "/app/api/evaluations/:id/grading/progress", (m) => {
  const e = gradingWorldOr404(m.groups!.id!);
  const total = e.attempts.length * e.items.length;
  let done = 0;
  for (const a of e.attempts) {
    for (const i of e.items) if (standingGrading(e, a.id, i.id)) done += 1;
  }
  return { done, total, pending: { runner: total - done, llm: 0 }, failed: 0 };
});

on("POST", "/app/api/evaluations/:id/grading/run", (m) => {
  const e = gradingWorldOr404(m.groups!.id!);
  // The pass settles every cell it left pending, exactly as the real one does.
  for (const a of e.attempts) {
    for (const i of e.items) {
      const key = cellKey(a.id, i.id);
      if ((e.gradings.get(key) ?? []).length > 0) continue;
      const q = questions.find((x) => x.id === i.questionId)!;
      const built = mockCodeDetails(publishedConfig(q), a.ability);
      e.gradings.set(key, [
        {
          id: `g${(gradingSeq += 1)}`,
          answerId: `${key}-ans`,
          attemptId: a.id,
          itemId: i.id,
          points: halfPoints(built.fraction * i.points),
          maxPoints: i.points,
          source: "auto",
          state: "proposed",
          details: built.details,
          confidence: "medium",
          comment: null,
          gradedBy: null,
          gradedAt: iso(0),
          supersedesId: null,
          regradeNote: null,
        },
      ]);
    }
  }
  return { evaluationId: e.evaluation.id, itemIds: e.items.map((i) => i.id), queued: false };
});

function validateChain(e: MockGradingWorld, g: MockGrading) {
  g.state = "validated";
  e.evaluation.modifiedAfterRelease = e.evaluation.releasedAt !== null ? true : e.evaluation.modifiedAfterRelease;
  return g;
}

on("POST", "/app/api/gradings/:id/validate", (m) => {
  for (const e of gradingWorlds) {
    for (const chain of e.gradings.values()) {
      const g = chain.find((x) => x.id === m.groups!.id);
      if (g) return validateChain(e, g);
    }
  }
  throw new MockError(404, "Grading not found");
});

function overrideCell(e: MockGradingWorld, g: MockGrading, body: Record<string, unknown>) {
  const chain = e.gradings.get(cellKey(g.attemptId, g.itemId))!;
  g.state = "superseded";
  const next: MockGrading = {
    ...g,
    id: `g${(gradingSeq += 1)}`,
    points: Number(body.points ?? 0),
    source: "manual",
    state: "validated",
    confidence: null,
    comment: String(body.comment ?? ""),
    gradedBy: "u-me",
    gradedAt: iso(0),
    supersedesId: g.id,
  };
  chain.push(next);
  if (e.evaluation.releasedAt !== null) e.evaluation.modifiedAfterRelease = true;
  return next;
}

on("POST", "/app/api/gradings/:id/override", (m, body) => {
  for (const e of gradingWorlds) {
    for (const chain of e.gradings.values()) {
      const g = chain.find((x) => x.id === m.groups!.id && x.state !== "superseded");
      if (g) return overrideCell(e, g, body);
    }
  }
  throw new MockError(404, "Grading not found");
});

on("POST", "/app/api/answers/:answerId/gradings", (m, body) => {
  const key = String(m.groups!.answerId).replace(/-ans$/, "");
  for (const e of gradingWorlds) {
    const chain = e.gradings.get(key);
    const g = chain?.find((x) => x.state !== "superseded");
    if (g) return overrideCell(e, g, body);
  }
  throw new MockError(404, "Answer not found");
});

on("POST", "/app/api/evaluations/:id/grading/validate-batch", (m, body) => {
  const e = gradingWorldOr404(m.groups!.id!);
  let validated = 0;
  for (const [key, chain] of e.gradings) {
    const g = chain.find((x) => x.state === "proposed");
    if (!g) continue;
    if (body.itemId && !key.endsWith(`:${String(body.itemId)}`)) continue;
    if (body.source && g.source !== body.source) continue;
    if (body.confidence && g.confidence !== body.confidence) continue;
    validateChain(e, g);
    validated += 1;
  }
  return { validated };
});

on("POST", "/app/api/evaluations/:id/items/:itemId/regrade", (m, body) => {
  const e = gradingWorldOr404(m.groups!.id!);
  const itemId = String(m.groups!.itemId);
  const note = String(body.note ?? "");
  for (const [key, chain] of e.gradings) {
    if (!key.endsWith(`:${itemId}`)) continue;
    const standing = chain.find((x) => x.state !== "superseded");
    if (!standing) continue;
    standing.state = "superseded";
    chain.push({
      ...standing,
      id: `g${(gradingSeq += 1)}`,
      source: "auto",
      state: "proposed",
      confidence: "medium",
      comment: null,
      gradedBy: null,
      gradedAt: iso(0),
      supersedesId: standing.id,
      regradeNote: note,
    });
  }
  if (e.evaluation.releasedAt !== null) e.evaluation.modifiedAfterRelease = true;
  return { evaluationId: e.evaluation.id, itemIds: [itemId], queued: false };
});

function resultsView(e: MockGradingWorld) {
  const total = gradedTotalPointsOf(e);
  const rows = e.attempts.map((a) => {
    const { points, perItem } = attemptPoints(e, a.id);
    return {
      userId: a.userId,
      displayName: a.displayName,
      lastName: a.lastName,
      firstName: a.firstName,
      email: a.email,
      attemptId: a.id,
      perItem,
      points,
      grade: gradeOf(points, total),
      durationS: a.durationS,
      state: a.state,
    };
  });
  // The students who never opened it: a 1.0 that belongs in the table and in
  // the statistics (deviation W6-10). They are the dashboard rows without an
  // attempt, so the absent count of the results matches the live grid's.
  const roster = classroomRoster(e.evaluation.classroomId);
  e.evaluation.rows.forEach((row, index) => {
    if (row.attemptId !== null) return;
    const student = roster[index];
    rows.push({
      userId: row.userId,
      displayName: row.displayName,
      lastName: student?.nom ?? row.displayName,
      firstName: student?.prenom ?? "",
      email: student?.email ?? "",
      attemptId: null as unknown as string,
      perItem: {},
      points: 0,
      grade: 1,
      durationS: null as unknown as number,
      state: "absent" as MockAttempt["state"],
    });
  });
  const grades = rows.map((r) => r.grade);
  const stats = describe(grades);
  return {
    evaluationId: e.evaluation.id,
    title: e.evaluation.title,
    totalPoints: total,
    scale: { kind: "linear", rounding: "nearest" },
    released: e.evaluation.releasedAt !== null,
    releasedAt: e.evaluation.releasedAt,
    modifiedAfterRelease: e.evaluation.modifiedAfterRelease,
    items: e.items.map((i) => {
      const scores = e.attempts
        .map((a) => standingGrading(e, a.id, i.id))
        .filter((g): g is MockGrading => g !== null && g.state === "validated");
      return {
        id: i.id,
        position: i.position,
        internalName: i.internalName,
        type: i.type,
        points: i.points,
        successRate:
          scores.length === 0
            ? null
            : Math.round((scores.reduce((s, g) => s + g.points / g.maxPoints, 0) / scores.length) * 100) / 100,
      };
    }),
    rows,
    stats: { ...stats, histogram: histogram(grades) },
  };
}

on("GET", "/app/api/evaluations/:id/results", (m) => resultsView(gradingWorldOr404(m.groups!.id!)));

on("GET", "/app/api/evaluations/:id/results/by-question", (m) => {
  const e = gradingWorldOr404(m.groups!.id!);
  const view = resultsView(e);
  return e.items.map((item, index) => {
    const q = questions.find((x) => x.id === item.questionId)!;
    const config = publishedConfig(q);
    const given = e.attempts
      .map((a) => e.answers.get(cellKey(a.id, item.id)))
      .filter((x) => x !== undefined);
    let distribution: { key: string; label: string; count: number; correct: boolean | null }[] = [];
    if (q.type === "mcq") {
      const choices = (config.choices ?? []) as { text: string; correct: boolean }[];
      distribution = choices.map((choice, id) => ({
        key: String(id),
        label: choice.text,
        count: given.filter((ans) => ((ans as { selected?: number[] }).selected ?? []).includes(id)).length,
        correct: choice.correct,
      }));
    } else if (q.type === "short" || q.type === "cloze") {
      const counts = new Map<string, number>();
      for (const ans of given) {
        const text =
          q.type === "short"
            ? String((ans as { text?: string }).text ?? "")
            : ((ans as { blanks?: string[] }).blanks ?? []).join(" · ");
        counts.set(text, (counts.get(text) ?? 0) + 1);
      }
      distribution = [...counts]
        .sort((a, b) => b[1] - a[1])
        .slice(0, 8)
        .map(([text, count]) => ({ key: text, label: text || "—", count, correct: null }));
    }
    const cases = ((config.tests as { cases?: CodeCaseLike[] })?.cases ?? []) as CodeCaseLike[];
    return {
      item: view.items[index]!,
      student: studentView(q, config),
      solution:
        q.type === "code"
          ? mockCodeDetails(config, 1).solution
          : (tryAnswer(q, config, null) as { solution?: unknown }).solution ?? null,
      explanation: q.versions.at(-1)?.explanation || null,
      answered: given.length,
      distribution,
      casePassRate:
        q.type === "code"
          ? cases.map((c) => ({
              name: c.name,
              passed: Math.round(e.attempts.length * (0.4 + rand() * 0.5)),
              total: e.attempts.length,
            }))
          : [],
      successRate: view.items[index]!.successRate,
      avgMs: null,
    };
  });
});

on("POST", "/app/api/evaluations/:id/release", (m) => {
  const e = gradingWorldOr404(m.groups!.id!);
  e.evaluation.releasedAt = iso(0);
  // Publishing moves the evaluation itself, so the classroom list, the
  // configuration header and the student's home all agree one call later.
  e.evaluation.state = "released";
  e.evaluation.modifiedAfterRelease = false;
  return { releasedAt: e.evaluation.releasedAt, rows: e.attempts.length, released: true };
});

on("POST", "/app/api/evaluations/:id/unrelease", (m) => {
  const e = gradingWorldOr404(m.groups!.id!);
  e.evaluation.releasedAt = null;
  e.evaluation.state = "closed";
  e.evaluation.modifiedAfterRelease = false;
  return { releasedAt: null, rows: 0, released: false };
});

on("GET", "/app/api/attempts/:id/feedback", (m) => {
  const attemptId = String(m.groups!.id);
  const e = gradingWorlds.find((x) => x.attempts.some((a) => a.id === attemptId));
  if (!e) throw new MockError(404, "Attempt not found");
  const attempt = e.attempts.find((a) => a.id === attemptId)!;
  if (e.evaluation.releasedAt === null) {
    return {
      available: false,
      reason: "results_pending",
      evaluation: { id: e.evaluation.id, title: e.evaluation.title },
    };
  }
  const { points } = attemptPoints(e, attempt.id);
  const total = gradedTotalPointsOf(e);
  return {
    available: true,
    evaluation: { id: e.evaluation.id, title: e.evaluation.title, releasedAt: e.evaluation.releasedAt },
    attemptId: attempt.id,
    points,
    totalPoints: total,
    grade: gradeOf(points, total),
    items: e.items.map((item) => {
      const q = questions.find((x) => x.id === item.questionId)!;
      const config = publishedConfig(q);
      const key = cellKey(attempt.id, item.id);
      const answer = e.answers.get(key) ?? null;
      const grading = standingGrading(e, attempt.id, item.id);
      const solution =
        q.type === "code"
          ? mockCodeDetails(config, 1).solution
          : (tryAnswer(q, config, answer, e.evaluation.mcqPolicy) as { solution?: unknown }).solution ?? null;
      return {
        itemId: item.id,
        position: item.position,
        type: item.type,
        points: grading ? grading.points : null,
        maxPoints: item.points,
        verdict: grading
          ? grading.points >= item.points
            ? "correct"
            : grading.points > 0
              ? "partial"
              : "wrong"
          : null,
        student: studentView(q, config),
        answer,
        solution,
        explanation: q.versions.at(-1)?.explanation || null,
        details: grading?.details ?? null,
        comment: grading?.comment ?? null,
      };
    }),
  };
});

// --- The fetch interception ----------------------------------------------

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

// --- The fake SSE stream ---------------------------------------------------
//
// ONE `EventSource` for the three kinds of connection the app opens (§4.8),
// because the browser has one too: `realtime/useEventStream` shares a single
// socket between the shell and whichever screen is watching something.
//
//   - no `watch`    the shell's hint stream. The mock never sends a hint —
//                   every mutation here mutates the store synchronously, so
//                   there is nothing to re-fetch — but it does send the
//                   `clock`, because thirty seconds without one is how the
//                   client decides a socket is dead and reopens it;
//   - `evaluation:` the teacher's dashboard (section 3): a `snapshot` seeding
//                   the grid, then a trickle of `dashboard.cell` and
//                   `dashboard.presence`, or a `lobby.count` climbing while
//                   nobody has started. The student's own evaluation
//                   (section 4) answers the same subject with the lobby it
//                   is watching instead;
//   - `attempt:`    the student's player (section 4): the attempt snapshot,
//                   a beat a second, and whatever `?scene=` asks for — the
//                   teacher granting time, the pause, the closure.
//
// The dashboard trickle is deliberately faster than the server's coalescing
// (a cell a second instead of one per 250 ms per pair): the point is to SEE
// the grid move while looking at it, not to reproduce a load profile.
//
// Every frame goes out through `emit`, which is typed `ServerEvent`: the
// client validates each one against the same schema and drops what it cannot
// read, so a frame this file got wrong would fail silently. The type is the
// only thing that catches it.

/** How often the fake stream emits, in ms. */
const STREAM = { clock: 5_000, beat: 1_000, cell: 1_100, presence: 4_000, lobby: 3_000 };

class MockEventSource {
  onmessage: ((e: MessageEvent) => void) | null = null;
  onopen: (() => void) | null = null;
  onerror: (() => void) | null = null;
  readonly url: string;
  private readonly listeners = new Map<string, ((e: MessageEvent) => void)[]>();
  private readonly intervals: ReturnType<typeof setInterval>[] = [];
  private readonly timeouts: ReturnType<typeof setTimeout>[] = [];
  private closed = false;

  constructor(url: string) {
    this.url = url;
    this.after(60, () => this.start());
  }

  addEventListener(name: string, fn: (e: MessageEvent) => void): void {
    this.listeners.set(name, [...(this.listeners.get(name) ?? []), fn]);
  }

  removeEventListener(name: string, fn: (e: MessageEvent) => void): void {
    this.listeners.set(name, (this.listeners.get(name) ?? []).filter((f) => f !== fn));
  }

  close(): void {
    this.closed = true;
    for (const timer of this.intervals) clearInterval(timer);
    for (const timer of this.timeouts) clearTimeout(timer);
    this.intervals.length = 0;
    this.timeouts.length = 0;
    this.listeners.clear();
  }

  /** The named frames of §4.8; the unnamed hint would go through `onmessage`. */
  private emit(event: ServerEvent): void {
    if (this.closed) return;
    const frame = new MessageEvent(event.type, { data: JSON.stringify(event) });
    for (const fn of this.listeners.get(event.type) ?? []) fn(frame);
  }

  private every(ms: number, fn: () => void): void {
    this.intervals.push(setInterval(fn, ms));
  }

  private after(ms: number, fn: () => void): void {
    this.timeouts.push(setTimeout(fn, ms));
  }

  private start(): void {
    if (this.closed) return;
    this.onopen?.();
    const watch = new URL(this.url, window.location.origin).searchParams.get("watch");
    const beat = watch !== null && watch.startsWith("attempt:") ? STREAM.beat : STREAM.clock;
    const tick = () => this.emit({ type: "clock", serverNow: new Date().toISOString() });
    tick();
    this.every(beat, tick);
    if (watch === null) return;
    const id = watch.slice(watch.indexOf(":") + 1);
    if (watch.startsWith("attempt:") || id === STUDENT_EVAL) {
      this.student(watch);
      return;
    }
    const evaluation = findEvaluation(id);
    if (evaluation !== null) this.dashboard(watch, evaluation);
  }

  /** Section 4: the player and the lobby the student is looking at. */
  private student(watch: string): void {
    const attempt = watch.startsWith("attempt:");
    this.emit({
      type: "snapshot",
      serverNow: new Date().toISOString(),
      subject: watch,
      state: attempt ? studentAttemptView() : studentLobbyView(),
    });
    if (!attempt) {
      this.emit({ type: "lobby.count", evaluationId: STUDENT_EVAL, present: 18, enrolled: 24 });
    }
    if (scene === "extend") {
      this.after(4000, () => {
        // Assignment, not `+=`: React mounts effects twice in development, so
        // two streams open and an increment would grant ten minutes instead
        // of five.
        studentDeadline = BASE_DEADLINE + 5 * 60_000;
        this.emit({
          type: "attempt.deadline",
          attemptId: STUDENT_ATTEMPT,
          deadlineAt: new Date(studentDeadline).toISOString(),
          bonusS: 300,
          reason: "teacher_extend",
          serverNow: new Date().toISOString(),
        });
      });
    }
    if (scene === "paused") {
      this.emit({
        type: "evaluation.state",
        evaluationId: STUDENT_EVAL,
        state: "paused",
        pausedAt: new Date().toISOString(),
        closesAt: null,
        serverNow: new Date().toISOString(),
      });
    }
    if (scene === "closed") {
      this.emit({
        type: "attempt.closed",
        attemptId: STUDENT_ATTEMPT,
        evaluationId: STUDENT_EVAL,
        closedBy: "server",
        serverNow: new Date().toISOString(),
      });
    }
  }

  /** Section 3: one class of students working, seen from the teacher's grid. */
  private dashboard(watch: string, evaluation: MockEvaluation): void {
    this.emit({
      type: "snapshot",
      serverNow: new Date().toISOString(),
      subject: watch,
      // Always without the answers, exactly like the server: the stream does
      // not know which toggles the teacher has on (`modules/realtime`).
      state: dashboardView(evaluation, false),
    });

    if (evaluation.state === "lobby" || evaluation.state === "scheduled") {
      this.every(STREAM.lobby, () => {
        const enrolled = evaluation.rows.length;
        evaluation.present = Math.min(enrolled, evaluation.present + (rand() < 0.6 ? 1 : 0));
        this.emit({
          type: "lobby.count",
          evaluationId: evaluation.id,
          present: evaluation.present,
          enrolled,
        });
      });
      return;
    }
    if (evaluation.state !== "running") return;

    // One student advances by one question at a time, in the store as well as
    // on the wire: a reload must not undo what the teacher watched happen.
    this.every(STREAM.cell, () => {
      const candidates = evaluation.rows.filter(
        (r) => r.attemptId !== null && r.state === "in_progress",
      );
      const row = candidates[Math.floor(rand() * candidates.length)];
      if (!row) return;
      const index = row.cells.findIndex((c) => c.status !== "done");
      const cell = row.cells[index];
      const item = evaluation.items[index];
      if (!cell || !item) return;
      const question = itemQuestion(item);
      cell.status = cell.status === "empty" ? "in_progress" : "done";
      cell.revision += 1;
      cell.summary =
        cell.status === "done" && question !== null
          ? summaryOf(question, index + cell.revision)
          : null;
      this.emit({
        type: "dashboard.cell",
        evaluationId: evaluation.id,
        attemptId: row.attemptId!,
        itemId: cell.itemId,
        status: cell.status,
        revision: cell.revision,
        points: null,
        summary: cell.summary,
      });
    });

    this.every(STREAM.presence, () => {
      const row = evaluation.rows[Math.floor(rand() * evaluation.rows.length)];
      if (!row) return;
      row.online = !row.online;
      row.lastSeenAt = new Date().toISOString();
      this.emit({
        type: "dashboard.presence",
        evaluationId: evaluation.id,
        userId: row.userId,
        online: row.online,
        lastSeenAt: row.lastSeenAt,
      });
    });
  }
}
(window as unknown as { EventSource: unknown }).EventSource = MockEventSource;

const active = FLAG_NAMES.filter((f) => flags[f]);
console.info(
  `[mock] persona: ${role} — switch with ?as=teacher|student|admin` +
    `\n[mock] scene flags: ${active.length ? active.join(", ") : "none"} — ?empty=1 ?fail=1 ?slow=1 ?many=1 (append =0 to clear)` +
    `\n[mock] student scene: ${scene} — ?scene=lobby|running|paused|closed|extend`,
);
