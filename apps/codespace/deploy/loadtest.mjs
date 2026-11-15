#!/usr/bin/env node
/**
 * Capacity load test of one portal instance, and the engine VM's load
 * sampler. ON the engine VM, as root (the env file, the cgroup files, the
 * rootful Podman socket). Node's standard library only, like smoke.mjs: the
 * checkout has no node_modules. RUNBOOK.md, Capacity, says when and how.
 *
 *   node loadtest.mjs <staging|prod> --port <n> --sessions 50 [--ramp 60s] [--hold 10m]
 *        [--work] [--dry-run] [--yes-prod] [--beside-live] [--out <file.json>]
 *   node loadtest.mjs watch [--every 10s] [--out /var/log/quiz-engine/load-YYYYMMDD.jsonl]
 *   node loadtest.mjs report <file.jsonl>
 *
 * Load mode: syncs the `lab` assignment `loadtest` on a PUBLIC repository
 * (LOADTEST_REPO, default octocat/Hello-World on master), whose quota holder
 * is the synthetic teacher `loadtest-teacher` with a quota of exactly
 * --sessions (the sync carries it: no real teacher's grant is touched);
 * launches students `load-001`… spread over --ramp (0: all at once), each
 * timed to its 303 and then to code-server's /healthz through the portal's
 * proxy; keeps them alive (one proxied request a minute) for --hold after
 * the ramp; with --work, runs in each session container, through the rootful
 * socket, what a student's activity costs: clangd on a C file (kept open,
 * the file re-sent before each build), a gcc build and a run every 20 to 40
 * s, a gdb -batch run one build in four. It samples every 10 s, prints one
 * line per sample, and ends with a table and a JSON file. code-server's
 * workbench websocket is NOT opened (its protocol is not reachable with the
 * standard library alone): the editor's own idle cost is in every sample,
 * its typing traffic is not.
 *
 * The portal has no API to close a session: the sessions close
 * SESSION_GRACE_MS after the last proxied request (the script prints when,
 * and the cleanup of the `load-*` volumes). SIGINT or SIGTERM stops the
 * launches and the work, then reports. Refuses prod without --yes-prod, and
 * an instance with running sessions without --beside-live. --dry-run checks
 * the secret, the health and the sync, and launches nothing.
 *
 * Watch mode launches nothing: one JSON line per sample, appended, until
 * stopped. Aggregates only: never a container name, a student, a teacher, a
 * course. Report mode prints the peaks of such a file.
 *
 * Tokens are printed nowhere.
 */
