import { describe, expect, it } from "vitest";

import {
  consentRecorded,
  CONTESTATIONS_CONSENT,
  MCP_CONSENT_REVISION,
  scopeAdmits,
  scopeCovers,
  scopeOfGrant,
  TOKEN_SCOPES,
  type ScopeTarget,
} from "./tokenScope.js";

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

describe("a route that names its own scope (ADR-139 §14)", () => {
  it("refuses a quiz:read token's GET of a route that needs quiz, and admits quiz and api", () => {
    const needs = { target: "internal" as const, method: "GET", needs: "quiz" as const };
    expect(scopeAdmits("quiz:read", needs)).toBe("quiz");
    expect(scopeAdmits("quiz", needs)).toBeNull();
    expect(scopeAdmits("api", needs)).toBeNull();
    expect(scopeAdmits("api", { ...needs, target: "elsewhere" })).toBeNull();
    expect(scopeAdmits("quiz", { ...needs, target: "elsewhere" })).toBe("api");
  });

  it("never applies to the MCP envelope itself", () => {
    expect(scopeAdmits("quiz:read", { target: "mcp", method: "POST", needs: "quiz" })).toBeNull();
  });
});

describe("the consent revision (ADR-139 §14)", () => {
  it("records what the consent showed, never above the current revision, and 1 when it says nothing", () => {
    expect(MCP_CONSENT_REVISION).toBeGreaterThanOrEqual(CONTESTATIONS_CONSENT);
    expect(consentRecorded(MCP_CONSENT_REVISION)).toBe(MCP_CONSENT_REVISION);
    expect(consentRecorded(MCP_CONSENT_REVISION + 5)).toBe(MCP_CONSENT_REVISION);
    expect(consentRecorded(1)).toBe(1);
    expect(consentRecorded(undefined)).toBe(1);
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
