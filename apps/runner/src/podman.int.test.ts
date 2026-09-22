import { execFileSync } from "node:child_process";

import type { RunnerLanguage, RunnerOutcome, RunnerRequest } from "@quiz/core/server";
import { beforeAll, describe, expect, it } from "vitest";

import { remoteArgs, type Engine } from "./engine.js";
import { executeRequest } from "./execute.js";
import { imageRef } from "./images.js";
import { announce, integrationEngine, integrationHost } from "./test/integration.js";

/**
 * The suite that really starts containers.
 *
 * `pnpm --filter @quiz/runner test:integration`. On a machine without a
 * reachable Podman it SKIPS: a laptop with no container engine must be able to
 * run every other test of the repository (decision D14).
 *
 * What it proves is the hardening, and only what a unit test cannot: that the
 * network is closed, that the root filesystem is read-only, that the memory
 * limit kills, that the wall clock fires, and that the whole thing is fast
 * enough for a classroom.
 */

const host = integrationHost();
const has = (language: RunnerLanguage): boolean => host.has(language);
announce(host, "the integration suite");

const config = host.config;
let engine: Engine;

beforeAll(async () => {
  if (!host.ok) return;
  engine = await integrationEngine(host);
  const capabilities = engine.capabilities;
  console.log(
    `[runner] ${capabilities.version}, rootless=${capabilities.rootless}, ` +
      `remote=${capabilities.remote}, userns=auto:${capabilities.usernsAuto}, ` +
      `runtime=${capabilities.runtime ?? "default"}, languages=${host.languages.join(",")}`,
  );
});

function request(
  language: RunnerLanguage,
  source: string,
  overrides: Partial<RunnerRequest> = {},
): RunnerRequest {
  const name = { c: "main.c", cpp: "main.cpp", python: "main.py", js: "main.js", rust: "main.rs" }[
    language
  ];
  return {
    language,
    files: [{ name, content: source }],
    compileArgs: "",
    action: "run",
    limits: { timeMs: 2000, memoryMb: 128, outputKb: 64 },
    cases: [{ name: "one", args: [], stdin: "" }],
    priority: "interactive",
    ...overrides,
  };
}

const run = (req: RunnerRequest): Promise<RunnerOutcome> => executeRequest(req, { engine, config });

// ===========================================================================
// One language, one shape of program: what the platform actually asks of it.
// ===========================================================================

const HELLO = {
  c: '#include <stdio.h>\nint main(void){int n;if(scanf("%d",&n)!=1)n=0;printf("%d\\n",n*2);return 0;}\n',
  python: "n = int(input())\nprint(n * 2)\n",
} as const;

const BROKEN = {
  c: '#include <stdio.h>\nint main(void){printf("oops")\nreturn 0;}\n',
  python: "def f(:\n    pass\n",
} as const;

const LOOP = {
  c: "int main(void){for(;;){}return 0;}\n",
  python: "while True:\n    pass\n",
} as const;

const BOMB = {
  c:
    "#include <stdlib.h>\n#include <string.h>\n" +
    "int main(void){size_t n=1u<<22;for(;;){char*p=malloc(n);if(!p)return 7;memset(p,1,n);}}\n",
  python: "a = []\nwhile True:\n    a.append(bytearray(4 * 1024 * 1024))\n",
} as const;

const FLOOD = {
  c:
    "#include <stdio.h>\nint main(void){for(int i=0;i<40000;i++)printf(\"%s\\n\"," +
    '"0123456789012345678901234567890123456789");return 0;}\n',
  python: 'for _ in range(40000):\n    print("0" * 40)\n',
} as const;

const NETWORK = {
  c:
    "#include <stdio.h>\n#include <sys/socket.h>\n#include <netinet/in.h>\n#include <arpa/inet.h>\n" +
    "int main(void){int s=socket(AF_INET,SOCK_STREAM,0);" +
    'if(s<0){printf("no-socket\\n");return 0;}' +
    "struct sockaddr_in a;a.sin_family=AF_INET;a.sin_port=htons(80);" +
    'a.sin_addr.s_addr=inet_addr("1.1.1.1");' +
    'printf("%s\\n", connect(s,(struct sockaddr*)&a,sizeof a)==0?"connected":"blocked");return 0;}\n',
  python:
    "import socket\n" +
    "try:\n"
    + "    socket.create_connection(('1.1.1.1', 80), 2)\n"
    + "    print('connected')\n"
    + "except OSError:\n"
    + "    print('blocked')\n",
} as const;

const PASSWD = {
  c:
    '#include <stdio.h>\nint main(void){FILE*f=fopen("/etc/passwd","w");' +
    'printf("%s\\n", f==NULL?"denied":"written");return 0;}\n',
  python:
    "try:\n    open('/etc/passwd', 'w')\n    print('written')\nexcept OSError:\n    print('denied')\n",
} as const;

