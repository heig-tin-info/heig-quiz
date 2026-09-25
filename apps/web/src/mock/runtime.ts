/**
 * The mock's runtime: what every section of the fake backend needs and what
 * none of them owns — the persona and the scene flags read from the URL, the
 * frozen clock and the deterministic RNG, the error types a handler throws,
 * and the route table itself. It imports nothing from the sections, which is
 * what keeps the module graph of the mock acyclic (`index.ts` explains the
 * layout).
 */
import type {
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
export const FLAG_NAMES = ["empty", "fail", "slow", "many", "mytest"] as const;
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

/**
 * The student player's scene, remembered the same way. It picks what the
 * fake backend serves on ONE evaluation (section 4) and changes nothing
 * anywhere else.
 */
export type Scene =
  | "lobby"
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

export type Handler = (m: RegExpMatchArray, body: Record<string, unknown>, url: URL) => unknown;
export const routes: { method: string; re: RegExp; h: Handler }[] = [];
export const on = (method: string, path: string, h: Handler) =>
  routes.push({ method, re: new RegExp(`^${path.replace(/:(\w+)/g, "(?<$1>[^/]+)")}$`), h });


let seq = 100;
export const nextId = (p: string) => `${p}${(seq += 1)}`;
