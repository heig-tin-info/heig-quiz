import { describe, expect, it } from "vitest";

import { redactTokens, redactUrl, requestLog } from "./redact.js";

const TOKEN = "AbCdEfGhIjKlMnOpQrStUvWxYz0123456789_-abcde";

describe("the request log", () => {
  it("never writes a SEB launch secret", () => {
    expect(redactUrl("/app/auth/seb/s3cret")).not.toContain("s3cret");
  });

  it("never writes a Teams link token, nor the login that comes back to it", () => {
    for (const url of [
      `/teams/link?token=${TOKEN}`,
      `/app/auth/login?next=${encodeURIComponent(`/teams/link?token=${TOKEN}`)}`,
      `/app/auth/dev?returnTo=${encodeURIComponent(`/teams/link?token=${TOKEN}`)}&x=1`,
    ]) {
      expect(redactUrl(url), url).not.toContain(TOKEN);
    }
    expect(redactUrl(`/app/auth/login?next=%2Fteams%2Flink%3Ftoken%3D${TOKEN}&persona=a`)).toBe(
      "/app/auth/login?next=%E2%80%A6&persona=a",
    );
  });

  it("never writes a kiosk pairing code, nor the login that comes back to it (ADR-051 §8)", () => {
    const code = "BCDF-GHJK";
    for (const url of [
      `/pair?code=${code}`,
      `/app/api/pair/${code}`,
      `/app/auth/login?next=${encodeURIComponent(`/pair?code=${code}`)}`,
      `/app/auth/dev?next=${encodeURIComponent(`/pair?code=${code}`)}`,
    ]) {
      expect(redactUrl(url), url).not.toContain("GHJK");
    }
    expect(redactUrl(`/pair?code=${code}`)).toBe("/pair?…");
    for (const variant of [`/pair/?code=${code}`, `/pair//?x=1&code=${code}`, `/app/auth/login?next=${encodeURIComponent(`/pair/?code=${code}`)}`]) {
      expect(redactUrl(variant), variant).not.toContain("GHJK");
    }
    expect(redactUrl(`/app/api/pair/${code}`)).toBe("/app/api/pair/…");
    // The approval carries its code in the body, and the page without one has nothing to hide.
    expect(redactUrl("/app/api/pair")).toBe("/app/api/pair");
    expect(redactUrl("/pair")).toBe("/pair");
  });

  it("leaves every other URL as it is", () => {
    for (const url of ["/app/api/me", "/app/auth/login?next=%2Fp%2FABC123", "/settings?tab=x"]) {
      expect(redactUrl(url)).toBe(url);
    }
  });

  it("is what the serializer writes", () => {
    const line = requestLog({ method: "GET", url: `/teams/link?token=${TOKEN}`, host: "quiz.test", ip: "10.0.0.1" });
    expect(line).toEqual({ method: "GET", url: "/teams/link…", host: "quiz.test", remoteAddress: "10.0.0.1" });
  });
});

describe("GitHub tokens (N-SEC-16)", () => {
  it("strips the installation token from a remote URL echoed by git", () => {
    // Same shape as a real failed-push message (classroom provisioning,
    // 2026-07-14), with a made-up token: a real one trips push protection.
    const msg =
      "Error: Command failed: git --git-dir /tmp/x/src.git push --quiet " +
      "https://x-access-token:ghs_0000000000FAKEFAKEFAKE0000000000000000@github.com/org/repo.git " +
      "refs/heads/master:refs/heads/master\nerror: RPC failed; curl 55";
    const clean = redactTokens(msg);
    expect(clean).not.toContain("ghs_0000");
    expect(clean).toContain("x-access-token:***@github.com/org/repo.git");
    expect(clean).toContain("RPC failed"); // the diagnostics survive
  });

  it("strips a token that has no known prefix from the remote URL", () => {
    expect(redactTokens("https://x-access-token:v1.abcdef0123@github.com/o/r.git")).toBe(
      "https://x-access-token:***@github.com/o/r.git",
    );
  });

  it("strips the authorization header git is handed, whatever its scheme", () => {
    const basic = Buffer.from("x-access-token:v1.opaque").toString("base64");
    expect(redactTokens(`http.https://github.com/.extraheader=AUTHORIZATION: basic ${basic}`)).toBe(
      "http.https://github.com/.extraheader=AUTHORIZATION: basic ***",
    );
    expect(redactTokens("Authorization: Bearer eyJhbGciOi.x.y")).toBe("Authorization: Bearer ***");
    expect(redactTokens("authorization: token v1.abc")).toBe("authorization: token ***");
  });

  it("strips every bare token by its prefix", () => {
    for (const prefix of ["ghs", "ghu", "ghp", "gho", "ghr"]) {
      expect(redactTokens(`token ${prefix}_abc123XYZ leaked`)).toBe("token gh*_*** leaked");
    }
  });

  it("leaves words that merely start with gh alone", () => {
    for (const text of ["ghost_town", "a ghs-like word", "sigh_s", "gh_x"]) {
      expect(redactTokens(text)).toBe(text);
    }
  });

  it("masks a token that reaches the request log in a URL", () => {
    expect(redactUrl("/app/api/x?t=ghs_abcdef123")).toBe("/app/api/x?t=gh*_***");
    expect(requestLog({ method: "GET", url: "/a?t=ghu_zz", host: "h", ip: "i" }).url).not.toContain("ghu_zz");
  });
});
