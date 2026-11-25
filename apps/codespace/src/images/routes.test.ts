/**
 * The image routes (ADR-146) behind the service token: bound to their
 * request (query included), single use, every input through its
 * `@quiz/contracts` schema. The admitted set is a stub here; its behaviour
 * is `admission.test.ts`.
 */
import cookie from "@fastify/cookie";
import {
  CodespaceBaseImage,
  CodespaceEngineImage,
  CodespaceImageAdmission,
  imageAdmissionPath,
  imagePath,
  IMAGE_ADMISSIONS_PATH,
  IMAGE_BASE_PATH,
  IMAGES_PATH,
} from "@quiz/contracts";
import { requestBinding, signHs256 } from "@quiz/domain";
import Fastify, { type FastifyInstance } from "fastify";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { loadConfig } from "../auth/config.js";
import { classroomRoutes } from "../classroom/routes.js";
import { openDb, type DbHandle } from "../db/client.js";
import { createSebVerifier } from "../seb/index.js";
import type { SessionManager } from "../sessions/manager.js";
import { createSittingSockets } from "../sessions/sittings.js";

import type { AdmissionRequestResult, ImageAdmissions, RemoveResult } from "./admission.js";

const SECRET = "test-launch-secret-0123456789012345";
const DIGEST = `sha256:${"c".repeat(64)}`;
const REF = `ghcr.io/heig/lab-go@${DIGEST}`;
const now = () => Math.floor(Date.now() / 1000);
let jti = 0;

async function token(method: string, url: string, body?: unknown): Promise<string> {
  jti += 1;
  return signHs256(
    {
      iss: "heig-quiz",
      aud: "heig-codespace-api",
      iat: now(),
      exp: now() + 120,
      jti: `img-${jti}`,
      ...(await requestBinding(method, url, body === undefined ? undefined : JSON.stringify(body))),
    },
    SECRET,
  );
}

const ADMISSION = {
  reference: REF,
  digest: DIGEST,
  state: "downloading" as const,
  reason: null,
  detail: null,
  baseVersion: null,
  compressedBytes: null,
  diskBytes: null,
  updatedAt: new Date().toISOString(),
};

function stub(): ImageAdmissions & { asked: string[]; removed: string[] } {
  const asked: string[] = [];
  const removed: string[] = [];
  let bases = 0;
  let removal: RemoveResult = "removed";
  return {
    asked,
    removed,
    async request(reference): Promise<AdmissionRequestResult> {
      asked.push(reference);
      if (reference.includes("private")) return { status: 422, error: { error: "not_public", detail: "401" } };
      return { status: 202, admission: ADMISSION };
    },
    get: (reference) => (reference === REF ? ADMISSION : null),
    async base() {
      bases += 1;
      if (bases === 1) return null;
      if (bases === 2) throw new Error("ghcr.io unreachable");
      return { reference: `ghcr.io/heig-tin-info/quiz-base@sha256:${"b".repeat(64)}`, digest: `sha256:${"b".repeat(64)}`, version: "1.0.0" };
    },
    list: async () => [
      { id: "sha256:1", names: [REF], diskBytes: 1, kind: "admitted", admissions: [{ reference: REF, digest: DIGEST, source: "course", state: "ready", lastUsedAt: null, liveSessions: 2 }] },
    ],
    async remove(reference) {
      removed.push(reference);
      const r = removal;
      removal = "image_in_use";
      return r;
    },
    runnable: async () => true,
    markUsed: () => undefined,
    startup: async () => undefined,
    idle: async () => undefined,
  };
}

let app: FastifyInstance;
let handle: DbHandle;
let images: ReturnType<typeof stub>;

beforeEach(async () => {
  const config = loadConfig({ NODE_ENV: "test", LOG_LEVEL: "fatal", CODESPACE_LAUNCH_SECRET: SECRET, SEB_VERIFIER: "simulated", DATABASE_PATH: ":memory:" });
  handle = openDb(":memory:");
  images = stub();
  app = Fastify({ logger: false });
  await app.register(cookie);
  await app.register(classroomRoutes, {
    config,
    db: handle.db,
    manager: {} as SessionManager,
    verifier: createSebVerifier({ mode: "simulated", nodeEnv: "test", url: { publicOrigin: "http://portal.test" } }),
    sittingSockets: createSittingSockets(),
    images,
  });
  await app.ready();
});
afterEach(async () => {
  await app.close();
  handle.close();
});

async function call(method: "GET" | "POST" | "DELETE", url: string, body?: unknown, auth?: string | null) {
  const bearer = auth === undefined ? await token(method, url, body) : auth;
  return app.inject({
    method,
    url,
    ...(bearer === null ? {} : { headers: { authorization: `Bearer ${bearer}` } }),
    ...(body === undefined ? {} : { payload: body as object }),
  });
}

