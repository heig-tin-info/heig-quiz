import { describe, expect, it } from "vitest";

import { sourceUrl } from "./source.js";

describe("sourceUrl", () => {
  it("names another database on the target's server, with its credentials", () => {
    expect(sourceUrl("postgres://quiz:s3cr%40t@postgres:5432/quiz", "hgc_cutover")).toBe(
      "postgres://quiz:s3cr%40t@postgres:5432/hgc_cutover",
    );
    expect(sourceUrl("postgresql://quiz@db/quiz?sslmode=disable", "hgc")).toBe(
      "postgresql://quiz@db/hgc?sslmode=disable",
    );
  });

  it("refuses a name that is not a plain identifier", () => {
    expect(() => sourceUrl("postgres://quiz@db/quiz", "hgc/../x")).toThrow(/not a database name/);
    expect(() => sourceUrl("postgres://quiz@db/quiz", "")).toThrow(/not a database name/);
  });

  it("refuses a target that is not PostgreSQL", () => {
    expect(() => sourceUrl("pglite://.data/pglite", "hgc")).toThrow(/not a PostgreSQL URL/);
  });
});
