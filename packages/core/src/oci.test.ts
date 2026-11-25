import { createHash } from "node:crypto";

import { describe, expect, it } from "vitest";

import {
  OCI_DOCUMENT_MAX_BYTES,
  OciError,
  createOciClient,
  formatOciReference,
  parseBearerChallenge,
  parseImageConfig,
  parseOciReference,
} from "./oci.js";

const D = (c: string) => `sha256:${c.repeat(64)}`;
const digestOf = (text: string) => `sha256:${createHash("sha256").update(text).digest("hex")}`;

describe("parseOciReference", () => {
  it("normalizes Docker Hub short names, defaults the tag, keeps a digest over a tag", () => {
    expect(parseOciReference("debian")).toEqual({ registry: "docker.io", repository: "library/debian", tag: "latest", digest: null });
    expect(parseOciReference("owner/img:1.2")).toEqual({ registry: "docker.io", repository: "owner/img", tag: "1.2", digest: null });
    expect(parseOciReference(`ghcr.io/heig-tin-info/quiz-base:1.0.0@${D("a")}`)).toEqual({
      registry: "ghcr.io",
      repository: "heig-tin-info/quiz-base",
      tag: null,
      digest: D("a"),
    });
    expect(parseOciReference("docker.io/library/debian:12")?.repository).toBe("library/debian");
  });

  it("refuses another registry, a bad component, tag or digest, and an oversized reference", () => {
    for (const bad of [
      "",
      " debian",
      "quay.io/a/b",
      "localhost/a",
      "registry.example:5000/a/b",
      "Owner/img",
      "a//b",
      "a/b:",
      "a/b:-x",
      "a/b@sha256:abc",
      `a/b@sha512:${"a".repeat(128)}`,
      `a/${"b".repeat(300)}`,
    ]) {
      expect(parseOciReference(bad), bad).toBeNull();
    }
  });

  it("formats the canonical spelling", () => {
    expect(formatOciReference(parseOciReference("debian")!)).toBe("docker.io/library/debian:latest");
    expect(formatOciReference(parseOciReference(`owner/x:1@${D("b")}`)!)).toBe(`docker.io/owner/x@${D("b")}`);
  });
});

describe("parseBearerChallenge and parseImageConfig", () => {
  it("reads a challenge's parameters", () => {
    expect(parseBearerChallenge('Bearer realm="https://ghcr.io/token",service="ghcr.io",scope="repository:a/b:pull"')).toEqual({
      realm: "https://ghcr.io/token",
      service: "ghcr.io",
      scope: "repository:a/b:pull",
    });
    expect(parseBearerChallenge("Basic realm=x")).toBeNull();
  });

  it("reads the fields an admission compares, and refuses a config without diff_ids", () => {
    const config = parseImageConfig({
      architecture: "amd64",
      os: "linux",
      config: { User: "1000", Entrypoint: ["/e"], Cmd: null, Labels: { a: "1", n: 2 } },
      rootfs: { type: "layers", diff_ids: [D("1")] },
    });
    expect(config).toEqual({ architecture: "amd64", os: "linux", diffIds: [D("1")], user: "1000", entrypoint: ["/e"], cmd: null, labels: { a: "1" } });
    expect(parseImageConfig({ rootfs: { diff_ids: [] } }).user).toBe("");
    expect(() => parseImageConfig({ rootfs: {} })).toThrow(OciError);
    expect(() => parseImageConfig({ rootfs: { diff_ids: ["md5:x"] } })).toThrow(OciError);
    expect(() => parseImageConfig("x")).toThrow(OciError);
  });
});

// --- a fake registry -----------------------------------------------------------------

interface Route {
  status?: number;
  body?: string;
  headers?: Record<string, string>;
}

/** A registry answering `routes` by URL; `auth` requires the anonymous token on /v2/ URLs. */
function registry(routes: Record<string, Route>, opts: { auth?: boolean; refuseToken?: boolean } = {}) {
  const calls: Array<{ url: string; authorization: string | null }> = [];
  const fake = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = String(input);
    const headers = new Headers(init?.headers);
    calls.push({ url, authorization: headers.get("authorization") });
    if (url.startsWith("https://ghcr.io/token") || url.startsWith("https://auth.docker.io/token")) {
      if (opts.refuseToken) return new Response("denied", { status: 403 });
      return Response.json({ token: "anon" });
    }
    if (opts.auth && url.includes("/v2/") && headers.get("authorization") !== "Bearer anon") {
      return new Response("", {
        status: 401,
        headers: { "www-authenticate": 'Bearer realm="https://ghcr.io/token",service="ghcr.io",scope="x"' },
      });
    }
    const route = routes[url];
    if (!route) return new Response("{}", { status: 404 });
    return new Response(route.body ?? "", { status: route.status ?? 200, headers: route.headers ?? {} });
  };
  return { fetch: fake as typeof fetch, calls };
}

