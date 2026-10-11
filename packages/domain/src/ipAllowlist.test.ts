import { describe, expect, it } from "vitest";

import { ipAllowed, isIpRange } from "./ipAllowlist.js";

describe("ipAllowed (F-EVAL-12)", () => {
  it("lets everybody in when the list is empty, nobody unknown otherwise", () => {
    expect(ipAllowed([], undefined)).toBe(true);
    expect(ipAllowed(["10.20.0.0/16"], undefined)).toBe(false);
    expect(ipAllowed(["10.20.0.0/16"], "not-an-ip")).toBe(false);
  });

  it("matches a range on its bits, at its boundaries", () => {
    expect(ipAllowed(["192.168.1.0/24"], "192.168.1.255")).toBe(true);
    expect(ipAllowed(["192.168.1.0/24"], "192.168.2.0")).toBe(false);
    expect(ipAllowed(["10.0.0.0/12"], "10.15.255.255")).toBe(true);
    expect(ipAllowed(["10.0.0.0/12"], "10.16.0.0")).toBe(false);
    expect(ipAllowed(["203.0.113.9"], "203.0.113.90")).toBe(false);
    expect(ipAllowed(["2001:db8::/127"], "2001:db8::1")).toBe(true);
    expect(ipAllowed(["2001:db8::/127"], "2001:db8::2")).toBe(false);
  });

  it("folds an IPv4-mapped IPv6 address to its IPv4, on either side", () => {
    expect(ipAllowed(["10.20.0.0/16"], "::ffff:10.20.0.7")).toBe(true);
    expect(ipAllowed(["10.20.0.0/16"], "::ffff:a14:7")).toBe(true);
    expect(ipAllowed(["10.20.0.0/16"], "::ffff:10.21.0.7")).toBe(false);
    expect(ipAllowed(["::ffff:10.20.0.0/112"], "10.20.3.4")).toBe(true);
  });

  it("never mixes families", () => {
    expect(ipAllowed(["10.0.0.0/8"], "2001:db8::1")).toBe(false);
    expect(ipAllowed(["2001:db8::/32"], "10.0.0.1")).toBe(false);
  });

  it("matches no text prefix (audit L10), and reads a stored whole-octet one as its range", () => {
    expect(ipAllowed(["10.2"], "10.20.0.7")).toBe(false);
    expect(ipAllowed(["10.20."], "10.20.0.7")).toBe(true);
    expect(ipAllowed(["10.20."], "10.200.0.7")).toBe(false);
    expect(ipAllowed(["10.20.300."], "10.20.30.1")).toBe(false);
  });
});

describe("isIpRange (the contract's rule)", () => {
  it("accepts canonical addresses and ranges of both families", () => {
    for (const ok of ["10.0.0.1", "10.0.0.0/8", "0.0.0.0/0", "2001:db8::/32", "::1", "::ffff:10.0.0.0/104"]) {
      expect(isIpRange(ok), ok).toBe(true);
    }
  });

  it("refuses prefixes, lenient forms, bad masks and zones", () => {
    const bad = ["10.20.", "10.2", "010.0.0.1", "0x0a.0.0.1", "10.0.0.0/08", "10.0.0.0/33", "2001:db8::/129",
      "10.0.0.0/8/8", "1.2.3.4::", "1.2.3.4::/8", "fe80::1%eth0", "localhost", ""];
    for (const text of bad) expect(isIpRange(text), text).toBe(false);
  });
});
