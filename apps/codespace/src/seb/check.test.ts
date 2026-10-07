import Fastify, { type FastifyInstance } from "fastify";
import { describe, expect, it } from "vitest";

import { checkExamRequest, replyOutsideSeb } from "./check.js";
import { EXAM_COOKIE, issueExamCookie } from "./examSession.js";
import { CONFIG_KEY_HEADER, REQUEST_HASH_HEADER, expectedHash } from "./verify.js";

const COOKIE_SECRET = "long-enough-test-secret";

/** A stand-in for the proxy: it reads ONLY the cookie (invariant 6). */
function proxy(): FastifyInstance {
  const app = Fastify({ logger: false });
  app.get("/s/:sessionId/", async (request, reply) => {
    const verdict = checkExamRequest(request, { secret: COOKIE_SECRET, assignmentId: "a1" });
    if (!verdict.ok) return replyOutsideSeb(reply, verdict);
    return reply.send({ ok: true, sessionId: verdict.claims.sessionId });
  });
  return app;
}

/** The cookie `/launch` sets after a verified SEB launch, bound to `clientAddress`. */
const examCookie = (clientAddress: string, assignmentId = "a1") =>
  `${EXAM_COOKIE}=${issueExamCookie(
    { assignmentId, sessionId: "s-42", clientAddress, issuedAt: Date.now() },
    { secret: COOKIE_SECRET },
  )}`;

describe("the proxy reads only the cookie (invariant 6)", () => {
  it("accepts the exam cookie from the address it was issued to", async () => {
    const res = await proxy().inject({
      method: "GET",
      url: "/s/s-42/",
      headers: { cookie: examCookie("10.0.0.7") },
      remoteAddress: "10.0.0.7",
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ ok: true, sessionId: "s-42" });
  });

  it("refuses it from another client address", async () => {
    const res = await proxy().inject({
      method: "GET",
      url: "/s/s-42/",
      headers: { cookie: examCookie("10.0.0.7") },
      remoteAddress: "10.0.0.8",
    });
    expect(res.statusCode).toBe(403);
    expect(res.body).toContain("depuis un autre poste");
  });

  it("refuses another assignment's cookie", async () => {
    const res = await proxy().inject({
      method: "GET",
      url: "/s/s-42/",
      headers: { cookie: examCookie("127.0.0.1", "a2") },
    });
    expect(res.statusCode).toBe(403);
  });

  it("finds the SEB headers useless without a cookie", async () => {
    const absolute = "https://codespace.heig-vd.ch/s/s-42/";
    const res = await proxy().inject({
      method: "GET",
      url: "/s/s-42/",
      headers: {
        [CONFIG_KEY_HEADER]: expectedHash(absolute, "a".repeat(64)),
        [REQUEST_HASH_HEADER]: expectedHash(absolute, "b".repeat(64)),
      },
    });
    expect(res.statusCode).toBe(403);
    expect(res.headers["content-type"]).toContain("text/html");
    expect(res.body).toContain("Session hors Safe Exam Browser");
  });
});
