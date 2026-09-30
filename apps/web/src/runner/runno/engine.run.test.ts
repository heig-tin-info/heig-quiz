/**
 * The worker half of the browser runner (`engine.ts`), without a real
 * toolchain: `@runno/wasi` and the tar reader are replaced by doubles, and
 * the "programs" are the smallest valid WebAssembly modules, hand-assembled
 * below. What is pinned is the engine's own logic:
 *
 *  - stdin served in byte-sized chunks that never split a UTF-8 sequence;
 *  - output capped like the backend runner's, and a flood stopped;
 *  - the memory ceiling, possible only on a module that imports its memory;
 *  - the order of the messages a job emits — `compile`, then `case.start` /
 *    `case` per case, then `done` — on which the main thread's wall clock
 *    depends, and every way a build fails.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { RunnoJob, WorkerMessage } from "./protocol";

// --- The WASI double ---------------------------------------------------------

interface WasiOptions {
  args: string[];
  fs: Record<string, { path: string; mode: string; content: unknown }>;
  stdin: (max: number) => string | null;
  stdout: (text: string) => void;
  stderr: (text: string) => void;
}

/** What one process does, decided by the test from its argv. */
type Behaviour = (options: WasiOptions) => { exitCode: number; fs?: WasiOptions["fs"] };

const wasi = vi.hoisted(() => ({
  behave: (() => ({ exitCode: 0 })) as (options: never) => { exitCode: number; fs?: unknown },
  seen: [] as { args: string[]; fs: Record<string, unknown>; memory: unknown }[],
}));

vi.mock("@runno/wasi", () => ({
  WASI: class {
    constructor(private readonly options: WasiOptions) {}
    getImportObject() {
      return { wasi_snapshot_preview1: {} };
    }
    start(_instance: unknown, extra: { memory?: WebAssembly.Memory }) {
      wasi.seen.push({ args: this.options.args, fs: this.options.fs, memory: extra.memory });
      const result = (wasi.behave as unknown as Behaviour)(this.options);
      return { exitCode: result.exitCode, fs: result.fs ?? this.options.fs };
    }
  },
}));

vi.mock("./tar", () => ({
  extractTarGz: vi.fn(async () => ({ "/sys/include/stdio.h": new Uint8Array([1]) })),
}));

import {
  ENTRY_FILE,
  memoryImportOf,
  OutputFlood,
  outputSink,
  PYTHON_SYNTAX_CHECK,
  runJob,
  runProcess,
  stdinReader,
} from "./engine";

// --- Hand-assembled modules --------------------------------------------------

const HEADER = [0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00];
const name = (s: string) => [s.length, ...new TextEncoder().encode(s)];

/** An empty module: exports nothing, imports nothing. */
const EMPTY = new Uint8Array(HEADER);

/** A module importing `env.memory` (min 1 page): one the host can cap. */
const IMPORTS_MEMORY = (() => {
  const entry = [...name("env"), ...name("memory"), 0x02, 0x00, 0x01];
  return new Uint8Array([...HEADER, 0x02, entry.length + 1, 0x01, ...entry]);
})();

const emptyModule = () => new WebAssembly.Module(EMPTY);

// --- Helpers ---------------------------------------------------------------

function job(over: Partial<RunnoJob> = {}): RunnoJob {
  return {
    language: "c",
    files: [{ name: "main.c", content: "int main(){}" }],
    cases: [
      { index: 0, args: ["a"], stdin: "one" },
      { index: 3, args: [], stdin: "" },
    ],
    limits: { timeMs: 1000, memoryMb: 32, outputKb: 1 },
    assets: {
      modules: { clang: emptyModule(), "wasm-ld": emptyModule(), python: emptyModule() },
      archives: { sysroot: new ArrayBuffer(4), stdlib: new ArrayBuffer(4) },
    },
    program: null,
    ...over,
  };
}

async function run(j: RunnoJob): Promise<WorkerMessage[]> {
  const messages: WorkerMessage[] = [];
  await runJob(j, { emit: (m) => messages.push(m) });
  return messages;
}

const kinds = (messages: WorkerMessage[]) =>
  messages.map((m) => (m.type === "case" || m.type === "case.start" ? `${m.type}:${m.index}` : m.type));

/** The C toolchain behaves: clang exits 0, wasm-ld writes a linkable program. */
const toolchainOk: Behaviour = (o) => {
  if (o.args[0] === "wasm-ld") {
    return {
      exitCode: 0,
      fs: { ...o.fs, "/program.wasm": { path: "/program.wasm", mode: "binary", content: EMPTY } },
    };
  }
  if (o.args[0] === "program") o.stdout(`ran ${o.args.slice(1).join(",")}`);
  return { exitCode: 0 };
};

beforeEach(() => {
  wasi.behave = toolchainOk as never;
  wasi.seen = [];
});

// --- Pure pieces -------------------------------------------------------------

