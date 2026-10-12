import {
  PROJECT_ARCHIVE_MAX_BYTES,
  PROJECT_FILE_MAX_BYTES,
  PROJECT_OUTPUT_MAX_BYTES,
  type ProjectRunRequest,
} from "@quiz/core/server";
import { describe, expect, it } from "vitest";

import type { ExecResult } from "./engine.js";
import {
  COLLECT_RESERVE_MS,
  outputFile,
  parseListing,
  prepareProject,
  ProjectArchiveError,
  REAP_ARGV,
  runProject,
  UNPACK_ARGV,
} from "./project.js";
import { readTar, writeTar } from "./tar.js";
import { createFakeEngine, type FakeCall } from "./test/fakeEngine.js";
import { rawTar } from "./test/tarFixture.js";
import { testConfig } from "./test/config.js";

const config = testConfig();

const ARCHIVE = rawTar([
  { name: "Makefile", data: "prepare:\n\ttrue\n" },
  { name: "tests/test_a.py", data: "def test_a(): pass\n" },
]);

function request(overrides: Partial<ProjectRunRequest> = {}): ProjectRunRequest {
  return {
    archive: ARCHIVE.toString("base64"),
    image: "lab-c",
    commands: { build: ["make", "prepare"], test: ["pytest", "--junitxml=report.xml", "-q"] },
    outputs: ["report.xml", "build/"],
    limits: { timeMs: 120_000, memoryMb: 512, cpus: 2 },
    budgetMs: 300_000,
    ...overrides,
  };
}

/** The listing `find -printf '%y %s %p\0'` prints. */
function listing(records: Array<[string, number, string]>): Buffer {
  return Buffer.from(records.map(([type, size, path]) => `${type} ${size} ./${path}\0`).join(""));
}

type Files = Record<string, Buffer>;

/** An engine whose container holds `files`, answering find, tar -c and head from them. */
function engineWith(
  files: Files,
  step: (call: FakeCall) => Partial<ExecResult> = () => ({}),
  extra: Array<[string, number, string]> = [],
) {
  return createFakeEngine((call) => {
    const [program] = call.argv;
    if (program === "find") {
      return {
        stdoutBytes: listing([
          ...Object.entries(files).map(([path, data]): [string, number, string] => ["f", data.length, path]),
          ...extra,
        ]),
      };
    }
    if (program === "tar" && call.argv[1] === "-c") {
      const paths = call.argv.slice(5).map((path) => path.slice(2));
      return {
        stdoutBytes: writeTar(
          paths.map((path) => ({ path, type: "file", mode: 0o644, mtime: 0, data: files[path]! })),
        ),
      };
    }
    if (program === "head") {
      const take = Number(call.argv[2]);
      return { stdoutBytes: files[call.argv[3]!.slice(2)]!.subarray(0, take) };
    }
    if (program === "timeout") return step(call);
    return {};
  });
}

const deps = (engine: ReturnType<typeof createFakeEngine>, signal?: AbortSignal) => ({
  engine,
  config,
  containerName: () => "quiz-run-project",
  signal,
});

const programs = (calls: FakeCall[]): string[] => calls.map((call) => call.argv[0]!);

