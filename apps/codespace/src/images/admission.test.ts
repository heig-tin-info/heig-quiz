/**
 * The admitted set (ADR-146 §5) without an engine nor a registry: the pure
 * manifest verdict, the admission job's steps and each of its refusals, one
 * row per reference, the startup (interrupted rows, earlier defaults, the
 * default's self-admission), the store's list and the un-admission, driven
 * through a fake `ImageEngine` and a fake `OciClient`. A real admission is
 * `admission.integration.test.ts` (never in CI).
 */
import { OciError, type OciClient, type OciImage } from "@quiz/core/oci";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { openDb, type Db, type DbHandle } from "../db/client.js";
import { admittedImages, assignments, sessions, users } from "../db/schema.js";
import { BASE_CHECK_PATH, type ImageEngine, type LocalImage, type Ran, type StoreImage } from "../engine/admission.js";

import { BASE_VERSION_LABEL, cleanDetail, createImageAdmissions, manifestVerdict, type BaseInfo, type ImageAdmissionOptions } from "./admission.js";

const L = (c: string) => `sha256:${c.repeat(64)}`;
const BASE = `ghcr.io/heig-tin-info/quiz-base@${L("b")}`;
const OLD_BASE = `ghcr.io/heig-tin-info/quiz-base@${L("a")}`;
const COURSE_DIGEST = L("c");
const COURSE = `ghcr.io/heig/lab-go@${COURSE_DIGEST}`;
/** The same digest under another name: a second row, never the first's. */
const MIRROR = `docker.io/heig/lab-go@${COURSE_DIGEST}`;
const GIB = 1024 ** 3;
const ENTRY = ["/usr/local/bin/entrypoint.sh"];
const BASE_LAYERS = [L("1"), L("2")];
const COURSE_LAYERS = [...BASE_LAYERS, L("3")];

function ociImage(reference: string, diffIds: string[], over: Partial<OciImage["config"]> = {}, compressedBytes = 1000): OciImage {
  return {
    reference,
    digest: reference.split("@")[1] ?? "",
    layers: diffIds.map((d) => ({ digest: d, size: 10 })),
    compressedBytes,
    config: { architecture: "amd64", os: "linux", diffIds, user: "student", entrypoint: ENTRY, cmd: null, labels: {}, ...over },
  };
}

/** The registry: images by reference, tags resolved through `tags`; `fail` throws for a reference. */
function fakeRegistry(images: Map<string, OciImage>, tags = new Map<string, string>(), fail = new Map<string, OciError>()): OciClient {
  return {
    async resolve(reference) {
      const pinned = tags.get(reference) ?? reference;
      const err = fail.get(reference) ?? fail.get(pinned);
      if (err) throw err;
      const image = images.get(pinned);
      if (!image) throw new OciError("not_found", `${reference}: not found`);
      return { reference: image.reference, digest: image.digest };
    },
    async image(reference) {
      const err = fail.get(reference);
      if (err) throw err;
      const image = images.get(reference);
      if (!image) throw new OciError("not_found", `${reference}: not found`);
      return image;
    },
  };
}

const local = (diffIds: string[], over: Partial<LocalImage> = {}): LocalImage => ({
  id: L("9"),
  sizeBytes: GIB,
  diffIds,
  user: "student",
  entrypoint: ENTRY,
  cmd: null,
  labels: {},
  ...over,
});

class FakeEngine implements ImageEngine {
  /** The store, by name. */
  readonly local = new Map<string, LocalImage>();
  readonly calls: string[] = [];
  readonly containers = new Set<string>();
  free: number | null = 100 * GIB;
  healthy = true;
  check: Ran = { code: 0, stdout: "ok uid\nok healthz\n", stderr: "" };
  checkScript = "#!/bin/sh\necho ok\n";
  pullFails = false;
  readFails = false;
  /** What a pull of a reference puts in the store. */
  onPull = new Map<string, LocalImage>();
  scripts: string[] = [];
  extra: StoreImage[] = [];

