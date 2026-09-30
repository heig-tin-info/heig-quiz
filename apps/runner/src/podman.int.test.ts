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
  // spice names its files per stimulus (`s0.cir`…), not `main.<ext>`.
  language: Exclude<RunnerLanguage, "spice">,
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

/**
 * The programming languages of the contract, `spice` aside (its own suite,
 * `spice.int.test.ts`). A loop over this list exercises every image the host
 * has and skips the others, so the CI job — which builds all of them, rust
 * included — runs every language through it.
 */
const PROGRAMMING = ["c", "cpp", "python", "js", "rust"] as const;

/**
 * Reads a number on stdin and prints its double: the toolchain, end to end.
 * Same programs as `PROGRAMS` in `scripts/smoke.py` (a script cannot import a test).
 */
const HELLO = {
  c: '#include <stdio.h>\nint main(void){int n;if(scanf("%d",&n)!=1)n=0;printf("%d\\n",n*2);return 0;}\n',
  cpp: '#include <iostream>\nint main(){int n=0;std::cin>>n;std::cout<<n*2<<"\\n";return 0;}\n',
  python: "n = int(input())\nprint(n * 2)\n",
  js: 'const n = parseInt(require("node:fs").readFileSync(0, "utf8"), 10) || 0;\nconsole.log(n * 2);\n',
  rust:
    "use std::io::Read;\n" +
    "fn main(){let mut s=String::new();std::io::stdin().read_to_string(&mut s).unwrap();" +
    'let n:i64=s.trim().parse().unwrap_or(0);println!("{}",n*2);}\n',
} as const;

