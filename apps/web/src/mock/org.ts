/**
 * Section 1b — courses, classrooms, roster and administration: the world a
 * teacher organises before there is a single question in it.
 */
import { ConditionKind, DEFAULT_MAX_ACTIVE_SESSIONS, LlmSettingsPatch, ScheduledTaskPatch, TeacherCodespaceGrantPatch } from "@quiz/contracts";
import type {
  AdminScheduledTask,
  AdminTeacher,
  AdminUser,
  ClassroomDetail,
  CourseCondition,
  CourseRole,
  CourseSummary,
  ImpersonationLink,
  RosterEntry,
  StudentClassroom,
  CheckDetail,
  CheckValue,
  LlmSettings,
  LlmTestResult,
  LlmUsage,
  SystemCheck,
  SystemStatus,
  TeacherCodespaceGrant,
  TestMailResult,
} from "@quiz/contracts";
import { addMonths, currentOrNextSemester, semesterMonths } from "@quiz/domain";
import {
  D,
  H,
  MockError,
  MockPayload,
  MOCK_CONDITIONS,
  flags,
  iso,
  nextId,
  on,
  pick,
  rand,
} from "./runtime";
import { journalRemovalRefusal } from "./journal";
import {
  me,
} from "./session";

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
      // PRG1-2026 is the classroom connected to GitHub (`mock/github.ts`):
      // three claimed students in four there have linked their account.
      githubLogin: claimed && prefix === "r1" && i % 4 !== 3 ? `${slug(prenom)}-${slug(nom)}` : null,
    });
  }
  return out;
}

export interface Room {
  id: string;
  name: string;
  period: string;
  periodStart: string | null;
  periodEnd: string | null;
  courseId: string;
  createdAt: string;
  archivedAt: string | null;
  roster: RosterEntry[];
  /** ADR-041 §6: when the teacher turned the drill on (`mock/drill.ts` writes it). */
  drillEnabledAt?: string | null;
}

export interface Course {
  id: string;
  name: string;
  code: string;
  createdAt: string;
  staff: CourseSummary["staff"];
  /** The mock teacher hid this course from their navigation (#155). */
  hidden?: boolean;
}

/**
 * The mock teacher's seat. `?assistant=1` makes them an assistant of every
 * course (ADR-068), with Pierre Roulet as the owner beside them: the screens
 * an assistant sees, without a second persona.
 */
const MY_ROLE: CourseRole = flags.assistant ? "assistant" : "owner";

export const ME_TEACHER: CourseSummary["staff"][number] = {
  userId: "u-me",
  givenName: "Prof",
  familyName: "Démo",
  email: "teacher@heig-vd.ch",
  avatarUrl: null,
  role: MY_ROLE,
};

const ROULET: CourseSummary["staff"][number] = {
  userId: "u2",
  givenName: "Pierre",
  familyName: "Roulet",
  email: "pierre.roulet@heig-vd.ch",
  avatarUrl: null,
  role: flags.assistant ? "owner" : "assistant",
};

/** A course's staff: the mock teacher, and an owner beside them when they are not one. */
const staffOf = (...others: CourseSummary["staff"]): CourseSummary["staff"] =>
  others.length === 0 && flags.assistant ? [ME_TEACHER, ROULET] : [ME_TEACHER, ...others];

export const courses: Course[] = [
  {
    id: "c1",
    name: "Programmation C",
    code: "PRG1",
    createdAt: iso(-400 * D),
    staff: staffOf(ROULET),
  },
  {
    id: "c2",
    name: "Systèmes embarqués",
    code: "EMB",
    createdAt: iso(-200 * D),
    staff: staffOf(),
  },
  // A course the teacher no longer teaches, hidden (#155): out of the list
  // until "Show hidden", out of both sidebar sections and of the palette.
  {
    id: "c3",
    name: "Algorithmique",
    code: "ALG",
    createdAt: iso(-800 * D),
    staff: staffOf(),
    hidden: true,
  },
];

/**
 * The semester of the browser's today, and the same one a year back (#156):
 * relative, like every date of the mock, so the sidebar shows the same
 * classrooms whatever day the mock is opened — the ended one leaves it.
 */
const NOW = semesterMonths(currentOrNextSemester(new Date()));
const LAST_YEAR = { start: addMonths(NOW.start, -12), end: addMonths(NOW.end, -12) };