import { spawn } from "node:child_process";
import { createHash, createHmac, randomUUID } from "node:crypto";
import { appendFileSync, mkdirSync, readdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { availableParallelism } from "node:os";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";

const SOCKET = "unix:///run/podman/podman.sock";
const CGROUP = "/sys/fs/cgroup";
const SLICES = ["codespace.slice", "quiz-runner.slice"];
const INSTANCES = ["prod", "staging"];
const ASSIGNMENT = "loadtest";
const TEACHER = "loadtest-teacher";
const MAX_SESSIONS = 200;

// --- pure parts (loadtest.test.mjs) ------------------------------------------

/** "500ms", "10s", "10m", "1h", or a bare number of seconds → milliseconds. */
export function parseDuration(text) {
  const m = /^(\d+(?:\.\d+)?)(ms|s|m|h)?$/.exec(String(text ?? ""));
  if (!m) throw new Error(`not a duration: ${text}`);
  const unit = { ms: 1, s: 1000, m: 60_000, h: 3_600_000 }[m[2] ?? "s"];
  return Math.round(Number(m[1]) * unit);
}

export function parseArgs(argv) {
  const [first, ...rest] = argv;
  const flags = new Set(["--work", "--dry-run", "--yes-prod", "--beside-live"]);
  const valued = new Set(["--port", "--sessions", "--ramp", "--hold", "--every", "--out"]);
  const opts = {};
  const positional = [];
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i];
    if (flags.has(a)) opts[a.slice(2)] = true;
    else if (valued.has(a)) {
      if (rest[i + 1] === undefined) throw new Error(`${a} needs a value`);
      opts[a.slice(2)] = rest[++i];
    } else if (a.startsWith("--")) throw new Error(`unknown option ${a}`);
    else positional.push(a);
  }
  if (first === "report") {
    if (positional.length !== 1) throw new Error("report <file.jsonl>");
    return { mode: "report", file: positional[0] };
  }
  if (positional.length) throw new Error(`unexpected argument ${positional[0]}`);
  if (first === "watch") {
    return { mode: "watch", everyMs: parseDuration(opts.every ?? "10s"), out: opts.out ?? null };
  }
  if (!/^[a-z][a-z0-9]{0,15}$/.test(first ?? "")) throw new Error("the first argument is an instance, `watch` or `report`");
  if (!/^\d+$/.test(opts.port ?? "")) throw new Error("--port <n> is required (the instance's PORT, deploy/lib.sh)");
  const sessions = Number(opts.sessions ?? (opts["dry-run"] ? 1 : NaN));
  if (!Number.isInteger(sessions) || sessions < 1 || sessions > MAX_SESSIONS) {
    throw new Error(`--sessions <1..${MAX_SESSIONS}> is required`);
  }
  return {
    mode: "load",
    instance: first,
    port: Number(opts.port),
    sessions,
    rampMs: parseDuration(opts.ramp ?? "60s"),
    holdMs: parseDuration(opts.hold ?? "10m"),
    work: Boolean(opts.work),
    dryRun: Boolean(opts["dry-run"]),
    yesProd: Boolean(opts["yes-prod"]),
    besideLive: Boolean(opts["beside-live"]),
    out: opts.out ?? null,
  };
}

/** Nearest-rank percentile; null for no value. */
export function percentile(values, p) {
  const v = values.filter((x) => typeof x === "number" && Number.isFinite(x)).sort((a, b) => a - b);
  if (!v.length) return null;
  return v[Math.min(v.length - 1, Math.max(0, Math.ceil((p / 100) * v.length) - 1))];
}

export function stats(values) {
  const v = values.filter((x) => typeof x === "number" && Number.isFinite(x));
  return {
    n: v.length,
    p50: percentile(v, 50),
    p95: percentile(v, 95),
    max: v.length ? Math.max(...v) : null,
    mean: v.length ? Math.round(v.reduce((a, b) => a + b, 0) / v.length) : null,
  };
}

/** `/proc/pressure/*`: { some: { avg10, avg60, avg300, total }, full: … }. */
export function parsePressure(text) {
  const out = {};
  for (const line of String(text).split("\n")) {
    const [kind, ...fields] = line.trim().split(/\s+/);
    if (kind !== "some" && kind !== "full") continue;
    out[kind] = Object.fromEntries(fields.map((f) => f.split("=")).map(([k, v]) => [k, Number(v)]));
  }
  return out;
}

/** "key value" lines (memory.events, cpu.stat) → numbers. */
export function parseKeyed(text) {
  const out = {};
  for (const line of String(text).split("\n")) {
    const [k, v] = line.trim().split(/\s+/);
    if (k && v !== undefined && /^\d+$/.test(v)) out[k] = Number(v);
  }
  return out;
}

/** `/proc/meminfo` → kB by key. */
export function parseMeminfo(text) {
  const out = {};
  for (const m of String(text).matchAll(/^(\w+(?:\(\w+\))?):\s+(\d+)/gm)) out[m[1]] = Number(m[2]);
  return out;
}

/** memory.high / memory.max: "max" is no limit (null). */
export function parseLimit(text) {
  const t = String(text ?? "").trim();
  return /^\d+$/.test(t) ? Number(t) : null;
}

/** systemd nests `a-b.slice` under `a.slice`: the slice's cgroup path. */
export function sliceCgroupPath(name) {
  const parts = name.replace(/\.slice$/, "").split("-");
  return parts.map((_, i) => `${parts.slice(0, i + 1).join("-")}.slice`).join("/");
}

/** A session container's scope in codespace.slice (the portals are services, not `libpod-*` scopes). */
export const isSessionScope = (dir) => /^libpod-[0-9a-f]{64}\.scope$/.test(dir);