function image(diffIds: string[], extra: Record<string, unknown> = {}) {
  const config = JSON.stringify({ architecture: "amd64", os: "linux", config: { User: "student" }, rootfs: { type: "layers", diff_ids: diffIds }, ...extra });
  const manifest = JSON.stringify({
    schemaVersion: 2,
    mediaType: "application/vnd.oci.image.manifest.v1+json",
    config: { mediaType: "application/vnd.oci.image.config.v1+json", digest: digestOf(config), size: config.length },
    layers: diffIds.map((_, i) => ({ mediaType: "application/vnd.oci.image.layer.v1.tar+gzip", digest: D(String(i)), size: 100 * (i + 1) })),
  });
  return { config, manifest, configDigest: digestOf(config), digest: digestOf(manifest) };
}

const BASE = "https://ghcr.io/v2/org/img";

describe("createOciClient", () => {
  it("resolves a tag through an index to its amd64 manifest, with an anonymous token", async () => {
    const img = image([D("a"), D("b")]);
    const index = JSON.stringify({
      mediaType: "application/vnd.oci.image.index.v1+json",
      manifests: [
        { digest: D("e"), size: 1, platform: { os: "linux", architecture: "arm64" } },
        { digest: img.digest, size: img.manifest.length, platform: { os: "linux", architecture: "amd64" } },
      ],
    });
    const reg = registry(
      {
        [`${BASE}/manifests/1.0`]: { body: index },
        [`${BASE}/manifests/${img.digest}`]: { body: img.manifest },
        [`${BASE}/blobs/${img.configDigest}`]: { status: 307, headers: { location: "https://blobs.example/c?sig=x" } },
        "https://blobs.example/c?sig=x": { body: img.config },
      },
      { auth: true },
    );
    const client = createOciClient({ fetch: reg.fetch });
    expect(await client.resolve("ghcr.io/org/img:1.0")).toEqual({ reference: `ghcr.io/org/img@${img.digest}`, digest: img.digest });
    const read = await client.image(`ghcr.io/org/img@${img.digest}`);
    expect(read.digest).toBe(img.digest);
    expect(read.config.diffIds).toEqual([D("a"), D("b")]);
    expect(read.compressedBytes).toBe(100 + 200 + img.config.length);
    // The blob storage never sees the registry's token.
    expect(reg.calls.find((c) => c.url.startsWith("https://blobs.example"))?.authorization).toBeNull();
    expect(reg.calls.filter((c) => c.url.includes("/token")).length).toBe(1);
  });

  it("reads Docker Hub on registry-1.docker.io", async () => {
    const img = image([D("a")]);
    const reg = registry({
      "https://registry-1.docker.io/v2/library/debian/manifests/latest": { body: img.manifest },
    });
    expect((await createOciClient({ fetch: reg.fetch }).resolve("debian")).reference).toBe(`docker.io/library/debian@${img.digest}`);
  });

  it("maps the registry's answers to the refusals", async () => {
    const kind = async (p: Promise<unknown>) => p.then(() => "ok", (e: unknown) => (e instanceof OciError ? e.kind : String(e)));
    const client = (routes: Record<string, Route>, o = {}) => createOciClient({ fetch: registry(routes, o).fetch });
    expect(await kind(client({}).resolve("ghcr.io/org/img:1"))).toBe("not_found");
    expect(await kind(client({}, { auth: true, refuseToken: true }).resolve("ghcr.io/org/img:1"))).toBe("not_public");
    expect(await kind(client({ [`${BASE}/manifests/1`]: { status: 401 } }).resolve("ghcr.io/org/img:1"))).toBe("not_public");
    expect(await kind(client({ [`${BASE}/manifests/1`]: { status: 500 } }).resolve("ghcr.io/org/img:1"))).toBe("unavailable");
    // The registry's status travels with the error; a failure without an answer has none.
    const status = async (p: Promise<unknown>) => p.then(() => "ok", (e: unknown) => (e instanceof OciError ? e.status : String(e)));
    expect(await status(client({ [`${BASE}/manifests/1`]: { status: 500 } }).resolve("ghcr.io/org/img:1"))).toBe(500);
    expect(await status(client({}).resolve("ghcr.io/org/img:1"))).toBe(404);
    expect(await status(client({}).resolve("quay.io/a/b"))).toBeNull();
    expect(await kind(client({ [`${BASE}/manifests/1`]: { body: "[]" } }).resolve("ghcr.io/org/img:1"))).toBe("invalid");
    expect(await kind(client({}).resolve("quay.io/a/b"))).toBe("invalid");
    // A pinned digest the body does not match.
    expect(await kind(client({ [`${BASE}/manifests/${D("f")}`]: { body: "{}" } }).resolve(`ghcr.io/org/img@${D("f")}`))).toBe("invalid");
    // An index without amd64.
    const arm = JSON.stringify({ mediaType: "application/vnd.oci.image.index.v1+json", manifests: [{ digest: D("e"), size: 1, platform: { os: "linux", architecture: "arm64" } }] });
    expect(await kind(client({ [`${BASE}/manifests/1`]: { body: arm } }).resolve("ghcr.io/org/img:1"))).toBe("invalid");
    // Oversized, declared.
    expect(await kind(client({ [`${BASE}/manifests/1`]: { body: "{}", headers: { "content-length": String(OCI_DOCUMENT_MAX_BYTES + 1) } } }).resolve("ghcr.io/org/img:1"))).toBe("invalid");
    // Unreachable.
    const down = createOciClient({ fetch: (async () => { throw new Error("ECONNREFUSED"); }) as typeof fetch });
    expect(await kind(down.resolve("ghcr.io/org/img:1"))).toBe("unavailable");
  });

  it("refuses a config that does not match its digest, a redirect to http, and a realm elsewhere", async () => {
    const img = image([D("a")]);
    const kind = async (p: Promise<unknown>) => p.then(() => "ok", (e: unknown) => (e instanceof OciError ? e.kind : String(e)));
    const tampered = registry({
      [`${BASE}/manifests/${img.digest}`]: { body: img.manifest },
      [`${BASE}/blobs/${img.configDigest}`]: { body: img.config.replace("student", "root") },
    });
    expect(await kind(createOciClient({ fetch: tampered.fetch }).image(`ghcr.io/org/img@${img.digest}`))).toBe("invalid");
    const http = registry({
      [`${BASE}/manifests/${img.digest}`]: { body: img.manifest },
      [`${BASE}/blobs/${img.configDigest}`]: { status: 302, headers: { location: "http://blobs.example/c" } },
    });
    expect(await kind(createOciClient({ fetch: http.fetch }).image(`ghcr.io/org/img@${img.digest}`))).toBe("unavailable");
    const elsewhere = (async (input: string | URL | Request) => {
      if (String(input).startsWith("https://evil.example")) return Response.json({ token: "x" });
      return new Response("", { status: 401, headers: { "www-authenticate": 'Bearer realm="https://evil.example/t"' } });
    }) as typeof fetch;
    expect(await kind(createOciClient({ fetch: elsewhere }).resolve("ghcr.io/org/img:1"))).toBe("unavailable");
    const noRealm = (async () => new Response("", { status: 401 })) as typeof fetch;
    expect(await kind(createOciClient({ fetch: noRealm }).resolve("ghcr.io/org/img:1"))).toBe("not_public");
  });

  it("refuses a manifest whose layers and diff_ids disagree", async () => {
    const img = image([D("a")]);
    const config = JSON.stringify({ architecture: "amd64", os: "linux", rootfs: { diff_ids: [D("a"), D("b")] } });
    const manifest = img.manifest.replace(img.configDigest, digestOf(config));
    const reg = registry({
      [`${BASE}/manifests/${digestOf(manifest)}`]: { body: manifest },
      [`${BASE}/blobs/${digestOf(config)}`]: { body: config },
    });
    await expect(createOciClient({ fetch: reg.fetch }).image(`ghcr.io/org/img@${digestOf(manifest)}`)).rejects.toThrow(/diff_ids/);
  });
});
