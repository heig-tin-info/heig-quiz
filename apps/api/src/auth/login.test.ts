import { describe, expect, it } from "vitest";

import type { AppConfig } from "../config.js";
import { oidcClaims as claims } from "../test/oidc.js";
import { loginAdmits } from "./login.js";

const config = {
  SUPER_ADMIN_EMAIL: "boss@heig.test",
  STAFF_AFFILIATION_DOMAINS: ["heig-vd.ch", "hes-so.ch"],
  LOGIN_ALLOWLIST: "",
} as AppConfig;

describe("loginAdmits (ADR-028)", () => {
  const staging = { ...config, LOGIN_ALLOWLIST: "dev@heig.test" } as AppConfig;

  it("refuses a listed login address the IdP did not verify", () => {
    expect(loginAdmits(staging, claims("s", { email: "dev@heig.test" }, false))).toBe(false);
  });

  it("admits a listed address the institution asserts", () => {
    expect(
      loginAdmits(
        staging,
        claims("s", { email: "x@gmail.test", swissEduIDLinkedAffiliationMail: ["dev@heig.test"] }, false),
      ),
    ).toBe(true);
  });
});
