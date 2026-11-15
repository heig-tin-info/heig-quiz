/**
 * #1101: an open workspace is a live one. After the first load, code-server
 * speaks over websockets only, which the proxy's `preHandler` sees once, at the
 * upgrade; `lastSeen` then aged as if the tab were closed, and `collect`
 * closed the session `SESSION_GRACE_MS` later under the student's feet —
 * container removed, cookie rotated, so "Reconnect Now" and "Reload Window"
 * both met the 403, and only a new opening from the platform worked.
 *
 * A real portal with a fake engine, and a minimal websocket upstream on the
 * loopback, reached through `buildPortal`'s `upstreamPort`.
 */
import { createHash } from "node:crypto";
import { createServer, request as httpRequest, type Server } from "node:http";
import type { AddressInfo, Socket } from "node:net";

import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { loadConfig } from "../auth/config.js";
import { openDb, type DbHandle } from "../db/client.js";
import { assignments, sessions, users } from "../db/schema.js";
import type { ContainerInfo, Engine } from "../engine/index.js";
import { buildPortal, type Portal } from "../server.js";

import { SESSION_COOKIE, SOCKET_HEARTBEAT_MS, cookieValue } from "./index.js";

const TOKEN = "test-session-token";
const PLATFORM = "https://quiz.example.test";
const IP = "127.0.0.1";
const GRACE_MS = 10 * 60 * 1000;

const engine: Engine = {
  runArgs: () => [],
  containerName: (sessionId) => `cs-test-${sessionId}`,
  run: async (req) => ({ id: "ctr", name: req.name, sessionId: req.sessionId, state: "running", ip: IP }),
  inspect: async (name): Promise<ContainerInfo | null> => ({ id: "ctr", name, sessionId: "s1", state: "running", ip: IP }),
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
function upgrade(port: number, cookie: string): Promise<{ status: number; socket?: Socket }> {
  return new Promise((resolve, reject) => {
    const req = httpRequest({
      host: "127.0.0.1",
      port,
      path: "/s/s1/stable-x/?reconnectionToken=r&reconnection=true",
      headers: {
        connection: "Upgrade",
        upgrade: "websocket",
        "sec-websocket-key": "dGhlIHNhbXBsZSBub25jZQ==",
        "sec-websocket-version": "13",
        cookie: `${SESSION_COOKIE}=${cookie}`,
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

async function until(check: () => boolean): Promise<void> {
  for (let i = 0; i < 300 && !check(); i += 1) await new Promise((r) => setTimeout(r, 10));
  expect(check()).toBe(true);
}

let handle: DbHandle;
let portal: Portal;
let up: { server: Server; open: Set<Socket>; port: number };
let port: number;

const row = () => handle.db.select().from(sessions).where(eq(sessions.id, "s1")).get()!;

beforeEach(async () => {
  // Only the intervals are faked: the sockets and the database keep real time.
  vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
  up = await upstream();
  handle = openDb(":memory:");
  const now = new Date();
  handle.db
    .insert(users)
    .values({ id: "u1", oidcSub: "sub-1", login: "student", email: "s@heig-vd.ch", displayName: "Sacha", role: "student", createdAt: now })
    .run();
  handle.db
    .insert(assignments)
    .values({ id: "tp", title: "tp", mode: "lab", image: "codespace/c-dev:4.137.0", uploadPack: true, beks: [], createdAt: now })
    .run();
  handle.db
    .insert(sessions)
    .values({
      id: "s1",
      userId: "u1",
      student: "student",
      assignmentId: "tp",
      containerId: "ctr",
      containerName: "cs-s1",
      containerIp: IP,
      volumeDir: "/tmp/vol/s1",
      state: "running",
      createdAt: now,
      lastSeen: now,
      cookieToken: TOKEN,
      sebVerified: false,
    })
    .run();
  portal = await buildPortal({
    config: loadConfig({
      EXAM_COOKIE_SECRET: "a-test-secret-long-enough-2",
      SEB_VERIFIER: "simulated",
      TRUST_PROXY: "1",
      LOG_LEVEL: "fatal",
      PLATFORM_URL: PLATFORM,
      SESSION_GRACE_MS: String(GRACE_MS),
    }),
    dbHandle: handle,
    engine,
    withGitServer: false,
    withTimers: false,
    upstreamPort: up.port,
  });
  await portal.app.listen({ host: "127.0.0.1", port: 0 });
  port = (portal.app.server.address() as AddressInfo).port;
});

afterEach(async () => {
  for (const socket of up.open) socket.destroy();
  await new Promise((r) => up.server.close(r));
  await portal.close();
  vi.useRealTimers();
});

describe("an open workspace is a live one (#1101)", () => {
  it("keeps a session whose websocket stays open past the grace period", async () => {
    const { status, socket } = await upgrade(port, cookieValue("s1", TOKEN));
    expect(status).toBe(101);
    await until(() => up.open.size === 1);

    // No HTTP request for an hour, the editor open all along.
    const hourAgo = new Date(Date.now() - 60 * 60 * 1000);
    handle.db.update(sessions).set({ lastSeen: hourAgo }).where(eq(sessions.id, "s1")).run();
    vi.advanceTimersByTime(SOCKET_HEARTBEAT_MS);

    expect(row().lastSeen.getTime()).toBeGreaterThan(hourAgo.getTime());
    expect((await portal.manager.collect()).closed).toBe(0);
    expect(row().state).toBe("running");
    socket?.destroy();
  });

  it("starts the grace period when the last websocket closes, and the stale tab is sent back to the platform", async () => {
    const { socket } = await upgrade(port, cookieValue("s1", TOKEN));
    await until(() => up.open.size === 1);
    socket?.destroy();
    // The proxy tears the upstream down with the browser's socket.
    await until(() => up.open.size === 0);
    const closedAt = row().lastSeen.getTime();
    vi.advanceTimersByTime(SOCKET_HEARTBEAT_MS);
    expect(row().lastSeen.getTime()).toBe(closedAt);

    expect((await portal.manager.collect(new Date(closedAt + GRACE_MS - 1000))).closed).toBe(0);
    expect((await portal.manager.collect(new Date(closedAt + GRACE_MS + 1000))).closed).toBe(1);
    expect(row().state).toBe("closed");

    // The tab left open: "Reconnect Now" and "Reload Window" with the old cookie.
    expect((await upgrade(port, cookieValue("s1", TOKEN))).status).toBe(403);
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
});
