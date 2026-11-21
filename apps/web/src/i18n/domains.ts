/**
 * Where a key of the dictionaries lives. Each entry names a domain file, the
 * same in `en/`, `fr/` and `de/`, and the first segments of the keys it holds: a
 * key goes to the one file that lists its first segment (`pool.col.name` is
 * in `pool.ts`, `pools.empty.title` too). A key with a new first segment adds it
 * here, to one file only: to the surface it belongs to, else to `common`.
 * `domains.test.ts` enforces the table; `en.ts`, `fr.ts` and `de.ts` spread
 * the files back into the dictionaries.
 */
export const DOMAINS = {
  common: [
    "common", "ui", "error", "sync", "view", "verdict", "segments", "countdown", "heatmap",
    "dur", "time", "key", "people", "bar", "export", "md", "markdown", "dev",
  ],
  shell: [
    "app", "connection", "crash", "confirm", "toast", "menu", "header", "nav", "bnav", "aside",
    "breadcrumb", "shortcuts", "search", "palette", "help", "impersonation", "superPowers",
    "whatsNew", "festive", "loginRefused",
  ],
  discover: ["discover", "landing", "privacy"],
  account: [
    "settings", "account", "avatar", "tokens", "connections", "oauth", "notif", "teamsTab",
    "teamsLink",
  ],
  admin: ["admin"],
  assist: ["assist", "coach", "training"],
  course: [
    "courses", "classrooms", "classroom", "classroomSettings", "groups", "sgroups", "roster",
    "import", "teacherPicker", "studentPicker", "activities", "activity",
  ],
  student: [
    "player", "shome", "sroom", "scourses", "practice", "ready", "feedback", "calc", "notepad",
  ],
  evaluation: [
    "eval", "launch", "templates", "templatePull", "picker", "conditions", "seb", "kiosk",
    "paper", "attempt",
  ],
  live: ["live", "poll", "join", "pair", "lobby"],
  pool: ["pool", "pools", "share", "categories", "concepts", "review"],
  question: ["question", "issue", "param", "preview", "mcq"],
  qt: ["qt"],
  grading: ["grading", "results", "correction", "contest", "figures", "counting"],
  gradebook: ["gbook", "sgrades", "staffRows", "grade"],
  drill: ["drill", "revise"],
  project: ["project", "sproj", "github"],
  journal: [
    "journal", "journalSettings", "journalEditor", "journalHistory", "journalPage",
    "journalDeleted",
  ],
} as const satisfies Record<string, readonly string[]>;
