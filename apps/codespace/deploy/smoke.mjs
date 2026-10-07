#!/usr/bin/env node
/**
 * Smoke test of one portal instance, ON the engine VM, as root (it reads the
 * instance's env file for the launch secret). Node's standard library only:
 * the checkout has no node_modules.
 *
 *   node apps/codespace/deploy/smoke.mjs <prod|staging>            # health, secret, sync
 *   node apps/codespace/deploy/smoke.mjs <prod|staging> --launch   # + a real session
 *
 * 1. GET /healthz on the loopback port;
 * 2. a service token signed here with the instance's CODESPACE_LAUNCH_SECRET:
 *    GET /api/assignments/m6-04-smoke/sessions answers 200 or 404, never 401
 *    (a 401 means the secret or the issuer is wrong, or the integration is off);
 * 3. PUT /api/assignments/m6-04-smoke, a `lab` assignment on a PUBLIC
 *    repository (SMOKE_REPO, default octocat/Hello-World on master);
 * 4. with --launch: a launch token for a smoke student, GET /launch?token=…
 *    expects the 303 to /s/<session>/ — a student container really started
 *    (image, network, seccomp, AppArmor, volume). The session is left to the
 *    garbage collector (SESSION_GRACE_MS) and counts against the smoke
 *    teacher's quota of 1, nobody else's.
 *
 * The port is the env file's PORT, or `--port <n>`. Tokens are printed
 * nowhere.
 */
import { createHmac, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";

const instance = process.argv[2];
const launch = process.argv.includes("--launch");
const portArg = process.argv[process.argv.indexOf("--port") + 1];
if (!/^[a-z][a-z0-9]{0,15}$/.test(instance ?? "")) {
  console.error("usage: smoke.mjs <prod|staging> [--launch] [--port <n>]");
  process.exit(2);
}
// SMOKE_ENV_FILE serves a run against a portal elsewhere (a workstation).
const env = Object.fromEntries(
  readFileSync(process.env.SMOKE_ENV_FILE ?? `/etc/quiz-codespace/${instance}/env`, "utf8")
    .split("\n")
    .filter((l) => /^[A-Z_]+=/.test(l))
    .map((l) => [l.slice(0, l.indexOf("=")), l.slice(l.indexOf("=") + 1)]),
);
const port = process.argv.includes("--port") ? portArg : env.PORT;
if (!/^\d+$/.test(port ?? "")) fail("no port: PORT in the env file, or --port <n>");
const base = `http://127.0.0.1:${port}`;
const secret = env.CODESPACE_LAUNCH_SECRET ?? "";
if (secret.length < 32) fail(`CODESPACE_LAUNCH_SECRET of ${instance} missing or short`);

const b64 = (o) => Buffer.from(JSON.stringify(o)).toString("base64url");
function sign(claims) {
  const head = `${b64({ alg: "HS256", typ: "JWT" })}.${b64(claims)}`;
  return `${head}.${createHmac("sha256", secret).update(head).digest("base64url")}`;
}
const now = () => Math.floor(Date.now() / 1000);
function fail(message) {
  console.error(`FAIL  ${message}`);
  process.exit(1);
}
const ok = (message) => console.log(`ok    ${message}`);

const ID = "m6-04-smoke";
const [owner, name] = (process.env.SMOKE_REPO ?? "octocat/Hello-World").split("/");
const branch = process.env.SMOKE_BRANCH ?? "master";
const service = () =>
  sign({ iss: "heig-quiz", aud: "heig-codespace-api", iat: now(), exp: now() + 120 });

const health = await fetch(`${base}/healthz`).catch((e) => fail(`/healthz: ${e.message}`));
if (health.status !== 200) fail(`/healthz answered ${health.status}`);
ok(`${base}/healthz`);

const sessions = await fetch(`${base}/api/assignments/${ID}/sessions`, {
  headers: { authorization: `Bearer ${service()}` },
});
if (![200, 404].includes(sessions.status)) {
  fail(`service token answered ${sessions.status} (401: wrong secret, or the integration is off)`);
}
ok(`service token accepted (${sessions.status})`);

const sync = await fetch(`${base}/api/assignments/${ID}`, {
  method: "PUT",
  headers: { authorization: `Bearer ${service()}`, "content-type": "application/json" },
  body: JSON.stringify({
    id: ID,
    slug: ID,
    name: "M6-04 smoke",
    classroomId: "m6-04-smoke",
    classroomName: "M6-04 smoke",
    mode: "online",
    image: null,
    sourceRepo: { fullName: `${owner}/${name}`, defaultBranch: branch },
    browserExamKeys: [],
    teacher: { id: "m6-04-smoke", email: "smoke@invalid.example" },
    quota: { maxActiveSessions: 1 },
    startAt: new Date(Date.now() - 3600_000).toISOString(),
    deadlineAt: null,
  }),
});
if (sync.status !== 200) fail(`sync answered ${sync.status}: ${await sync.text()}`);
ok(`assignment ${ID} synced (${owner}/${name})`);

if (launch) {
  const token = sign({
    iss: "heig-quiz",
    aud: "heig-codespace",
    iat: now(),
    exp: now() + 300,
    jti: randomUUID(),
    sub: "m6-04-smoke",
    email: "smoke@invalid.example",
    displayName: "M6-04 smoke",
    githubLogin: null,
    assignmentId: ID,
    repo: { fullName: `${owner}/${name}`, defaultBranch: branch },
  });
  const res = await fetch(`${base}/launch?token=${token}`, { redirect: "manual" });
  const where = res.headers.get("location") ?? "";
  if (res.status !== 303 || !/^\/s\/[^/]+\/$/.test(where)) {
    fail(`launch answered ${res.status} ${where} (journalctl -u quiz-codespace-${instance})`);
  }
  ok(`launch: 303 ${where}, a student container is running`);
}
console.log(`smoke of ${instance}: passed`);
