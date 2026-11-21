/**
 * The close of a kiosk sitting through a real portal (ADR-089, amendment of
 * 2026-11-15, point 4): the proxy, the platform route and the database, with
 * a fake engine whose "container" is a local upstream answering HTTP and
 * websocket upgrades. What it holds: a close drops every socket upgraded
 * under that sitting's cookie — whoever holds the session by then — and no
 * other; it revokes that sitting's `exam_session` cookies, never a `seb`
 * one; and the revocation survives a restart of the portal.
 */
import { createHash } from "node:crypto";
import { createServer, request as httpRequest, type Server } from "node:http";
import type { AddressInfo, Socket } from "node:net";

import { signHs256 } from "@quiz/domain";
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { loadConfig, type AppConfig } from "../auth/config.js";
import { openDb, type DbHandle } from "../db/client.js";
import { assignments, sessions, users } from "../db/schema.js";
import type { ContainerInfo, Engine } from "../engine/index.js";
import { SESSION_COOKIE, cookieValue } from "../proxy/index.js";
import { EXAM_COOKIE, issueExamCookie } from "../seb/index.js";
import { buildPortal, type Portal } from "../server.js";

import { createSittingSockets, sittingRetentionMs } from "./sittings.js";

const SECRET = "test-launch-secret-0123456789012345";
const EXAM_SECRET = "a-test-secret-long-enough-2";
const SITTING = "6f1c2a3b-0000-4000-8000-0000000000a1";
const OTHER = "6f1c2a3b-0000-4000-8000-0000000000a2";

