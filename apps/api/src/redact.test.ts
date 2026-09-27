import { describe, expect, it } from "vitest";

import { redactUrl, requestLog } from "./redact.js";

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