describe("stdinReader", () => {
  it("hands everything over at once when it fits, then EOF", () => {
    const read = stdinReader("hello\n");
    expect(read(64)).toBe("hello\n");
    expect(read(64)).toBeNull();
  });

  it("cuts at the buffer size, in bytes, and never splits a UTF-8 sequence", () => {
    const read = stdinReader("aé€b"); // 1 + 2 + 3 + 1 bytes
    const chunks: string[] = [];
    for (let chunk = read(3); chunk !== null; chunk = read(3)) chunks.push(chunk);
    expect(chunks.join("")).toBe("aé€b");
    for (const chunk of chunks) expect(new TextEncoder().encode(chunk).byteLength).toBeLessThanOrEqual(3);
    expect(chunks).toEqual(["aé", "€", "b"]);
  });

  it("serves nothing for an empty stdin", () => {
    expect(stdinReader("")(10)).toBeNull();
  });
});

describe("outputSink", () => {
  it("keeps what fits, drops the rest and says so", () => {
    const sink = outputSink(5);
    sink.push("abc");
    sink.push("de");
    expect(sink.truncated).toBe(false);
    sink.push("f");
    expect(sink.text).toBe("abcde");
    expect(sink.truncated).toBe(true);
  });

  it("stops a program that keeps printing at eight times the cap", () => {
    const sink = outputSink(4);
    sink.push("x".repeat(32)); // exactly 8x: still tolerated
    expect(() => sink.push("x")).toThrow(OutputFlood);
  });

  it("counts bytes, not characters", () => {
    const sink = outputSink(3);
    sink.push("€€");
    expect(sink.text).toBe("");
    expect(sink.truncated).toBe(true);
  });
});

describe("memoryImportOf", () => {
  it("finds the imported memory of a module the host can cap", () => {
    expect(memoryImportOf(new WebAssembly.Module(IMPORTS_MEMORY))).toEqual({ module: "env", name: "memory" });
  });

  it("finds none in a module that brings its own", () => {
    expect(memoryImportOf(emptyModule())).toBeNull();
  });
});

// --- One process ------------------------------------------------------------

describe("runProcess", () => {
  const base = { args: ["program"], fs: {}, stdin: "", memoryMb: 16, outputBytes: 1024 };

  it("returns the exit code and the collected streams", async () => {
    wasi.behave = ((o: WasiOptions) => {
      o.stdout("out");
      o.stderr("err");
      return { exitCode: 3 };
    }) as never;
    const result = await runProcess({ ...base, module: emptyModule() });
    expect(result).toMatchObject({ exitCode: 3, stdout: "out", stderr: "err", oom: false, truncated: false, memoryCapped: false });
  });

  it("caps the memory of a module that imports it, at memoryMb", async () => {
    const result = await runProcess({ ...base, module: new WebAssembly.Module(IMPORTS_MEMORY) });
    expect(result.memoryCapped).toBe(true);
    const memory = wasi.seen[0]!.memory as WebAssembly.Memory;
    expect(memory).toBeInstanceOf(WebAssembly.Memory);
    // 16 MB is 256 pages of 64 KB: growing past them fails.
    memory.grow(254);
    expect(() => memory.grow(1)).toThrow(RangeError);
  });

  it("reads a RangeError as out of memory, with the error on stderr", async () => {
    wasi.behave = (() => {
      throw new RangeError("Maximum call stack size exceeded");
    }) as never;
    const result = await runProcess({ ...base, module: emptyModule() });
    expect(result).toMatchObject({ exitCode: null, oom: true });
    expect(result.stderr).toContain("RangeError: Maximum call stack size exceeded");
  });

  it("reads any other trap as a crash, not out of memory", async () => {
    wasi.behave = (() => {
      throw new Error("unreachable executed");
    }) as never;
    const result = await runProcess({ ...base, module: emptyModule() });
    expect(result).toMatchObject({ exitCode: null, oom: false });
    expect(result.stderr).toContain("Error: unreachable executed");
  });

  it("ends a flood as truncated output, with nothing added to stderr", async () => {
    wasi.behave = ((o: WasiOptions) => {
      for (;;) o.stdout("y".repeat(100));
    }) as never;
    const result = await runProcess({ ...base, outputBytes: 100, module: emptyModule() });
    expect(result).toMatchObject({ exitCode: null, oom: false, truncated: true, stderr: "" });
    expect(result.stdout).toBe("y".repeat(100));
  });
});

// --- The job ----------------------------------------------------------------

