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
 *  - `many`  — 8 courses, 30 classrooms and a 120-student roster on the
 *    first one, for long lists and the sidebar.
 */
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


// --- WP8: evaluation + dashboard -----------------------------------------
//
// Everything a teacher can configure and supervise, with enough data that the
// five states of every surface are reachable without a backend: one
// evaluation per state, and a running one at 24 students x 10 questions —
// the size the grid has to stay usable at.
//
// Ids are real UUIDs, not "e1": the SSE client validates every frame against
// the `ServerEvent` schema of `@quiz/contracts` (invariant 7), which means the
// mock has to speak the same grammar as the server, down to the id format.

let uuidSeq = 0;
const uuid = (): string =>
  `00000000-0000-4000-8000-${(uuidSeq += 1).toString(16).padStart(12, "0")}`;

const ADJECTIVES = ["calme", "vif", "patient", "curieux", "sobre", "franc", "alerte", "serein"];
const ANIMALS = ["héron", "renard", "lynx", "martre", "bouquetin", "chamois", "castor", "milan"];
/** Decision D20: a stable adjective+animal per row, never the student's name. */
const pseudonymOf = (index: number) =>
  `${ADJECTIVES[index % ADJECTIVES.length]} ${ANIMALS[(index * 3) % ANIMALS.length]}`;

interface MockQuestion {
  id: string;
  type: string;
  internalName: string;
  difficulty: number;
  tags: string[];
  latestNumber: number | null;
  deprecated: boolean;
}

const QUESTION_SEEDS: [string, string, number][] = [
  ["mcq", "Déclaration d'un pointeur", 2],
  ["short", "Taille de int sur x86-64", 1],
  ["mcq", "Arithmétique de pointeurs", 3],
  ["cloze", "Parcours d'un tableau", 3],
  ["short", "Valeur d'un pointeur non initialisé", 2],
  ["mcq", "Tableau et pointeur : différences", 4],
  ["short", "Résultat de sizeof(tab)", 3],
  ["mcq", "Passage par adresse", 2],
  ["cloze", "Allocation dynamique", 4],
  ["short", "Libération de la mémoire", 2],
  ["mcq", "Chaînes de caractères", 2],
  ["code", "Somme d'un tableau", 3],
  ["code", "Inverser une chaîne", 4],
  ["short", "Terminaison d'une chaîne", 1],
  ["mcq", "Opérateur d'indirection", 1],
];

const pools = [
  {
    id: uuid(),
    name: "PRG1 — pointeurs",
    visibility: "private" as const,
    ownerId: "u-me",
    isPersonal: false,
    createdAt: iso(-300 * D),
  },
  {
    id: uuid(),
    name: "PRG1 — bases",
    visibility: "private" as const,
    ownerId: "u-me",
    isPersonal: false,
    createdAt: iso(-320 * D),
  },
];

const questions: (MockQuestion & { poolId: string })[] = QUESTION_SEEDS.map(
  ([type, internalName, difficulty], i) => ({
    id: uuid(),
    poolId: pools[i % 2 === 0 ? 0 : 1]!.id,
    type,
    internalName,
    difficulty,
    tags: i % 3 === 0 ? ["pointeurs"] : ["bases"],
    // One question in seven has never been published: the picker shows it
    // disabled rather than hiding it.
    latestNumber: i === 6 ? null : 1 + (i % 3),
    deprecated: i === 13,
  }),
);

/** The student payload of one item, by type — what `toStudent` would have produced. */
function studentConfigOf(q: MockQuestion): unknown {
  if (q.type === "mcq") {
    return {
      prompt: `${q.internalName} — laquelle de ces affirmations est correcte ?`,
      choices: [
        { id: 0, text: "`int *p;` déclare un pointeur sur un entier" },
        { id: 1, text: "`int p*;` déclare un pointeur sur un entier" },
        { id: 2, text: "`*int p;` déclare un pointeur sur un entier" },
      ],
      mode: "single",
    };
  }
  if (q.type === "cloze") {
    return {
      template: q.internalName + " : `for (size_t i = 0; i < ⸢0⸣; i++)` puis `⸢1⸣`.",
      blanks: [
        { index: 0, weight: 1, kind: "input", numeric: false },
        { index: 1, weight: 1, kind: "input", numeric: false },
      ],
    };
  }
  return { prompt: `${q.internalName} ?`, kind: "text", placeholder: "…" };
}

