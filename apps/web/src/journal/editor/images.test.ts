import { describe, expect, it } from "vitest";

import { imagePlacement, journalImageUrl, randomSuffix } from "./images";

/*
 * D25 condition 3: a picture goes into the repository beside its page and is
 * referred to by a RELATIVE path, never `asset:<id>`; and the editor draws
 * the page's relative pictures from the journal's asset route.
 */

describe("imagePlacement", () => {
  it("puts the picture in an images/ folder beside the page, with a relative href", () => {
    expect(imagePlacement("semaine-01/index.md", { name: "Schéma du CPU.PNG", type: "image/png" }, "a1b2c3")).toEqual({
      path: "semaine-01/images/schema-du-cpu-a1b2c3.png",
      href: "images/schema-du-cpu-a1b2c3.png",
    });
    expect(imagePlacement("README.md", { name: "x.jpeg", type: "image/jpeg" }, "000000")).toEqual({
      path: "images/x-000000.jpg",
      href: "images/x-000000.jpg",
    });
  });

  it("never writes an asset: reference", () => {
    const placed = imagePlacement("a/b.md", { name: "p.webp", type: "image/webp" }, randomSuffix());
    expect(placed?.href).toMatch(/^images\/p-[0-9a-f]{6}\.webp$/);
    expect(placed?.href).not.toMatch(/^asset:/);
  });

  it("names a picture without a usable name `image`", () => {
    expect(imagePlacement("a.md", { name: ".png", type: "image/png" }, "ffffff")?.href).toBe("images/image-ffffff.png");
  });

  it("refuses a type the journal does not serve", () => {
    expect(imagePlacement("a.md", { name: "x.bmp", type: "image/bmp" }, "ffffff")).toBeNull();
  });
});

describe("journalImageUrl", () => {
  const local = new Map([["images/new-aaaaaa.png", "blob:local"]]);
  const url = journalImageUrl("r1", "semaine-01/index.md", local);

  it("draws a picture uploaded in this session from the browser's copy", () => {
    expect(url("images/new-aaaaaa.png")).toBe("blob:local");
  });

  it("resolves a relative path against the page, to the journal's asset route", () => {
    expect(url("images/cpu.png")).toBe("/app/api/classrooms/r1/journal/assets/semaine-01/images/cpu.png");
    expect(url("../annexe/gdb%20session.png")).toBe(
      "/app/api/classrooms/r1/journal/assets/annexe/gdb%20session.png",
    );
  });

  it("leaves what is not a path of the journal to the editor", () => {
    expect(url("https://example.org/x.png")).toBeNull();
    expect(url("asset:abc")).toBeNull();
    expect(url("../../outside.png")).toBeNull();
  });
});
