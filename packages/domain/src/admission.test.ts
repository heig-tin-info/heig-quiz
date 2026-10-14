import { describe, expect, it } from "vitest";

import { admissionRefusal, affiliationKindsIn, type AdmissionFacts } from "./admission.js";

describe("affiliationKindsIn", () => {
  const ours = ["heig-vd.ch", "hes-so.ch"];

  it("reads the kinds scoped to a listed institution", () => {
    expect(affiliationKindsIn(["student@heig-vd.ch", "staff@hes-so.ch"], ours)).toEqual([
      "student",
      "staff",
    ]);
  });

  it("ignores another institution's scope, a subdomain and an unscoped kind", () => {
    expect(
      affiliationKindsIn(["staff@unige.ch", "staff@mail.heig-vd.ch", "staff", "student", "affiliate@eduid.ch"], ours),
    ).toEqual([]);
  });
});

describe("admissionRefusal (ADR-111)", () => {
  const domains = ["heig-vd.ch"];
  const stranger: AdmissionFacts = {
    addresses: ["someone@gmail.com"],
    affiliations: ["affiliate@eduid.ch", "affiliate"],
    complete: true,
    known: false,
    invited: false,
  };

  it("admits everyone while the list is empty", () => {
    expect(admissionRefusal([], stranger)).toBeNull();
    expect(admissionRefusal([], { ...stranger, complete: false })).toBeNull();
  });

  it("refuses a person with no listed domain, no invitation and no account", () => {
    expect(admissionRefusal(domains, stranger)).toBe("not_invited");
  });

  it("admits a verified address at a listed domain, exactly", () => {
    expect(admissionRefusal(domains, { ...stranger, addresses: ["x@gmail.com", "first.last@heig-vd.ch"] })).toBeNull();
    expect(admissionRefusal(domains, { ...stranger, addresses: ["first.last@mail.heig-vd.ch"] })).toBe("not_invited");
    expect(admissionRefusal(domains, { ...stranger, addresses: ["first.last@evil-heig-vd.ch"] })).toBe("not_invited");
    expect(admissionRefusal(domains, { ...stranger, addresses: ["heig-vd.ch"] })).toBe("not_invited");
  });

  it("admits an affiliation scoped on a listed domain, whatever its kind, never an unscoped one", () => {
    for (const kind of ["member", "student", "staff", "affiliate"]) {
      expect(admissionRefusal(domains, { ...stranger, affiliations: [`${kind}@heig-vd.ch`] }), kind).toBeNull();
    }
    expect(admissionRefusal(domains, { ...stranger, affiliations: ["staff", "student"] })).toBe("not_invited");
    expect(admissionRefusal(domains, { ...stranger, affiliations: ["staff@hes-so.ch"] })).toBe("not_invited");
  });

  it("admits an invited address (a pending roster line, a teacher grant)", () => {
    expect(admissionRefusal(domains, { ...stranger, invited: true })).toBeNull();
  });

  it("admits a known account or an adoption candidate", () => {
    expect(admissionRefusal(domains, { ...stranger, known: true })).toBeNull();
    expect(admissionRefusal(domains, { ...stranger, known: true, complete: false })).toBeNull();
  });

  it("refuses a new person on a partial picture with retry, unless what is there admits", () => {
    expect(admissionRefusal(domains, { ...stranger, affiliations: [], complete: false })).toBe("retry");
    expect(
      admissionRefusal(domains, { ...stranger, addresses: ["first.last@heig-vd.ch"], affiliations: [], complete: false }),
    ).toBeNull();
  });
});
