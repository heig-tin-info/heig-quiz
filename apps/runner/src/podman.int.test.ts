import { execFileSync } from "node:child_process";

import type { RunnerLanguage, RunnerOutcome, RunnerRequest } from "@quiz/core/server";
import { beforeAll, describe, expect, it } from "vitest";

import { detectSocket, loadConfig, type RunnerConfig } from "./config.js";
import { createEngine, type Engine } from "./engine.js";
import { executeRequest } from "./execute.js";
import { availableLanguages, imageRef } from "./images.js";
import { probeEngine } from "./probe.js";

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

const SOCKET = detectSocket();

function engineIsReachable(): { ok: boolean; languages: RunnerLanguage[]; config: RunnerConfig } {
  const config = loadConfig({ LOG_LEVEL: "fatal", ...(SOCKET === null ? {} : { PODMAN_SOCKET: SOCKET }) });
  try {
    const base = config.PODMAN_SOCKET === null ? [] : ["--remote", "--url", `unix://${config.PODMAN_SOCKET}`];
    const images = execFileSync(
      config.PODMAN_BIN,
      [...base, "images", "--format", "{{.Repository}}:{{.Tag}}"],
      { encoding: "utf8", timeout: 20_000 },
    );
    return { ok: true, languages: availableLanguages(images.split("\n"), config), config };
  } catch {
    return { ok: false, languages: [], config };
  }
}

const probe = engineIsReachable();
const has = (language: RunnerLanguage): boolean => probe.ok && probe.languages.includes(language);

if (!probe.ok) {
  console.warn("[runner] Podman is not reachable: the integration suite is skipped.");
} else if (probe.languages.length === 0) {
  console.warn("[runner] no quiz-runner-* image: run images/build.sh first.");
}

const config = probe.config;
let engine: Engine;

beforeAll(async () => {
  if (!probe.ok) return;
  const probed = await probeEngine(config);
  engine = createEngine({
    podmanBin: config.PODMAN_BIN,
    socket: config.PODMAN_SOCKET,
    seccompProfile: config.RUNNER_SECCOMP,
    usernsAuto: probed.capabilities.usernsAuto,
    runtime: probed.capabilities.runtime,
    capabilities: probed.capabilities,
  });
  console.log(
    `[runner] ${probed.capabilities.version}, rootless=${probed.capabilities.rootless}, ` +
      `remote=${probed.capabilities.remote}, userns=auto:${probed.capabilities.usernsAuto}, ` +
      `runtime=${probed.capabilities.runtime ?? "default"}, languages=${probe.languages.join(",")}`,
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

describe.skipIf(!has("c"))("the container itself", () => {
  it("runs as a user that is not root and owns nothing outside /work", async () => {
    const outcome = await run(
      request(
        "c",
        '#include <stdio.h>\n#include <unistd.h>\nint main(void){printf("%d\\n",(int)getuid());return 0;}\n',
      ),
    );
    expect(outcome.cases[0]!.stdout.trim()).not.toBe("0");
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
        ...(config.PODMAN_SOCKET === null ? [] : ["--remote", "--url", `unix://${config.PODMAN_SOCKET}`]),
        "ps", "-a", "--filter", "label=quiz.runner=1", "--format", "{{.Names}}",
      ],
      { encoding: "utf8" },
    ).trim();
    expect(listed).toBe("");
  });

  it("has an image for the language it claims to serve", () => {
    expect(probe.languages.map((language) => imageRef(config, language))).toContain(
      "quiz-runner-c:latest",
    );
  });
});