const BROKEN = {
  c: '#include <stdio.h>\nint main(void){printf("oops")\nreturn 0;}\n',
  cpp: '#include <cstdio>\nint main(){std::printf("oops")\nreturn 0;}\n',
  python: "def f(:\n    pass\n",
  js: "function f( {\n",
  rust: 'fn main(){ let _x: i32 = "oops"; }\n',
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

for (const language of PROGRAMMING) {
  describe.skipIf(!has(language))(`the ${language} toolchain in a real container`, () => {
    it("builds and runs a hello world", async () => {
      const outcome = await run(
        request(language, HELLO[language], { cases: [{ name: "twice", args: [], stdin: "21\n" }] }),
      );
      expect(outcome.compile.ok, outcome.compile.stderr).toBe(true);
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
  });
}

for (const language of ["c", "python"] as const) {
  describe.skipIf(!has(language))(`${language} in a real container`, () => {
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
 * No new namespace, no mount, no keyring, no ptrace — and threads still work.
 *
 * A user namespace would hand the program a fresh set of capabilities over
 * it, and with them the netfilter / netlink attack surface of the kernel. The
 * profile allows `clone` only without any `CLONE_NEW*` flag and answers
 * `clone3` with ENOSYS (its flags sit in a struct seccomp cannot read), so
 * glibc falls back to `clone` — which the `pthread_create` line proves.
 * Each line is `<name> <rc> <errno>`; a raw `syscall()` keeps glibc's own
 * wrappers and fallbacks out of the measure.
 *
 * The profile is the same for every image, but what a toolchain needs from it
 * is not: rustc runs a thread pool and a linker, Node a worker pool, CPython
 * forks. So the probe runs in EVERY language (`ISOLATION` below), each asking
 * the same questions in its own words, and each proving that its own threads
 * and its own `fork` still work under the filter.
 */
const NAMESPACES =
  "#ifndef _GNU_SOURCE\n#define _GNU_SOURCE\n#endif\n" +
  "#include <stdio.h>\n#include <errno.h>\n#include <sched.h>\n#include <signal.h>\n" +
  "#include <pthread.h>\n#include <unistd.h>\n#include <sys/syscall.h>\n#include <sys/wait.h>\n" +
  "#define TRY(n,e) do{errno=0;long rc=(e);printf(\"%s %ld %d\\n\",n,rc,errno);}while(0)\n" +
  "static void*noop(void*a){return a;}\n" +
  "int main(void){\n" +
  ' TRY("unshare-user",syscall(SYS_unshare,CLONE_NEWUSER));\n' +
  ' TRY("unshare-net",syscall(SYS_unshare,CLONE_NEWUSER|CLONE_NEWNET));\n' +
  ' TRY("clone-user",syscall(SYS_clone,CLONE_NEWUSER|SIGCHLD,0,0,0,0));\n' +
  ' TRY("clone3",syscall(SYS_clone3,(void*)0,0));\n' +
  ' TRY("setns",syscall(SYS_setns,0,0));\n' +
  ' TRY("mount",syscall(SYS_mount,"none","/tmp","tmpfs",0,(void*)0));\n' +
  ' TRY("fsopen",syscall(SYS_fsopen,"tmpfs",0));\n' +
  ' TRY("keyctl",syscall(SYS_keyctl,0,0,0,0,0));\n' +
  ' TRY("ptrace",syscall(SYS_ptrace,0,0,0,0));\n' +
  " pthread_t t;int prc=pthread_create(&t,0,noop,0);if(prc==0)pthread_join(t,0);\n" +
  ' printf("pthread %d 0\\n",prc);\n' +
  " pid_t p=fork();if(p==0)_exit(0);int st=0;waitpid(p,&st,0);\n" +
  ' printf("fork %d 0\\n",p>0&&WIFEXITED(st)?0:-1);\n' +
  " return 0;}\n";

/**
 * The syscall numbers the Python and Rust probes need, which neither language
 * names without a crate or a module the images do not ship. x86_64 only: the
 * code VM and the CI runner both are. Order: unshare, clone, clone3, setns,
 * mount, fsopen, keyctl, ptrace.
 */
const SYSCALLS = [272, 56, 435, 308, 165, 430, 250, 101] as const;

/** CPython, through `ctypes` on musl's own `syscall()`. */
const NAMESPACES_PY =
  "import ctypes, os, threading\n" +
  `NR = dict(zip(["unshare","clone","clone3","setns","mount","fsopen","keyctl","ptrace"], ${JSON.stringify(SYSCALLS)}))\n` +
  "libc = ctypes.CDLL(None, use_errno=True)\n" +
  "libc.syscall.restype = ctypes.c_long\n" +
  "def TRY(name, nr, *args):\n" +
  "    ctypes.set_errno(0)\n" +
  "    rc = libc.syscall(ctypes.c_long(nr), *[ctypes.c_long(a) if isinstance(a, int) else a for a in args])\n" +
  "    print(name, rc, ctypes.get_errno(), flush=True)\n" +
  "NEWUSER, NEWNET, SIGCHLD = 0x10000000, 0x40000000, 17\n" +
  'TRY("unshare-user", NR["unshare"], NEWUSER)\n' +
  'TRY("unshare-net", NR["unshare"], NEWUSER | NEWNET)\n' +
  'TRY("clone-user", NR["clone"], NEWUSER | SIGCHLD, 0, 0, 0, 0)\n' +
  'TRY("clone3", NR["clone3"], 0, 0)\n' +
  'TRY("setns", NR["setns"], 0, 0)\n' +
  'TRY("mount", NR["mount"], b"none", b"/tmp", b"tmpfs", 0, 0)\n' +
  'TRY("fsopen", NR["fsopen"], b"tmpfs", 0)\n' +
  'TRY("keyctl", NR["keyctl"], 0, 0, 0, 0, 0)\n' +
  'TRY("ptrace", NR["ptrace"], 0, 0, 0, 0)\n' +
  "t = threading.Thread(target=lambda: None); t.start(); t.join()\n" +
  'print("pthread 0 0", flush=True)\n' +
  "pid = os.fork()\n" +
  "if pid == 0:\n    os._exit(0)\n" +
  "_, status = os.waitpid(pid, 0)\n" +
  'print("fork", 0 if os.WIFEXITED(status) and os.WEXITSTATUS(status) == 0 else -1, 0)\n';

/**
 * Rust, with no `libc` crate: musl's `syscall()` and `__errno_location()`
 * declared by hand, as the uid probe below declares `getuid`. `std::thread` is
 * rustc's own path to `pthread_create`.
 */
const NAMESPACES_RS =
  "use std::os::raw::{c_int, c_long};\n" +
  'extern "C" {\n' +
  "  fn syscall(n: c_long, ...) -> c_long;\n" +
  "  fn __errno_location() -> *mut c_int;\n" +
  "  fn fork() -> c_int;\n" +
  "  fn waitpid(pid: c_int, status: *mut c_int, options: c_int) -> c_int;\n" +
  "  fn _exit(code: c_int) -> !;\n" +
  "}\n" +
  `const NR: [c_long; 8] = [${SYSCALLS.join(", ")}];\n` +
  "const NEWUSER: c_long = 0x10000000; const NEWNET: c_long = 0x40000000; const SIGCHLD: c_long = 17;\n" +
  "fn attempt(name: &str, call: impl FnOnce() -> c_long) {\n" +
  "  unsafe { *__errno_location() = 0; }\n" +
  "  let rc = call();\n" +
  "  let errno = unsafe { *__errno_location() };\n" +
  '  println!("{} {} {}", name, rc, errno);\n' +
  "}\n" +
  "fn main() {\n" +
  '  let none = b"none\\0".as_ptr() as c_long; let tmp = b"/tmp\\0".as_ptr() as c_long;\n' +
  '  let tmpfs = b"tmpfs\\0".as_ptr() as c_long;\n' +
  "  unsafe {\n" +
  '    attempt("unshare-user", || syscall(NR[0], NEWUSER));\n' +
  '    attempt("unshare-net", || syscall(NR[0], NEWUSER | NEWNET));\n' +
  '    attempt("clone-user", || syscall(NR[1], NEWUSER | SIGCHLD, 0 as c_long, 0 as c_long, 0 as c_long, 0 as c_long));\n' +
  '    attempt("clone3", || syscall(NR[2], 0 as c_long, 0 as c_long));\n' +
  '    attempt("setns", || syscall(NR[3], 0 as c_long, 0 as c_long));\n' +
  '    attempt("mount", || syscall(NR[4], none, tmp, tmpfs, 0 as c_long, 0 as c_long));\n' +
  '    attempt("fsopen", || syscall(NR[5], tmpfs, 0 as c_long));\n' +
  '    attempt("keyctl", || syscall(NR[6], 0 as c_long, 0 as c_long, 0 as c_long, 0 as c_long, 0 as c_long));\n' +
  '    attempt("ptrace", || syscall(NR[7], 0 as c_long, 0 as c_long, 0 as c_long, 0 as c_long));\n' +
  "  }\n" +
  '  println!("pthread {} 0", if std::thread::spawn(|| ()).join().is_ok() { 0 } else { -1 });\n' +
  "  let ok = unsafe {\n" +
  "    let p = fork(); if p == 0 { _exit(0); }\n" +
  "    let mut st: c_int = 0; waitpid(p, &mut st, 0);\n" +
  "    p > 0 && (st & 0x7f) == 0 && ((st >> 8) & 0xff) == 0\n" +
  "  };\n" +
  '  println!("fork {} 0", if ok { 0 } else { -1 });\n' +
  "}\n";

/**
 * Node has no raw syscall, so the probe asks through busybox's `unshare` and
 * `mount` (both in the Alpine base of the image) and reads the reason off
 * their message: a program in the image is exactly what a student's
 * `child_process` would reach for. `keyctl`, `ptrace`, `clone3` and `fsopen`
 * have no such door from JavaScript; the C probe covers them, under the same
 * profile. The `worker_threads` Worker is libuv's `pthread_create`, and
 * `spawnSync` its `fork`.
 */
const NAMESPACES_JS =
  'const { spawnSync } = require("node:child_process");\n' +
  'const { Worker } = require("node:worker_threads");\n' +
  "function attempt(name, argv) {\n" +
  '  const r = spawnSync(argv[0], argv.slice(1), { encoding: "utf8" });\n' +
  '  const said = `${r.stderr ?? ""}${r.error ?? ""}`;\n' +
  "  const errno = /not implemented/i.test(said) ? 38 : /not permitted/i.test(said) ? 1 : 0;\n" +
  "  console.log(`${name} ${r.status === 0 ? 0 : -1} ${errno}`);\n" +
  "}\n" +
  'attempt("unshare-user", ["unshare", "-U", "true"]);\n' +
  'attempt("unshare-net", ["unshare", "-U", "-n", "true"]);\n' +
  'attempt("mount", ["mount", "-t", "tmpfs", "none", "/tmp"]);\n' +
  'console.log(`fork ${spawnSync("true").status === 0 ? 0 : -1} 0`);\n' +
  'new Worker("", { eval: true }).on("exit", (code) => console.log(`pthread ${code === 0 ? 0 : -1} 0`));\n';

/** Every name a raw-syscall probe prints, and must see refused. */
const DENIED = [
  "unshare-user", "unshare-net", "clone-user", "setns", "mount", "fsopen", "keyctl", "ptrace",
] as const;

const ISOLATION: Record<
  (typeof PROGRAMMING)[number],
  { source: string; denied: readonly string[]; rawSyscalls: boolean }
> = {
  c: { source: NAMESPACES, denied: DENIED, rawSyscalls: true },
  cpp: { source: NAMESPACES, denied: DENIED, rawSyscalls: true },
  python: { source: NAMESPACES_PY, denied: DENIED, rawSyscalls: true },
  rust: { source: NAMESPACES_RS, denied: DENIED, rawSyscalls: true },
  js: { source: NAMESPACES_JS, denied: ["unshare-user", "unshare-net", "mount"], rawSyscalls: false },
};

for (const language of PROGRAMMING) {
  describe.skipIf(!has(language))(`the ${language} program under the seccomp profile`, () => {
    it("cannot create a namespace, mount, use a keyring or ptrace — and still runs threads and fork", async () => {
      const probe = ISOLATION[language];
      const outcome = await run(request(language, probe.source));
      expect(outcome.compile.ok, outcome.compile.stderr).toBe(true);
      const stdout = outcome.cases[0]!.stdout;
      const results = Object.fromEntries(
        stdout
          .trim()
          .split("\n")
          .map((line) => {
            const [name, rc, errno] = line.split(" ");
            return [name, { rc: Number(rc), errno: Number(errno) }];
          }),
      );
      for (const name of probe.denied) {
        // EPERM or ENOSYS: the filter answered; the kernel never saw the call.
        expect(results[name], `${name}\n${stdout}${outcome.cases[0]!.stderr}`).toMatchObject({ rc: -1 });
        expect([1, 38], name).toContain(results[name]!.errno);
      }
      if (probe.rawSyscalls) {
        expect(results.clone3).toEqual({ rc: -1, errno: 38 });
      }
      expect(results.pthread, stdout).toEqual({ rc: 0, errno: 0 });
      expect(results.fork, stdout).toEqual({ rc: 0, errno: 0 });
    });
  });
}

/**
 * The uid the program runs under, asked of the program itself.
 *
 * The `adduser` stanza lives in two files (`images/Containerfile` for the
 * Alpine images, `images/js/Containerfile` for Node) and the assertion is
 * repeated per image: an image added later without it is exactly the mistake
 * this loop catches, and it catches it on that image rather than on `c`'s. Rust declares `getuid` itself — the image
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

for (const language of PROGRAMMING) {
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
