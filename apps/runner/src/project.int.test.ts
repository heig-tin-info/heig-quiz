import type { ProjectRunRequest } from "@quiz/core/server";
import { beforeAll, describe, expect, it } from "vitest";

import type { Engine } from "./engine.js";
import { prepareProject, runProject } from "./project.js";
import { writeTar, type CleanEntry } from "./tar.js";
import { announce, integrationEngine, integrationHost } from "./test/integration.js";
import { rawTar } from "./test/tarFixture.js";

/**
 * A project run against a real container (ADR-106 §3): the `lab-c` image,
 * the flags of `containerArgs()`, the archive unpacked by the container's own
 * GNU tar, `make` then `pytest`, the outputs read back. Skipped without
 * Podman or without `quiz-runner-lab-c` (`images/build.sh lab-c`), like the
 * other integration suites.
 */

const host = integrationHost();
announce(host, "the project suite");
if (host.ok && !host.hasProject("lab-c")) {
  console.warn("[runner] no quiz-runner-lab-c image: run images/build.sh lab-c first.");
}
let engine: Engine;

beforeAll(async () => {
  if (!host.ok || !host.hasProject("lab-c")) return;
  engine = await integrationEngine(host);
});

const MAKEFILE = [
  "prepare: build/hello build/notes.txt",
  "build/hello: hello.c",
  "\tmkdir -p build",
  "\tgcc -O2 -o build/hello hello.c",
  "build/notes.txt:",
  "\tmkdir -p build",
  "\techo 'built by make' > build/notes.txt",
  // A link a student could plant to read the image's files back: never followed.
  "\tln -sf /etc/passwd build/passwd",
  // A process left behind: reaped after the step, it does not hold the run.
  "\t(sleep 300 &)",
  "",
].join("\n");

const HELLO = '#include <stdio.h>\nint main(void) { puts("hello"); return 0; }\n';

const TESTS = [
  "import subprocess",
  "",
  "def test_hello():",
  "    out = subprocess.run(['./build/hello'], capture_output=True, text=True).stdout",
  "    assert out == 'hello\\n'",
  "",
  "def test_fails():",
  "    assert 1 == 2",
  "",
].join("\n");

function file(path: string, content: string): CleanEntry {
  return { path, type: "file", mode: 0o644, mtime: 1_700_000_000, data: Buffer.from(content) };
}

function request(archive: Buffer, overrides: Partial<ProjectRunRequest> = {}): ProjectRunRequest {
  return {
    archive: archive.toString("base64"),
    image: "lab-c",
    commands: { build: ["make", "prepare"], test: ["pytest", "--junitxml=report.xml", "-q", "-p", "no:cacheprovider"] },
    outputs: ["report.xml", "build/"],
    limits: { timeMs: 120_000, memoryMb: 512, cpus: 1 },
    budgetMs: 300_000,
    ...overrides,
  };
}

describe.skipIf(!host.ok || !host.hasProject("lab-c"))("a project run in lab-c", () => {
  it("builds with make, tests with pytest, and brings the outputs back", async () => {
    // A tar as git would make it, ustar headers and all, through the sanitizer.
    const archive = rawTar([
      { name: "Makefile", data: MAKEFILE },
      { name: "hello.c", data: HELLO },
      { name: "tests/", type: "5", mode: 0o755 },
      { name: "tests/test_hello.py", data: TESTS },
    ]);
    const started = Date.now();
    const result = await runProject(prepareProject(request(archive)), { engine, config: host.config });

    expect(result.build).toMatchObject({ exitCode: 0, timedOut: false });
    // One test passes, one fails: pytest exits 1, the report says both.
    expect(result.test).toMatchObject({ exitCode: 1, timedOut: false });
    expect(result.test.stdout).toMatch(/1 failed, 1 passed/);

    const paths = result.files.map((f) => f.path);
    expect(paths).toEqual(["report.xml", "build/hello", "build/notes.txt"]);
    const report = result.files[0]!;
    expect("content" in report && report.content).toMatch(/<testsuite[^>]* tests="2"/);
    expect(result.files[1]).toMatchObject({ path: "build/hello", binary: true });
    expect(result.files[2]).toEqual({ path: "build/notes.txt", content: "built by make\n", truncated: false });
    // The left-behind `sleep 300` did not hold the run.
    expect(Date.now() - started).toBeLessThan(120_000);
  });

  it("runs the tests after a failed build", async () => {
    const archive = writeTar([
      file("Makefile", "prepare:\n\tfalse\n"),
      file("test_a.py", "def test_a():\n    assert True\n"),
    ]);
    const result = await runProject(
      prepareProject(request(archive, { outputs: ["report.xml"] })),
      { engine, config: host.config },
    );
    expect(result.build).toMatchObject({ exitCode: 2 });
    expect(result.test).toMatchObject({ exitCode: 0 });
    expect(result.files.map((f) => f.path)).toEqual(["report.xml"]);
  });

  it("has no network and no package manager to reach one", async () => {
    const archive = writeTar([
      file(
        "test_net.py",
        [
          "import shutil, socket",
          "def test_offline():",
          "    assert shutil.which('pip') is None and shutil.which('pip3') is None",
          "    s = socket.socket()",
          "    s.settimeout(2)",
          "    try:",
          "        s.connect(('1.1.1.1', 80))",
          "        assert False, 'connected'",
          "    except OSError:",
          "        pass",
          "",
        ].join("\n"),
      ),
    ]);
    const result = await runProject(
      prepareProject(request(archive, { commands: { test: ["pytest", "-q", "-p", "no:cacheprovider"] }, outputs: [] })),
      { engine, config: host.config },
    );
    expect(result.test.stdout).toMatch(/1 passed/);
  });
});