function solutionOf(q: MockQuestion): unknown {
  if (q.type === "mcq") return { correct: [0] };
  if (q.type === "cloze") return { blanks: [{ index: 0, expected: "n" }, { index: 1, expected: "t[i]" }] };
  return { expected: ["4"] };
}

function answerOf(q: MockQuestion, seedValue: number): unknown {
  if (q.type === "mcq") return { selected: [seedValue % 3] };
  if (q.type === "cloze") return { blanks: ["n", "t[i]"] };
  return { text: ["4", "8", "NULL", "0x1004"][seedValue % 4]! };
}

/** One glyph or two for the grid cell (what `type.summarize` returns). */
function summaryOf(q: MockQuestion, seedValue: number): string {
  if (q.type === "mcq") return ["A", "B", "C"][seedValue % 3]!;
  if (q.type === "cloze") return `${1 + (seedValue % 2)}/2`;
  return ["4", "8", "NULL", "0x1004"][seedValue % 4]!;
}

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

function makeItems(count: number): MockItem[] {
  return Array.from({ length: count }, (_, i) => {
    const q = questions[i % questions.length]!;
    const frozen = 1 + (i % 2);
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
      // Two items of five carry a newer published version: the stale badge
      // and the one-click update are reachable without editing anything.
      latestVersionNumber: i % 5 === 1 ? frozen + 1 : frozen,
      deprecated: false,
    };
  });
}