/** code-server as the proxy sees it: 200 on a request, 101 on an upgrade, then silence. */
async function startUpstream(): Promise<{ server: Server; port: number; sockets: Set<Socket> }> {
  const sockets = new Set<Socket>();
  const server = createServer((_req, res) => res.end("ok"));
  server.on("upgrade", (req, socket: Socket) => {
    sockets.add(socket);
    const accept = createHash("sha1")
      .update(`${String(req.headers["sec-websocket-key"])}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`)
      .digest("base64");
    socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`);
    socket.on("error", () => undefined);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return { server, port: (server.address() as AddressInfo).port, sockets };
}

/** When set, `inspect` (hence `ensureRunning`) calls it and waits for it: a slow container check. */
let slowInspect: (() => Promise<void>) | null = null;

const engine: Engine = {
  runArgs: () => [],
  containerName: (sessionId) => `cs-test-${sessionId}`,
  run: async (req) => ({ id: "ctr", name: req.name, sessionId: req.sessionId, state: "running", ip: "127.0.0.1" }),
  inspect: async (name): Promise<ContainerInfo | null> => {
    await slowInspect?.();
    return { id: "ctr", name, sessionId: name, state: "running", ip: "127.0.0.1" };
  },
  stop: async () => undefined,
  rm: async () => undefined,
  listSessions: async () => [],
  waitHealthy: async () => 1,
  exec: async () => "",
};

let handle: DbHandle;
let config: AppConfig;
let portal: Portal;
let upstream: Awaited<ReturnType<typeof startUpstream>>;
let port: number;
const clients: Socket[] = [];

async function startPortal(): Promise<void> {
  portal = await buildPortal({ config, dbHandle: handle, engine, withGitServer: false, withTimers: false, upstreamPort: upstream.port });
  await portal.app.listen({ host: "127.0.0.1", port: 0 });
  port = (portal.app.server.address() as AddressInfo).port;
}

/** A session of `id` on the exam, its cookies as the launch set them: under `sitting`, or SEB's (none). */
function seat(id: string, sitting: string | null): string {
  const at = new Date();
  handle.db.insert(users).values({ id: `user-${id}`, oidcSub: `classroom:${id}`, login: id, email: `${id}@heig-vd.ch`, displayName: id, createdAt: at }).run();
  handle.db
    .insert(sessions)
    .values({ id, userId: `user-${id}`, student: id, assignmentId: "ex", containerName: `cs-${id}`, containerIp: "127.0.0.1", volumeDir: `/tmp/${id}`, state: "running", createdAt: at, lastSeen: at, cookieToken: `tok-${id}`, sebVerified: sitting === null, openedBySitting: sitting })
    .run();
  const exam = issueExamCookie(
    { assignmentId: "ex", sessionId: id, clientAddress: "127.0.0.1", issuedAt: Date.now(), ...(sitting ? { sitting } : {}) },
    { secret: EXAM_SECRET },
  );
  return `${SESSION_COOKIE}=${cookieValue(id, `tok-${id}`)}; ${EXAM_COOKIE}=${exam}`;
}

/** A websocket upgraded through the proxy: the client's socket once the 101 arrived. */
function upgrade(id: string, cookie: string): Promise<Socket> {
  return new Promise((resolve, reject) => {
    const req = httpRequest({
      host: "127.0.0.1",
      port,
      path: `/s/${id}/stable/socket`,
      headers: { connection: "Upgrade", upgrade: "websocket", "sec-websocket-key": "dGhlIHNhbXBsZSBub25jZQ==", "sec-websocket-version": "13", cookie },
    });
    req.on("upgrade", (res, socket) => {
      clients.push(socket);
      socket.on("error", () => undefined);
      if (res.statusCode === 101) resolve(socket);
      else reject(new Error(`no 101: ${res.statusCode}`));
    });
    req.on("response", (res) => reject(new Error(`no upgrade: ${res.statusCode}`)));
    req.on("error", reject);
    req.end();
  });
}

/** Whether `socket` closes within `ms`. */
function closesWithin(socket: Socket, ms: number): Promise<boolean> {
  if (socket.destroyed || socket.closed) return Promise.resolve(true);
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(false), ms);
    socket.once("close", () => {
      clearTimeout(timer);
      resolve(true);
    });
  });
}

async function close(sitting: string): Promise<number> {
  const iat = Math.floor(Date.now() / 1000);
  const token = await signHs256(
    { iss: "heig-quiz", aud: "heig-codespace-sitting-close", iat, exp: iat + 120, jti: `close-${Math.random()}`, sitting, projectId: null },
    SECRET,
  );
  const reply = await portal.app.inject({ method: "POST", url: "/api/sittings/close", headers: { authorization: `Bearer ${token}` } });
  return reply.statusCode;
}

const get = (id: string, cookie: string) => portal.app.inject({ method: "GET", url: `/s/${id}/x`, headers: { cookie } });

beforeEach(async () => {
  upstream = await startUpstream();
  handle = openDb(":memory:");
  config = loadConfig({ CODESPACE_LAUNCH_SECRET: SECRET, EXAM_COOKIE_SECRET: EXAM_SECRET, SEB_VERIFIER: "simulated", LOG_LEVEL: "fatal" });
  handle.db.insert(assignments).values({ id: "ex", title: "ex", mode: "exam", image: "codespace/c-dev:4.137.0", uploadPack: true, beks: [], createdAt: new Date() }).run();
  await startPortal();
});

afterEach(async () => {
  slowInspect = null;
  for (const socket of clients.splice(0)) socket.destroy();
  for (const socket of upstream.sockets) socket.destroy();
  await portal.close();
  await new Promise((resolve) => upstream.server.close(resolve));
  handle.close();
});

describe("the close of a kiosk sitting (ADR-089)", () => {
  it("drops every socket of that sitting, and leaves a seb session's and another sitting's open", async () => {
    const station = seat("station", SITTING);
    const neighbour = seat("neighbour", OTHER);
    const seb = seat("seb", null);
    const mine = [await upgrade("station", station), await upgrade("station", station)];
    const others = [await upgrade("neighbour", neighbour), await upgrade("seb", seb)];

    expect(await close(SITTING)).toBe(204);
    for (const socket of mine) expect(await closesWithin(socket, 2000)).toBe(true);
    for (const socket of others) expect(await closesWithin(socket, 200)).toBe(false);
    expect((await get("seb", seb)).statusCode).toBe(200);
    expect((await get("neighbour", neighbour)).statusCode).toBe(200);
  });

  it("drops the station's sockets even after another browser resumed the session", async () => {
    const station = seat("station", SITTING);
    const socket = await upgrade("station", station);
    // The student resumed it from their own browser: a new cookie, another opener.
    handle.db.update(sessions).set({ openedBySitting: null, cookieToken: "tok-resumed" }).where(eq(sessions.id, "station")).run();

    expect(await close(SITTING)).toBe(204);
    expect(await closesWithin(socket, 2000)).toBe(true);
    // The resumed session's cookie stays; the station's cookie no longer opens anything.
    expect(handle.db.select().from(sessions).where(eq(sessions.id, "station")).get()?.cookieToken).toBe("tok-resumed");
  });

  it("revokes that sitting's exam cookie, and the revocation survives a restart", async () => {
    const station = seat("station", SITTING);
    const seb = seat("seb", null);
    // The session cookie is not rotated, as after a resumption elsewhere:
    // only the exam cookie's revocation stands in the way.
    handle.db.update(sessions).set({ openedBySitting: null }).where(eq(sessions.id, "station")).run();
    expect((await get("station", station)).statusCode).toBe(200);

    expect(await close(SITTING)).toBe(204);
    const refused = await get("station", station);
    expect(refused.statusCode).toBe(403);
    // The station's words, not the SEB page.
    expect(refused.body).toContain("Your session on this station has ended");
    expect(refused.body).not.toContain("Safe Exam Browser");

    await portal.close();
    await startPortal();
    expect((await get("station", station)).statusCode).toBe(403);
    await expect(upgrade("station", station)).rejects.toThrow();
    expect((await get("seb", seb)).statusCode).toBe(200);
  });
});

describe("a close during an upgrade (ADR-089)", () => {
  it("leaves no socket of the sitting when it lands while the proxy awaits the container", async () => {
    const station = seat("station", SITTING);
    let closeRan!: () => void;
    const closed = new Promise<void>((resolve) => (closeRan = resolve));
    // The first check of the guard passed; the close lands during `ensureRunning`.
    slowInspect = async () => {
      slowInspect = null;
      expect(await close(SITTING)).toBe(204);
      closeRan();
    };
    const upgraded = upgrade("station", station).then(
      (socket) => closesWithin(socket, 2000),
      () => true,
    );
    await closed;
    expect(await upgraded).toBe(true);
  });
});

describe("the socket registry", () => {
  it("forgets a socket once it closed, and drops nothing twice", async () => {
    const sockets = createSittingSockets();
    const { Socket: NetSocket } = await import("node:net");
    const a = new NetSocket();
    sockets.track(SITTING, a);
    a.destroy();
    await new Promise((resolve) => setImmediate(resolve));
    expect(sockets.drop(SITTING)).toBe(0);
    const b = new NetSocket();
    sockets.track(SITTING, b);
    expect(sockets.drop(SITTING)).toBe(1);
    expect(b.destroyed).toBe(true);
    expect(sockets.drop(SITTING)).toBe(0);
  });

  it("keeps a closed sitting as long as one of its cookies or launch tokens can live", () => {
    expect(sittingRetentionMs(4 * 3600_000)).toBe(4 * 3600_000);
    expect(sittingRetentionMs(1000)).toBeGreaterThanOrEqual(300_000);
  });
});