const MiB = 1024 * 1024;
const mib = (bytes) => (bytes == null ? "-" : `${Math.round(bytes / MiB)}M`);
const delta = (a, b) => (a == null || b == null ? null : b - a);

/** The peaks of a watch file's samples (or a load run's). */
export function report(samples) {
  if (!samples.length) return null;
  const first = samples[0];
  const last = samples.at(-1);
  const total = (s) => Object.values(s.sessions ?? {}).reduce((a, b) => a + (b ?? 0), 0);
  const cs = (s) => s.slices?.["codespace.slice"] ?? {};
  const peakMem = samples.reduce((best, s) => ((cs(s).current ?? -1) > (cs(best).current ?? -1) ? s : best), first);
  const worst = (res, kind) => Math.max(0, ...samples.map((s) => s.psi?.[res]?.[kind]?.avg10 ?? 0));
  const events = {};
  for (const slice of SLICES) {
    const a = first.slices?.[slice]?.events ?? {};
    const b = last.slices?.[slice]?.events ?? {};
    events[slice] = Object.fromEntries(["high", "max", "oom", "oom_kill"].map((k) => [k, delta(a[k], b[k])]));
  }
  return {
    from: first.t,
    to: last.t,
    samples: samples.length,
    nproc: last.nproc,
    memTotalMiB: last.memTotalKb == null ? null : Math.round(last.memTotalKb / 1024),
    maxSessions: Math.max(...samples.map(total)),
    peakSliceMemory: cs(peakMem).current ?? null,
    peakSliceMemoryAt: peakMem.t,
    sessionsAtPeak: total(peakMem),
    perSessionMeanAtPeak: peakMem.sessionMemory?.mean ?? null,
    perSessionP95AtPeak: peakMem.sessionMemory?.p95 ?? null,
    sliceMemoryPeakCounter: Math.max(0, ...samples.map((s) => cs(s).peak ?? 0)) || null,
    sliceMax: cs(last).max ?? null,
    events,
    worstPsi: {
      memorySome: worst("memory", "some"),
      memoryFull: worst("memory", "full"),
      cpuSome: worst("cpu", "some"),
      ioSome: worst("io", "some"),
    },
    minMemAvailableMiB: Math.round(Math.min(...samples.map((s) => s.memAvailableKb ?? Infinity)) / 1024),
    maxLoad1: Math.max(...samples.map((s) => s.load?.[0] ?? 0)),
  };
}

export function formatReport(r) {
  if (!r) return "no sample";
  const ev = (s) => Object.entries(r.events[s]).map(([k, v]) => `${k} +${v ?? "?"}`).join(", ");
  return [
    `samples           ${r.samples}, ${r.from} → ${r.to} (${r.nproc} vCPU, ${r.memTotalMiB} MiB RAM)`,
    `max sessions      ${r.maxSessions}`,
    `peak slice memory ${mib(r.peakSliceMemory)} of ${mib(r.sliceMax)} at ${r.peakSliceMemoryAt} with ${r.sessionsAtPeak} sessions (memory.peak ${mib(r.sliceMemoryPeakCounter)})`,
    `per session there mean ${mib(r.perSessionMeanAtPeak)}, p95 ${mib(r.perSessionP95AtPeak)}`,
    `codespace.slice   ${ev("codespace.slice")}`,
    `quiz-runner.slice ${ev("quiz-runner.slice")}`,
    `worst PSI avg10   memory some ${r.worstPsi.memorySome}% full ${r.worstPsi.memoryFull}%, cpu some ${r.worstPsi.cpuSome}%, io some ${r.worstPsi.ioSome}%`,
    `min MemAvailable  ${r.minMemAvailableMiB} MiB, max load1 ${r.maxLoad1}`,
  ].join("\n");
}

