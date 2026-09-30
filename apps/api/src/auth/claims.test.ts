import { describe, expect, it } from "vitest";

import {
  addressesOf,
  affiliationKindsIn,
  affiliationsOf,
  claimList,
  persistableClaims,
  verifiedAddressesOf,
} from "./claims.js";
import { scopeFor } from "./oidc.js";

describe("scopeFor", () => {
  it("asks edu-ID for its attribute scope", () => {
    expect(scopeFor("https://login.eduid.ch/")).toBe(
      "openid profile email https://eduid.ch/scope/userinfo.read",
    );
  });

  it("leaves any other IdP alone — an unknown scope is an invalid_scope error", () => {
    expect(scopeFor("http://localhost:8080/realms/quiz-dev")).toBe("openid profile email");
    // A look-alike host must not be taken for edu-ID.
    expect(scopeFor("https://eduid.ch.evil.test/")).toBe("openid profile email");
    expect(scopeFor("not a url")).toBe("openid profile email");
  });
});

describe("claimList", () => {
  it.each([
    ["the JSON arrays edu-ID specifies", ["student@heig-vd.ch", "member@heig-vd.ch"], ["student@heig-vd.ch", "member@heig-vd.ch"]],
    ["the separated strings the SAML bridges hand out", "student, staff;member", ["student", "staff", "member"]],
  ])("takes %s", (_, claim, list) => {
    expect(claimList(claim)).toEqual(list);
  });

  it("ignores what is absent or unusable", () => {
    expect(claimList(undefined)).toEqual([]);
    expect(claimList(null)).toEqual([]);
    expect(claimList([" ", ""])).toEqual([]);
    expect(claimList({ nope: true })).toEqual([]);
  });
});

describe("affiliationsOf", () => {
  it("merges the three affiliation claims, lowercased and deduplicated", () => {
    expect(
      affiliationsOf({
        eduPersonPrimaryAffiliation: ["student"],
        eduPersonScopedAffiliation: ["Student@heig-vd.ch", "member@heig-vd.ch"],
        swissEduIDLinkedAffiliation: ["student@heig-vd.ch", "staff@hes-so.ch"],
      }),
    ).toEqual(["student", "student@heig-vd.ch", "member@heig-vd.ch", "staff@hes-so.ch"]);
  });

  it("reads eduPersonAffiliation, which edu-ID does release", () => {
    // Production releases the unscoped claim alongside the scoped one and
    // does NOT release eduPersonPrimaryAffiliation.
    expect(
      affiliationsOf({
        eduPersonAffiliation: ["member", "staff"],
        eduPersonScopedAffiliation: ["staff@hes-so.ch"],
      }),
    ).toEqual(["member", "staff", "staff@hes-so.ch"]);
  });

  it("is empty when the IdP releases no affiliation", () => {
    expect(affiliationsOf({ email: "who@example.test" })).toEqual([]);
  });
});

describe("addressesOf", () => {
  it("puts the login address first, then the institutional ones", () => {
    // Shape observed on production: a private login address, one @heig-vd.ch
    // affiliation address.
    expect(
      addressesOf(
        {
          email: "Willy.TK89@gmail.test",
          swissEduIDLinkedAffiliationMail: ["William.Ammann@heig-vd.ch"],
        },
        true,
      ),
    ).toEqual([
      { email: "willy.tk89@gmail.test", source: "login", verified: true },
      {
        email: "william.ammann@heig-vd.ch",
        source: "swissEduIDLinkedAffiliationMail",
        verified: true,
      },
    ]);
  });

  it("keeps the first source of an address released twice", () => {
    const found = addressesOf(
      {
        email: "a@heig.test",
        swissEduIDLinkedAffiliationMail: ["a@heig.test"],
        swissEduIDAssociatedMail: ["b@heig.test"],
      },
      false,
    );
    // The institution vouches for the login address the IdP did not verify.
    expect(found).toEqual([
      { email: "a@heig.test", source: "login", verified: true },
      { email: "b@heig.test", source: "swissEduIDAssociatedMail", verified: true },
    ]);
  });

  it("is empty when the IdP released nothing usable", () => {
    expect(addressesOf({ sub: "abc" }, true)).toEqual([]);
  });
});

describe("verifiedAddressesOf", () => {
  const claims = {
    email: "boss@heig.test",
    swissEduIDLinkedAffiliationMail: ["first.last@heig-vd.ch"],
  };

  it.each([
    ["drops the login address the IdP did not verify", false, ["first.last@heig-vd.ch"]],
    ["keeps it once verified", true, ["boss@heig.test", "first.last@heig-vd.ch"]],
  ])("%s", (_, verified, addresses) => {
    expect(verifiedAddressesOf(claims, verified)).toEqual(addresses);
  });
});

describe("affiliationKindsIn", () => {
  const ours = ["heig-vd.ch", "hes-so.ch"];

  it("reads the kinds scoped to a listed institution", () => {
    expect(affiliationKindsIn(["student@heig-vd.ch", "staff@hes-so.ch"], ours)).toEqual([
      "student",
      "staff",
    ]);
  });

  it("ignores another institution's scope and an unscoped kind", () => {
    expect(affiliationKindsIn(["staff@unige.ch", "staff", "student", "affiliate@eduid.ch"], ours)).toEqual(
      [],
    );
  });
});

describe("persistableClaims", () => {
  it("keeps the attributes and drops the token plumbing", () => {
    const kept = persistableClaims({
      sub: "abc",
      email: "private@example.test",
      swissEduIDLinkedAffiliationMail: ["first.last@heig-vd.ch"],
      at_hash: "…",
      nonce: "…",
      iss: "https://login.eduid.ch/",
      exp: 1,
    });
    expect(kept).toEqual({
      sub: "abc",
      email: "private@example.test",
      swissEduIDLinkedAffiliationMail: ["first.last@heig-vd.ch"],
    });
  });
});