describe("the image routes", () => {
  it("answer 401 without a token, on a token bound elsewhere (another query included), and on a replay", async () => {
    expect((await call("GET", IMAGES_PATH, undefined, null)).statusCode).toBe(401);
    expect((await call("GET", IMAGES_PATH, undefined, await token("GET", IMAGE_BASE_PATH))).statusCode).toBe(401);
    expect((await call("DELETE", imagePath(REF), undefined, await token("GET", imagePath(REF)))).statusCode).toBe(401);
    const other = `ghcr.io/heig/other@${DIGEST}`;
    expect((await call("DELETE", imagePath(REF), undefined, await token("DELETE", imagePath(other)))).statusCode).toBe(401);
    expect(images.removed).toEqual([]);
    const once = await token("POST", IMAGE_ADMISSIONS_PATH, { reference: "debian" });
    expect((await call("POST", IMAGE_ADMISSIONS_PATH, { reference: "debian" }, once)).statusCode).toBe(202);
    expect((await call("POST", IMAGE_ADMISSIONS_PATH, { reference: "debian" }, once)).statusCode).toBe(401);
    // A token for one body never carries another.
    expect((await call("POST", IMAGE_ADMISSIONS_PATH, { reference: "ubuntu" }, await token("POST", IMAGE_ADMISSIONS_PATH, { reference: "debian" }))).statusCode).toBe(401);
  });

  it("POST: the reference through its schema, canonical, then the admission's 202 or the 422", async () => {
    const asked = await call("POST", IMAGE_ADMISSIONS_PATH, { reference: "ghcr.io/heig/lab-go:1" });
    expect(asked.statusCode).toBe(202);
    expect(CodespaceImageAdmission.parse(asked.json())).toMatchObject({ digest: DIGEST, state: "downloading" });
    expect(images.asked).toEqual(["ghcr.io/heig/lab-go:1"]);
    expect((await call("POST", IMAGE_ADMISSIONS_PATH, { reference: "debian" })).statusCode).toBe(202);
    expect(images.asked[1]).toBe("docker.io/library/debian:latest");
    const refused = await call("POST", IMAGE_ADMISSIONS_PATH, { reference: "ghcr.io/x/private:1" });
    expect(refused.statusCode).toBe(422);
    expect(refused.json()).toEqual({ error: "not_public", detail: "401" });
    for (const bad of [{ reference: "quay.io/a/b" }, { reference: "ghcr.io/a/b", more: 1 }, {}]) {
      expect((await call("POST", IMAGE_ADMISSIONS_PATH, bad)).statusCode, JSON.stringify(bad)).toBe(400);
    }
    expect(images.asked).toHaveLength(3);
  });

  it("GET an admission by reference: 200, 404, 400 (a tag, an extra key, none)", async () => {
    expect((await call("GET", imageAdmissionPath(REF))).json()).toMatchObject({ reference: REF });
    // A non-canonical spelling of it reaches the same row.
    expect((await call("GET", `${IMAGE_ADMISSIONS_PATH}?reference=${encodeURIComponent(`ghcr.io/heig/lab-go:1@${DIGEST}`)}`)).statusCode).toBe(200);
    expect((await call("GET", imageAdmissionPath(`ghcr.io/heig/other@${DIGEST}`))).statusCode).toBe(404);
    for (const url of [imageAdmissionPath("ghcr.io/heig/lab-go:1"), `${imageAdmissionPath(REF)}&x=1`, IMAGE_ADMISSIONS_PATH]) {
      expect((await call("GET", url)).statusCode, url).toBe(400);
    }
  });

  it("GET the base: 503 before the first release, 503 when its registry fails, then the release", async () => {
    const before = await call("GET", IMAGE_BASE_PATH);
    expect(before.statusCode).toBe(503);
    expect(before.json()).toEqual({ error: "base_unreleased" });
    expect((await call("GET", IMAGE_BASE_PATH)).json()).toEqual({ error: "registry_unavailable" });
    expect(CodespaceBaseImage.parse((await call("GET", IMAGE_BASE_PATH)).json()).version).toBe("1.0.0");
  });

  it("GET the list; DELETE un-admits: 204, then 409 with the reason, 400 on a bad reference", async () => {
    const listed = (await call("GET", IMAGES_PATH)).json() as unknown[];
    expect(listed.map((i) => CodespaceEngineImage.parse(i).kind)).toEqual(["admitted"]);
    expect((await call("DELETE", imagePath(REF))).statusCode).toBe(204);
    const busy = await call("DELETE", imagePath(REF));
    expect(busy.statusCode).toBe(409);
    expect(busy.json()).toEqual({ error: "image_in_use" });
    expect(images.removed).toEqual([REF, REF]);
    expect((await call("DELETE", imagePath("x"))).statusCode).toBe(400);
  });
});