/** One printed line of a sample. */
export function sampleLine(s, elapsedMs, extra = "") {
  const c = s.slices?.["codespace.slice"] ?? {};
  const ev = c.events ?? {};
  const p = (res, kind) => s.psi?.[res]?.[kind]?.avg10 ?? "-";
  const sm = s.sessionMemory ?? {};
  return [
    `t+${String(Math.round(elapsedMs / 1000)).padStart(4)}s`,
    extra,
    `sessions prod=${s.sessions?.prod ?? "?"} staging=${s.sessions?.staging ?? "?"}`,
    `avail=${s.memAvailableKb == null ? "-" : Math.round(s.memAvailableKb / 1024)}M`,
    `load=${s.load?.[0] ?? "-"}`,
    `psi mem=${p("memory", "some")}/${p("memory", "full")} cpu=${p("cpu", "some")} io=${p("io", "some")}`,
    `slice=${mib(c.current)}/${mib(c.high)}/${mib(c.max)} high=${ev.high ?? "-"} oom_kill=${ev.oom_kill ?? "-"}`,
    `session p50=${mib(sm.p50)} p95=${mib(sm.p95)} max=${mib(sm.max)}`,
  ]
    .filter(Boolean)
    .join("  ");
}

// --- sampling (the VM's files, Podman) ---------------------------------------

const readOr = (path, fallback = null) => {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return fallback;
  }
};

function run(args, { input, timeoutMs = 60_000 } = {}) {
  return new Promise((resolve) => {
    const child = spawn("podman", ["--remote", "--url", SOCKET, ...args], { stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "";
    child.stdout.on("data", (d) => (stdout += d));
    child.stderr.resume();
    const timer = setTimeout(() => child.kill("SIGKILL"), timeoutMs);
    child.on("error", () => resolve({ code: -1, stdout }));
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ code, stdout });
    });
    child.stdin.end(input ?? "");
  });
}

/** Running session containers of an instance, counted: null when Podman fails. */
async function liveSessions(instance) {
  const r = await run([
    "ps",
    "--filter", "label=heig-codespace.session",
    "--filter", `label=heig-codespace.instance=${instance}`,
    "--filter", "status=running",
    "--format", "{{.ID}}",
  ]);
  return r.code === 0 ? r.stdout.split("\n").filter(Boolean).length : null;
}

function sliceSample(name) {
  const dir = join(CGROUP, sliceCgroupPath(name));
  const current = parseLimit(readOr(join(dir, "memory.current")));
  if (current === null) return null;
  return {
    current,
    peak: parseLimit(readOr(join(dir, "memory.peak"))),
    high: parseLimit(readOr(join(dir, "memory.high"))),
    max: parseLimit(readOr(join(dir, "memory.max"))),
    events: parseKeyed(readOr(join(dir, "memory.events"), "")),
    cpuUsageUsec: parseKeyed(readOr(join(dir, "cpu.stat"), "")).usage_usec ?? null,
  };
}

/** Per-session memory.current over codespace.slice's session scopes (both instances): aggregates only. */
function sessionMemory() {
  const dir = join(CGROUP, "codespace.slice");
  let entries = [];
  try {
    entries = readdirSync(dir).filter(isSessionScope);
  } catch {
    /* no slice */
  }
  return stats(entries.map((e) => parseLimit(readOr(join(dir, e, "memory.current")))));
}

export async function sample() {
  const mem = parseMeminfo(readOr("/proc/meminfo", ""));
  const psi = {};
  for (const res of ["cpu", "memory", "io"]) {
    const p = parsePressure(readOr(`/proc/pressure/${res}`, ""));
    psi[res] = Object.fromEntries(Object.entries(p).map(([k, v]) => [k, { avg10: v.avg10, avg60: v.avg60 }]));
  }
  const sessions = {};
  for (const i of INSTANCES) sessions[i] = await liveSessions(i);
  return {
    t: new Date().toISOString(),
    nproc: availableParallelism(),
    memTotalKb: mem.MemTotal ?? null,
    memAvailableKb: mem.MemAvailable ?? null,
    load: (readOr("/proc/loadavg", "") ?? "").split(" ").slice(0, 3).map(Number),
    psi,
    slices: Object.fromEntries(SLICES.map((s) => [s, sliceSample(s)])),
    sessions,
    sessionMemory: sessionMemory(),
  };
}

// --- watch and report ----------------------------------------------------------

