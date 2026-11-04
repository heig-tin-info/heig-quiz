/**
 * The PDF tests' tools (ADR-125): the real Typst binary — `TYPST_BIN`, else
 * `typst` on PATH — and poppler's `pdftotext`. Without them a PDF test is
 * skipped on a workstation and FAILS in CI (`CI` set), which installs both:
 * the PDF path is never green there by being untested.
 */
import { execFile, spawnSync } from "node:child_process";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";

import { inTempDir } from "../typst/compile.js";
import { probeTypst } from "../typst/service.js";

/** The binary the PDF tests compile with. */
export const TYPST_BIN = process.env["TYPST_BIN"] ?? "typst";

/** The probe's verdict on {@link TYPST_BIN}. */
export const typstProbe = await probeTypst(TYPST_BIN, 1024);

const hasPdftotext = spawnSync("pdftotext", ["-v"]).error === undefined;

/** Whether the PDF tests run: both tools here, or CI, where a missing one fails them. */
export const pdfTools = (typstProbe.available && hasPdftotext) || Boolean(process.env["CI"]);

/** The text of a PDF, through `pdftotext`, its layout kept. */
export async function pdfText(pdf: Buffer): Promise<string> {
  return inTempDir(async (dir) => {
    await writeFile(join(dir, "out.pdf"), pdf);
    const { stdout } = await promisify(execFile)("pdftotext", ["-enc", "UTF-8", "-layout", "out.pdf", "-"], { cwd: dir });
    return stdout;
  });
}
