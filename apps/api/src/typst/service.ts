/**
 * The PDF of a document (ADR-121 §7, ADR-125 §1–§3): the one door every
 * PDF route goes through, decorated on the application as `app.pdf`.
 *
 * - **Availability**: a probe, once per process, runs `typst --version` and
 *   compiles a one-line document in the sandbox, under the same
 *   `prlimit` caps as a real compile when the host has `prlimit` (without
 *   it, uncapped, and the system status says so); only a PDF out of it
 *   makes the binary available (a binary that cannot see the temporary
 *   directory, a confined snap for one, is not). `/app/api/config` (`pdf`)
 *   and the system status read it; a PDF route answers
 *   `503 pdf_unavailable` without it. `server.ts` runs it at boot.
 * - **One compile at a time**, behind a queue of at most
 *   {@link MAX_WAITING}: past it `503 pdf_busy` with a `retry-after`. One
 *   Typst beside the Node process is what the staging container's memory
 *   holds.
 * - **The images a reader may see**: the document's `asset:<id>` references
 *   are loaded for the requesting reader (`readableAssets` of the pool
 *   module), copied into the compile root, and named in the `drawable` line
 *   before the source; any other prints its alt text.
 * - **A formula never fails the PDF**: the converted maths is checked by
 *   `@quiz/docexport/typst`, and a compile that still fails while the source
 *   held converted formulas is tried once more with every formula as its
 *   LaTeX source.
 */
import type { FastifyBaseLogger } from "fastify";

import type { Document } from "@quiz/docexport";
import { BODY_FONT, drawable, renderTypst } from "@quiz/docexport/typst";

import type { AppConfig } from "../config.js";
import { refusalClass } from "../modules/http.js";
import type { AssetReader } from "../modules/pool/service.js";
import { compileTypst, inTempDir, run, TypstFailure, type CompileOptions } from "./compile.js";

/** What the probe found. */
export interface PdfStatus {
  available: boolean;
  /** `0.15.1`; null when the binary did not answer. */
  version: string | null;
  /** Each compile runs under `prlimit`'s address-space and file-size caps. */
  capped: boolean;
}

/** Compiles waiting behind the running one before a request is refused. */
export const MAX_WAITING = 8;

/** The `retry-after` of a `pdf_busy`, in seconds. */
export const PDF_RETRY_AFTER_S = 5;

export class PdfError extends refusalClass("PdfError", {
  pdf_unavailable: [503, "PDF export is not available on this server"],
  pdf_busy: [503, "Too many PDFs are being made: try again shortly", PDF_RETRY_AFTER_S],
  pdf_failed: [500, "The PDF could not be made"],
}) {}

/** The probe's document: one line in the body font, as every real one. */
const PROBE_SOURCE = `#set text(font: "${BODY_FONT}")\nQuiz`;

const UNAVAILABLE: PdfStatus = { available: false, version: null, capped: false };

/** The caps of a compile on a host with `prlimit`, for `maxMemoryMb`. */
export const prlimitCaps = (maxMemoryMb: number): NonNullable<CompileOptions["memory"]> => ({
  prlimit: "prlimit",
  bytes: maxMemoryMb * 1024 * 1024,
});

/**
 * Whether `bin` compiles in the sandbox, its version, and whether it does so
 * under `prlimit` (tried first; a host without the program compiles
 * uncapped). Never throws: a binary that is missing, confined elsewhere or
 * broken is unavailable.
 */
export async function probeTypst(bin: string, maxMemoryMb: number, timeoutMs = 10_000): Promise<PdfStatus> {
  let version: string | null;
  try {
    const { stdout } = await inTempDir((dir) => run(bin, ["--version"], dir, 5_000));
    version = /typst\s+(\S+)/.exec(stdout)?.[1] ?? null;
  } catch {
    return UNAVAILABLE;
  }
  for (const memory of [prlimitCaps(maxMemoryMb), null]) {
    try {
      const pdf = await compileTypst({ source: PROBE_SOURCE, assets: [] }, { bin, timeoutMs, memory });
      return { available: pdf.subarray(0, 5).toString("latin1") === "%PDF-", version, capped: memory !== null };
    } catch (error) {
      // No `prlimit` on this host: the same compile, uncapped.
      if (memory !== null && error instanceof TypstFailure && error.reason === "missing") continue;
      return UNAVAILABLE;
    }
  }
  return UNAVAILABLE;
}