describe("prepareProject", () => {
  it("repacks a clean archive before anything runs", () => {
    const prepared = prepareProject(request());
    expect(readTar(prepared.tar).map((entry) => entry.path)).toEqual(["Makefile", "tests/", "tests/test_a.py"]);
  });

  it("refuses the WHOLE archive for one bad entry, naming every one (invariant 12)", () => {
    const archive = rawTar([
      { name: "Makefile", data: "x" },
      { name: "evil", type: "2", linkname: "/etc/shadow" },
      { name: "../up", data: "x" },
    ]).toString("base64");
    let refused: ProjectArchiveError | null = null;
    try {
      prepareProject(request({ archive }));
    } catch (error) {
      refused = error as ProjectArchiveError;
    }
    expect(refused?.reason).toBe("archive_refused");
    expect(refused?.entries).toEqual(["evil: symbolic_link", "../up: dot_segment"]);
  });

  it("refuses what is not base64, what is not a tar, and what is too large", () => {
    const reason = (archive: string): string => {
      try {
        prepareProject(request({ archive }));
        return "accepted";
      } catch (error) {
        return (error as ProjectArchiveError).reason;
      }
    };
    expect(reason("not base64!")).toBe("archive_invalid");
    expect(reason(Buffer.from("x".repeat(600)).toString("base64"))).toBe("archive_invalid");
    expect(reason(Buffer.alloc(PROJECT_ARCHIVE_MAX_BYTES + 3).toString("base64"))).toBe("archive_too_large");
  });
});