  async inspect(reference: string) {
    return this.local.get(reference) ?? null;
  }
  async exists(reference: string) {
    return this.local.has(reference);
  }
  async pull(reference: string) {
    this.calls.push(`pull ${reference}`);
    if (this.pullFails) throw Object.assign(new Error("podman pull failed"), { stderr: "Error: manifest unknown\n" });
    const image = this.onPull.get(reference);
    if (image) this.local.set(reference, image);
  }
  async freeBytes() {
    return this.free;
  }
  async listImages(): Promise<StoreImage[]> {
    const byId = new Map<string, StoreImage>();
    for (const [name, img] of this.local) {
      const entry = byId.get(img.id) ?? { id: img.id, names: [], sizeBytes: img.sizeBytes, diffIds: img.diffIds };
      entry.names.push(name.includes("@") ? name : `localhost/${name}`);
      byId.set(img.id, entry);
    }
    return [...byId.values(), ...this.extra];
  }
  async readFile(reference: string, path: string) {
    this.calls.push(`read ${reference} ${path}`);
    if (this.readFails) throw new Error("reading failed");
    return this.checkScript;
  }
  async startAdmission(reference: string) {
    this.calls.push(`start ${reference}`);
    const name = `cs-test-admission-${this.containers.size}`;
    this.containers.add(name);
    return name;
  }
  async waitHealthy() {
    return this.healthy;
  }
  async runCheck(_name: string, script: string) {
    this.scripts.push(script);
    return this.check;
  }
  async logs() {
    return "line 1\ncode-server crashed\n";
  }
  async removeContainer(name: string) {
    this.calls.push(`rm ${name}`);
    this.containers.delete(name);
  }
  async sweep() {
    this.calls.push("sweep");
    return 0;
  }
}

const LOG = { info: () => undefined, warn: () => undefined, error: () => undefined };

let handle: DbHandle;
let db: Db;
let engine: FakeEngine;
let images: Map<string, OciImage>;

beforeEach(() => {
  handle = openDb(":memory:");
  db = handle.db;
  engine = new FakeEngine();
  images = new Map([
    [BASE, ociImage(BASE, BASE_LAYERS, { labels: { [BASE_VERSION_LABEL]: "1.2.0" } })],
    [OLD_BASE, ociImage(OLD_BASE, [L("1")], { labels: { [BASE_VERSION_LABEL]: "1.0.0" } })],
    [COURSE, ociImage(COURSE, COURSE_LAYERS)],
    [MIRROR, ociImage(MIRROR, COURSE_LAYERS)],
  ]);
  engine.local.set(BASE, local(BASE_LAYERS, { id: L("b"), labels: { [BASE_VERSION_LABEL]: "1.2.0" } }));
  engine.onPull.set(COURSE, local(COURSE_LAYERS, { id: L("c") }));
  engine.onPull.set(MIRROR, local(COURSE_LAYERS, { id: L("c") }));
});
afterEach(() => handle.close());

function admissions(over: Partial<ImageAdmissionOptions> = {}, registry = fakeRegistry(images, new Map([["ghcr.io/heig/lab-go:1", COURSE]]))) {
  return createImageAdmissions({
    db,
    registry,
    engine,
    defaultImage: BASE,
    baseReleases: [BASE, OLD_BASE],
    maxBytes: 4 * GIB,
    minFreeBytes: 20 * GIB,
    healthTimeoutMs: 1000,
    log: LOG,
    ...over,
  });
}

async function admit(reference = "ghcr.io/heig/lab-go:1", over: Partial<ImageAdmissionOptions> = {}) {
  const a = admissions(over);
  const asked = await a.request(reference);
  await a.idle();
  return { a, asked, row: a.get(COURSE) };
}

