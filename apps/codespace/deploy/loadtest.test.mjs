// The pure parts of loadtest.mjs: arguments, durations, percentiles, the
// kernel files' parsers, the slice paths and the report of a watch file.
//   node --test apps/codespace/deploy/loadtest.test.mjs
import assert from "node:assert/strict";
import { test } from "node:test";

import {
  abortReason,
  formatReport,
  isSessionScope,
  parseArgs,
  parseDuration,
  parseKeyed,
  parseLimit,
  parseMeminfo,
  parsePressure,
  percentile,
  report,
  sampleLine,
  sliceCgroupPath,
  stats,
} from "./loadtest.mjs";

test("durations", () => {
  assert.equal(parseDuration("60s"), 60_000);
  assert.equal(parseDuration("10m"), 600_000);
  assert.equal(parseDuration("1h"), 3_600_000);
  assert.equal(parseDuration("500ms"), 500);
  assert.equal(parseDuration("0"), 0);
  assert.equal(parseDuration("90"), 90_000);
  assert.throws(() => parseDuration("10 m"));
  assert.throws(() => parseDuration("-1s"));
});

test("load arguments", () => {
  const o = parseArgs(["staging", "--sessions", "50", "--ramp", "0", "--work"]);
  assert.deepEqual(o, {
    mode: "load",
    instance: "staging",
    port: 3120,
    sessions: 50,
    rampMs: 0,
    holdMs: 600_000,
    work: true,
    dryRun: false,
    yesProd: false,
    besideLive: false,
    abortOnOom: true,
    out: null,
  });
  assert.equal(parseArgs(["staging", "--sessions", "5", "--no-abort-on-oom"]).abortOnOom, false);
  assert.equal(parseArgs(["staging", "--dry-run"]).sessions, 1);
  const prod = parseArgs(["prod", "--sessions", "5", "--yes-prod"]);
  assert.equal(prod.yesProd, true);
  assert.equal(prod.port, 3110);
  assert.throws(() => parseArgs(["prod", "--sessions", "5"]), /--yes-prod/);
  assert.throws(() => parseArgs(["prod", "--dry-run"]), /--yes-prod/);
  assert.equal(parseArgs(["prod", "--dry-run", "--yes-prod"]).dryRun, true);
  assert.throws(() => parseArgs(["staging", "--port", "3120", "--sessions", "5"]), /unknown option --port/);
  assert.throws(() => parseArgs(["staging"]), /--sessions/);
  assert.throws(() => parseArgs(["staging", "--sessions", "201"]), /--sessions/);
  assert.throws(() => parseArgs(["staging", "--sessions", "0"]), /--sessions/);
  assert.throws(() => parseArgs(["staging", "--sessions", "5", "--force"]), /unknown option/);
  assert.throws(() => parseArgs(["staging", "--sessions"]), /needs a value/);
  assert.throws(() => parseArgs(["default", "--sessions", "1"]), /prod, staging/);
  assert.throws(() => parseArgs(["../etc", "--sessions", "1"]), /prod, staging/);
  assert.throws(() => parseArgs([]), /prod, staging/);
});

test("the run stops on an OOM kill or a stalled host", () => {
  const at = (oomKill, full) => ({
    slices: { "codespace.slice": { events: { oom_kill: oomKill } } },
    psi: { memory: { full: { avg10: full } } },
  });
  assert.equal(abortReason(at(2, 0), at(2, 9.9)), null);
  assert.match(abortReason(at(2, 0), at(3, 0)), /oom_kill 2 → 3/);
  assert.match(abortReason(at(0, 0), at(0, 10.5)), /full avg10 10.5/);
  assert.equal(abortReason(at(0, 0), {}), null);
  assert.equal(abortReason({}, { slices: { "codespace.slice": null } }), null);
});

test("watch and report arguments", () => {
  assert.deepEqual(parseArgs(["watch"]), { mode: "watch", everyMs: 10_000, out: null });
  assert.deepEqual(parseArgs(["watch", "--every", "5s", "--out", "/tmp/x.jsonl"]), { mode: "watch", everyMs: 5000, out: "/tmp/x.jsonl" });
  assert.deepEqual(parseArgs(["report", "a.jsonl"]), { mode: "report", file: "a.jsonl" });
  assert.throws(() => parseArgs(["report"]), /report/);
  assert.throws(() => parseArgs(["watch", "extra"]), /unexpected/);
});

test("percentiles, nearest rank", () => {
  const v = Array.from({ length: 100 }, (_, i) => i + 1);
  assert.equal(percentile(v, 50), 50);
  assert.equal(percentile(v, 95), 95);
  assert.equal(percentile(v, 100), 100);
  assert.equal(percentile([7], 95), 7);
  assert.equal(percentile([3, 1, 2], 50), 2);
  assert.equal(percentile([], 50), null);
  assert.equal(percentile([null, 4, undefined], 50), 4);
  assert.deepEqual(stats([10, 20, 30, null]), { n: 3, p50: 20, p95: 30, max: 30, mean: 20 });
  assert.deepEqual(stats([]), { n: 0, p50: null, p95: null, max: null, mean: null });
});