/** One compile at a time, at most `maxWaiting` behind it. */
export class CompileGate {
  private busy = false;
  private readonly waiting: (() => void)[] = [];
  constructor(private readonly maxWaiting: number) {}

  async run<T>(job: () => Promise<T>): Promise<T> {
    if (this.busy) {
      if (this.waiting.length >= this.maxWaiting) throw new PdfError("pdf_busy");
      await new Promise<void>((go) => this.waiting.push(go));
    } else {
      this.busy = true;
    }
    try {
      return await job();
    } finally {
      // The slot passes to the next in line, or frees.
      const next = this.waiting.shift();
      if (next) next();
      else this.busy = false;
    }
  }
}

/** The bytes of the images `ids` that `reader` may see; any other is left out. */
export type AssetLoader = (ids: readonly string[], reader: AssetReader) => Promise<readonly { id: string; bytes: Buffer }[]>;

export class PdfService {
  private probed: Promise<PdfStatus> | null = null;
  private readonly gate = new CompileGate(MAX_WAITING);

  constructor(
    private readonly config: Pick<AppConfig, "TYPST_BIN" | "PDF_TIMEOUT_MS" | "PDF_MAX_MEMORY_MB">,
    private readonly log: FastifyBaseLogger,
    /** Reads the `asset:<id>` images a document draws (`readableAssets`). */
    private readonly load: AssetLoader,
    /** The compile itself; a test observes the options it is given. */
    private readonly compile: typeof compileTypst = compileTypst,
  ) {}

  /** The probe's verdict, run once. */
  status(): Promise<PdfStatus> {
    this.probed ??= probeTypst(this.config.TYPST_BIN, this.config.PDF_MAX_MEMORY_MB).then((status) => {
      this.log.info({ pdf: status }, status.available ? "typst available" : "typst unavailable: no PDF export");
      return status;
    });
    return this.probed;
  }

  /** The PDF of `doc`, with the images `reader` may see. */
  async render(doc: Document, reader: AssetReader): Promise<Buffer> {
    const status = await this.status();
    if (!status.available) throw new PdfError("pdf_unavailable");
    const first = renderTypst(doc);
    const loaded = await this.load(
      first.assets.map((a) => a.id),
      reader,
    );
    const line = drawable(loaded.map((a) => a.id));
    const assets = loaded.map((a) => ({ path: `assets/${a.id}`, bytes: a.bytes }));
    const options: CompileOptions = {
      bin: this.config.TYPST_BIN,
      timeoutMs: this.config.PDF_TIMEOUT_MS,
      memory: status.capped ? prlimitCaps(this.config.PDF_MAX_MEMORY_MB) : null,
    };
    return this.gate.run(async () => {
      if (first.warnings > 0) this.log.info({ warnings: first.warnings }, "pdf: formulas printed as LaTeX");
      try {
        return await this.compile({ source: line + first.source, assets }, options);
      } catch (error) {
        if (!(error instanceof TypstFailure) || error.reason !== "error" || first.formulas === 0) throw this.failed(error);
        this.log.warn("pdf: compile failed, trying again with every formula as LaTeX");
        this.log.debug({ log: error.log }, "pdf: typst output");
        const raw = renderTypst(doc, { math: "raw" });
        return this.compile({ source: line + raw.source, assets }, options).catch((again: unknown) => {
          throw this.failed(again);
        });
      }
    });
  }

  /** A failure for the log (the child's output at debug), `pdf_failed` for the client. */
  private failed(error: unknown): PdfError {
    if (error instanceof TypstFailure) {
      this.log.warn({ reason: error.reason }, "pdf: compile failed");
      this.log.debug({ log: error.log }, "pdf: typst output");
    } else {
      this.log.error({ err: error }, "pdf: compile failed");
    }
    return new PdfError("pdf_failed");
  }
}

declare module "fastify" {
  interface FastifyInstance {
    /** The PDF renderer and its probe (ADR-125 §3). */
    pdf: PdfService;
  }
}