describe("manifestVerdict", () => {
  const base = (reference: string, diffIds: string[], over: Partial<BaseInfo> = {}): BaseInfo => ({
    reference,
    digest: reference.split("@")[1] ?? "",
    diffIds,
    user: "student",
    entrypoint: ENTRY,
    cmd: null,
    version: "1",
    ...over,
  });
  const released = [base(BASE, BASE_LAYERS, { version: "1.2.0" }), base(OLD_BASE, [L("1")], { version: "1.0.0" })];

  it("takes the longest released prefix, never a label", () => {
    const verdict = manifestVerdict(ociImage(COURSE, COURSE_LAYERS, { labels: { [BASE_VERSION_LABEL]: "9.9.9" } }), released, GIB);
    expect(verdict).toMatchObject({ ok: true, base: { version: "1.2.0" } });
    expect(manifestVerdict(ociImage(COURSE, [L("1"), L("4")]), released, GIB)).toMatchObject({ ok: true, base: { version: "1.0.0" } });
    // The base itself derives from itself; an empty prefix derives nothing.
    expect(manifestVerdict(ociImage(BASE, BASE_LAYERS), released, GIB)).toMatchObject({ ok: true });
    expect(manifestVerdict(ociImage(COURSE, COURSE_LAYERS), [base(BASE, [])], GIB)).toEqual({ ok: false, reason: "not_on_base", detail: null });
  });

  it("refuses with a reason and a diagnostic, in this order", () => {
    expect(manifestVerdict(ociImage(COURSE, COURSE_LAYERS, { architecture: "arm64" }), released, GIB)).toEqual({ ok: false, reason: "config", detail: "linux/arm64" });
    expect(manifestVerdict(ociImage(COURSE, COURSE_LAYERS, {}, 5 * GIB), released, 4 * GIB)).toEqual({ ok: false, reason: "too_large", detail: `${5 * GIB}>${4 * GIB}` });
    expect(manifestVerdict(ociImage(COURSE, [L("7"), ...BASE_LAYERS]), released, GIB)).toEqual({ ok: false, reason: "not_on_base", detail: null });
    expect(manifestVerdict(ociImage(COURSE, COURSE_LAYERS), [], GIB)).toMatchObject({ reason: "not_on_base" });
    expect(manifestVerdict(ociImage(COURSE, COURSE_LAYERS, { user: "root", cmd: ["bash"], entrypoint: [] }), released, GIB)).toEqual({ ok: false, reason: "config", detail: "User,Entrypoint,Cmd" });
    // An empty list and null are the same Cmd.
    expect(manifestVerdict(ociImage(COURSE, COURSE_LAYERS, { cmd: [] }), released, GIB)).toMatchObject({ ok: true });
  });
});

describe("an admission", () => {
  it("resolves the tag, pulls by digest, checks with the base's own script, then ready", async () => {
    const { a, asked, row } = await admit();
    expect(asked).toMatchObject({ status: 202, admission: { reference: COURSE, digest: COURSE_DIGEST, state: "downloading" } });
    expect(row).toMatchObject({ state: "ready", reason: null, detail: null, baseVersion: "1.2.0", compressedBytes: 1000, diskBytes: GIB });
    expect(engine.calls).toEqual([`pull ${COURSE}`, `read ${BASE} ${BASE_CHECK_PATH}`, `start ${COURSE}`, "rm cs-test-admission-0"]);
    // The check is the base's copy, never the candidate's.
    expect(engine.scripts).toEqual([engine.checkScript]);
    expect(await a.runnable(COURSE)).toBe(true);
    expect(await a.runnable(MIRROR)).toBe(false);
  });

  it("one row per reference: two names of one digest both run, and neither rewrites the other", async () => {
    const { a } = await admit();
    const before = a.get(COURSE);
    expect(await a.request(MIRROR)).toMatchObject({ status: 202, admission: { reference: MIRROR, state: "downloading" } });
    await a.idle();
    expect(a.get(MIRROR)?.state).toBe("ready");
    expect(a.get(COURSE)).toEqual(before);
    expect(await a.runnable(COURSE)).toBe(true);
    expect(await a.runnable(MIRROR)).toBe(true);
  });

  it("never rewrites the default's row: asked as a course image, it is answered as it is", async () => {
    const a = admissions();
    await a.startup();
    const before = db.select().from(admittedImages).all();
    expect(await a.request(BASE)).toMatchObject({ status: 202, admission: { reference: BASE, state: "ready" } });
    await a.idle();
    expect(db.select().from(admittedImages).all()).toEqual(before);
    expect(before[0]?.source).toBe("default");
  });

  it("is idempotent per reference: a ready or running admission is answered as it is", async () => {
    const { a } = await admit();
    expect(await a.request(COURSE)).toMatchObject({ status: 202, admission: { state: "ready" } });
    await a.idle();
    expect(engine.calls.filter((c) => c.startsWith("pull"))).toHaveLength(1);
  });

  it("re-admits a ready image the store lost (removed by hand): a Refresh brings it back", async () => {
    const { a } = await admit();
    engine.local.delete(COURSE);
    expect(await a.runnable(COURSE)).toBe(false);
    expect(await a.request("ghcr.io/heig/lab-go:1")).toMatchObject({ status: 202, admission: { state: "downloading" } });
    await a.idle();
    expect(a.get(COURSE)?.state).toBe("ready");
    expect(engine.calls.filter((c) => c === `pull ${COURSE}`)).toHaveLength(2);
    expect(await a.runnable(COURSE)).toBe(true);
  });

  it("the 422 and 503 before any digest: not found, not public, malformed, registry down", async () => {
    const fail = new Map<string, OciError>([
      ["ghcr.io/x/private:1", new OciError("not_public", "ghcr.io/x/private: the registry asks for a credential", 401)],
      ["ghcr.io/x/arm:1", new OciError("invalid", "no linux/amd64 image in the index")],
      ["ghcr.io/x/down:1", new OciError("unavailable", "ghcr.io unreachable: ECONNREFUSED")],
    ]);
    const a = admissions({}, fakeRegistry(images, new Map(), fail));
    expect(await a.request("ghcr.io/x/none:1")).toMatchObject({ status: 422, error: { error: "not_found" } });
    // The detail is the registry's HTTP status, never the error's prose.
    expect(await a.request("ghcr.io/x/private:1")).toEqual({ status: 422, error: { error: "not_public", detail: "401" } });
    expect(await a.request("ghcr.io/x/arm:1")).toEqual({ status: 422, error: { error: "config", detail: null } });
    expect(await a.request("ghcr.io/x/down:1")).toEqual({ status: 503, error: { error: "registry_unavailable", detail: null } });
    expect(db.select().from(admittedImages).all()).toEqual([]);
  });
});

