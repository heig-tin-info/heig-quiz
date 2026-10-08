/**
 * The mock's runtime: what every section of the fake backend needs and what
 * none of them owns — the persona and the scene flags read from the URL, the
 * frozen clock and the deterministic RNG, the error types a handler throws,
 * and the route table itself. It imports nothing from the sections, which is
 * what keeps the module graph of the mock acyclic (`index.ts` explains the
 * layout).
 */
import type {
  CalculatorMode,
  EvaluationCondition,
  Me,
} from "@quiz/contracts";

type Role = Me["role"];

const ROLE_KEY = "quiz-mock-role";
export const params = new URLSearchParams(window.location.search);
let urlDirty = false;
const asParam = params.get("as");
if (asParam === "teacher" || asParam === "student" || asParam === "admin") {
  localStorage.setItem(ROLE_KEY, asParam);
  params.delete("as");
  urlDirty = true;
}
export const role: Role = (localStorage.getItem(ROLE_KEY) as Role | null) ?? "teacher";

/** Scene flags: read from the URL, then remembered like the persona. */
/**
 * `negative`: every evaluation of the mock scores its choice questions negatively (ADR-026).
 * `impersonating`: the session is an admin acting as this persona, read-only (ADR-034).
 * `kiosk`: the open exam of the student's home is sat on a kiosk station (ADR-051).
 * `reviewed`: the student already did today's drill, the empty day (`mock/drill.ts`).
 * `unlinked`: the persona has no linked GitHub account (`mock/github.ts`).
 * `ghwarn`: PRG1-2026's organization is on GitHub's free plan, without the
 *   LLM secret — the warning lines of the checks (`mock/github.ts`).
 * `ghmissing`: PRG1-2026's organization is gone from GitHub (`mock/github.ts`).
 * `journal`: the classroom PRG1-2026 has a journal, in Quiz mode (`mock/journal.ts`).
 * `journalgithub`: ...in a GitHub repository instead, read-only (ADR-057).
 * `journalerror`: ...in a GitHub repository whose last synchronisation failed.
 * `journalconflict`: ...and every save of a page meets a page saved
 *   meanwhile, `409 conflict` (`mock/journal.ts`).
 * `srcmissing`: a new project's create is refused `422 source_not_found`
 *   (`mock/projectNew.ts`); `distfail`: ...`502 distribution_failed`.
 * `unassigned`: publishing the draft project is refused `409
 *   unassigned_students`, three students in no group (`mock/project.ts`).
 * `groups`: PRG1-2026 has three group sets and PRG1-2024 one, and with
 *   `projects` two of PRG1-2026's drafts are group projects (`mock/groups.ts`).
 * `superpowers`: the admin persona's Super Powers are on, 54 minutes left (ADR-054).
 * `lastminutes`: ...with 4 min 30 s left instead, the banner's countdown.
 * `degraded`: the admin's system status has a dead clock, a stale backup and
 *   a failed job (`mock/org.ts`, ADR-055).
 * `assistant`: the teacher persona is an assistant of every course, not an
 *   owner (`mock/org.ts`, ADR-068).
 * `calculator`: the student's evaluation provides the scientific calculator
 *   (ADR-069); `stdcalc`: the standard one.
 * `provisioning`: the student's Accept of a project takes twenty seconds
 *   (`mock/student.ts`, M3-13); `refused`: it is refused `409
 *   repo_name_taken`; `stale`: `409 github_account_stale` (Relink GitHub).
 * `codespace`: the platform has the online workspace (ADR-047, M6-06): a
 *   project's workspace section, the student's *Open workspace*, the
 *   administration's grants (`mock/codespace.ts`); off, those routes 404.
 * `sebproject`: the student persona is in Safe Exam Browser, on the `seb`
 *   session of its `online_seb` project (D21, M6-07; `mock/session.ts`):
 *   that project page and nothing else. With `codespace`.
 * `staffseat`: the student persona is a teacher on a STAFF seat (ADR-077): their
 *   project page offers the real actions; `staffrepo`: the staff project page
 *   shows that teacher's test repository, badged (`mock/project.ts`).
 * `nollm`: the platform has no model (`GET /generate/availability` says so):
 *   no AI card in the question editor, no "LLM review" tab (ADR-082).
 */