describe("runProject", () => {
  it("unpacks the clean archive on stdin, builds, tests, reaps, and destroys the container", async () => {
    const engine = engineWith({ "report.xml": Buffer.from("<testsuite/>") }, (call) =>
      call.argv[4] === "make" ? { exitCode: 0, stdout: "built\n" } : { exitCode: 0, stdout: "1 passed\n" },
    );
    const prepared = prepareProject(request());
    const result = await runProject(prepared, deps(engine));

    expect(engine.created).toEqual([
      {
        name: "quiz-run-project",
        image: "quiz-runner-lab-c:latest",
        memoryMb: 512,
        pidsLimit: 64,
        cpus: 2,
        workdirMb: config.RUNNER_PROJECT_WORKDIR_MB,
        ttlSeconds: 305,
      },
    ]);
    const [unpack] = engine.calls;
    expect(unpack!.argv).toEqual(UNPACK_ARGV);
    expect(Buffer.isBuffer(unpack!.stdin) && unpack!.stdin.equals(prepared.tar)).toBe(true);
    expect(programs(engine.calls)).toEqual(["tar", "timeout", "kill", "timeout", "kill", "find", "tar"]);
    expect(engine.calls[1]!.argv).toEqual(["timeout", "-s", "KILL", "120", "make", "prepare"]);
    expect(engine.calls[2]!.argv).toEqual(REAP_ARGV);
    expect(engine.calls[3]!.argv).toEqual(["timeout", "-s", "KILL", "120", "pytest", "--junitxml=report.xml", "-q"]);
    expect(result).toEqual({
      build: { exitCode: 0, stdout: "built\n", stderr: "", ms: 1, timedOut: false, truncated: false },
      test: { exitCode: 0, stdout: "1 passed\n", stderr: "", ms: 1, timedOut: false, truncated: false },
      files: [{ path: "report.xml", content: "<testsuite/>", truncated: false }],
    });
    expect(engine.removed).toContain("quiz-run-project");
  });

  it("runs the tests after a failed build, as the course's workflow does", async () => {
    const engine = engineWith({}, (call) =>
      call.argv[4] === "make" ? { exitCode: 2, stderr: "make: *** error\n" } : { exitCode: 1 },
    );
    const result = await runProject(prepareProject(request()), deps(engine));
    expect(result.build).toMatchObject({ exitCode: 2, stderr: "make: *** error\n" });
    expect(result.test).toMatchObject({ exitCode: 1, timedOut: false });
  });

  it("has no build step when the request names none", async () => {
    const engine = engineWith({});
    const result = await runProject(
      prepareProject(request({ commands: { test: ["pytest"] } })),
      deps(engine),
    );
    expect(result.build).toBeNull();
    expect(engine.calls.filter((call) => call.argv[0] === "timeout")).toHaveLength(1);
  });

  it("caps the clamps: memory by RUNNER_MAX_MEMORY_MB, cpus by RUNNER_PROJECT_MAX_CPUS", async () => {
    const engine = engineWith({});
    await runProject(
      prepareProject(request({ limits: { timeMs: 10_000, memoryMb: 2048, cpus: 4 } })),
      { ...deps(engine), config: testConfig({ RUNNER_MAX_MEMORY_MB: 768, RUNNER_PROJECT_MAX_CPUS: 1.5 }) },
    );
    expect(engine.created[0]).toMatchObject({ memoryMb: 768, cpus: 1.5, pidsLimit: 64 });
  });

  it("fits each step into the budget, keeping the outputs' reserve", async () => {
    const engine = engineWith({});
    await runProject(prepareProject(request({ budgetMs: 30_000 })), deps(engine));
    const seconds = Math.floor((30_000 - COLLECT_RESERVE_MS - config.RUNNER_CASE_GRACE_MS) / 1000);
    const steps = engine.calls.filter((call) => call.argv[0] === "timeout");
    expect(steps[0]!.argv[3]).toBe(String(seconds));
    expect(steps[0]!.timeoutMs).toBe(seconds * 1000 + config.RUNNER_CASE_GRACE_MS);
  });

  it("starts no step the budget cannot hold, and reports it timed out", async () => {
    const engine = engineWith({});
    const result = await runProject(prepareProject(request({ budgetMs: 5_000 })), deps(engine));
    expect(engine.calls.some((call) => call.argv[0] === "timeout")).toBe(false);
    expect(result.build).toMatchObject({ exitCode: null, timedOut: true });
    expect(result.test).toMatchObject({ exitCode: null, timedOut: true });
  });

  it("caps the budget at RUNNER_PROJECT_TIMEOUT_MS", async () => {
    const engine = engineWith({});
    await runProject(prepareProject(request({ budgetMs: 600_000 })), {
      ...deps(engine),
      config: testConfig({ RUNNER_PROJECT_TIMEOUT_MS: 60_000 }),
    });
    expect(engine.created[0]!.ttlSeconds).toBe(65);
  });

  it("runs nothing more in a container the service's clock or the OOM killer took", async () => {
    const engine = engineWith({ "report.xml": Buffer.from("x") }, (call) =>
      call.argv[4] === "make" ? { exitCode: null, timedOut: true } : {},
    );
    const result = await runProject(prepareProject(request()), deps(engine));
    expect(result.build).toMatchObject({ exitCode: null, timedOut: true });
    expect(result.test).toMatchObject({ exitCode: null, timedOut: true, ms: 0 });
    expect(result.files).toEqual([]);
    expect(programs(engine.calls)).toEqual(["tar", "timeout"]);
  });

  it("fails as upload_failed when the archive does not unpack", async () => {
    const engine = createFakeEngine((call) => (call.argv[0] === "tar" ? { exitCode: 2 } : {}));
    await expect(runProject(prepareProject(request()), deps(engine))).rejects.toMatchObject({
      reason: "upload_failed",
    });
    expect(engine.removed).toContain("quiz-run-project");
  });

  it("starts nothing for a caller that has gone", async () => {
    const engine = engineWith({});
    const gone = new AbortController();
    gone.abort();
    await expect(runProject(prepareProject(request()), deps(engine, gone.signal))).rejects.toMatchObject({
      reason: "aborted",
    });
    expect(engine.created).toEqual([]);
  });
});

