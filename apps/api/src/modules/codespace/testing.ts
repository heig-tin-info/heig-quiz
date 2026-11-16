/**
 * The fakes and fixtures the online workspace's tests share (`codespace.db`,
 * `relay.db`, `review.db`, and the access sweep's server): the portal on
 * `portal.test`, GitHub's scoped token mint, the captured log, a teacher
 * with or without the workspace grant, a classroom connected to a fresh
 * organization. Each test file builds its own instances.
 *
 * Test support only; nothing in the application imports it.
 */
import { randomUUID } from "node:crypto";

import { teacherGrants } from "../../db/schema.js";
import { json, type Route } from "../../github/testing.js";
import type { TestServer } from "../../test/http.js";
import { seedLive, type Seeded } from "../../test/live.js";
import { gh, linkClassroom, newOrg, server, world } from "../../test/projectWorld.js";

export const PORTAL = "http://portal.test";
export const PORTAL_SECRET = "s".repeat(40);
/** The configuration that turns the online workspace on, beside the App's. */
export const CODESPACE_ENV = { CODESPACE_URL: PORTAL, CODESPACE_LAUNCH_SECRET: PORTAL_SECRET };

/**
 * The body of `PUT …/workspace/mode` for `mode`: under supervision with a
 * device level (ADR-089), SEB by default — the level M6-07's `online_seb`
 * had.
 */
export const workModeBody = (mode: string, devices = "seb"): { mode: string; devices?: string } =>
  mode === "online_seb" ? { mode, devices } : { mode };

/** A call the stub portal received. */
export interface PortalCall {
  method: string;
  path: string;
  authorization: string | null;
  body: unknown;
  /** The body's exact text, as the portal hashes it. */
  raw: string | null;
}

/**
 * The portal: it accepts a sync (`PUT /api/assignments/:id`, or answers
 * `putStatus`), lists `sessions` (or answers that status), and is
 * unreachable while `down`. `fetch` hands anything else to the fake GitHub.
 */
export function fakePortal() {
  const portal = {
    calls: [] as PortalCall[],
    /** What `PUT /api/assignments/:id` answers. */
    putStatus: 200,
    /** What `GET /api/assignments/:id/sessions` answers: a body, or a status. */
    sessions: [] as unknown[] | number,
    /** What `POST /api/assignments/:id/collections` answers (ADR-130): a body from the order, or a status. */
    collect: 404 as ((order: Record<string, unknown>) => unknown) | number,
    down: false,
    fetch: (input: string | URL | Request, init: RequestInit = {}): Promise<Response> => {
      const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
      return url.origin === PORTAL ? answer(url, init) : gh.fetch(input, init);
    },
  };
  async function answer(url: URL, init: RequestInit): Promise<Response> {
    if (portal.down) throw new TypeError("fetch failed");
    const headers = new Headers(init.headers);
    const body = typeof init.body === "string" ? JSON.parse(init.body) : null;
    const raw = typeof init.body === "string" ? init.body : null;
    portal.calls.push({ method: init.method ?? "GET", path: url.pathname, authorization: headers.get("authorization"), body, raw });
    if (init.method === "PUT" && /^\/api\/assignments\/[^/]+$/.test(url.pathname)) {
      if (portal.putStatus !== 200) return json({ error: "nope" }, portal.putStatus);
      return json({ id: (body as { id: string }).id, configKey: null, sebLink: null });
    }
    if (/^\/api\/assignments\/[^/]+\/sessions$/.test(url.pathname)) {
      return typeof portal.sessions === "number" ? json({ error: "x" }, portal.sessions) : json(portal.sessions);
    }
    if (init.method === "POST" && /^\/api\/assignments\/[^/]+\/collections$/.test(url.pathname)) {
      return typeof portal.collect === "number" ? json({ error: "x" }, portal.collect) : json(await portal.collect(body as Record<string, unknown>));
    }
    return json({ error: "not_found" }, 404);
  }
  return portal;
}

/** A token GitHub minted on the scoped route: its installation, its body, the token. */
export interface Minted {
  installationId: number;
  body: { repository_ids?: number[]; permissions?: Record<string, string> };
  token: string;
}

/**
 * GitHub's scoped mint: an access token asked with `repository_ids` (the
 * App's own installation tokens fall through), recorded in `minted`, an
 * hour long by the test clock; `status` set, GitHub answers it instead.
 */
export function scopedMint() {
  const mint = {
    minted: [] as Minted[],
    status: null as number | null,
    route: ((url, init) => {
      const m = /^\/app\/installations\/(\d+)\/access_tokens$/.exec(url.pathname);
      if (url.host !== "api.github.com" || init.method !== "POST" || !m || typeof init.body !== "string") return undefined;
      const body = JSON.parse(init.body) as Minted["body"];
      if (!body.repository_ids) return undefined;
      if (mint.status !== null) return json({ message: "boom" }, mint.status);
      const token = `ghs_scoped${randomUUID().replaceAll("-", "")}`;
      mint.minted.push({ installationId: Number(m[1]), body, token });
      return json({ token, expires_at: new Date(server.clock.now().getTime() + 3_600_000).toISOString() }, 201);
    }) as Route,
  };
  return mint;
}

/** Every line pino writes (the request loggers share `app.log`'s stream), from now on, into the returned array. */
export function captureLog(app: TestServer["app"]): string[] {
  const lines: string[] = [];
  const log = app.log as unknown as Record<symbol, { write: (line: string) => boolean }>;
  const streamSym = Object.getOwnPropertySymbols(Object.getPrototypeOf(log))
    .concat(Object.getOwnPropertySymbols(log))
    .find((s) => s.description === "pino.stream");
  if (!streamSym) throw new Error("pino stream not found");
  log[streamSym]!.write = (line: string) => {
    lines.push(line);
    return true;
  };
  app.log.level = "trace";
  return lines;
}

/** A teacher whose `teacher_grants` row says `enabled` (no row at all with `null`). */
export async function grantedTeacher(enabled: boolean | null, maxActiveSessions = 3) {
  const email = `t-${randomUUID().slice(0, 8)}@heig.test`;
  const signed = await server.signIn("teacher", email);
  if (enabled !== null) {
    await server.app.db.insert(teacherGrants).values({
      id: randomUUID(),
      email,
      createdBy: signed.id,
      codespaceEnabled: enabled,
      codespaceMaxActiveSessions: maxActiveSessions,
    });
  }
  return signed;
}

export interface Room extends Seeded {
  org: string;
  installationId: number;
}

/** A classroom of `teacher`'s course, `students` enrolled, connected to a fresh organization (`prefix`) holding `starter` with `files`. */
export async function connectedClassroom(
  teacher: { id: string },
  students: { id: string }[],
  { prefix, files = { "README.md": "# Lab" } }: { prefix: string; files?: Record<string, string> },
): Promise<Room> {
  const seeded = await seedLive(server.app.db, { teacherId: teacher.id, studentIds: students.map((s) => s.id), questions: 0 });
  const { n, login: org, orgId } = await newOrg(prefix);
  world.source(org, "starter", { main: files });
  await linkClassroom(seeded.classroomId, orgId, teacher.id);
  return { ...seeded, org, installationId: n };
}
