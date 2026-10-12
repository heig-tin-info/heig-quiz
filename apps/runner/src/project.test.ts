import { PROJECT_FILE_MAX_BYTES, PROJECT_OUTPUT_MAX_BYTES, type ProjectRunRequest } from "@quiz/core/server";
import { readTar, writeTar, type CleanEntry } from "@quiz/core/tar";
import { describe, expect, it } from "vitest";

import type { ExecResult } from "./engine.js";
import {
  COLLECT_RESERVE_MS,
  outputsUnderDirectories,
  parentsOf,
  parseListing,
  prepareProject,
  ProjectArchiveError,
  REAP_ARGV,
  runProject,
  UNPACK_ARGV,
} from "./project.js";
import { createFakeEngine, type FakeCall } from "./test/fakeEngine.js";
import { testConfig } from "./test/config.js";

const config = testConfig();

function file(path: string, content: string | Buffer): CleanEntry {
  return { path, type: "file", mode: 0o644, mtime: 0, data: Buffer.from(content) };
}

const ARCHIVE = Buffer.from(
  writeTar([file("Makefile", "prepare:\n\ttrue\n"), file("tests/test_a.py", "def test_a(): pass\n")]),
);

function request(overrides: Partial<ProjectRunRequest> = {}): ProjectRunRequest {
  return {
    archive: ARCHIVE.toString("base64"),
    image: "lab-c",
    commands: { build: ["make", "prepare"], test: ["pytest", "--junitxml=report.xml", "-q"] },
    outputs: ["report.xml", "build/"],
    ...overrides,
  };
}

/** The listing `find -printf` prints: `%y %s %p\0`, or `%y %p\0` without a size. */
function listing(records: Array<[string, number | null, string]>): Buffer {
  return Buffer.from(
    records.map(([type, size, path]) => `${type} ${size === null ? "" : `${size} `}./${path}\0`).join(""),
  );
}

type Files = Record<string, Buffer>;

/**
 * An engine whose container holds `files` (and `links`, symbolic links),
 * answering both `find` listings and `tar -c` from them.
 */
function engineWith(
  files: Files,
  step: (call: FakeCall) => Partial<ExecResult> = () => ({}),
  links: string[] = [],
) {
  return createFakeEngine((call) => {
    const [program] = call.argv;
    if (program === "find" && call.argv.includes("-maxdepth")) {
      const asked = call.argv.slice(1, call.argv.indexOf("-maxdepth")).map((path) => path.slice(2));
      return { stdoutBytes: listing(asked.map((path) => [links.includes(path) ? "l" : "d", null, path])) };
    }
    if (program === "find") {
      return {
        stdoutBytes: listing([
          ...Object.entries(files).map(([path, data]): [string, number, string] => ["f", data.length, path]),
          ...links.map((path): [string, number, string] => ["l", 11, path]),
        ]),
      };
    }
    if (program === "tar" && call.argv[1] === "-c") {
      const paths = call.argv.slice(5).map((path) => path.slice(2));
      return { stdoutBytes: Buffer.from(writeTar(paths.map((path) => file(path, files[path]!)))) };
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
    expect(readTar(prepareProject(request()).tar).map((entry) => entry.path)).toEqual([
      "Makefile",
      "tests/",
      "tests/test_a.py",
    ]);
  });

  it("refuses what is not base64 or not a tar", () => {
    for (const archive of ["not base64!", Buffer.from("x".repeat(600)).toString("base64")]) {
      expect(() => prepareProject(request({ archive }))).toThrow(ProjectArchiveError);
    }
  });
});