describe("the outputs", () => {
  it("never follows nor returns a symbolic link, a directory or a refused name", () => {
    const listed = parseListing(
      listing([
        ["d", 4096, "build"],
        ["l", 11, "build/passwd"],
        ["f", 3, "build/b.txt"],
        ["f", 3, "build/a.txt"],
        ["f", 1, "build/bad\nname"],
        ["f", 9, "report.xml"],
        ["f", 2, "other.txt"],
      ]),
      ["report.xml", "build/", "build/a.txt"],
    );
    expect(listed).toEqual([
      { path: "report.xml", size: 9 },
      { path: "build/a.txt", size: 3 },
      { path: "build/b.txt", size: 3 },
    ]);
  });

  it("returns a symlink's target never: a link under build/ is not in the files", async () => {
    const engine = engineWith({ "build/out.txt": Buffer.from("ok") }, () => ({}), [["l", 11, "build/shadow"]]);
    const result = await runProject(prepareProject(request()), deps(engine));
    expect(result.files).toEqual([{ path: "build/out.txt", content: "ok", truncated: false }]);
    const tarCall = engine.calls.find((call) => call.argv[0] === "tar" && call.argv[1] === "-c");
    expect(tarCall!.argv).toEqual(["tar", "-c", "-f", "-", "--no-recursion", "./build/out.txt"]);
  });

  it("lists with ./ before every path: a path is never an option of find", async () => {
    const engine = engineWith({});
    await runProject(prepareProject(request({ outputs: ["-delete", "build/"] })), deps(engine));
    const find = engine.calls.find((call) => call.argv[0] === "find");
    expect(find!.argv).toEqual(["find", "./-delete", "./build", "-printf", "%y %s %p\\0"]);
  });

  it("returns a file with a NUL byte, or not UTF-8, as its size only", async () => {
    const engine = engineWith({
      "build/prog": Buffer.from([0x7f, 0x45, 0x4c, 0x46, 0x00, 0x01]),
      "build/latin1.txt": Buffer.from([0x63, 0x61, 0x66, 0xe9]),
      "build/notes.md": Buffer.from("café ✓"),
    });
    const result = await runProject(prepareProject(request({ outputs: ["build/"] })), deps(engine));
    expect(result.files).toEqual([
      { path: "build/latin1.txt", binary: true, size: 4 },
      { path: "build/notes.md", content: "café ✓", truncated: false },
      { path: "build/prog", binary: true, size: 6 },
    ]);
  });

  it("cuts a file over its cap through head -c, a character cut in two included", async () => {
    const big = Buffer.concat([Buffer.alloc(PROJECT_FILE_MAX_BYTES - 1, "a"), Buffer.from("é and more")]);
    const engine = engineWith({ "build/log.txt": big });
    const result = await runProject(prepareProject(request({ outputs: ["build/"] })), deps(engine));
    const head = engine.calls.find((call) => call.argv[0] === "head");
    expect(head!.argv).toEqual(["head", "-c", String(PROJECT_FILE_MAX_BYTES), "./build/log.txt"]);
    expect(result.files).toEqual([
      { path: "build/log.txt", content: "a".repeat(PROJECT_FILE_MAX_BYTES - 1), truncated: true },
    ]);
  });

  it("stops reading at the total cap, in the order of the outputs", async () => {
    const files: Files = { "report.xml": Buffer.from("<r/>") };
    for (let i = 0; i < 9; i += 1) files[`build/f${i}.txt`] = Buffer.alloc(PROJECT_FILE_MAX_BYTES, "x");
    const engine = engineWith(files);
    const result = await runProject(prepareProject(request()), deps(engine));
    expect(result.files[0]).toEqual({ path: "report.xml", content: "<r/>", truncated: false });
    const read = result.files.reduce((sum, file) => sum + ("content" in file ? file.content.length : 0), 0);
    expect(read).toBe(PROJECT_OUTPUT_MAX_BYTES);
    // The eighth build file got what was left, through head -c; the ninth nothing.
    expect(result.files.slice(-2)).toEqual([
      { path: "build/f7.txt", content: "x".repeat(PROJECT_FILE_MAX_BYTES - 4), truncated: true },
      { path: "build/f8.txt", content: "", truncated: true },
    ]);
  });

  it("judges a cut file by its complete characters only", () => {
    const cut = Buffer.from("ab✓").subarray(0, 4);
    expect(outputFile("a", cut, 5, true)).toEqual({ path: "a", content: "ab", truncated: true });
    expect(outputFile("a", cut, 5, false)).toEqual({ path: "a", binary: true, size: 5 });
  });
});
