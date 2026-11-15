/**
 * #1101: an open workspace is a live one. After the first load, code-server
 * speaks over websockets only, which the proxy's `preHandler` sees once, at the
 * upgrade; `lastSeen` then aged as if the tab were closed, and `collect`
 * closed the session `SESSION_GRACE_MS` later under the student's feet —
 * container removed, cookie rotated, so "Reconnect Now" and "Reload Window"
 * both met the 403, and only a new opening from the platform worked.
 *
 * Open sockets alone hold a session `SESSION_MAX_HELD_MS` at most after its
 * last page load: a forgotten tab must free its quota slot.
 *
 * A real portal with a fake engine, and a minimal websocket upstream on the
 * loopback, reached through `buildPortal`'s `upstreamPort`. The intervals and
 * `Date` are faked; the sockets keep real time.
 */
import { createHash } from "node:crypto";
import { createServer, request as httpRequest, type Server } from "node:http";
import type { AddressInfo, Socket } from "node:net";

import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { loadConfig } from "../auth/config.js";
import { openDb, type DbHandle } from "../db/client.js";
import { assignments, closedSittings, sessions, users } from "../db/schema.js";
import type { ContainerInfo, Engine } from "../engine/index.js";
import { EXAM_COOKIE, issueExamCookie } from "../seb/index.js";
import { buildPortal, type Portal } from "../server.js";

import { SESSION_COOKIE, SOCKET_HEARTBEAT_MS, cookieValue } from "./index.js";

const TOKEN = "test-session-token";
const PLATFORM = "https://quiz.example.test";
const EXAM_SECRET = "a-test-secret-long-enough-2";
const SITTING = "6f1c2a3b-0000-4000-8000-0000000000a1";
const IP = "127.0.0.1";
const GRACE_MS = 10 * 60 * 1000;
const MAX_HELD_MS = 60 * 60 * 1000;

/** Runs once, inside the next `inspect`: a close landing during the guard's awaits. */
let duringInspect: (() => void) | null = null;

const engine: Engine = {
  runArgs: () => [],
  containerName: (sessionId) => `cs-test-${sessionId}`,
  run: async (req) => ({ id: "ctr", name: req.name, sessionId: req.sessionId, state: "running", ip: IP }),
  inspect: async (name): Promise<ContainerInfo | null> => {
    duringInspect?.();
    duringInspect = null;
    return { id: "ctr", name, sessionId: "s1", state: "running", ip: IP };
  },
  stop: async () => undefined,
  rm: async () => undefined,
  listSessions: async () => [],
  waitHealthy: async () => 1,
  exec: async () => "",
};

/** code-server's stand-in: accepts any websocket and keeps it open. */
function upstream(): Promise<{ server: Server; open: Set<Socket>; port: number }> {
  const open = new Set<Socket>();
  const server = createServer((_req, res) => res.end("workbench"));
  server.on("upgrade", (req, socket: Socket) => {
    const accept = createHash("sha1")
      .update(`${String(req.headers["sec-websocket-key"])}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`)
      .digest("base64");
    socket.write(
      `HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`,
    );
    open.add(socket);
    // The browser sends nothing here: the only frame is the proxy's close, answered by hanging up.
    socket.on("data", () => socket.end());
    socket.on("close", () => open.delete(socket));
  });
  return new Promise((resolve) =>
    server.listen(0, IP, () => resolve({ server, open, port: (server.address() as AddressInfo).port })),
  );
}

/** A websocket upgrade as the browser sends it: the socket on a 101, else the status. */
function upgrade(port: number, cookie: string, sid = "s1"): Promise<{ status: number; socket?: Socket }> {
  return new Promise((resolve, reject) => {
    const req = httpRequest({
      host: IP,
      port,
      path: `/s/${sid}/stable-x/?reconnectionToken=r&reconnection=true`,
      headers: {
        connection: "Upgrade",
        upgrade: "websocket",
        "sec-websocket-key": "dGhlIHNhbXBsZSBub25jZQ==",
        "sec-websocket-version": "13",
        cookie,
      },
    });
    req.on("upgrade", (res, socket) => resolve({ status: res.statusCode ?? 101, socket }));
    req.on("response", (res) => {
      res.resume();
      resolve({ status: res.statusCode ?? 0 });
    });
    req.on("error", reject);
    req.end();
  });
}

