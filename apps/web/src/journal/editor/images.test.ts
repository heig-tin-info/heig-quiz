import { describe, expect, it } from "vitest";

import { REFUSED } from "../../markdown/imageUrl";
import { imagePlacement, journalImageUrl, pageFolder, randomSuffix } from "./images";

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

  it("refuses whatever is not a path of the journal: never fetched", () => {
    for (const src of ["https://evil/x.png", "//evil/x.png", "asset:abc", "../../outside.png", "/abs.png", "blob:other", "data:image/png;base64,AA"]) {
      expect(url(src), src).toBe(REFUSED);
    }
  });
});

describe("pageFolder", () => {
  it("is the folder with its slash, or nothing at the root", () => {
    expect(pageFolder("a/b/c.md")).toBe("a/b/");
    expect(pageFolder("c.md")).toBe("");
  });
});