test("kernel files", () => {
  assert.deepEqual(parsePressure("some avg10=1.50 avg60=0.20 avg300=0.00 total=123\nfull avg10=0.00 avg60=0.00 avg300=0.00 total=4\n"), {
    some: { avg10: 1.5, avg60: 0.2, avg300: 0, total: 123 },
    full: { avg10: 0, avg60: 0, avg300: 0, total: 4 },
  });
  assert.deepEqual(parsePressure("some avg10=0.10 avg60=0.00 avg300=0.00 total=1\n").full, undefined);
  assert.deepEqual(parseKeyed("low 0\nhigh 12\nmax 3\noom 1\noom_kill 1\noom_group_kill 0\n"), {
    low: 0, high: 12, max: 3, oom: 1, oom_kill: 1, oom_group_kill: 0,
  });
  assert.equal(parseKeyed("usage_usec 987654\nuser_usec 1\n").usage_usec, 987654);
  const m = parseMeminfo("MemTotal:        3911092 kB\nMemFree:          100 kB\nMemAvailable:    2000000 kB\nActive(anon):  5 kB\n");
  assert.equal(m.MemTotal, 3911092);
  assert.equal(m.MemAvailable, 2000000);
  assert.equal(m["Active(anon)"], 5);
  assert.equal(parseLimit("max\n"), null);
  assert.equal(parseLimit("2147483648\n"), 2147483648);
  assert.equal(parseLimit(null), null);
});

test("slice cgroup paths follow systemd's dashes", () => {
  assert.equal(sliceCgroupPath("codespace.slice"), "codespace.slice");
  assert.equal(sliceCgroupPath("quiz-runner.slice"), "quiz.slice/quiz-runner.slice");
  assert.ok(isSessionScope(`libpod-${"a".repeat(64)}.scope`));
  assert.ok(!isSessionScope(`libpod-conmon-${"a".repeat(64)}.scope`));
  assert.ok(!isSessionScope("quiz-codespace-prod.service"));
});

const sample = (t, { sessions, current, peak, oomKill, high, mem = 0, cpu = 0, mean, avail }) => ({
  t,
  nproc: 8,
  memTotalKb: 16 * 1024 * 1024,
  memAvailableKb: avail,
  load: [cpu / 10, 0, 0],
  psi: { memory: { some: { avg10: mem, avg60: 0 }, full: { avg10: mem / 2, avg60: 0 } }, cpu: { some: { avg10: cpu, avg60: 0 } }, io: { some: { avg10: 0.5, avg60: 0 } } },
  slices: {
    "codespace.slice": { current, peak, high: 12 * 2 ** 30, max: 14 * 2 ** 30, events: { high, max: 0, oom: oomKill, oom_kill: oomKill }, cpuUsageUsec: 1 },
    "quiz-runner.slice": { current: 1, peak: null, high: null, max: 2 ** 30, events: { high: 0, max: 0, oom: 0, oom_kill: 0 }, cpuUsageUsec: 1 },
  },
  sessions: { prod: sessions, staging: 1 },
  sessionMemory: { n: sessions, p50: 1, p95: 2, max: 3, mean },
});

test("the report of a watch file finds the peaks", () => {
  const r = report([
    sample("T1", { sessions: 10, current: 2 * 2 ** 30, peak: 2 * 2 ** 30, oomKill: 2, high: 5, mem: 0.5, cpu: 10, mean: 100, avail: 8_000_000 }),
    sample("T2", { sessions: 49, current: 9 * 2 ** 30, peak: 10 * 2 ** 30, oomKill: 3, high: 9, mem: 4.2, cpu: 80, mean: 180 * 2 ** 20, avail: 2_000_000 }),
    sample("T3", { sessions: 30, current: 6 * 2 ** 30, peak: 10 * 2 ** 30, oomKill: 3, high: 9, mem: 1, cpu: 20, mean: 150, avail: 4_000_000 }),
  ]);
  assert.equal(r.maxSessions, 50);
  assert.equal(r.peakSliceMemory, 9 * 2 ** 30);
  assert.equal(r.peakSliceMemoryAt, "T2");
  assert.equal(r.sessionsAtPeak, 50);
  assert.equal(r.perSessionMeanAtPeak, 180 * 2 ** 20);
  assert.equal(r.sliceMemoryPeakCounter, 10 * 2 ** 30);
  assert.deepEqual(r.events["codespace.slice"], { high: 4, max: 0, oom: 1, oom_kill: 1 });
  assert.deepEqual(r.events["quiz-runner.slice"], { high: 0, max: 0, oom: 0, oom_kill: 0 });
  assert.deepEqual(r.worstPsi, { memorySome: 4.2, memoryFull: 2.1, cpuSome: 80, ioSome: 0.5 });
  assert.equal(r.minMemAvailableMiB, Math.round(2_000_000 / 1024));
  assert.equal(r.maxLoad1, 8);
  const text = formatReport(r);
  assert.match(text, /max sessions\s+50/);
  assert.match(text, /oom_kill \+1/);
  assert.equal(report([]), null);
});

test("a printed sample line names no container", () => {
  const line = sampleLine(sample("T", { sessions: 3, current: 2 ** 30, peak: null, oomKill: 0, high: 0, mean: 1, avail: 1024 * 1024 }), 12_345, "up=3/5");
  assert.match(line, /^t\+ {2}12s {2}up=3\/5 {2}sessions prod=3 staging=1/);
  assert.match(line, /slice=1024M\/12288M\/14336M/);
  assert.doesNotMatch(line, /libpod|cs-|load-/);
});