describe("runProject", () => {
  it("unpacks the clean archive on stdin, builds, tests, reaps, and destroys the container", async () => {
    const engine = engineWith({ "report.xml": Buffer.from("<testsuite/>") }, (call) =>
      call.argv[4] === "make" ? { exitCode: 0, stdout: "built\n" } : { exitCode: 0, stdout: "1 passed\n" },
    );
    const prepared = prepareProject(request());
    const result = await runProject(prepared, deps(engine));

    // The runner's configuration, never the request's (ADR-106 §3).
    expect(engine.created).toEqual([
      {
        name: "quiz-run-project",
        image: "quiz-runner-lab-c:latest",
        memoryMb: config.RUNNER_MAX_MEMORY_MB,
        pidsLimit: 64,
        cpus: 1,
        workdirMb: config.RUNNER_PROJECT_WORKDIR_MB,
        ttlSeconds: config.RUNNER_PROJECT_TIMEOUT_MS / 1000 + 5,
      },
    ]);
    const [unpack] = engine.calls;
    expect(unpack!.argv).toEqual(UNPACK_ARGV);
    expect(unpack!.stdin).toEqual(prepared.tar);
    expect(programs(engine.calls)).toEqual(["tar", "timeout", "kill", "timeout", "kill", "find", "tar"]);
    // The build gets half the budget; the tests the rest, minus the outputs' reserve and the grace.
    const half = config.RUNNER_PROJECT_TIMEOUT_MS / 2000;
    expect(engine.calls[1]!.argv).toEqual(["timeout", "-s", "KILL", String(half), "make", "prepare"]);
    expect(engine.calls[2]!.argv).toEqual(REAP_ARGV);
    const testSeconds = Number(engine.calls[3]!.argv[3]);
    expect(testSeconds * 1000).toBeLessThanOrEqual(
      config.RUNNER_PROJECT_TIMEOUT_MS - COLLECT_RESERVE_MS - config.RUNNER_CASE_GRACE_MS,
    );
    expect(testSeconds).toBeGreaterThan(half);
    expect(result).toEqual({
      build: { exitCode: 0, stdout: "built\n", stderr: "", ms: 1, timedOut: false, truncated: false },
      test: { exitCode: 0, stdout: "1 passed\n", stderr: "", ms: 1, timedOut: false, truncated: false },
      files: [{ path: "report.xml", content: "<testsuite/>", truncated: false, size: 12 }],
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
    const result = await runProject(prepareProject(request({ commands: { test: ["pytest"] } })), deps(engine));
    expect(result.build).toBeNull();
    expect(engine.calls.filter((call) => call.argv[0] === "timeout")).toHaveLength(1);
  });

  it("starts no step the budget cannot hold, and reports it timed out", async () => {
    const engine = engineWith({});
    const tight = testConfig({ RUNNER_PROJECT_TIMEOUT_MS: COLLECT_RESERVE_MS + 2_500 });
    const result = await runProject(prepareProject(request()), { ...deps(engine), config: tight });
    expect(engine.calls.some((call) => call.argv[0] === "timeout")).toBe(false);
    expect(result.build).toMatchObject({ exitCode: null, timedOut: true });
    expect(result.test).toMatchObject({ exitCode: null, timedOut: true });
  });

  it.each([
    ["the service's clock fired", { exitCode: null, timedOut: true }],
    ["the container is gone", { exitCode: 137, containerGone: true }],
  ])("runs nothing more once %s", async (_, answer) => {
    const engine = engineWith({ "report.xml": Buffer.from("x") }, (call) => (call.argv[4] === "make" ? answer : {}));
    const result = await runProject(prepareProject(request()), deps(engine));
    expect(result.test).toMatchObject({ exitCode: null, timedOut: true, ms: 0 });
    expect(result.files).toEqual([]);
    expect(programs(engine.calls)).toEqual(["tar", "timeout"]);
  });

  it("ends the run, not the request, when the reap fails", async () => {
    const engine = engineWith({ "report.xml": Buffer.from("x") });
    const exec = engine.exec.bind(engine);
    engine.exec = async (name, options) => {
      if (options.argv[0] === "kill") throw new Error("socket closed");
      return exec(name, options);
    };
    const result = await runProject(prepareProject(request()), deps(engine));
    expect(result.build).toMatchObject({ exitCode: 0 });
    expect(result.test).toMatchObject({ exitCode: null, timedOut: true });
    expect(result.files).toEqual([]);
  });

  it("refuses an archive that does not fit the work directory, never as a retryable failure", async () => {
    const engine = createFakeEngine((call) => (call.argv[0] === "tar" ? { exitCode: 2, stderr: "No space left" } : {}));
    await expect(runProject(prepareProject(request()), deps(engine))).rejects.toMatchObject({
      reason: "archive_too_large_for_workdir",
    });
    expect(engine.removed).toContain("quiz-run-project");
  });

  it("is upload_failed, retryable, when the engine lost the container while unpacking", async () => {
    const engine = createFakeEngine((call) => (call.argv[0] === "tar" ? { exitCode: null, containerGone: true } : {}));
    await expect(runProject(prepareProject(request()), deps(engine))).rejects.toMatchObject({ reason: "upload_failed" });
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
  it("drops an output whose parent the build replaced by a link (invariant 12)", async () => {
    expect(parentsOf("out/sub/report.xml")).toEqual(["out", "out/sub"]);
    expect(
      outputsUnderDirectories(["out/x", "build/", "a/b/c"], listing([["l", null, "out"], ["d", null, "a"]])),
    ).toEqual(["build/"]);

    const engine = engineWith({ "build/ok.txt": Buffer.from("ok") }, () => ({}), ["out"]);
    const result = await runProject(prepareProject(request({ outputs: ["out/x", "build/"] })), deps(engine));
    const parents = engine.calls.find((call) => call.argv.includes("-maxdepth"));
    expect(parents!.argv).toEqual(["find", "./out", "-maxdepth", "0", "-printf", "%y %p\\0"]);
    const list = engine.calls.find((call) => call.argv[0] === "find" && !call.argv.includes("-maxdepth"));
    expect(list!.argv).toEqual(["find", "./build", "-printf", "%y %s %p\\0"]);
    expect(result.files.map((f) => f.path)).toEqual(["build/ok.txt"]);
  });

  it("returns no symbolic link, no directory, no refused name: regular files in the order of outputs", async () => {
    expect(
      parseListing(
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
      ),
    ).toEqual([
      { path: "report.xml", size: 9 },
      { path: "build/a.txt", size: 3 },
      { path: "build/b.txt", size: 3 },
    ]);
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
      { path: "build/notes.md", content: "café ✓", truncated: false, size: 9 },
      { path: "build/prog", binary: true, size: 6 },
    ]);
  });

  it("never reads a file over its cap, nor one past the total, in the order of the outputs", async () => {
    const files: Files = {
      "report.xml": Buffer.from("<r/>"),
      "build/huge.log": Buffer.alloc(PROJECT_FILE_MAX_BYTES + 1, "x"),
    };
    for (let i = 0; i < 8; i += 1) files[`build/f${i}.txt`] = Buffer.alloc(PROJECT_FILE_MAX_BYTES, "x");
    const engine = engineWith(files);
    const result = await runProject(prepareProject(request()), deps(engine));

    const tarCall = engine.calls.find((call) => call.argv[0] === "tar" && call.argv[1] === "-c");
    expect(tarCall!.argv).not.toContain("./build/huge.log");
    expect(result.files[0]).toEqual({ path: "report.xml", content: "<r/>", truncated: false, size: 4 });
    const read = result.files.reduce((sum, f) => sum + ("content" in f ? f.content.length : 0), 0);
    expect(read).toBeLessThanOrEqual(PROJECT_OUTPUT_MAX_BYTES);
    expect(result.files).toContainEqual({ path: "build/huge.log", content: "", truncated: true, size: PROJECT_FILE_MAX_BYTES + 1 });
    // Seven 256 KB files fit beside report.xml; the eighth is past the total.
    expect(result.files).toContainEqual({ path: "build/f7.txt", content: "", truncated: true, size: PROJECT_FILE_MAX_BYTES });
    expect(result.files).toContainEqual({ path: "build/f6.txt", content: "x".repeat(PROJECT_FILE_MAX_BYTES), truncated: false, size: PROJECT_FILE_MAX_BYTES });
  });
});