describe("its refusals: a reason, a diagnostic, and the store left as it is", () => {
  it("what the manifest decides, before any pull", async () => {
    images.set(COURSE, ociImage(COURSE, COURSE_LAYERS, { user: "root" }));
    expect((await admit()).row).toMatchObject({ state: "refused", reason: "config", detail: "User" });
    expect(engine.calls.some((c) => c.startsWith("pull"))).toBe(false);
  });

  it("not_on_base when no quiz-base is released", async () => {
    expect((await admit(undefined, { baseReleases: [] })).row).toMatchObject({ reason: "not_on_base", detail: null });
  });

  it("an unreadable release is skipped; pull_failed only when no release can be read", async () => {
    const down = (status: number) => new OciError("unavailable", `ghcr.io: HTTP ${status}`, status);
    const one = admissions({}, fakeRegistry(images, new Map(), new Map([[OLD_BASE, down(502)]])));
    await one.request(COURSE);
    await one.idle();
    expect(one.get(COURSE)).toMatchObject({ state: "ready", baseVersion: "1.2.0" });

    handle.close();
    handle = openDb(":memory:");
    db = handle.db;
    const none = admissions({}, fakeRegistry(images, new Map(), new Map([[OLD_BASE, down(502)], [BASE, down(503)]])));
    await none.request(COURSE);
    await none.idle();
    expect(none.get(COURSE)).toMatchObject({ reason: "pull_failed", detail: "503" });
  });

  it("pull_failed from the candidate's own registry read: its status only", async () => {
    const reg = fakeRegistry(images);
    const failing = { ...reg, image: async (ref: string) => (ref === COURSE ? Promise.reject(new OciError("unavailable", "ghcr.io unreachable: ETIMEDOUT")) : reg.image(ref)) };
    const a = admissions({}, failing);
    await a.request(COURSE);
    await a.idle();
    expect(a.get(COURSE)).toMatchObject({ reason: "pull_failed", detail: null });
    const gone = { ...reg, image: async (ref: string) => (ref === COURSE ? Promise.reject(new OciError("not_found", "ghcr.io/heig/lab-go: not found", 404)) : reg.image(ref)) };
    const b = admissions({}, gone);
    // Refused before: asked again, it runs again.
    await b.request(COURSE);
    await b.idle();
    expect(b.get(COURSE)).toMatchObject({ reason: "not_found", detail: "404" });
  });

  it("too_large on disk, and the pulled image stays in the store", async () => {
    engine.onPull.set(COURSE, local(COURSE_LAYERS, { sizeBytes: 5 * GIB }));
    expect((await admit()).row).toMatchObject({ reason: "too_large", detail: `${5 * GIB}>${4 * GIB}`, diskBytes: 5 * GIB });
    expect(engine.local.has(COURSE)).toBe(true);
  });

  it("disk_full: under the floor, or unknown, before any pull", async () => {
    engine.free = 10 * GIB;
    expect((await admit()).row).toMatchObject({ reason: "disk_full", detail: `${10 * GIB}<${20 * GIB}` });
    engine.free = null;
    const a = admissions();
    await a.request(COURSE);
    await a.idle();
    expect(a.get(COURSE)).toMatchObject({ reason: "disk_full", detail: null });
    expect(engine.calls.some((c) => c.startsWith("pull"))).toBe(false);
  });

  it("disk_full too before pulling a released base the store lacks", async () => {
    engine.local.delete(BASE);
    engine.free = 30 * GIB;
    const a = admissions();
    await a.request(COURSE);
    // The candidate's pull passes the floor; the base's then finds less.
    engine.onPull.set(COURSE, local(COURSE_LAYERS));
    const realPull = engine.pull.bind(engine);
    engine.pull = async (ref: string) => {
      await realPull(ref);
      engine.free = 10 * GIB;
    };
    await a.idle();
    expect(a.get(COURSE)).toMatchObject({ reason: "disk_full", detail: `${10 * GIB}<${20 * GIB}` });
    expect(engine.calls).not.toContain(`pull ${BASE}`);
  });

  it("pull_failed: the engine's last line, or a pull that brings another image", async () => {
    engine.pullFails = true;
    expect((await admit()).row).toMatchObject({ reason: "pull_failed", detail: "Error: manifest unknown" });
    engine.pullFails = false;
    engine.onPull.set(COURSE, local([L("8")]));
    const a = admissions();
    await a.request(COURSE);
    await a.idle();
    expect(a.get(COURSE)).toMatchObject({ reason: "pull_failed", detail: null });
  });

  it("contract_failed: never healthy, the check's last line, an unreadable check; the container always removed", async () => {
    engine.healthy = false;
    expect((await admit()).row).toMatchObject({ reason: "contract_failed", detail: "code-server crashed" });
    engine.healthy = true;
    engine.check = { code: 1, stdout: "ok uid\nFAIL /proxy/8000/ 200\n", stderr: "" };
    const a = admissions();
    await a.request(COURSE);
    await a.idle();
    expect(a.get(COURSE)).toMatchObject({ reason: "contract_failed", detail: "FAIL /proxy/8000/ 200" });
    expect(engine.containers.size).toBe(0);
    expect(await a.runnable(COURSE)).toBe(false);
    // The pulled image stays: the portal never removes one.
    expect(engine.local.has(COURSE)).toBe(true);

    engine.readFails = true;
    const b = admissions();
    await b.request(COURSE);
    await b.idle();
    expect(b.get(COURSE)).toMatchObject({ reason: "contract_failed", detail: null });
  });

  it("a refused image may be asked again, and then admitted", async () => {
    engine.healthy = false;
    const { a } = await admit();
    engine.healthy = true;
    await a.request(COURSE);
    await a.idle();
    expect(a.get(COURSE)?.state).toBe("ready");
  });

  it("cleans a diagnostic into one capped line", () => {
    expect(cleanDetail("a\n\u001b[31mb\t c")).toBe("a [31mb c");
    expect(cleanDetail("x".repeat(900))).toHaveLength(500);
    expect(cleanDetail("  \n")).toBeNull();
    expect(cleanDetail(null)).toBeNull();
  });
});

