import Fastify from "fastify";
import { describe, expect, it } from "vitest";

import { projectStationPath } from "@quiz/contracts";

import { CSP, registerSecurityHeaders, stationCsp } from "./csp.js";

/* ADR-089 §10: Quiz admits the portal in a frame on a project's station page only. */

const PORTAL = "https://code.example.ch";

async function serve(codespaceUrl: string) {
  const app = Fastify();
  registerSecurityHeaders(app, codespaceUrl);
  app.get("/*", async () => "spa");
  await app.ready();
  return app;
}

const directives = (policy: string) => new Map(policy.split("; ").map((d) => [d.split(" ")[0], d.split(" ").slice(1)]));

describe("the station page's frame-src (ADR-089 §10)", () => {
  it("names the portal's origin, and only it, on the station page", async () => {
    const app = await serve(`${PORTAL}/some/base`);
    const res = await app.inject({ method: "GET", url: `${projectStationPath("p1")}?x=1` });
    const policy = res.headers["content-security-policy"] as string;
    expect(policy).toBe(stationCsp(PORTAL));
    expect(directives(policy).get("frame-src")).toEqual([PORTAL]);
    // Nobody frames the station page itself.
    expect(directives(policy).get("frame-ancestors")).toEqual(["'self'"]);
    expect(res.headers["x-frame-options"]).toBe("SAMEORIGIN");
    // Everything else of the common policy is kept.
    for (const name of ["default-src", "script-src", "object-src", "connect-src"]) {
      expect(directives(policy).get(name), name).toEqual(directives(CSP).get(name));
    }
    await app.close();
  });

  it("keeps the common policy everywhere else, the project's own pages included", async () => {
    const app = await serve(PORTAL);
    for (const url of ["/projects/p1", "/projects/p1/grading", "/projects/p1/station/x", "/station", "/app/api/projects/p1/station"]) {
      const res = await app.inject({ method: "GET", url });
      expect(res.headers["content-security-policy"], url).toBe(CSP);
      expect(directives(CSP).get("frame-src"), url).toBeUndefined();
    }
    await app.close();
  });

  it("frames nothing without a portal", async () => {
    expect(stationCsp("")).toBeNull();
    const app = await serve("");
    const res = await app.inject({ method: "GET", url: projectStationPath("p1") });
    expect(res.headers["content-security-policy"]).toBe(CSP);
    await app.close();
  });
});