export const FLAG_NAMES = [
  "empty",
  "fail",
  "slow",
  "many",
  "mytest",
  "negative",
  "impersonating",
  "seb",
  "kiosk",
  "reviewed",
  "unlinked",
  "ghwarn",
  "ghmissing",
  "journal",
  "journalgithub",
  "journalerror",
  "journalconflict",
  "projects",
  "srcmissing",
  "distfail",
  "unassigned",
  "unreleased",
  "ahead",
  "groups",
  "superpowers",
  "lastminutes",
  "degraded",
  "assistant",
  "calculator",
  "stdcalc",
  "provisioning",
  "refused",
  "stale",
  "staffseat",
  "staffrepo",
  "codespace",
  "sebproject",
  "nollm",
] as const;
type FlagName = (typeof FLAG_NAMES)[number];
export const flags = {} as Record<FlagName, boolean>;
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

/** ADR-069: the calculator the mock's evaluations provide, from `?calculator=1` or `?stdcalc=1`. */
export const mockCalculator = (): { calculator?: CalculatorMode } =>
  flags.calculator ? { calculator: "scientific" } : flags.stdcalc ? { calculator: "standard" } : {};

/**
 * ADR-079: the conditions a teacher announced on the mock's student
 * evaluation and on the draft exam — the teacher's own words, as stored.
 */
export const MOCK_CONDITIONS: EvaluationCondition[] = [
  { kind: "allowed", text: "Une feuille A4 recto-verso de notes manuscrites" },
  { kind: "forbidden", text: "Téléphones et montres connectées, éteints dans le sac" },
  { kind: "provided", text: "Le formulaire distribué à l'entrée de la salle" },
  { kind: "info", text: "Vous pouvez répondre en français ou en anglais" },
];

/**
 * The student player's scene, remembered the same way. It picks what the
 * fake backend serves on ONE evaluation (section 4) and changes nothing
 * anywhere else.
 */
export type Scene =
  | "lobby"
  | "ready"
  | "running"
  | "paused"
  | "closed"
  | "extend"
  | "single"
  | "marks"
  | "forward"
  | "exercise";
const SCENE_KEY = "quiz-mock-scene";
const sceneParam = params.get("scene");
if (sceneParam !== null) {
  if (sceneParam === "" || sceneParam === "0") localStorage.removeItem(SCENE_KEY);
  else localStorage.setItem(SCENE_KEY, sceneParam);
  params.delete("scene");
  urlDirty = true;
}
export const scene = (localStorage.getItem(SCENE_KEY) ?? "running") as Scene;

/**
 * The HEIG Quiz tab's scene inside the fake Teams (`mock/teams.ts`), from
 * `?teams=`. Not remembered: outside that one page there is no Teams.
 */
const TEAMS_SCENES = ["unlinked", "linked", "target", "refused", "sso"] as const;
export type TeamsScene = (typeof TEAMS_SCENES)[number];
const teamsParam = params.get("teams");
export const teamsScene: TeamsScene | null =
  TEAMS_SCENES.find((scene) => scene === teamsParam) ?? null;

if (urlDirty) {
  const q = params.toString();
  window.history.replaceState(null, "", window.location.pathname + (q ? `?${q}` : ""));
}

export const H = 3_600_000;
export const D = 24 * H;
export const now = Date.now();
export const iso = (offsetMs: number) => new Date(now + offsetMs).toISOString();

// --- Deterministic pseudo-random (stable screenshots across reloads) ---
let seed = 42;
export const rand = () => {
  seed = (seed * 1664525 + 1013904223) % 4294967296;
  return seed / 4294967296;
};
export const pick = <T,>(xs: T[]): T => xs[Math.floor(rand() * xs.length)]!;

// --- Router ---

export class MockError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

/** A 422 that carries the issue list, as `PUT /draft` and publication do. */
export class MockValidation extends MockError {
  constructor(
    message: string,
    readonly details: { path: string[]; code: string; message: string }[],
  ) {
    super(422, message);
  }
}

/**
 * An error whose BODY is the answer, for the routes whose refusal carries
 * data the client branches on — `POST /questions/move` and its 409 listing
 * the classrooms that play the question (ADR-017).
 */
export class MockPayload extends MockError {
  constructor(
    status: number,
    readonly body: Record<string, unknown>,
  ) {
    super(status, String(body.message ?? ""));
  }
}

/** A refusal of the API: `{ error, message, ...extra }` under `status`, as the routes' error handlers answer. */
export const refuse = (status: number, error: string, message: string, extra: Record<string, unknown> = {}) =>
  new MockPayload(status, { error, message, ...extra });

export type Handler = (m: RegExpMatchArray, body: Record<string, unknown>, url: URL) => unknown;
export const routes: { method: string; re: RegExp; h: Handler }[] = [];
export const on = (method: string, path: string, h: Handler) =>
  routes.push({ method, re: new RegExp(`^${path.replace(/:(\w+)/g, "(?<$1>[^/]+)")}$`), h });


let seq = 100;
export const nextId = (p: string) => `${p}${(seq += 1)}`;