describe("startup", () => {
  it("refuses interrupted admissions, sweeps, demotes an earlier default and admits the current one", async () => {
    const at = new Date();
    db.insert(admittedImages)
      .values([
        { reference: COURSE, digest: COURSE_DIGEST, state: "checking", source: "course", requestedAt: at, updatedAt: at },
        { reference: OLD_BASE, digest: L("a"), state: "ready", source: "default", requestedAt: at, updatedAt: at },
      ])
      .run();
    engine.local.set(OLD_BASE, local([L("1")]));
    const a = admissions();
    await a.startup();
    expect(a.get(COURSE)).toMatchObject({ state: "refused", reason: "interrupted", detail: null });
    expect(engine.calls).toContain("sweep");
    expect(a.get(OLD_BASE)).toBeNull();
    expect(await a.runnable(OLD_BASE)).toBe(false);
    expect(db.select().from(admittedImages).all().find((r) => r.reference === BASE)).toMatchObject({ source: "default", state: "ready", digest: L("b"), baseVersion: "1.2.0", diskBytes: GIB });
    expect(await a.runnable(BASE)).toBe(true);
  });

  it("a default under a local tag: admitted by its image id; a missing default is never pulled", async () => {
    engine.local.set("codespace/c-dev:4.137.0", local([L("1")], { id: L("9") }));
    const a = admissions({ defaultImage: "codespace/c-dev:4.137.0", baseReleases: [] });
    await a.startup();
    expect(db.select().from(admittedImages).all()).toEqual([expect.objectContaining({ digest: L("9"), reference: "codespace/c-dev:4.137.0", source: "default" })]);
    expect(await a.base()).toBeNull();
    expect(await a.runnable("codespace/c-dev:4.137.0")).toBe(true);

    engine.local.delete(BASE);
    const b = admissions();
    await b.startup();
    expect(engine.calls.some((c) => c.startsWith("pull"))).toBe(false);
    // The default the store does not hold: refused at the start, not a failed `--pull=never`.
    expect(await b.runnable(BASE)).toBe(false);
  });

  it("the base: the default's digest and version, from its registry", async () => {
    expect(await admissions().base()).toEqual({ reference: BASE, digest: L("b"), version: "1.2.0" });
  });
});