export const rooms: Room[] = [
  {
    id: "r1",
    name: "PRG1-2026",
    period: "2026-A",
    periodStart: NOW.start,
    periodEnd: NOW.end,
    courseId: "c1",
    createdAt: iso(-40 * D),
    archivedAt: null,
    roster: makeStudents(24, 0.85, "r1"),
  },
  {
    id: "r2",
    name: "PRG1-2025",
    period: "2025-A",
    periodStart: LAST_YEAR.start,
    periodEnd: LAST_YEAR.end,
    courseId: "c1",
    createdAt: iso(-400 * D),
    archivedAt: null,
    roster: makeStudents(18, 1, "r2"),
  },
  {
    id: "r3",
    name: "EMB-2026",
    period: "2026-A",
    periodStart: NOW.start,
    periodEnd: NOW.end,
    courseId: "c2",
    createdAt: iso(-30 * D),
    archivedAt: null,
    roster: makeStudents(12, 0.6, "r3"),
  },
  // A name a teacher really gives a classroom, and one that outgrows the
  // 240 px sidebar: the row it lands on has to stay readable (#153).
  {
    id: "r4",
    name: "Prog-C-2026-2027-test",
    period: "2026-A",
    periodStart: null,
    periodEnd: null,
    courseId: "c1",
    createdAt: iso(-5 * D),
    archivedAt: null,
    roster: makeStudents(3, 1, "r4"),
  },
  {
    id: "r5",
    name: "ALG-2024",
    period: "2024-A",
    periodStart: null,
    periodEnd: null,
    courseId: "c3",
    createdAt: iso(-750 * D),
    archivedAt: null,
    roster: makeStudents(20, 1, "r5"),
  },
  // A past year, archived: reached from the course card's "Show archived".
  {
    id: "r6",
    name: "PRG1-2024",
    period: "2024-A",
    periodStart: null,
    periodEnd: null,
    courseId: "c1",
    createdAt: iso(-760 * D),
    archivedAt: iso(-300 * D),
    roster: makeStudents(22, 1, "r6"),
  },
];

export const teachers: Omit<AdminTeacher, "codespace">[] = [
  {
    id: "t1",
    email: "ada.lovelace@heig-vd.ch",
    givenName: "Ada",
    familyName: "Lovelace",
    avatarUrl: null,
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
    avatarUrl: null,
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
    avatarUrl: null,
    signedUp: false,
    courses: 0,
    lastLoginAt: null,
    grantedAt: iso(-1 * D),
  },
  // Colleagues with no seat on any pool: what the invite picker offers.
  {
    id: "t4",
    email: "margaret.hamilton@heig-vd.ch",
    givenName: "Margaret",
    familyName: "Hamilton",
    avatarUrl: null,
    signedUp: true,
    courses: 2,
    lastLoginAt: iso(-3 * D),
    grantedAt: iso(-300 * D),
  },
  {
    id: "t5",
    email: "barbara.liskov@heig-vd.ch",
    givenName: "Barbara",
    familyName: "Liskov",
    avatarUrl: null,
    signedUp: true,
    courses: 1,
    lastLoginAt: iso(-12 * D),
    grantedAt: iso(-250 * D),
  },
  {
    id: "t6",
    email: "dennis.ritchie@heig-vd.ch",
    givenName: "Dennis",
    familyName: "Ritchie",
    avatarUrl: null,
    signedUp: true,
    courses: 4,
    lastLoginAt: iso(-1 * H),
    grantedAt: iso(-500 * D),
  },
];

/**
 * `?many=1`: 8 courses, 30 classrooms, 120 students on the first one — and a
 * staff of twelve on the first course, which is what makes the row of discs
 * hit its cap and show the "+N" the ordinary scene never reaches.
 */
