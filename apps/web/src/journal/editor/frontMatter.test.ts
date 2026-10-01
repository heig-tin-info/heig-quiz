import { describe, expect, it } from "vitest";

import { composePage, joinPage, readFields, splitPage, writeFields, yamlScalar } from "./frontMatter";
import { fromLocalInput, toLocalInput } from "./PageFieldsForm";

describe("visible_from in a datetime-local input", () => {
  it("shows the moment in the reader's zone, and writes it back with its offset", () => {
    const iso = "2026-09-16T08:00:00+02:00";
    const local = toLocalInput(iso)!;
    expect(local).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/);
    const written = fromLocalInput(local);
    expect(written).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:00[+-]\d{2}:\d{2}$/);
    expect(new Date(written).getTime()).toBe(new Date(iso).getTime());
  });

  it("says when a value is not a date, and empties to nothing", () => {
    expect(toLocalInput("next week")).toBeNull();
    expect(toLocalInput("")).toBe("");
    expect(fromLocalInput("")).toBe("");
  });
});

/*
 * D25 condition 2: the front matter is kept out of the editor and edited as
 * four fields, and what the teacher did not touch in it is written back
 * byte for byte (unknown keys, comments, quoting, order).
 */

const PAGE = [
  "---",
  "title: \"Semaine 1: introduction\"",
  "# a comment the teacher left",
  "date: 2026-09-16",
  "author: Yves",
  "tags: [intro, c]",
  "visible_from: 2026-09-16T08:00:00+02:00",
  "---",
  "",
  "# Introduction",
  "",
].join("\n");

describe("splitPage and joinPage", () => {
  it("cuts the block off the body, and puts it back as it was", () => {
    const split = splitPage(PAGE);
    expect(split.body).toBe("\n# Introduction\n");
    expect(split.yaml).toContain("author: Yves");
    expect(joinPage(split)).toBe(PAGE);
  });

  it("leaves a page without front matter whole, in the body", () => {
    const split = splitPage("# Title\n\ntext\n");
    expect(split.yaml).toBeNull();
    expect(split.body).toBe("# Title\n\ntext\n");
    expect(joinPage(split)).toBe("# Title\n\ntext\n");
  });

  it("does not take a thematic break further down for front matter", () => {
    expect(splitPage("text\n\n---\n\nmore\n---\n").yaml).toBeNull();
  });

  it("keeps CRLF fences and a `...` end", () => {
    const crlf = "---\r\ntitle: a\r\n---\r\nbody\r\n";
    expect(joinPage(splitPage(crlf))).toBe(crlf);
    expect(splitPage("---\ntitle: a\n...\nbody").body).toBe("body");
  });
});

describe("readFields", () => {
  it("reads the four fields, unquoted", () => {
    expect(readFields(splitPage(PAGE).yaml)).toEqual({
      title: "Semaine 1: introduction",
      date: "2026-09-16",
      draft: false,
      visibleFrom: "2026-09-16T08:00:00+02:00",
    });
  });

  it("reads `draft: true` and single quotes", () => {
    expect(readFields("title: 'l''été'\ndraft: true")).toMatchObject({ title: "l'été", draft: true });
  });

  it("reads nothing from no front matter", () => {
    expect(readFields(null)).toEqual({ title: "", date: "", draft: false, visibleFrom: "" });
  });
});

describe("writeFields", () => {
  const yaml = splitPage(PAGE).yaml;
  const fields = readFields(yaml);

  it("returns the block untouched when no field changed", () => {
    expect(writeFields(yaml, fields)).toBe(yaml);
  });

  it("rewrites the one line of a changed field, in place, and nothing else", () => {
    const out = writeFields(yaml, { ...fields, date: "2026-09-17" })!;
    expect(out).toBe(yaml!.replace("date: 2026-09-16", "date: 2026-09-17"));
  });

  it("adds a field that had no line at the end, and removes one emptied", () => {
    const out = writeFields(yaml, { ...fields, draft: true, visibleFrom: "" })!;
    expect(out.split("\n")).toEqual([
      'title: "Semaine 1: introduction"',
      "# a comment the teacher left",
      "date: 2026-09-16",
      "author: Yves",
      "tags: [intro, c]",
      "draft: true",
    ]);
  });

  it("quotes a title YAML would read otherwise", () => {
    expect(writeFields(null, { title: "Les pointeurs: suite", date: "", draft: false, visibleFrom: "" })).toBe(
      'title: "Les pointeurs: suite"',
    );
    expect(yamlScalar("Les pointeurs")).toBe("Les pointeurs");
    expect(yamlScalar("true")).toBe('"true"');
    expect(yamlScalar("2026")).toBe('"2026"');
    expect(yamlScalar("# not a comment")).toBe('"# not a comment"');
  });

  it("drops the block, fences included, when nothing is left in it", () => {
    const split = splitPage("---\ndraft: true\n---\n# A\n");
    expect(composePage(split, { ...readFields(split.yaml), draft: false }, split.body)).toBe("# A\n");
  });

  it("gives a page without front matter one when a field is set", () => {
    const split = splitPage("# A\n");
    expect(composePage(split, { title: "A", date: "", draft: true, visibleFrom: "" }, split.body)).toBe(
      "---\ntitle: A\ndraft: true\n---\n# A\n",
    );
  });
});
