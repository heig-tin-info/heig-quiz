/**
 * The Typst sandbox (ADR-125 §2), against the real binary: the tools of
 * `test/pdf.ts`, skipped on a workstation without them and FAILING in CI.
 */
import { mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { answerZone, drawing, heading, markdown, scopeZones, type Block, type Document, type Drawing, type DrawingItem } from "@quiz/docexport";
import { drawable, renderTypst } from "@quiz/docexport/typst";

import { compileArgs, compileTypst, DEAD_PROXY, inTempDir, run, TypstFailure, typstEnv } from "./compile.js";
import { pdfText, pdfTools, TYPST_BIN as BIN, typstProbe as probe } from "../test/pdf.js";
import { prlimitCaps } from "./service.js";

/** On a workstation without Typst or `pdftotext`, skip; in CI, run and fail. */
const skip = !pdfTools;

const provenance = {
  kind: "test",
  version: 1,
  source: {},
  attempts: [],
  generatedAt: "2026-11-04T10:00:00.000Z",
  app: null,
};
const doc = (blocks: readonly Block[]): Document => ({ provenance, lang: "en", blocks });
/** `main.typ` of `blocks`, with the assets `ids` named drawable as the service names them. */
const sourceOf = (blocks: readonly Block[], ids: readonly string[] = []) => drawable(ids) + renderTypst(doc(blocks)).source;

let parent: string;
beforeAll(async () => {
  parent = await mkdtemp(join(tmpdir(), "quiz-typst-test-"));
});
afterAll(async () => {
  await rm(parent, { recursive: true, force: true });
});

const options = (timeoutMs = 20_000) => ({ bin: BIN, timeoutMs, parent });

/** Why a compile failed, or a throw when it did not. */
async function failure(promise: Promise<unknown>): Promise<TypstFailure> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof TypstFailure) return error;
    throw error;
  }
  throw new Error("the compile succeeded");
}

describe("the compile's environment (ADR-125 §2)", () => {
  it("is a CLOSED list, built from scratch, with every path inside the temporary directory", () => {
    // Adding a key here is handing it to a process that reads teacher and
    // student text: it is done in `typstEnv`, with this test.
    const env = typstEnv("/tmp/quiz-typst-x");
    expect(Object.keys(env)).toEqual([
      "PATH",
      "HOME",
      "XDG_CACHE_HOME",
      "XDG_DATA_HOME",
      "TYPST_PACKAGE_PATH",
      "TYPST_PACKAGE_CACHE_PATH",
      "HTTPS_PROXY",
      "https_proxy",
      "HTTP_PROXY",
      "http_proxy",
    ]);
    expect(env).toEqual({
      PATH: process.env["PATH"] ?? "/usr/local/bin:/usr/bin:/bin",
      HOME: "/tmp/quiz-typst-x",
      XDG_CACHE_HOME: "/tmp/quiz-typst-x/cache",
      XDG_DATA_HOME: "/tmp/quiz-typst-x/data",
      TYPST_PACKAGE_PATH: "/tmp/quiz-typst-x/packages",
      TYPST_PACKAGE_CACHE_PATH: "/tmp/quiz-typst-x/package-cache",
      HTTPS_PROXY: DEAD_PROXY,
      https_proxy: DEAD_PROXY,
      HTTP_PROXY: DEAD_PROXY,
      http_proxy: DEAD_PROXY,
    });
    expect(DEAD_PROXY).toBe("http://127.0.0.1:9");
  });

  it("is all a child receives: nothing of the API's own environment", async () => {
    process.env["QUIZ_TYPST_CANARY"] = "secret-of-the-api";
    try {
      const { stdout } = await inTempDir((dir) => run("env", [], dir, 5_000), parent);
      const keys = stdout.trim().split("\n").map((line) => line.split("=")[0]);
      expect(keys.sort()).toEqual(Object.keys(typstEnv("/x")).sort());
      expect(stdout).not.toContain("secret-of-the-api");
    } finally {
      delete process.env["QUIZ_TYPST_CANARY"];
    }
  });

  it("compiles with an argv array, rooted at the directory, with the embedded fonts only", () => {
    expect(compileArgs("/d")).toEqual([
      "compile",
      "--root",
      "/d",
      "--ignore-system-fonts",
      "--diagnostic-format",
      "short",
      "--format",
      "pdf",
      "main.typ",
      "out.pdf",
    ]);
  });

  it("names a program that is not there as missing", async () => {
    const failed = await failure(compileTypst({ source: "x", assets: [] }, { ...options(), bin: "/nonexistent/typst" }));
    expect(failed.reason).toBe("missing");
  });
});