const sessionCookie = (sid = "s1", token = TOKEN) => `${SESSION_COOKIE}=${cookieValue(sid, token)}`;

async function until(check: () => boolean): Promise<void> {
  for (let i = 0; i < 300 && !check(); i += 1) await new Promise((r) => setTimeout(r, 10));
  expect(check()).toBe(true);
}

let handle: DbHandle;
let portal: Portal;
let up: { server: Server; open: Set<Socket>; port: number };
let port: number;
const clients: Socket[] = [];

const row = (sid = "s1") => handle.db.select().from(sessions).where(eq(sessions.id, sid)).get()!;
/** Runs the collector now; whether it closed `sid`. */
async function collected(sid = "s1"): Promise<boolean> {
  await portal.manager.collect();
  return row(sid).state === "closed";
}
/** Lets the heartbeat run for `ms` of fake time. */
const elapse = (ms: number) => vi.advanceTimersByTime(ms);

async function open(sid = "s1"): Promise<void> {
  const before = up.open.size;
  const { status, socket } = await upgrade(port, sessionCookie(sid));
  expect(status).toBe(101);
  if (socket) clients.push(socket);
  await until(() => up.open.size === before + 1);
}

beforeEach(async () => {
  vi.useFakeTimers({ toFake: ["setInterval", "clearInterval", "Date"] });
  up = await upstream();
  handle = openDb(":memory:");
  const now = new Date();
  handle.db
    .insert(users)
    .values({ id: "u1", oidcSub: "sub-1", login: "student", email: "s@heig-vd.ch", displayName: "Sacha", role: "student", createdAt: now })
    .run();
  for (const [id, mode] of [
    ["tp", "lab"],
    ["ex", "exam"],
  ] as const) {
    handle.db
      .insert(assignments)
      .values({ id, title: id, mode, image: "codespace/c-dev:4.137.0", uploadPack: true, beks: [], createdAt: now })
      .run();
  }
  for (const [id, assignmentId] of [
    ["s1", "tp"],
    ["s2", "ex"],
  ] as const) {
    handle.db
      .insert(sessions)
      .values({
        id,
        userId: "u1",
        student: "student",
        assignmentId,
        containerId: "ctr",
        containerName: `cs-${id}`,
        containerIp: IP,
        volumeDir: `/tmp/vol/${id}`,
        state: "running",
        createdAt: now,
        lastSeen: now,
        cookieToken: TOKEN,
        sebVerified: false,
      })
      .run();
  }
  portal = await buildPortal({
    config: loadConfig({
      EXAM_COOKIE_SECRET: EXAM_SECRET,
      SEB_VERIFIER: "simulated",
      TRUST_PROXY: "1",
      LOG_LEVEL: "fatal",
      PLATFORM_URL: PLATFORM,
      SESSION_GRACE_MS: String(GRACE_MS),
      SESSION_MAX_HELD_MS: String(MAX_HELD_MS),
    }),
    dbHandle: handle,
    engine,
    withGitServer: false,
    withTimers: false,
    upstreamPort: up.port,
  });
  await portal.app.listen({ host: IP, port: 0 });
  port = (portal.app.server.address() as AddressInfo).port;
});

afterEach(async () => {
  for (const socket of clients.splice(0)) socket.destroy();
  for (const socket of up.open) socket.destroy();
  duringInspect = null;
  await new Promise((r) => up.server.close(r));
  await portal.close();
  vi.useRealTimers();
});

