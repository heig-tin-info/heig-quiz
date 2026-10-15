import { describe, expect, it } from "vitest";

import { scopeAdmits, scopeCovers, scopeOfGrant, TOKEN_SCOPES, type ScopeTarget } from "./tokenScope.js";

describe("scopeCovers", () => {
  it("orders quiz:read ⊂ quiz ⊂ api", () => {
    expect(scopeCovers("api", "quiz")).toBe(true);
    expect(scopeCovers("api", "quiz:read")).toBe(true);
    expect(scopeCovers("quiz", "quiz:read")).toBe(true);
    expect(scopeCovers("quiz", "api")).toBe(false);
    expect(scopeCovers("quiz:read", "quiz")).toBe(false);
    for (const s of TOKEN_SCOPES) expect(scopeCovers(s, s)).toBe(true);
  });
});

describe("scopeAdmits", () => {
  const at = (target: ScopeTarget, method: string) => ({ target, method });

  it("lets api through everywhere, with any method", () => {
    for (const target of ["mcp", "internal", "elsewhere"] as const) {
      for (const method of ["GET", "POST", "DELETE"]) expect(scopeAdmits("api", at(target, method))).toBeNull();
    }
  });

  it("keeps quiz on the MCP endpoint and its tools' calls", () => {
    expect(scopeAdmits("quiz", at("mcp", "POST"))).toBeNull();
    expect(scopeAdmits("quiz", at("internal", "POST"))).toBeNull();
    expect(scopeAdmits("quiz", at("internal", "PATCH"))).toBeNull();
    expect(scopeAdmits("quiz", at("elsewhere", "GET"))).toBe("api");
  });

  it("lets quiz:read post the MCP envelope but write nothing through a tool", () => {
    expect(scopeAdmits("quiz:read", at("mcp", "POST"))).toBeNull();
    expect(scopeAdmits("quiz:read", at("internal", "GET"))).toBeNull();
    expect(scopeAdmits("quiz:read", at("internal", "head"))).toBeNull();
    for (const method of ["POST", "PUT", "PATCH", "DELETE"]) {
      expect(scopeAdmits("quiz:read", at("internal", method))).toBe("quiz");
    }
    expect(scopeAdmits("quiz:read", at("elsewhere", "GET"))).toBe("api");
  });
});

describe("scopeOfGrant", () => {
  it("maps the consent's quiz, with or without offline_access", () => {
    expect(scopeOfGrant("quiz")).toBe("quiz");
    expect(scopeOfGrant("quiz offline_access")).toBe("quiz");
  });

  it("never yields api, and falls to the narrowest otherwise", () => {
    expect(scopeOfGrant("api")).toBe("quiz:read");
    expect(scopeOfGrant("quiz:read")).toBe("quiz:read");
    expect(scopeOfGrant("")).toBe("quiz:read");
  });
});