describe.skipIf(skip)(`a compile, with ${BIN} (${probe.version ?? "missing"})`, () => {
  it("is available on this machine, under prlimit's caps (CI installs both)", () => {
    expect(probe).toMatchObject({ available: true, capped: true });
  });

  it("makes a PDF of a document, and leaves no directory behind", async () => {
    const pdf = await compileTypst({ source: sourceOf([heading(1, "Exam"), markdown("Hello $x^2$.")]), assets: [] }, options());
    expect(pdf.subarray(0, 5).toString("latin1")).toBe("%PDF-");
    expect(await pdfText(pdf)).toContain("Hello");
    expect(await readdir(parent)).toEqual([]);
  });

  it("reads nothing outside its root", async () => {
    for (const path of ["../../etc/hostname", "/etc/hostname", "../../../../../../etc/passwd"]) {
      const failed = await failure(compileTypst({ source: `#read("${path}")`, assets: [] }, options()));
      expect(failed.reason).toBe("error");
    }
    expect(await readdir(parent)).toEqual([]);
  });

  it("is killed at its timeout, and its directory still goes", async () => {
    // A loop: Typst memoizes function calls, so a recursion would come back at once.
    const source = "#let x = 0\n#for i in range(100000000) { x += i }\n#x";
    const started = Date.now();
    const failed = await failure(compileTypst({ source, assets: [] }, options(50)));
    expect(failed.reason).toBe("timeout");
    expect(Date.now() - started).toBeLessThan(5_000);
    expect(await readdir(parent)).toEqual([]);
  });

  it("is stopped by its address-space cap, at once", async () => {
    // Thirty million values do not fit in 256 MiB.
    const source = "#let a = range(30000000)\n#a.len()";
    const started = Date.now();
    const failed = await failure(compileTypst({ source, assets: [] }, { ...options(), memory: prlimitCaps(256) }));
    expect(failed.reason).toBe("error");
    expect(Date.now() - started).toBeLessThan(10_000);
    expect(await readdir(parent)).toEqual([]);
  });

  it("prints a statement holding an import as text, and fetches nothing for a real one", async () => {
    const statement = '#import "@preview/cetz:0.3.4": *';
    const pdf = await compileTypst({ source: sourceOf([markdown(statement)]), assets: [] }, options());
    expect((await pdfText(pdf)).replace(/[“”]/g, '"')).toContain(statement);

    // Typst's own import, written by no renderer: refused offline, at once.
    const started = Date.now();
    const failed = await failure(compileTypst({ source: statement, assets: [] }, options(10_000)));
    expect(failed.reason).toBe("error");
    expect(failed.log).toMatch(/failed to download package/);
    expect(failed.log).toMatch(/Connection refused|connect/i);
    expect(failed.log).not.toMatch(/downloading/i);
    expect(Date.now() - started).toBeLessThan(10_000);
  });

  it("draws an asset copied into its root, prints the alt text of one it lacks, and refuses a path that leaves it", async () => {
    // A 1×1 PNG.
    const png = Buffer.from(
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==",
      "base64",
    );
    const blocks = [markdown("![dot](asset:a1b2?w=25) ![ALT_OF_MISSING](asset:gone)")];
    const pdf = await compileTypst({ source: sourceOf(blocks, ["a1b2"]), assets: [{ path: "assets/a1b2", bytes: png }] }, options());
    expect(pdf.subarray(0, 5).toString("latin1")).toBe("%PDF-");
    expect(await pdfText(pdf)).toContain("ALT_OF_MISSING");
    await expect(
      compileTypst({ source: sourceOf(blocks), assets: [{ path: "../escape", bytes: png }] }, options()),
    ).rejects.toThrow(/escapes the compile root/);
    expect(await readdir(parent)).toEqual([]);
  });

  it("lists one answer zone per id for palier B", async () => {
    const source = sourceOf([
      { ...answerZone("name"), id: "name" },
      ...scopeZones("i1", [answerZone("bubbles", { labels: ["A", "B"] })]),
      ...scopeZones("i2", [answerZone("lines", { part: "b0", lines: 2 }), answerZone("lines", { part: "b1" })]),
      ...scopeZones("i3", [answerZone("free", { heightMm: 50 })]),
    ]);
    const zones = await inTempDir(async (dir) => {
      await writeFile(join(dir, "main.typ"), source);
      // `typst query` is deprecated by 0.15: `eval` over the same document.
      const args = ["eval", "--root", dir, "--ignore-system-fonts", "--in", "main.typ", "query(<answer-zone>).map(it => it.value)"];
      return JSON.parse((await run(BIN, args, dir, 20_000)).stdout) as Record<string, unknown>[];
    });
    expect(zones.map((z) => [z["id"], z["kind"]])).toEqual([
      ["name", "name"],
      ["i1", "bubbles"],
      ["i2:b0", "lines"],
      ["i2:b1", "lines"],
      ["i3", "free"],
    ]);
    for (const zone of zones) {
      expect(zone).toEqual({
        id: expect.any(String),
        kind: expect.any(String),
        page: 1,
        x: expect.any(Number),
        y: expect.any(Number),
        w: expect.any(Number),
        h: expect.any(Number),
      });
      // Inside the 20 mm margin (56.7 pt), which keeps palier B's 10 mm free.
      expect(zone["x"]).toBeGreaterThanOrEqual(56);
    }
  });

  it("draws a figure as inline SVG, its text in the embedded DejaVu Sans Mono faces, extractable from the PDF (ADR-126 §2)", async () => {
    const figure: Drawing = {
      viewBox: [0, 0, 160, 100],
      items: [
        { kind: "rect", x: 10, y: 10, w: 140, h: 80, fill: "faint" },
        { kind: "text", x: 20, y: 30, text: "FIGTEXT_REGULAR <&>" },
        { kind: "text", x: 20, y: 50, text: "FIGTEXT_BOLD", weight: "bold" },
        { kind: "text", x: 20, y: 70, text: "FIGTEXT_OBLIQUE", italic: true, baseline: "middle" },
        { kind: "text", x: 20, y: 85, text: "FIGTEXT_BOTH é", weight: "bold", italic: true, anchor: "start" },
      ],
    };
    const blocks = [drawing(figure, "ALT_OF_FIGURE", { widthMm: 160 }), drawing({ viewBox: [0, 0, 1, 1], items: [{ kind: "path", d: "url(" }] }, "ALT_OF_REFUSED")];
    const pdf = await compileTypst({ source: sourceOf(blocks), assets: [] }, options());
    const text = await pdfText(pdf);
    // SVG text stays text in the PDF (not outlines): a leak test reads it there too.
    for (const word of ["FIGTEXT_REGULAR <&>", "FIGTEXT_BOLD", "FIGTEXT_OBLIQUE", "FIGTEXT_BOTH é", "ALT_OF_REFUSED"]) {
      expect(text).toContain(word);
    }
    // The four faces are embedded in the binary, so `--ignore-system-fonts` still finds them.
    const raw = pdf.toString("latin1");
    for (const face of ["DejaVuSansMono", "DejaVuSansMono-Bold", "DejaVuSansMono-Oblique", "DejaVuSansMono-BoldOblique"]) {
      expect(raw).toMatch(new RegExp(`/BaseFont ?/[A-Z]{6}\\+${face}[/\\s]`));
    }
    expect(await readdir(parent)).toEqual([]);
  });

  it("prints the alt text of nested transforms that would overflow, and the rest of the document", async () => {
    // Six groups each scaling by 10^6, with an opacity: within the cap one by one, a
    // panic of Typst's PDF writer once composed (ADR-126 §2).
    let nested: DrawingItem = { kind: "ellipse", cx: 0, cy: 0, rx: 1, ry: 1 };
    for (let i = 0; i < 6; i++) nested = { kind: "g", transform: [1e6, 0, 0, 1e6, 0, 0], opacity: 0.5, items: [nested] };
    const blocks = [markdown("BEFORE_FIGURE"), drawing({ viewBox: [0, 0, 10, 10], items: [nested] }, "ALT_OF_HUGE")];
    const text = await pdfText(await compileTypst({ source: sourceOf(blocks), assets: [] }, options()));
    expect(text).toContain("BEFORE_FIGURE");
    expect(text).toContain("ALT_OF_HUGE");
  });

  it("draws ruled frames and a starter as free zones, still listed as `free` for palier B (ADR-126 §3)", async () => {
    const starter: Drawing = { viewBox: [0, 0, 200, 100], items: [{ kind: "rect", x: 5, y: 5, w: 50, h: 30 }, { kind: "text", x: 10, y: 25, text: "STARTER" }] };
    const source = sourceOf([
      ...scopeZones("i1", [answerZone("free", { heightMm: 100, pattern: { kind: "grid", pitchMm: 4 } })]),
      ...scopeZones("i2", [answerZone("free", { heightMm: 60, pattern: { kind: "grid", pitchMm: 4 }, underlay: starter })]),
      ...scopeZones("i3", [answerZone("free", { heightMm: 40, pattern: { kind: "lines", pitchMm: 8 } })]),
    ]);
    const pdf = await compileTypst({ source, assets: [] }, options());
    expect(await pdfText(pdf)).toContain("STARTER");
    const zones = await inTempDir(async (dir) => {
      await writeFile(join(dir, "main.typ"), source);
      const args = ["eval", "--root", dir, "--ignore-system-fonts", "--in", "main.typ", "query(<answer-zone>).map(it => it.value)"];
      return JSON.parse((await run(BIN, args, dir, 20_000)).stdout) as Record<string, unknown>[];
    });
    expect(zones.map((z) => [z["id"], z["kind"]])).toEqual([
      ["i1", "free"],
      ["i2", "free"],
      ["i3", "free"],
    ]);
    // The frame keeps the height it was given (100 mm ≈ 283 pt), whatever it holds.
    expect(zones[0]!["h"]).toBeCloseTo(283.46, 0);
  });
});