describe("an open workspace is a live one (#1101)", () => {
  it("keeps a session whose websocket stays open past the grace period", async () => {
    // A websocket with no page load before it: a reconnect after a portal
    // restart. Its hold counts from now, not from nothing.
    await open();
    elapse(GRACE_MS + 5 * 60 * 1000);
    expect(Date.now() - row().lastSeen.getTime()).toBeLessThanOrEqual(SOCKET_HEARTBEAT_MS);
    expect(await collected()).toBe(false);
  });

  it("starts the grace period when the last websocket closes, and the stale tab is sent back to the platform", async () => {
    await open();
    clients.splice(0).forEach((s) => s.destroy());
    // The proxy tears the upstream down with the browser's socket.
    await until(() => up.open.size === 0);
    const closedAt = row().lastSeen.getTime();
    elapse(SOCKET_HEARTBEAT_MS);
    expect(row().lastSeen.getTime()).toBe(closedAt);

    await portal.manager.collect(new Date(closedAt + GRACE_MS - 1000));
    expect(row().state).toBe("running");
    await portal.manager.collect(new Date(closedAt + GRACE_MS + 1000));
    expect(row().state).toBe("closed");

    // The tab left open: "Reconnect Now" and "Reload Window" with the old cookie.
    expect((await upgrade(port, sessionCookie())).status).toBe(403);
    const reload = await portal.app.inject({
      method: "GET",
      url: "/s/s1/",
      cookies: { [SESSION_COOKIE]: cookieValue("s1", TOKEN) },
      headers: { "accept-language": "en" },
    });
    expect(reload.statusCode).toBe(403);
    expect(reload.body).toContain(`href="${PLATFORM}"`);
    expect(reload.body).toContain("Open it again from the platform");
  });

  it("counts a socket only through the upgrade path: an Upgrade header on a plain request holds nothing", async () => {
    const res = await portal.app.inject({
      method: "GET",
      url: "/s/s1/static/x.js",
      cookies: { [SESSION_COOKIE]: cookieValue("s1", TOKEN) },
      headers: { upgrade: "websocket" },
    });
    // Past the guard (the upstream client then refuses the stray header): not a refusal.
    expect([403, 404, 410]).not.toContain(res.statusCode);
    elapse(GRACE_MS + 2 * 60 * 1000);
    expect(await collected()).toBe(true);
  });
});

describe("a refused upgrade is never counted", () => {
  it("with a stale cookie", async () => {
    expect((await upgrade(port, sessionCookie("s1", "rotated-away"))).status).toBe(403);
    elapse(GRACE_MS + 2 * 60 * 1000);
    expect(await collected()).toBe(true);
  });

  it("with a station's cookie whose sitting closed while the guard waited", async () => {
    const exam = issueExamCookie(
      { assignmentId: "ex", sessionId: "s2", clientAddress: IP, issuedAt: Date.now(), sitting: SITTING },
      { secret: EXAM_SECRET },
    );
    duringInspect = () => void handle.db.insert(closedSittings).values({ sitting: SITTING, closedAt: new Date() }).run();
    expect((await upgrade(port, `${sessionCookie("s2")}; ${EXAM_COOKIE}=${exam}`, "s2")).status).toBe(403);
    expect(duringInspect).toBeNull();
    elapse(GRACE_MS + 2 * 60 * 1000);
    expect(await collected("s2")).toBe(true);
  });
});

describe("open sockets alone hold a session SESSION_MAX_HELD_MS at most", () => {
  it("collects a forgotten tab past the cap plus the grace, its socket still open", async () => {
    await open();
    elapse(MAX_HELD_MS - 5 * 60 * 1000);
    expect(await collected()).toBe(false);
    elapse(5 * 60 * 1000 + GRACE_MS + 2 * 60 * 1000);
    expect(up.open.size).toBe(1);
    expect(await collected()).toBe(true);
  });

  it("renews the hold on a page reload, not on a websocket reconnect", async () => {
    await open();
    elapse(MAX_HELD_MS / 2);
    // A reconnect: a second socket, no page load. The hold still counts from the first.
    await open();
    elapse(MAX_HELD_MS / 2 - 60 * 1000);
    const reload = await portal.app.inject({
      method: "GET",
      url: "/s/s1/",
      cookies: { [SESSION_COOKIE]: cookieValue("s1", TOKEN) },
    });
    expect(reload.statusCode).toBe(200);
    elapse(MAX_HELD_MS / 2);
    expect(Date.now() - row().lastSeen.getTime()).toBeLessThanOrEqual(SOCKET_HEARTBEAT_MS);
    expect(await collected()).toBe(false);
  });

  it("without the reload, the reconnect does not renew it", async () => {
    await open();
    elapse(MAX_HELD_MS / 2);
    await open();
    elapse(MAX_HELD_MS / 2 + GRACE_MS + 2 * 60 * 1000);
    expect(await collected()).toBe(true);
  });
});
