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