async function watch(opts) {
  const day = new Date().toISOString().slice(0, 10).replaceAll("-", "");
  const out = opts.out ?? `/var/log/quiz-engine/load-${day}.jsonl`;
  mkdirSync(dirname(out), { recursive: true, mode: 0o750 });
  let stop = false;
  for (const sig of ["SIGINT", "SIGTERM"]) process.on(sig, () => (stop = true));
  console.log(`watch: one sample every ${opts.everyMs / 1000} s into ${out}; stop with Ctrl-C or systemctl stop`);
  const start = Date.now();
  while (!stop) {
    const s = await sample();
    appendFileSync(out, `${JSON.stringify(s)}\n`, { mode: 0o640 });
    console.log(sampleLine(s, Date.now() - start));
    const until = Date.now() + opts.everyMs;
    while (!stop && Date.now() < until) await sleep(Math.min(500, until - Date.now()));
  }
  console.log(`watch: stopped; node ${process.argv[1]} report ${out}`);
}

function printReport(file) {
  const samples = readFileSync(file, "utf8")
    .split("\n")
    .filter((l) => l.trim().startsWith("{"))
    .map((l) => JSON.parse(l));
  console.log(formatReport(report(samples)));
}

// --- load ----------------------------------------------------------------------

const sleep = (ms) => new Promise((r) => setTimeout(r, Math.max(0, ms)));

const C_SOURCE = `#include <math.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

typedef struct node { int value; struct node *next; } node;

static node *push(node *head, int value) {
    node *n = malloc(sizeof *n);
    n->value = value;
    n->next = head;
    return n;
}

int main(void) {
    enum { N = 2000000 };
    char *composite = calloc(N + 1, 1);
    node *primes = NULL;
    int count = 0;
    for (int i = 2; i <= N; i++) {
        if (composite[i]) continue;
        primes = push(primes, i);
        count++;
        for (long j = (long)i * i; j <= N; j += i) composite[j] = 1;
    }
    double sum = 0;
    for (node *n = primes; n; n = n->next) sum += sqrt((double)n->value);
    printf("%d primes, %.1f\\n", count, sum);
    while (primes) { node *next = primes->next; free(primes); primes = next; }
    free(composite);
    return 0;
}
`;

const lsp = (msg) => {
  const body = JSON.stringify({ jsonrpc: "2.0", ...msg });
  return `Content-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`;
};

/** A student's activity in one session container, until `signal` aborts. */
export async function work(name, signal, counters) {
  const exec = (argv, input) => run(["exec", ...(input ? ["-i"] : []), name, ...argv], { input, timeoutMs: 120_000 });
  const step = async (argv, input) => {
    const r = await exec(argv, input);
    counters[r.code === 0 ? "ok" : "failed"]++;
    return r.code === 0;
  };
  if (!(await step(["mkdir", "-p", "/work/lt"])) || !(await step(["tee", "/work/lt/main.c"], C_SOURCE))) return;
  // clangd: the biggest resident process of a real session, kept open on the file.
  const clangd = spawn("podman", ["--remote", "--url", SOCKET, "exec", "-i", name, "clangd", "--log=error"], {
    stdio: ["pipe", "ignore", "ignore"],
  });
  clangd.on("error", () => counters.failed++);
  clangd.stdin.on("error", () => {});
  const uri = "file:///work/lt/main.c";
  clangd.stdin.write(lsp({ id: 1, method: "initialize", params: { processId: null, rootUri: "file:///work/lt", capabilities: {} } }));
  clangd.stdin.write(lsp({ method: "initialized", params: {} }));
  clangd.stdin.write(lsp({ method: "textDocument/didOpen", params: { textDocument: { uri, languageId: "c", version: 1, text: C_SOURCE } } }));
  let version = 1;
  try {
    while (!signal.aborted) {
      await sleep(20_000 + Math.random() * 20_000);
      if (signal.aborted) break;
      version++;
      const text = `${C_SOURCE}// edit ${version}\n`;
      clangd.stdin.write(lsp({ method: "textDocument/didChange", params: { textDocument: { uri, version }, contentChanges: [{ text }] } }));
      if (!(await step(["gcc", "-g", "-O0", "-Wall", "-o", "/work/lt/a.out", "/work/lt/main.c", "-lm"]))) continue;
      await step(["/work/lt/a.out"]);
      if (Math.random() < 0.25) await step(["gdb", "-batch", "-ex", "break main", "-ex", "run", "-ex", "next", "-ex", "bt", "/work/lt/a.out"]);
    }
  } finally {
    clangd.stdin.end();
    setTimeout(() => clangd.kill("SIGKILL"), 5000).unref();
  }
}