for (const language of ["c", "python"] as const) {
  describe.skipIf(!has(language))(`${language} in a real container`, () => {
    it("builds and runs a hello world", async () => {
      const outcome = await run(
        request(language, HELLO[language], { cases: [{ name: "twice", args: [], stdin: "21\n" }] }),
      );
      expect(outcome.compile.ok).toBe(true);
      expect(outcome.cases[0]).toMatchObject({
        exitCode: 0,
        stdout: "42\n",
        timedOut: false,
        oom: false,
        truncated: false,
      });
    });

    it("reports a compile error and runs nothing", async () => {
      const outcome = await run(request(language, BROKEN[language]));
      expect(outcome.compile.ok).toBe(false);
      expect(outcome.compile.stderr.length).toBeGreaterThan(0);
      expect(outcome.cases).toEqual([]);
    });

    it("kills an infinite loop at its deadline", async () => {
      const outcome = await run(
        request(language, LOOP[language], {
          limits: { timeMs: 1000, memoryMb: 128, outputKb: 64 },
        }),
      );
      expect(outcome.cases[0]).toMatchObject({ timedOut: true, oom: false });
      // The service's grace is 2 s: a case must never hold a slot much longer.
      expect(outcome.cases[0]!.ms).toBeLessThan(1000 + config.RUNNER_CASE_GRACE_MS + 2000);
    });

    it("kills a memory bomb at the memory limit", async () => {
      const outcome = await run(
        request(language, BOMB[language], {
          limits: { timeMs: 5000, memoryMb: 64, outputKb: 64 },
        }),
      );
      expect(outcome.cases[0]).toMatchObject({ oom: true, timedOut: false });
    });

    it("truncates a flood of output instead of swallowing it", async () => {
      const outcome = await run(
        request(language, FLOOD[language], {
          limits: { timeMs: 10_000, memoryMb: 128, outputKb: 8 },
        }),
      );
      expect(outcome.cases[0]!.truncated).toBe(true);
      expect(Buffer.byteLength(outcome.cases[0]!.stdout)).toBeLessThanOrEqual(8 * 1024);
    });

    it("has no network at all", async () => {
      const outcome = await run(request(language, NETWORK[language]));
      expect(outcome.compile.ok).toBe(true);
      expect(outcome.cases[0]!.stdout).not.toContain("connected");
    });

    it("cannot write on the root filesystem", async () => {
      const outcome = await run(request(language, PASSWD[language]));
      expect(outcome.compile.ok).toBe(true);
      expect(outcome.cases[0]!.stdout.trim()).toBe("denied");
    });
  });
}

/**
 * `args` reaches the program as `argv[1..]`, and ONE argument stays one
 * argument whatever is inside it. This is the check that no shell is in the
 * path: with one, `x;echo pwned` would print `pwned` and `a b` would arrive
 * as two arguments.
 */
const ARGV = {
  c:
    "#include <stdio.h>\n" +
    'int main(int argc,char**argv){printf("%d\\n",argc);' +
    'for(int i=1;i<argc;i++)printf("[%s]\\n",argv[i]);return 0;}\n',
  python:
    "import sys\n" +
    "print(len(sys.argv))\n" +
    "for a in sys.argv[1:]:\n    print(f'[{a}]')\n",
} as const;

const SUM = {
  c:
    "#include <stdio.h>\n#include <stdlib.h>\n" +
    "int main(int argc,char**argv){long s=0;for(int i=1;i<argc;i++)s+=atol(argv[i]);" +
    'printf("%ld\\n",s);return 0;}\n',
  python: "import sys\nprint(sum(int(a) for a in sys.argv[1:]))\n",
} as const;

for (const language of ["c", "python"] as const) {
  describe.skipIf(!has(language))(`${language} command line in a real container`, () => {
    it("sums the numbers of its command line", async () => {
      const outcome = await run(
        request(language, SUM[language], { cases: [{ name: "3+4", args: ["3", "4"], stdin: "" }] }),
      );
      expect(outcome.compile.ok).toBe(true);
      expect(outcome.cases[0]).toMatchObject({ exitCode: 0, stdout: "7\n" });
    });

    it("receives a space, a quote and a `;` as ONE argument each", async () => {
      const nasty = ["a b", 'say "hi"', "x;echo pwned", "$HOME", "*"];
      const outcome = await run(
        request(language, ARGV[language], {
          cases: [{ name: "nasty", args: nasty, stdin: "" }],
        }),
      );
      expect(outcome.compile.ok).toBe(true);
      const lines = outcome.cases[0]!.stdout.split("\n").filter((l) => l !== "");
      // argc counts the program itself.
      expect(lines[0]).toBe(String(nasty.length + 1));
      expect(lines.slice(1)).toEqual(nasty.map((a) => `[${a}]`));
      // No shell ran: `echo pwned` never became a command of its own, `$HOME`
      // was not expanded and `*` did not glob the work directory.
      expect(lines).not.toContain("pwned");
      expect(lines).not.toContain("[/work]");
      expect(lines).not.toContain("[main.c]");
      expect(lines).not.toContain("[main.py]");
    });

    it("runs with no argument at all when the case has none", async () => {
      const outcome = await run(request(language, ARGV[language]));
      expect(outcome.cases[0]!.stdout.split("\n")[0]).toBe("1");
    });
  });
}

