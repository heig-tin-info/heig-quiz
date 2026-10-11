import { describe, expect, it } from "vitest";

import { ipAllowed, isIpRange, parseIp } from "./ipAllowlist.js";

describe("ipAllowed (F-EVAL-12)", () => {
  it("lets everybody in when the list is empty", () => {
    expect(ipAllowed([], "203.0.113.9")).toBe(true);
    expect(ipAllowed([], undefined)).toBe(true);
  });

  it("refuses an unknown or unreadable address under a non-empty list", () => {
    expect(ipAllowed(["10.20.0.0/16"], undefined)).toBe(false);
    expect(ipAllowed(["10.20.0.0/16"], "not-an-ip")).toBe(false);
  });

  it("matches an IPv4 range on its bits, at its boundaries", () => {
    const room = ["192.168.1.0/24"];
    expect(ipAllowed(room, "192.168.1.0")).toBe(true);
    expect(ipAllowed(room, "192.168.1.255")).toBe(true);
    expect(ipAllowed(room, "192.168.0.255")).toBe(false);
    expect(ipAllowed(room, "192.168.2.0")).toBe(false);
    // A prefix that does not fall on an octet.
    expect(ipAllowed(["10.0.0.0/12"], "10.15.255.255")).toBe(true);
    expect(ipAllowed(["10.0.0.0/12"], "10.16.0.0")).toBe(false);
    expect(ipAllowed(["0.0.0.0/0"], "203.0.113.9")).toBe(true);
  });

  it("reads a bare address as itself alone", () => {
    expect(ipAllowed(["203.0.113.9"], "203.0.113.9")).toBe(true);
    expect(ipAllowed(["203.0.113.9"], "203.0.113.90")).toBe(false);
    expect(ipAllowed(["2001:db8::1"], "2001:db8::1")).toBe(true);
    expect(ipAllowed(["2001:db8::1"], "2001:db8::10")).toBe(false);
  });

  it("matches IPv6 ranges, compressed or not", () => {
    const room = ["2001:db8:abcd::/48"];
    expect(ipAllowed(room, "2001:db8:abcd:12::7")).toBe(true);
    expect(ipAllowed(room, "2001:0db8:abcd:ffff:ffff:ffff:ffff:ffff")).toBe(true);
    expect(ipAllowed(room, "2001:db8:abce::1")).toBe(false);
    expect(ipAllowed(["2001:db8::/127"], "2001:db8::1")).toBe(true);
    expect(ipAllowed(["2001:db8::/127"], "2001:db8::2")).toBe(false);
  });

  it("folds an IPv4-mapped IPv6 address to its IPv4, on either side", () => {
    expect(ipAllowed(["10.20.0.0/16"], "::ffff:10.20.0.7")).toBe(true);
    expect(ipAllowed(["10.20.0.0/16"], "::ffff:10.21.0.7")).toBe(false);
    expect(ipAllowed(["::ffff:10.20.0.0/112"], "10.20.3.4")).toBe(true);
    expect(ipAllowed(["::ffff:10.20.0.0/112"], "10.21.3.4")).toBe(false);
  });

  it("never mixes families", () => {
    expect(ipAllowed(["10.0.0.0/8"], "2001:db8::1")).toBe(false);
    expect(ipAllowed(["2001:db8::/32"], "10.0.0.1")).toBe(false);
  });

  it("no longer matches text prefixes (audit L10)", () => {
    // `10.2` used to admit 10.200.0.7 and 10.20.0.7 alike.
    expect(ipAllowed(["10.2"], "10.200.0.7")).toBe(false);
    expect(ipAllowed(["10.2"], "10.20.0.7")).toBe(false);
    expect(ipAllowed(["192.168.1"], "192.168.10.4")).toBe(false);
  });

  it("reads a stored legacy prefix of whole octets as the range it meant, nothing wider", () => {
    expect(ipAllowed(["10.20."], "10.20.0.7")).toBe(true);
    expect(ipAllowed(["10.20."], "10.200.0.7")).toBe(false);
    expect(ipAllowed(["10.20.", "192.168.1."], "192.168.1.4")).toBe(true);
    expect(ipAllowed(["10."], "10.255.0.1")).toBe(true);
    expect(ipAllowed(["10.20.300."], "10.20.30.1")).toBe(false);
  });
});

describe("isIpRange (the contract's rule)", () => {
  it("accepts addresses and CIDR ranges of both families", () => {
    for (const ok of ["10.0.0.1", "10.0.0.0/8", "0.0.0.0/0", "2001:db8::/32", "::1", "::ffff:10.0.0.0/104", "fe80::1:2:3:4"]) {
      expect(isIpRange(ok), ok).toBe(true);
    }
  });

  it("refuses text prefixes, bad masks and anything else", () => {
    for (const bad of ["10.20.", "10.2", "10.0.0.0/33", "2001:db8::/129", "10.0.0.256", "10.0.0.1/", "01.2.3.4", "fe80::1%eth0", "1::2::3", "::ffff:1.2.3.999", "::fffg:1", "1:2:3:4:5:6:7", "1:2:3:4::5:6:7:8", "::ffff:10.0.0.0/90", "localhost", ""]) {
      expect(isIpRange(bad), bad).toBe(false);
    }
  });
});

describe("parseIp", () => {
  it("parses both families and folds mapped addresses", () => {
    expect(parseIp("10.0.0.1")).toEqual([10, 0, 0, 1]);
    expect(parseIp("::ffff:10.0.0.1")).toEqual([10, 0, 0, 1]);
    expect(parseIp("::1")).toEqual([...new Array<number>(15).fill(0), 1]);
    expect(parseIp("1:2:3:4:5:6:7:8:9")).toBeNull();
  });
});