function readEnv(instance) {
  const file = process.env.LOADTEST_ENV_FILE ?? `/etc/quiz-codespace/${instance}/env`;
  return Object.fromEntries(
    readFileSync(file, "utf8")
      .split("\n")
      .filter((l) => /^[A-Z_]+=/.test(l))
      .map((l) => [l.slice(0, l.indexOf("=")), l.slice(l.indexOf("=") + 1)]),
  );
}

async function load(opts) {
  const fail = (m) => {
    console.error(`FAIL  ${m}`);
    process.exit(1);
  };
  const ok = (m) => console.log(`ok    ${m}`);
  if (opts.instance === "prod" && !opts.yesProd && !opts.dryRun) fail("prod: add --yes-prod (its sessions also hold the prod deploy's live-session guard)");
  const env = readEnv(opts.instance);
  const secret = env.CODESPACE_LAUNCH_SECRET ?? "";
  if (secret.length < 32) fail(`CODESPACE_LAUNCH_SECRET of ${opts.instance} missing or short`);
  const base = `http://127.0.0.1:${opts.port}`;
  const b64 = (o) => Buffer.from(JSON.stringify(o)).toString("base64url");
  const sign = (claims) => {
    const head = `${b64({ alg: "HS256", typ: "JWT" })}.${b64(claims)}`;
    return `${head}.${createHmac("sha256", secret).update(head).digest("base64url")}`;
  };
  const now = () => Math.floor(Date.now() / 1000);
  const service = (method, path, body) =>
    sign({
      iss: "heig-quiz", aud: "heig-codespace-api", iat: now(), exp: now() + 120, jti: randomUUID(), method, path,
      ...(body ? { bodyHash: createHash("sha256").update(body).digest("base64url") } : {}),
    });

  const health = await fetch(`${base}/healthz`).catch((e) => fail(`/healthz: ${e.message}`));
  if (health.status !== 200) fail(`/healthz answered ${health.status}`);
  ok(`${base}/healthz`);

  const live = await liveSessions(opts.instance);
  if (live === null && !opts.besideLive) fail("podman ps failed: cannot tell whether real sessions run (--beside-live to go on)");
  if (live > 0 && !opts.besideLive && !opts.dryRun) fail(`${live} session(s) running on ${opts.instance}: wait, or add --beside-live`);
  ok(`${live ?? "?"} session(s) running on ${opts.instance}`);

  const [owner, name] = (process.env.LOADTEST_REPO ?? "octocat/Hello-World").split("/");
  const branch = process.env.LOADTEST_BRANCH ?? "master";
  const repo = { fullName: `${owner}/${name}`, defaultBranch: branch };
  const syncBody = JSON.stringify({
    id: ASSIGNMENT, slug: ASSIGNMENT, name: "Load test", classroomId: ASSIGNMENT, classroomName: "Load test",
    mode: "online", image: null, sourceRepo: repo, browserExamKeys: [],
    teacher: { id: TEACHER, email: "loadtest@invalid.example" },
    // The synthetic holder's quota is the test's size: no real grant is involved.
    quota: { maxActiveSessions: opts.sessions },
    startAt: new Date(Date.now() - 3600_000).toISOString(), deadlineAt: null,
  });
  const path = `/api/assignments/${ASSIGNMENT}`;
  const sync = await fetch(`${base}${path}`, {
    method: "PUT",
    headers: { authorization: `Bearer ${service("PUT", path, syncBody)}`, "content-type": "application/json" },
    body: syncBody,
  });
  if (sync.status !== 200) fail(`service token or sync answered ${sync.status} (401: wrong secret, or the integration is off)`);
  ok(`assignment ${ASSIGNMENT} synced (${repo.fullName}, quota ${opts.sessions} for ${TEACHER})`);
  if (opts.dryRun) {
    console.log("dry run: nothing launched");
    return;
  }

  const aborter = new AbortController();
  let interrupted = 0;
  for (const sig of ["SIGINT", "SIGTERM"]) {
    process.on(sig, () => {
      if (++interrupted > 1) process.exit(130);
      console.log("\ninterrupted: no more launches, stopping the work, reporting (again to quit at once)");
      aborter.abort();
    });
  }
  const abortable = (ms) =>
    new Promise((r) => {
      const t = setTimeout(r, Math.max(0, ms));
      aborter.signal.addEventListener("abort", () => (clearTimeout(t), r()), { once: true });
    });

  const launches = [];
  const counters = { ok: 0, failed: 0 };
  const workers = [];
  const startedAt = Date.now();
  const samples = [];
  // One sample every 10 s, and a last one once the run is over.
  const sampler = (async () => {
    for (;;) {
      const s = await sample();
      samples.push(s);
      const up = launches.filter((l) => l.ok).length;
      console.log(sampleLine(s, Date.now() - startedAt, `up=${up}/${opts.sessions} work ok=${counters.ok} failed=${counters.failed}`));
      if (aborter.signal.aborted) break;
      await abortable(10_000);
    }
  })();

  async function launchOne(i) {
    const sub = `load-${String(i + 1).padStart(3, "0")}`;
    const entry = { student: sub, ok: false, cause: null, status: null, ms303: null, msHealth: null, sessionId: null };
    launches.push(entry);
    const token = sign({
      iss: "heig-quiz", aud: "heig-codespace", iat: now(), exp: now() + 300, jti: randomUUID(), sub,
      email: `${sub}@invalid.example`, displayName: `Load ${sub}`, githubLogin: null, assignmentId: ASSIGNMENT, repo,
    });
    const t0 = Date.now();
    let res;
    try {
      res = await fetch(`${base}/launch?token=${token}`, { redirect: "manual", signal: AbortSignal.timeout(180_000) });
    } catch (e) {
      entry.cause = e.name === "TimeoutError" ? "timeout" : "network";
      return;
    }
    entry.status = res.status;
    entry.ms303 = Date.now() - t0;
    await res.arrayBuffer().catch(() => {});
    const where = res.headers.get("location") ?? "";
    const sid = /^\/s\/([^/]+)\/$/.exec(where)?.[1];
    if (res.status !== 303 || !sid) {
      entry.cause = res.status === 429 ? "429" : res.status >= 500 ? "5xx" : `${res.status}`;
      return;
    }
    entry.sessionId = sid;
    const cookie = /cs_session=([^;,\s]+)/.exec(res.headers.get("set-cookie") ?? "")?.[1];
    if (!cookie) {
      entry.cause = "no-cookie";
      return;
    }
    entry.cookie = cookie;
    const t1 = Date.now();
    const h = await fetch(`${base}/s/${sid}/healthz`, { headers: { cookie: `cs_session=${cookie}` }, signal: AbortSignal.timeout(60_000) }).catch(() => null);
    entry.msHealth = Date.now() - t1;
    if (h?.status !== 200) {
      entry.cause = h ? `health-${h.status}` : "health-timeout";
      return;
    }
    entry.ok = true;
    if (opts.work) {
      const ps = await run(["ps", "--filter", `label=heig-codespace.session=${sid}`, "--format", "{{.Names}}"]);
      const container = ps.stdout.split("\n").find(Boolean);
      if (container) workers.push(work(container, aborter.signal, counters));
      else counters.failed++;
    }
  }

  // The ramp: launch i at i × ramp / N, each without waiting for the others.
  const pending = [];
  for (let i = 0; i < opts.sessions && !aborter.signal.aborted; i++) {
    await abortable(startedAt + (i * opts.rampMs) / opts.sessions - Date.now());
    if (!aborter.signal.aborted) pending.push(launchOne(i));
  }
  await Promise.all(pending);
  const rampDone = Date.now();
  console.log(`ramp done in ${Math.round((rampDone - startedAt) / 1000)} s; holding ${Math.round(opts.holdMs / 1000)} s`);

  // Keep-alive: a proxied request a minute counts as the tab's heartbeat.
  const keepAlive = setInterval(() => {
    for (const l of launches.filter((x) => x.ok)) {
      fetch(`${base}/s/${l.sessionId}/healthz`, { headers: { cookie: `cs_session=${l.cookie}` }, signal: AbortSignal.timeout(30_000) })
        .then((r) => r.arrayBuffer().then(() => r.status !== 200 && (l.lost = (l.lost ?? 0) + 1)))
        .catch(() => (l.lost = (l.lost ?? 0) + 1));
    }
  }, 60_000);
  await abortable(rampDone + opts.holdMs - Date.now());
  clearInterval(keepAlive);
  aborter.abort();
  await Promise.allSettled(workers);
  await sampler;

  const okLaunches = launches.filter((l) => l.ok);
  const causes = {};
  for (const l of launches.filter((x) => !x.ok)) causes[l.cause] = (causes[l.cause] ?? 0) + 1;
  const summary = {
    ...report(samples),
    launched: launches.length,
    up: okLaunches.length,
    failures: causes,
    lostAfterLaunch: okLaunches.filter((l) => l.lost).length,
    latency303: stats(launches.map((l) => l.ms303)),
    latencyHealth: stats(okLaunches.map((l) => l.msHealth)),
    work: counters,
  };
  const ms = (s) => `p50 ${s.p50 ?? "-"} ms, p95 ${s.p95 ?? "-"} ms, max ${s.max ?? "-"} ms`;
  console.log(`\n--- ${opts.instance}: ${opts.sessions} sessions, ramp ${opts.rampMs / 1000} s, hold ${opts.holdMs / 1000} s, work ${opts.work}`);
  console.log(`launches          ${summary.up} up of ${summary.launched}; failures ${JSON.stringify(causes)}; lost after launch ${summary.lostAfterLaunch}`);
  console.log(`launch → 303      ${ms(summary.latency303)}`);
  console.log(`303 → /healthz    ${ms(summary.latencyHealth)}`);
  console.log(`work steps        ${counters.ok} ok, ${counters.failed} failed`);
  console.log(formatReport(report(samples)));

  const out = opts.out ?? `/root/loadtest-${opts.instance}-${new Date(startedAt).toISOString().replace(/[:.]/g, "-")}.json`;
  const saved = launches.map(({ cookie: _cookie, ...l }) => l);
  writeFileSync(out, `${JSON.stringify({ opts, summary, launches: saved, samples }, null, 1)}\n`, { mode: 0o600 });
  console.log(`\nwritten: ${out}`);

  const grace = Math.round(Number(env.SESSION_GRACE_MS ?? 600_000) / 60_000);
  const gc = Math.round(Number(env.SESSION_GC_INTERVAL_MS ?? 60_000) / 60_000);
  console.log(
    [
      "",
      `The portal has no API to close a session: the load sessions close ${grace} min (+${gc} min) after this run's last request.`,
      "Then, as root, check none is left and remove their volumes:",
      `  podman --remote --url ${SOCKET} ps --filter label=heig-codespace.instance=${opts.instance} --format '{{.Names}}' | wc -l`,
      `  rm -rf /srv/quiz-codespace/${opts.instance}/volumes/load-[0-9][0-9][0-9]`,
    ].join("\n"),
  );
}

async function main() {
  let opts;
  try {
    opts = parseArgs(process.argv.slice(2));
  } catch (e) {
    console.error(`${e.message}\nusage: loadtest.mjs <staging|prod> --port <n> --sessions <n> [--ramp 60s] [--hold 10m] [--work] [--dry-run] [--yes-prod] [--beside-live] [--out f.json]\n       loadtest.mjs watch [--every 10s] [--out f.jsonl]\n       loadtest.mjs report <f.jsonl>`);
    process.exit(2);
  }
  if (opts.mode === "report") return printReport(opts.file);
  if (opts.mode === "watch") return watch(opts);
  return load(opts);
}

if (process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) {
  await main();
  process.exit(0);
}
