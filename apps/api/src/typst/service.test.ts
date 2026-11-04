/**
 * The PDF door (ADR-125 §2, §3): one compile at a time behind a bounded
 * queue, the `retry-after` of a refusal for load, the caps of every compile,
 * the images of the reader, and a formula that breaks the compile printed as
 * its LaTeX rather than failing the PDF.
 */
import type { FastifyBaseLogger, FastifyReply } from "fastify";
import { describe, expect, it, vi } from "vitest";

import { heading, markdown, type Document } from "@quiz/docexport";

import { sendFailure } from "../modules/http.js";
import { compileTypst } from "./compile.js";
import { CompileGate, PDF_RETRY_AFTER_S, PdfError, PdfService, prlimitCaps, probeTypst } from "./service.js";

const BIN = process.env["TYPST_BIN"] ?? "typst";
const probe = await probeTypst(BIN, 1024);
const withTypst = probe.available || Boolean(process.env["CI"]);

const quiet = () => ({ info: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn() }) as unknown as FastifyBaseLogger;
const config = (bin = BIN) => ({ TYPST_BIN: bin, PDF_TIMEOUT_MS: 20_000, PDF_MAX_MEMORY_MB: 1024 });
const teacher = { id: "t1", role: "teacher" };

describe("CompileGate", () => {
  it("runs one job at a time, keeps a bounded line, and refuses past it", async () => {
    const gate = new CompileGate(2);
    const order: string[] = [];
    let release!: () => void;
    const first = gate.run(
      () =>
        new Promise<void>((done) => {
          order.push("first");
          release = done;
        }),
    );
    const second = gate.run(async () => void order.push("second"));
    const third = gate.run(async () => void order.push("third"));
    await expect(gate.run(async () => "fourth")).rejects.toMatchObject({ code: "pdf_busy", status: 503 });
    expect(order).toEqual(["first"]);
    release();
    await Promise.all([first, second, third]);
    expect(order).toEqual(["first", "second", "third"]);
    // The line is empty again: the next one runs at once.
    expect(await gate.run(async () => "next")).toBe("next");
  });

  it("frees its slot when a job fails", async () => {
    const gate = new CompileGate(0);
    await expect(gate.run(async () => Promise.reject(new Error("boom")))).rejects.toThrow("boom");
    expect(await gate.run(async () => "after")).toBe("after");
  });
});

describe("pdf_busy through the shared tail", () => {
  it("is a 503 that says when to come back", () => {
    const sent: { status?: number; headers: Record<string, string>; body?: unknown } = { headers: {} };
    const reply = {
      code: (status: number) => ((sent.status = status), reply),
      header: (name: string, value: string) => ((sent.headers[name] = value), reply),
      send: (body: unknown) => ((sent.body = body), reply),
    };
    sendFailure(reply as unknown as FastifyReply, new PdfError("pdf_busy"), new Date());
    expect(sent).toEqual({
      status: 503,
      headers: { "retry-after": String(PDF_RETRY_AFTER_S) },
      body: { error: "pdf_busy", message: "Too many PDFs are being made: try again shortly" },
    });
  });
});

const doc = (text: string): Document => ({
  provenance: { kind: "test", version: 1, source: {}, attempts: [], generatedAt: "2026-11-04T10:00:00.000Z", app: null },
  lang: "en",
  blocks: [heading(1, "Formulas"), markdown(text)],
});

describe("PdfService", () => {
  it("refuses with pdf_unavailable when the probe found no Typst", async () => {
    const service = new PdfService(config("/nonexistent/typst"), quiet(), async () => []);
    expect(await service.status()).toEqual({ available: false, version: null, capped: false });
    await expect(service.render(doc("x"), teacher)).rejects.toMatchObject({ code: "pdf_unavailable", status: 503 });
  });

  it.skipIf(!withTypst)("compiles under prlimit's caps, with the images the reader may see", async () => {
    const compile = vi.fn(compileTypst);
    const png = Buffer.from(
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==",
      "base64",
    );
    const load = vi.fn(async (ids: readonly string[]) => ids.filter((id) => id === "seen").map((id) => ({ id, bytes: png })));
    const service = new PdfService(config(), quiet(), load, compile);
    const student = { id: "s1", role: "student" };
    const pdf = await service.render(doc("![a](asset:seen) ![b](asset:hidden)"), student);
    expect(pdf.subarray(0, 5).toString("latin1")).toBe("%PDF-");
    expect(load).toHaveBeenCalledWith(["seen", "hidden"], student);
    const [input, options] = compile.mock.calls[0]!;
    expect(input.source.startsWith('#let drawable = ("seen",)\n')).toBe(true);
    expect(input.assets.map((a) => a.path)).toEqual(["assets/seen"]);
    expect(options.memory).toEqual(prlimitCaps(1024));
  });

  it.skipIf(!withTypst)("prints a formula Typst refuses as its LaTeX, and still makes the PDF", async () => {
    const log = quiet();
    const service = new PdfService(config(), log, async () => []);
    // `\hat{}` converts (`hat()`) and Typst then refuses it: the second try boxes every formula.
    const pdf = await service.render(doc("Fine $x^2$, broken $\\hat{}$."), teacher);
    expect(pdf.subarray(0, 5).toString("latin1")).toBe("%PDF-");
    expect(log.warn).toHaveBeenCalledWith("pdf: compile failed, trying again with every formula as LaTeX");
  });
});