describe("runJob — C", () => {
  it("compiles, links, sends the program back, then runs each case in order", async () => {
    const messages = await run(job());
    expect(kinds(messages)).toEqual(["compile", "case.start:0", "case:0", "case.start:3", "case:3", "done"]);
    const compile = messages[0] as Extract<WorkerMessage, { type: "compile" }>;
    expect(compile.ok).toBe(true);
    expect(compile.program).toBeInstanceOf(ArrayBuffer);
    expect(compile.memoryCapped).toEqual({ clang: false, "wasm-ld": false });
    expect(messages[2]).toMatchObject({ type: "case", index: 0, exitCode: 0, stdout: "ran a" });

    const [clang, ld] = wasi.seen;
    expect(clang!.args[0]).toBe("clang");
    expect(clang!.args.at(-1)).toBe(`/${ENTRY_FILE.c}`);
    expect(clang!.args).not.toContain("-fcolor-diagnostics");
    // The sources are on the filesystem beside the sysroot.
    expect(Object.keys(clang!.fs)).toEqual(expect.arrayContaining(["/main.c", "/sys/include/stdio.h"]));
    expect(ld!.args[0]).toBe("wasm-ld");
    expect(wasi.seen[2]!.args).toEqual(["program", "a"]);
  });

  it("writes a file under a sanitized name, never a path (invariant 12)", async () => {
    await run(job({ files: [{ name: "main.c", content: "" }, { name: "../../etc/passwd", content: "x" }], cases: [] }));
    const paths = Object.keys(wasi.seen[0]!.fs);
    expect(paths).toContain("/.._.._etc_passwd");
    expect(paths.some((p) => p.includes("/etc/"))).toBe(false);
  });

  it("reports a compile error and runs nothing", async () => {
    wasi.behave = ((o: WasiOptions) => {
      o.stderr("main.c:1:1: error: expected ';'");
      return { exitCode: 1 };
    }) as never;
    const messages = await run(job());
    expect(kinds(messages)).toEqual(["compile", "done"]);
    expect(messages[0]).toMatchObject({ ok: false, program: null, stderr: "main.c:1:1: error: expected ';'" });
    expect(wasi.seen).toHaveLength(1);
  });

  it("reports a link that produced no program as a failed build, with both outputs", async () => {
    wasi.behave = ((o: WasiOptions) => {
      if (o.args[0] === "clang") o.stderr("warning\n");
      else o.stderr("wasm-ld: undefined symbol: foo\n");
      return { exitCode: o.args[0] === "clang" ? 0 : 1 };
    }) as never;
    const messages = await run(job());
    expect(kinds(messages)).toEqual(["compile", "done"]);
    expect(messages[0]).toMatchObject({ ok: false, stderr: "warning\nwasm-ld: undefined symbol: foo\n" });
  });

  it("does not compile again when a previous worker sent the program back", async () => {
    const messages = await run(job({ program: EMPTY.slice().buffer, cases: [{ index: 1, args: [], stdin: "" }] }));
    expect(kinds(messages)).toEqual(["case.start:1", "case:1", "done"]);
    expect(wasi.seen.map((s) => s.args[0])).toEqual(["program"]);
  });

  it("builds and runs nothing when there is no case (the Compile button)", async () => {
    const messages = await run(job({ cases: [], check: true }));
    expect(kinds(messages)).toEqual(["compile", "done"]);
  });

  it("fails without its toolchain or sysroot", async () => {
    await expect(run(job({ assets: { modules: {}, archives: { sysroot: new ArrayBuffer(1) } } }))).rejects.toThrow(
      /missing clang toolchain/,
    );
    await expect(run(job({ assets: { modules: {}, archives: {} } }))).rejects.toThrow(/missing clang sysroot/);
  });
});

describe("runJob — Python", () => {
  const python = (over: Partial<RunnoJob> = {}) =>
    job({ language: "python", files: [{ name: "main.py", content: "print(1)" }], ...over });

  it("has no build: an ok compile, then each case runs the entry file with its arguments", async () => {
    const messages = await run(python());
    expect(kinds(messages)).toEqual(["compile", "case.start:0", "case:0", "case.start:3", "case:3", "done"]);
    expect(messages[0]).toMatchObject({ ok: true, program: null, memoryCapped: { python: false } });
    expect(wasi.seen.map((s) => s.args)).toEqual([
      ["python", `/${ENTRY_FILE.python}`, "a"],
      ["python", `/${ENTRY_FILE.python}`],
    ]);
  });

  it("checks the syntax on `check`, without running the program", async () => {
    wasi.behave = ((o: WasiOptions) => {
      o.stderr('  File "/main.py", line 1\nSyntaxError: invalid syntax\n');
      return { exitCode: 1 };
    }) as never;
    const messages = await run(python({ check: true }));
    expect(kinds(messages)).toEqual(["compile", "done"]);
    expect(messages[0]).toMatchObject({ ok: false, stderr: expect.stringContaining("SyntaxError") });
    expect(wasi.seen).toHaveLength(1);
    expect(wasi.seen[0]!.args).toEqual(["python", "-c", PYTHON_SYNTAX_CHECK, `/${ENTRY_FILE.python}`]);
  });

  it("passes a clean syntax check as a successful build", async () => {
    wasi.behave = (() => ({ exitCode: 0 })) as never;
    const messages = await run(python({ check: true }));
    expect(messages[0]).toMatchObject({ type: "compile", ok: true });
  });

  it("fails without its standard library or interpreter", async () => {
    await expect(run(python({ assets: { modules: {}, archives: {} } }))).rejects.toThrow(/stdlib/);
    await expect(run(python({ assets: { modules: {}, archives: { stdlib: new ArrayBuffer(1) } } }))).rejects.toThrow(
      /missing python module/,
    );
  });
});