function makeRows(e: MockEvaluation, started: boolean): MockRowState[] {
  const room = rooms.find((r) => r.id === e.classroomId);
  const roster = (room?.roster ?? []).filter((s) => !s.staff);
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
            status === "done"
              ? summaryOf(questions.find((q) => q.id === item.questionId)!, index + i)
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
    makeEvaluation(room.id, "Quiz 0 — prise en main", "closed", 5, {
      startedAt: iso(-20 * D),
      closedAt: iso(-20 * D + H),
    }),
    makeEvaluation(room.id, "Test d'entrée", "released", 6, {
      startedAt: iso(-60 * D),
      closedAt: iso(-60 * D + H),
      releasedAt: iso(-59 * D),
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
const findEvaluation = (key: string): MockEvaluation | null =>
  evaluations.find((x) => x.id === key) ?? evaluations.find((x) => x.state === key) ?? null;

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
    items: e.items.map((item, i) => {
      const q = questions.find((x) => x.id === item.questionId)!;
      const cell = row.cells.find((c) => c.itemId === item.id);
      return {
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
      };
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
  items: e.items.map((item) => {
    const q = questions.find((x) => x.id === item.questionId)!;
    return {
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
    };
  }),
});

// --- Pools (what the question picker reads) ---

on("GET", "/app/api/pools", () =>
  pools.map((p) => ({
    ...p,
    questionCount: questions.filter((q) => q.poolId === p.id).length,
  })),
);
on("GET", "/app/api/pools/:id/questions", (m, _b, url) => {
  const poolId = m.groups!.id!;
  const q = (url.searchParams.get("q") ?? "").toLowerCase();
  const type = url.searchParams.get("type");
  const difficulty = url.searchParams.get("difficulty");
  const items = questions
    .filter((x) => x.poolId === poolId)
    .filter((x) => q === "" || x.internalName.toLowerCase().includes(q))
    .filter((x) => !type || x.type === type)
    .filter((x) => !difficulty || String(x.difficulty) === difficulty)
    .map((x) => ({
      id: x.id,
      type: x.type,
      internalName: x.internalName,
      difficulty: x.difficulty,
      tags: x.tags,
      categoryId: null,
      latestNumber: x.latestNumber,
      hasDraftChanges: false,
      updatedAt: iso(-5 * D),
      deprecated: x.deprecated,
      deletedAt: null,
    }));
  return { items, nextCursor: null };
});

// --- Evaluations ---

on("GET", "/app/api/classrooms/:id/evaluations", (m) =>
  evaluations.filter((e) => e.classroomId === m.groups!.id).map(evaluationSummary),
);
on("POST", "/app/api/classrooms/:id/evaluations", (m, body) => {
  const e = makeEvaluation(
    roomOr404(m.groups!.id!).id,
    String(body.title),
    "draft",
    0,
    { mode: (body.mode as MockEvaluation["mode"]) ?? "exam" },
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
    if (!q || q.latestNumber === null) continue;
    e.items.push({
      id: uuid(),
      position: e.items.length + 1,
      points: q.type === "code" ? 3 : 1,
      milestone: false,
      questionId: q.id,
      questionVersionId: uuid(),
      type: q.type,
      internalName: q.internalName,
      versionNumber: q.latestNumber,
      latestVersionNumber: q.latestNumber,
      deprecated: q.deprecated,
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

// --- Teacher controls of a live evaluation ---

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
        return new Response(JSON.stringify({ message: e.message }), {
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

// WP8: evaluation + dashboard — the fake SSE stream.
//
// The shipped client reads two kinds of frame on one connection: the unnamed
// `hint` (which the mock still never sends, because every mutation here
// mutates the store synchronously) and the NAMED live frames. Without the
// second kind the dashboard would be a still photograph, so the mock plays
// them: a `snapshot` to seed the grid, a `clock` so the countdowns follow a
// server clock rather than the browser's, and then a trickle of
// `dashboard.cell` and `dashboard.presence` — one class of students working.
//
// It is deliberately faster than the server's coalescing (a cell a second
// instead of one per 250 ms per pair): the point is to SEE the grid move
// while looking at it, not to reproduce a load profile.

/** How often the fake stream emits, in ms. */
const STREAM = { clock: 5_000, cell: 1_100, presence: 4_000, lobby: 3_000 };

class MockEventSource {
  onmessage: ((e: MessageEvent) => void) | null = null;
  onopen: (() => void) | null = null;
  onerror: (() => void) | null = null;
  readonly url: string;
  private listeners = new Map<string, ((e: MessageEvent) => void)[]>();
  private timers: ReturnType<typeof setInterval>[] = [];
  private closed = false;

  constructor(url: string) {
    this.url = url;
    setTimeout(() => this.start(), 60);
  }

  addEventListener(name: string, fn: (e: MessageEvent) => void) {
    const list = this.listeners.get(name) ?? [];
    list.push(fn);
    this.listeners.set(name, list);
  }

  removeEventListener(name: string, fn: (e: MessageEvent) => void) {
    this.listeners.set(name, (this.listeners.get(name) ?? []).filter((f) => f !== fn));
  }

  close() {
    this.closed = true;
    for (const timer of this.timers) clearInterval(timer);
    this.timers = [];
  }

  private emit(name: string, payload: Record<string, unknown>) {
    if (this.closed) return;
    const event = new MessageEvent(name, { data: JSON.stringify({ type: name, ...payload }) });
    for (const fn of this.listeners.get(name) ?? []) fn(event);
  }

  private every(ms: number, fn: () => void) {
    this.timers.push(setInterval(fn, ms));
  }

  private start() {
    if (this.closed) return;
    this.onopen?.();
    const watch = new URL(this.url, window.location.origin).searchParams.get("watch");
    const id = watch?.startsWith("evaluation:") ? watch.slice("evaluation:".length) : null;
    this.every(STREAM.clock, () => this.emit("clock", { serverNow: new Date().toISOString() }));
    this.emit("clock", { serverNow: new Date().toISOString() });
    if (id === null) return;
    const evaluation = findEvaluation(id);
    if (!evaluation) return;

    this.emit("snapshot", {
      serverNow: new Date().toISOString(),
      subject: watch,
      state: dashboardView(evaluation, false),
    });

    if (evaluation.state === "lobby" || evaluation.state === "scheduled") {
      this.every(STREAM.lobby, () => {
        const enrolled = evaluation.rows.length;
        evaluation.present = Math.min(enrolled, evaluation.present + (rand() < 0.6 ? 1 : 0));
        this.emit("lobby.count", {
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
      const candidates = evaluation.rows.filter((r) => r.attemptId !== null && r.state === "in_progress");
      const row = candidates[Math.floor(rand() * candidates.length)];
      if (!row) return;
      const index = row.cells.findIndex((c) => c.status !== "done");
      const cell = row.cells[index];
      const item = evaluation.items[index];
      if (!cell || !item) return;
      cell.status = cell.status === "empty" ? "in_progress" : "done";
      cell.revision += 1;
      cell.summary =
        cell.status === "done"
          ? summaryOf(questions.find((q) => q.id === item.questionId)!, index + cell.revision)
          : null;
      this.emit("dashboard.cell", {
        evaluationId: evaluation.id,
        attemptId: row.attemptId,
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
      this.emit("dashboard.presence", {
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
    `\n[mock] scene flags: ${active.length ? active.join(", ") : "none"} — ?empty=1 ?fail=1 ?slow=1 ?many=1 (append =0 to clear)`,
);