describe("the store's list and the un-admission", () => {
  async function withSession(reference: string, state: "running" | "closed" = "running") {
    db.insert(users).values({ id: "u1", oidcSub: "classroom:u1", login: "u1", email: "u1@x", role: "student", createdAt: new Date() }).onConflictDoNothing().run();
    db.insert(assignments).values({ id: "lab", title: "Lab", mode: "lab", image: BASE, imageRef: reference, createdAt: new Date() }).onConflictDoNothing().run();
    const at = new Date();
    db.insert(sessions).values({ id: "s1", userId: "u1", student: "u1", assignmentId: "lab", volumeDir: "/v", state, createdAt: at, lastSeen: at, cookieToken: "t", image: reference }).run();
  }

  it("lists the default, the bases, the admitted, the orphans, and admissions gone from the store; nothing else", async () => {
    const { a } = await admit();
    await a.startup();
    engine.local.set(OLD_BASE, local([L("1")], { id: L("a") }));
    // Derived from a base, admitted by no row here: an orphan (refused, or the other instance's).
    engine.local.set(`ghcr.io/x/orphan@${L("e")}`, local([L("1"), L("5")], { id: L("e"), sizeBytes: 7 }));
    // Not a workspace image at all: the runner's.
    engine.extra.push({ id: L("f"), names: ["localhost/quiz-runner-c:1"], sizeBytes: 3, diffIds: [L("6")] });
    // Admitted, then removed from the store by hand.
    const at = new Date();
    db.insert(admittedImages).values({ reference: MIRROR, digest: COURSE_DIGEST, state: "ready", source: "course", requestedAt: at, updatedAt: at }).run();
    await withSession(COURSE);
    a.markUsed(COURSE);

    const listed = await a.list();
    const byKind = Object.fromEntries(listed.map((i) => [i.id ?? `gone:${i.admissions[0]?.reference}`, i.kind]));
    expect(byKind).toEqual({ [L("b")]: "default", [L("a")]: "base", [L("c")]: "admitted", [L("e")]: "orphan", [`gone:${MIRROR}`]: "admitted" });
    const course = listed.find((i) => i.id === L("c"));
    expect(course?.admissions).toEqual([expect.objectContaining({ reference: COURSE, source: "course", liveSessions: 1 })]);
    expect(course?.admissions[0]?.lastUsedAt).not.toBeNull();
    expect(listed.find((i) => i.id === L("b"))?.names).toEqual([BASE]);
  });

  it("un-admits only: never the default, nor while it runs here, nor during its admission; the store keeps it", async () => {
    const { a } = await admit();
    await a.startup();
    expect(await a.remove(MIRROR)).toBe("not_found");
    expect(await a.remove(BASE)).toBe("default_image");
    await withSession(COURSE);
    expect(await a.remove(COURSE)).toBe("image_in_use");
    db.update(sessions).set({ state: "closed" }).run();
    expect(await a.remove(COURSE)).toBe("removed");
    expect(a.get(COURSE)).toBeNull();
    expect(await a.runnable(COURSE)).toBe(false);
    expect(engine.local.has(COURSE)).toBe(true);

    const at = new Date();
    db.insert(admittedImages).values({ reference: MIRROR, digest: COURSE_DIGEST, state: "downloading", source: "course", requestedAt: at, updatedAt: at }).run();
    expect(await a.remove(MIRROR)).toBe("admission_running");
  });
});