function inflate() {
  rooms[0]!.roster = makeStudents(120, 0.8, "r1");
  const first = courses[0]!;
  for (let i = first.staff.length; i < 12; i += 1) {
    const givenName = FIRST[i]!;
    const familyName = LAST[i]!;
    first.staff.push({
      userId: `u-staff${i + 1}`,
      givenName,
      familyName,
      email: `${slug(givenName)}.${slug(familyName)}@heig-vd.ch`,
      avatarUrl: null,
      role: "assistant",
    });
  }
  const topics = ["Strings", "Structs", "Recursion", "Sorting", "Files", "Makefiles", "Tests", "Pointers"];
  for (let i = courses.length; i < 8; i += 1) {
    courses.push({
      id: `c${i + 1}`,
      name: `Course ${i + 1} — ${topics[i % topics.length]}`,
      code: `C${i + 1}`,
      createdAt: iso(-(20 + i) * D),
      staff: staffOf(),
    });
  }
  for (let i = rooms.length; i < 30; i += 1) {
    const course = courses[i % courses.length]!;
    rooms.push({
      id: `r${i + 1}`,
      name: `${course.code}-${2020 + (i % 7)}`,
      period: `${2020 + (i % 7)}-A`,
      // Undated: the "show all" row of the sidebar needs more than twelve.
      periodStart: null,
      periodEnd: null,
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

/**
 * Every account (F-ADMIN-01): the signed-up grantees, one teacher for each
 * other branch of the role rule, one stale teacher the rule no longer gives
 * a reason for, and every claimed seat of the rosters as a student — some
 * seventy of them, enough for the "Show all" row.
 */
const account = (
  id: string,
  givenName: string,
  familyName: string,
  email: string,
  rest: Partial<AdminUser> = {},
): AdminUser => ({
  id,
  email,
  givenName,
  familyName,
  avatarUrl: null,
  role: "teacher",
  reason: null,
  lastLoginAt: iso(-rand() * 30 * D),
  createdAt: iso(-(100 + rand() * 400) * D),
  pools: 0,
  questions: 0,
  classrooms: 0,
  ...rest,
});

function buildAdminUsers(): AdminUser[] {
  if (flags.empty) return [];
  const teaching = (pools: number, questions: number, classrooms: number) => ({
    pools,
    questions,
    classrooms,
  });
  const staff: AdminUser[] = [
    account("u-admin", "Admin", "Démo", "admin@heig-vd.ch", {
      role: "admin",
      reason: "super_admin",
      lastLoginAt: iso(-3 * H),
      ...teaching(1, 4, 0),
    }),
    ...teachers
      .filter((g) => g.signedUp)
      .map((g, i) =>
        account(`u-${g.id}`, g.givenName ?? "", g.familyName ?? "", g.email, {
          reason: "grant",
          lastLoginAt: g.lastLoginAt,
          ...teaching(1 + (i % 3), 12 + i * 17, g.courses),
        }),
      ),
    account("u-wirth", "Niklaus", "Wirth", "niklaus.wirth@heig-vd.ch", {
      reason: "course_seat",
      ...teaching(0, 0, 2),
    }),
    account("u-hoare", "Tony", "Hoare", "tony.hoare@hes-so.ch", {
      // The affiliation is read at sign-in: this account has signed in.
      reason: "staff_affiliation",
      lastLoginAt: iso(-6 * D),
    }),
    account("u-knuth", "Donald", "Knuth", "donald.knuth@heig-vd.ch", teaching(2, 48, 0)),
  ];
  // One account per address: a student may sit in two rosters.
  const claimed = new Map(
    rooms.flatMap((r) => r.roster.filter((e) => e.userId !== null).map((e) => [e.email, e])),
  );
  const students = [...claimed.values()].map((e) =>
    account(e.userId!, e.prenom, e.nom, e.email, {
      role: "student",
      lastLoginAt: e.lastLoginAt,
      avatarUrl: e.avatarUrl,
    }),
  );
  return [...staff, ...students];
}

const adminUsers = buildAdminUsers();

// --- Views ---

/**
 * How many templates a course keeps. The templates live in `./evaluation`,
 * which imports this file: it plugs its count in here rather than this file
 * importing it back.
 */
export const templateCount = { of: (_courseId: string): number => 0 };

/**
 * The reader's role on a course: their seat's, or an owner's for anyone
 * without one (the admin persona, as under Super Powers).
 */
const myRoleOn = (courseId: string | null | undefined): CourseRole =>
  courses.find((c) => c.id === courseId)?.staff.find((s) => s.userId === ME_TEACHER.userId)?.role ??
  "owner";

const courseSummary = (c: Course): CourseSummary => ({
  id: c.id,
  name: c.name,
  code: c.code,
  createdAt: c.createdAt,
  hidden: c.hidden ?? false,
  myRole: myRoleOn(c.id),
  templates: templateCount.of(c.id),
  staff: c.staff,
  classrooms: rooms
    .filter((r) => r.courseId === c.id && !r.archivedAt)
    .map((r) => ({
      id: r.id,
      name: r.name,
      period: r.period,
      periodStart: r.periodStart,
      periodEnd: r.periodEnd,
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
    periodStart: r.periodStart,
    periodEnd: r.periodEnd,
    archivedAt: r.archivedAt,
    drillEnabled: (r.drillEnabledAt ?? null) !== null,
    course: { id: c.id, name: c.name, code: c.code },
    roster: r.roster,
  };
};

export const studentRooms = (): StudentClassroom[] =>
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

export const courseOr404 = (id: string) => {
  const c = courses.find((x) => x.id === id);
  if (!c) throw new MockError(404, "Course not found");
  return c;
};
/** The students of a classroom, staff excluded, in dashboard-row order. */
export const classroomRoster = (classroomId: string): RosterEntry[] =>
  (rooms.find((r) => r.id === classroomId)?.roster ?? []).filter((s) => !s.staff);

export const roomOr404 = (id: string) => {
  const r = rooms.find((x) => x.id === id);
  if (!r) throw new MockError(404, "Classroom not found");
  return r;
};

// --- Courses ---

on("GET", "/app/api/courses", () => courses.map(courseSummary));
on("POST", "/app/api/courses", (_m, body) => {
  const c: Course = {
    id: nextId("c"),
    name: String(body.name),
    code: String(body.code).toUpperCase(),
    createdAt: iso(0),
    staff: [{ ...ME_TEACHER, role: "owner" }],
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
on("POST", "/app/api/courses/:id/hide", (m) => {
  courseOr404(m.groups!.id!).hidden = true;
  return undefined;
});
on("POST", "/app/api/courses/:id/unhide", (m) => {
  courseOr404(m.groups!.id!).hidden = false;
  return undefined;
});
on("POST", "/app/api/courses/:id/staff", (m, body) => {
  const c = courseOr404(m.groups!.id!);
  const email = String(body.email);
  const role: CourseRole = body.role === "owner" ? "owner" : "assistant";
  if (c.staff.some((s) => s.email === email)) {
    throw new MockPayload(409, { error: "already_staff", message: "This account is already on the staff" });
  }
  const [prenom = "New", nom = "Member"] = email.split("@")[0]!.split(".");
  const userId = nextId("u");
  c.staff.push({ userId, givenName: prenom, familyName: nom, email, avatarUrl: null, role });
  return { userId, role };
});

/** The server's last-owner rule (ADR-068): the seat, or the 409 that keeps the last owner. */
const seatChange = (c: Course, uid: string, next: CourseRole | "remove") => {
  const seat = c.staff.find((s) => s.userId === uid);
  if (!seat) throw new MockError(404, "Not found");
  const owners = c.staff.filter((s) => s.role === "owner").length;
  if (seat.role === "owner" && next !== "owner" && owners <= 1) {
    throw new MockPayload(409, { error: "last_owner", message: "A course keeps at least one owner" });
  }
  return seat;
};
on("PATCH", "/app/api/courses/:id/staff/:uid", (m, body) => {
  const c = courseOr404(m.groups!.id!);
  const role: CourseRole = body.role === "owner" ? "owner" : "assistant";
  seatChange(c, m.groups!.uid!, role).role = role;
  return { userId: m.groups!.uid, role };
});
on("DELETE", "/app/api/courses/:id/staff/:uid", (m) => {
  const c = courseOr404(m.groups!.id!);
  seatChange(c, m.groups!.uid!, "remove");
  c.staff = c.staff.filter((s) => s.userId !== m.groups!.uid);
  return undefined;
});
// --- The course's catalog of conditions (F-ORG-16) ---

/**
 * PRG1's catalog: the first two of the draft exam's conditions came from it
 * (`mock/evaluation.ts` links them), two more wait unticked, and one is
 * archived. The other courses start empty (`?empty=1` empties PRG1's too).
 */
export const MOCK_CATALOG: Record<string, CourseCondition[]> = {
  c1: flags.empty
    ? []
    : [
        { id: "0f6c7a52-6d1f-4c43-9a0e-7f1b8c2d3e41", ...MOCK_CONDITIONS[0]!, archivedAt: null },
        { id: "1a7d8b63-7e2a-4d54-8b1f-8a2c9d3e4f52", ...MOCK_CONDITIONS[1]!, archivedAt: null },
        { id: "2b8e9c74-8f3b-4e65-9c2a-9b3d0e4f5a63", kind: "allowed", text: "Une calculatrice non programmable", archivedAt: null },
        { id: "3c9f0d85-9a4c-4f76-8d3b-0c4e1f5a6b74", kind: "info", text: "Les sorties sont autorisées après 30 minutes", archivedAt: null },
        { id: "4d0a1e96-0b5d-4a87-9e4c-1d5f2a6b7c85", kind: "provided", text: "Une feuille de brouillon", archivedAt: iso(-120 * D) },
      ],
};
const catalogOf = (courseId: string) => (MOCK_CATALOG[courseOr404(courseId).id] ??= []);
const catalogEntry = (m: RegExpMatchArray) => {
  const entry = catalogOf(m.groups!.id!).find((e) => e.id === m.groups!.cid);
  if (!entry) throw new MockError(404, "Not found");
  return entry;
};
on("GET", "/app/api/courses/:id/conditions", (m) => {
  const all = catalogOf(m.groups!.id!);
  return [...all.filter((e) => e.archivedAt === null), ...all.filter((e) => e.archivedAt !== null)];
});
on("POST", "/app/api/courses/:id/conditions", (m, body) => {
  const entry: CourseCondition = {
    id: crypto.randomUUID(),
    kind: ConditionKind.catch("allowed").parse(body.kind),
    text: String(body.text).trim(),
    archivedAt: null,
  };
  catalogOf(m.groups!.id!).push(entry);
  return entry;
});
on("PATCH", "/app/api/courses/:id/conditions/:cid", (m, body) => {
  const entry = catalogEntry(m);
  if (body.kind !== undefined) entry.kind = ConditionKind.catch("allowed").parse(body.kind);
  if (typeof body.text === "string") entry.text = body.text.trim();
  return entry;
});
on("PUT", "/app/api/courses/:id/conditions/order", (m, body) => {
  const all = catalogOf(m.groups!.id!);
  const ids = Array.isArray(body.ids) ? (body.ids as string[]) : [];
  const ordered = ids.map((id) => all.find((e) => e.id === id)!).filter(Boolean);
  all.splice(0, all.length, ...ordered, ...all.filter((e) => !ids.includes(e.id)));
  return undefined;
});
for (const [path, archived] of [["archive", true], ["unarchive", false]] as const) {
  on("POST", `/app/api/courses/:id/conditions/:cid/${path}`, (m) => {
    const entry = catalogEntry(m);
    entry.archivedAt = archived ? (entry.archivedAt ?? iso(0)) : null;
    if (!archived) {
      // Brought back, it goes last, as on the server.
      const all = catalogOf(m.groups!.id!);
      all.splice(all.indexOf(entry), 1);
      all.push(entry);
    }
    return entry;
  });
}

on("POST", "/app/api/courses/:id/classrooms", (m, body) => {
  const c = courseOr404(m.groups!.id!);
  const r: Room = {
    id: nextId("r"),
    name: String(body.name),
    period: String(body.period ?? ""),
    periodStart: typeof body.periodStart === "string" ? body.periodStart : null,
    periodEnd: typeof body.periodEnd === "string" ? body.periodEnd : null,
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
  if (body.periodStart !== undefined) r.periodStart = (body.periodStart as string | null) ?? null;
  if (body.periodEnd !== undefined) r.periodEnd = (body.periodEnd as string | null) ?? null;
  return classroomDetail(r);
});
on("DELETE", "/app/api/classrooms/:id", (m, _body, url) => {
  // A Quiz-mode journal with pages goes with its classroom only by name (F-ORG-09).
  const refused = journalRemovalRefusal(m.groups!.id!, url);
  if (refused) throw refused;
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
      githubLogin: null,
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
      githubLogin: null,
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
// ADR-034: the one-time link an admin copies. `?as=student&impersonating=1`
// shows what opening it looks like.
on("POST", "/app/api/classrooms/:id/roster/:eid/impersonation", (): ImpersonationLink => ({
  url: `${window.location.origin}/app/auth/as/mock-${nextId("link")}`,
}));

// --- Student ---

on("GET", "/app/api/student/classrooms", () => studentRooms());

// --- Admin ---

/**
 * The online workspace grants (ADR-047 §4, `?codespace=1`): Ada has it, for
 * three workspaces at once; every other grant is off, the default quota.
 * Without the flag the platform has no portal, and no row carries a grant.
 */
const codespaceGrants = new Map<string, TeacherCodespaceGrant>([["t1", { enabled: true, maxActiveSessions: 3 }]]);
on("GET", "/app/api/admin/teachers", (): AdminTeacher[] =>
  teachers.map((x) => ({
    ...x,
    codespace: flags.codespace ? (codespaceGrants.get(x.id) ?? { enabled: false, maxActiveSessions: DEFAULT_MAX_ACTIVE_SESSIONS }) : null,
  })),
);
on("PATCH", "/app/api/admin/teachers/:gid/codespace", (m, raw) => {
  const body = TeacherCodespaceGrantPatch.safeParse(raw);
  if (!flags.codespace || !teachers.some((x) => x.id === m.groups!.gid)) throw new MockError(404, "Not found");
  if (!body.success) throw new MockPayload(400, { error: "validation", message: body.error.message });
  const grant = { ...(codespaceGrants.get(m.groups!.gid!) ?? { enabled: false, maxActiveSessions: DEFAULT_MAX_ACTIVE_SESSIONS }), ...body.data };
  codespaceGrants.set(m.groups!.gid!, grant);
  return grant;
});
on("GET", "/app/api/admin/users", () => adminUsers);
on("POST", "/app/api/admin/teachers", (_m, body) => {
  teachers.push({
    id: nextId("t"),
    email: String(body.email),
    givenName: null,
    familyName: null,
    avatarUrl: null,
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

// The scheduled tasks (F-ADMIN-06, D10): one of each state — ok, a failure,
// one still running, one paused on a changed period.
const MIN = 60_000;
function task(
  key: AdminScheduledTask["key"],
  defaultIntervalMinutes: number,
  over: Partial<AdminScheduledTask> = {},
): AdminScheduledTask {
  const intervalMinutes = over.intervalMinutes ?? defaultIntervalMinutes;
  const lastRunAt = over.lastRunAt === undefined ? iso(-3 * MIN) : over.lastRunAt;
  const enabled = over.enabled ?? true;
  return {
    key,
    enabled,
    intervalMinutes,
    defaultIntervalMinutes,
    lastRunAt,
    lastStatus: "ok",
    lastMessage: null,
    lastDurationMs: 12,
    lastOkAt: lastRunAt,
    nextRunAt:
      enabled && lastRunAt
        ? new Date(Date.parse(lastRunAt) + intervalMinutes * MIN).toISOString()
        : enabled
          ? iso(0)
          : null,
    ...over,
  };
}
const tasks: AdminScheduledTask[] = [
  task("sessions.purge", 10, { lastMessage: "4 expired sessions deleted", lastDurationMs: 18 }),
  task("oauth.purge", 60, {
    lastRunAt: iso(-25 * MIN),
    lastStatus: "error",
    lastMessage: 'canceling statement due to statement timeout',
    lastDurationMs: 30_004,
    lastOkAt: iso(-85 * MIN),
  }),
  task("poll.end_idle", 1, { lastRunAt: iso(-20_000), lastMessage: "0 idle polls ended", lastDurationMs: 7 }),
  task("notifications.deadline_reminders", 1, {
    lastRunAt: iso(-4_000),
    lastStatus: "running",
    lastMessage: "12 reminders sent",
    lastDurationMs: 240,
    lastOkAt: iso(-64_000),
  }),
  task("drill.purge", 360, {
    enabled: false,
    intervalMinutes: 1440,
    lastRunAt: iso(-2 * D),
    lastMessage: "0 cards and 0 reviews deleted",
    lastDurationMs: 95,
  }),
  task("health.checks", 5, { lastMessage: "10 ok, 2 warn, 1 unknown", lastDurationMs: 64 }),
  task("llm.review", 60, { lastMessage: "outside the night (01:00–06:00, Zurich)", lastDurationMs: 3 }),
];
const taskOf = (m: RegExpMatchArray) => {
  const found = tasks.find((x) => x.key === m.groups!.key);
  if (!found) throw new MockError(404, "not_found");
  return found;
};
on("GET", "/app/api/admin/tasks", () => tasks);
on("PATCH", "/app/api/admin/tasks/:key", (m, body) => {
  const patch = ScheduledTaskPatch.safeParse(body);
  if (!patch.success) throw new MockError(400, "The period is a whole number of minutes, 1 to 10080");
  const found = taskOf(m);
  Object.assign(found, patch.data);
  found.nextRunAt = found.enabled
    ? new Date(Date.parse(found.lastRunAt ?? iso(0)) + found.intervalMinutes * MIN).toISOString()
    : null;
  return found;
});
on("POST", "/app/api/admin/tasks/:key/run", (m) => {
  const found = taskOf(m);
  if (found.lastStatus === "running") throw new MockError(409, "This task is already running");
  Object.assign(found, {
    lastRunAt: iso(0),
    lastStatus: "ok",
    lastOkAt: iso(0),
    lastDurationMs: 9,
    nextRunAt: found.enabled ? iso(found.intervalMinutes * MIN) : null,
  });
  return found;
});

// The system status (N-OPS-03, F-ADMIN-07, ADR-055). By default a healthy
// production: every check OK. `?degraded=1`: a dead clock and its symptoms,
// a failed job, a late task, a stale backup and a disk filling up.
const GB = 1_000_000_000;
function systemStatus(): SystemStatus {
  const at = iso(0);
  const bad = flags.degraded;
  const check = (
    key: SystemCheck["key"],
    section: SystemCheck["section"],
    status: SystemCheck["status"],
    value: SystemCheck["value"],
    cause: SystemCheck["cause"] = null,
    details: SystemCheck["details"] = [],
  ): SystemCheck => ({
    key,
    section,
    status,
    value,
    cause,
    details,
    checkedAt: at,
    // As the `health.checks` task records it: two runs of five minutes ago at least.
    failingSince: status === "fail" ? iso(-25 * MIN) : null,
  });
  const count = (n: number) => ({ kind: "count" as const, n });
  const queue = (name: string, waiting: number, failed: number, oldestMs: number | null): CheckDetail => ({
    subject: { kind: "name", name },
    values: [
      { meaning: "waiting", value: count(waiting) },
      { meaning: "failed", value: count(failed) },
      ...(oldestMs === null ? [] : [{ meaning: "oldest" as const, value: { kind: "duration" as const, ms: oldestMs } }]),
    ],
    cause: null,
  });
  const named = (name: string, ...values: CheckValue[]): CheckDetail => ({
    subject: { kind: "name", name },
    values: values.map((value) => ({ meaning: null, value })),
    cause: null,
  });
  const table = (name: string, n: number) => named(name, { kind: "bytes", n });
  const lastFailure = (errorClass: string, at: number, inARow: number): CheckDetail => ({
    subject: { kind: "name", name: errorClass },
    values: [
      { meaning: "lastFailure", value: { kind: "at", iso: iso(at) } },
      ...(inARow > 0 ? [{ meaning: "failed" as const, value: count(inARow) }] : []),
    ],
    cause: null,
  });
  return {
    checkedAt: at,
    checks: [
      bad
        ? check("ticker", "live", "fail", { kind: "duration", ms: 4 * 60_000 + 12_000 }, "ticker.stale")
        : check("ticker", "live", "ok", { kind: "duration", ms: 420 }),
      bad
        ? check("attempts.overdue", "live", "fail", count(7), "attempts.overdue")
        : check("attempts.overdue", "live", "ok", count(0)),
      bad
        ? check("evaluations.overdue", "live", "fail", count(1), "evaluations.overdue")
        : check("evaluations.overdue", "live", "ok", count(0)),
      bad
        ? check("tasks", "live", "warn", count(2), "tasks.attention", [
            {
              subject: { kind: "task", key: "oauth.purge" },
              values: [{ meaning: null, value: { kind: "at", iso: iso(-25 * MIN) } }],
              cause: "tasks.error",
            },
            {
              subject: { kind: "task", key: "sessions.purge" },
              values: [{ meaning: null, value: { kind: "at", iso: iso(-3 * H) } }],
              cause: "tasks.overdue",
            },
          ])
        : check("tasks", "live", "ok", count(0)),
      check("jobs", "live", bad ? "warn" : "ok", count(bad ? 3 : 0), bad ? "jobs.failed" : null, [
        queue("grading.evaluation", bad ? 2 : 0, bad ? 3 : 0, bad ? 95_000 : null),
        queue("notifications.email", 0, 0, null),
      ]),
      bad ? check("runner", "live", "fail", null, "runner.down") : check("runner", "live", "ok", null),
      bad
        ? check("http.errors", "live", "warn", count(17), "http.errors", [
            named("/app/api/evaluations/:id/grading", count(11)),
            named("/app/api/attempts/:id/answers/:itemId", count(4)),
            named("unmatched", count(2)),
          ])
        : check("http.errors", "live", "ok", count(0)),
      check("evaluations.live", "live", "ok", count(bad ? 1 : 0), bad ? "evaluations.live" : null),
      check("connections.live", "live", "ok", count(bad ? 58 : 12)),
      check("database", "storage", "ok", { kind: "duration", ms: 2 }),
      check("database.size", "storage", "ok", { kind: "bytes", n: 184_300_000 }, null, [
        table("answers", 61_200_000),
        table("attempt_events", 38_900_000),
        table("pgboss.job_common", 22_400_000),
        table("question_versions", 9_800_000),
        table("audit_log", 4_100_000),
      ]),
      check("database.connections", "storage", "ok", { kind: "share", part: 14, total: 40, bytes: false }),
      bad
        ? check("disk", "storage", "warn", { kind: "share", part: 4.1 * GB, total: 38.4 * GB, bytes: true }, "disk.low")
        : check("disk", "storage", "ok", { kind: "share", part: 21.7 * GB, total: 38.4 * GB, bytes: true }),
      check(
        "backup",
        "storage",
        bad ? "warn" : "ok",
        { kind: "at", iso: iso(bad ? -31 * H : -7 * H) },
        bad ? "backup.stale" : null,
        [named("quiz-2026-09-30.dump", { kind: "bytes", n: 41_800_000 })],
      ),
      // The services, as this process saw them: e-mail refused by the
      // provider for three quarters of an hour when degraded.
      bad
        ? check("service.mail", "services", "fail", { kind: "at", iso: iso(-3 * H) }, "service.failing", [
            lastFailure("http_502", -2 * MIN, 6),
          ])
        : check("service.mail", "services", "ok", { kind: "at", iso: iso(-12 * MIN) }),
      check("service.signin", "services", "ok", { kind: "at", iso: iso(-4 * MIN) }, null, [
        lastFailure("invalid_grant", -5 * H, 0),
      ]),
      bad
        ? check("service.teams", "services", "warn", { kind: "at", iso: iso(-50 * MIN) }, "service.failed_recently", [
            lastFailure("timeout", -6 * MIN, 1),
          ])
        : check("service.teams", "services", "ok", { kind: "at", iso: iso(-50 * MIN) }),
      check("service.llm", "services", "unknown", null, "service.not_configured"),
      check("service.github", "services", "unknown", null, "service.unused"),
    ],
    deployment: {
      commitSha: "8cc9a4a9f1e2d3c4b5a6978877665544332211ff",
      commitDate: iso(-5 * H),
      migration: "0042_scheduled_tasks",
      startedAt: iso(-2 * D),
      node: "v24.9.0",
      workerMode: "all",
      nodeEnv: "production",
      host: "quiz.chevallier.io",
    },
  };
}
on("GET", "/app/api/admin/system", () => systemStatus());
// The mock has no mailer: a dry run, as in development.
on("POST", "/app/api/admin/system/test-mail", (): TestMailResult => ({ outcome: "dry_run" }));

// The LLM gateway (ADR-058): a key saved, Sonnet, a month of authoring.
// `?empty=1`: no key yet and no call; the test answers like a real provider.
const llm: LlmSettings = {
  enabled: true,
  provider: "anthropic",
  keyLast4: flags.empty ? null : "Q7fA",
  keyReadable: true,
  model: "claude-sonnet-5-5",
  dailyCapUsd: 20,
  dailyCapMaxUsd: 100,
  spentTodayUsd: flags.empty ? 0 : 0.84,
  updatedAt: iso(-6 * D),
};
on("GET", "/app/api/admin/llm", () => llm);
on("PATCH", "/app/api/admin/llm", (_m, body) => {
  const patch = LlmSettingsPatch.safeParse(body);
  if (!patch.success) throw new MockError(400, "validation");
  const { apiKey, model, dailyCapUsd } = patch.data;
  if (dailyCapUsd !== undefined && dailyCapUsd > llm.dailyCapMaxUsd) {
    throw new MockError(400, `The daily cap cannot exceed ${llm.dailyCapMaxUsd} USD`);
  }
  Object.assign(llm, {
    ...(apiKey !== undefined ? { keyLast4: apiKey === null ? null : apiKey.slice(-4) } : {}),
    ...(model ? { model } : {}),
    ...(dailyCapUsd !== undefined ? { dailyCapUsd } : {}),
    updatedAt: iso(0),
  });
  return llm;
});
on("POST", "/app/api/admin/llm/test", (): LlmTestResult =>
  llm.keyLast4 ? { ok: true, model: llm.model, latencyMs: 1240 } : { ok: false, model: null, error: "not_configured" },
);
const usageRow = (given: string, family: string, calls: number, input: number, output: number) => ({
  userId: `u-${slug(family)}`,
  givenName: given,
  familyName: family,
  email: `${slug(given)}.${slug(family)}@heig-vd.ch`,
  calls,
  errors: calls > 40 ? 1 : 0,
  inputTokens: input,
  outputTokens: output,
  costUsd: (input * 2 + output * 10) / 1_000_000,
});
on("GET", "/app/api/admin/llm/usage", (): LlmUsage => {
  const rows = flags.empty
    ? []
    : [
        usageRow("Sophie", "Rochat", 64, 412_000, 96_000),
        usageRow("Marc", "Favre", 23, 151_000, 38_500),
        { ...usageRow("", "", 3, 240, 30), userId: null, givenName: null, familyName: null, email: null },
      ];
  const total = rows.reduce(
    (t, r) => ({
      calls: t.calls + r.calls,
      errors: t.errors + r.errors,
      inputTokens: t.inputTokens + r.inputTokens,
      outputTokens: t.outputTokens + r.outputTokens,
      costUsd: t.costUsd + r.costUsd,
    }),
    { calls: 0, errors: 0, inputTokens: 0, outputTokens: 0, costUsd: 0 },
  );
  return { since: new Date(new Date(iso(0)).setDate(1)).toISOString(), rows, total };
});