/**
 * A syscall the profile denies, asked for with a deliberately invalid
 * argument.
 *
 * `perf_event_open` is `SCMP_ACT_ERRNO` / EPERM in `infra/seccomp/runner.json`
 * for a process holding neither `CAP_PERFMON` nor `CAP_SYS_ADMIN` — which
 * `--cap-drop=ALL` guarantees. The attribute pointer is NULL on purpose: a
 * filter answers before the kernel ever looks at it, so EPERM means the
 * profile fired, while the EFAULT of a container without one means it did not.
 */
const PERF_EVENT_OPEN =
  "#define _GNU_SOURCE\n" +
  "#include <stdio.h>\n#include <errno.h>\n#include <unistd.h>\n#include <sys/syscall.h>\n" +
  "int main(void){long rc=syscall(SYS_perf_event_open,(void*)0,0,-1,-1,0UL);" +
  'printf("%ld %d\\n",rc,errno);return 0;}\n';

/**
 * The uid the program runs under, asked of the program itself.
 *
 * Every `images/*​/Containerfile` repeats the same `adduser` stanza and the
 * assertion has to be repeated with it: an image added later with the stanza
 * forgotten is exactly the mistake this loop catches, and it catches it on
 * that image rather than on `c`'s. Rust declares `getuid` itself — the image
 * ships `rustc` with no crate registry to fetch `libc` from, and there is no
 * network inside the container anyway (invariant 11).
 */
const UID = {
  c: '#include <stdio.h>\n#include <unistd.h>\nint main(void){printf("%d\\n",(int)getuid());return 0;}\n',
  cpp: '#include <cstdio>\n#include <unistd.h>\nint main(){std::printf("%d\\n",(int)getuid());return 0;}\n',
  python: "import os\nprint(os.getuid())\n",
  js: "console.log(process.getuid());\n",
  rust: 'extern "C" { fn getuid() -> u32; }\nfn main(){ println!("{}", unsafe { getuid() }); }\n',
} as const;

for (const language of ["c", "cpp", "python", "js", "rust"] as const) {
  describe.skipIf(!has(language))(`the ${language} image`, () => {
    it("runs the student's program as a user that is not root", async () => {
      const outcome = await run(request(language, UID[language]));
      expect(outcome.compile.ok, outcome.compile.stderr).toBe(true);
      const uid = Number(outcome.cases[0]!.stdout.trim());
      expect(Number.isInteger(uid)).toBe(true);
      expect(uid).not.toBe(0);
    });
  });
}

describe.skipIf(!has("c"))("the container itself", () => {
  it("has the seccomp profile in force, and not merely configured", async () => {
    // Invariant 12. `loadConfig` checks that the profile EXISTS on this host,
    // which is a local sanity check and nothing more: the path travels to the
    // Podman server and the server is what opens it (`--remote`, and in
    // production `/etc/quiz-runner/seccomp.json`). The only witness that the
    // profile applied is a container, and what it can report is the errno.
    const outcome = await run(request("c", PERF_EVENT_OPEN));
    expect(outcome.compile.ok).toBe(true);
    const [rc, errno] = outcome.cases[0]!.stdout.trim().split(" ").map(Number);
    expect(rc).toBe(-1);
    // EPERM is the profile's own `errnoRet`; ENOSYS is what a filter that
    // removes the syscall outright answers. Anything else — EFAULT above all
    // — means the call reached the kernel and no profile was in the way.
    expect([1, 38]).toContain(errno);
  });

  it("carries the closed list of environment variables and nothing else", async () => {
    const outcome = await run(
      request(
        "c",
        "#include <stdio.h>\nextern char **environ;\n" +
          'int main(void){for(char**e=environ;*e;e++)printf("%s\\n",*e);return 0;}\n',
      ),
    );
    const names = outcome.cases[0]!.stdout
      .split("\n")
      .filter((line) => line !== "")
      .map((line) => line.split("=")[0]);
    // PATH, HOSTNAME, TERM and container= come from the image and from Podman;
    // what must NEVER be there is a secret of the platform.
    expect(names).toContain("HOME");
    expect(names).toContain("LANG");
    for (const name of names) {
      expect(name).not.toMatch(/SECRET|TOKEN|PASSWORD|KEY|DATABASE_URL|OIDC/i);
    }
  });

  it("is destroyed when the request is over", async () => {
    await run(request("c", HELLO.c, { cases: [{ name: "one", args: [], stdin: "1\n" }] }));
    const listed = execFileSync(
      config.PODMAN_BIN,
      [
        ...remoteArgs(config.PODMAN_SOCKET),
        "ps", "-a", "--filter", "label=quiz.runner=1", "--format", "{{.Names}}",
      ],
      { encoding: "utf8" },
    ).trim();
    expect(listed).toBe("");
  });

  it("has an image for the language it claims to serve", () => {
    expect(host.languages.map((language) => imageRef(config, language))).toContain(
      "quiz-runner-c:latest",
    );
  });
});
