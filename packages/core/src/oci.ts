/**
 * A public OCI image, read from its registry without a credential (ADR-146
 * §1, §5): the reference grammar the workspace accepts, the resolution of a
 * tag to its `linux/amd64` manifest's digest, and what an admission reads of
 * that manifest and its config — the layers' compressed sizes, the
 * uncompressed `rootfs.diff_ids`, `User`, `Entrypoint`, `Cmd` and labels.
 *
 * `@quiz/core/oci`, a subpath of its own like `@quiz/core/tar`: the contracts
 * validate a reference with its grammar, and the workspace portal reads
 * registries with its client. Web APIs only (`fetch`, `crypto.subtle`),
 * injectable `fetch` for the tests.
 *
 * Only two registries, GitHub Container Registry and Docker Hub, and only
 * anonymously: an answer that asks for a credential is the proof that the
 * image is not public (`not_public`), never a reason to send one. Every
 * document is checked against its digest, and capped in size: a registry is
 * a third party.
 */

/** The registries a workspace image may come from (ADR-146 §1). */
export const OCI_REGISTRIES = ["ghcr.io", "docker.io"] as const;
export type OciRegistry = (typeof OCI_REGISTRIES)[number];

/** A digest the workspace accepts: SHA-256 only. */
export const OCI_DIGEST = /^sha256:[0-9a-f]{64}$/;

/** Docker's path component, lower case: `a`, `a.b`, `a_b`, `a__b`, `a-b`. */
const COMPONENT = /^[a-z0-9]+(?:(?:[._]|__|-+)[a-z0-9]+)*$/;
const TAG = /^[A-Za-z0-9_][A-Za-z0-9_.-]{0,127}$/;
/** Docker's limit on a whole reference. */
export const OCI_REFERENCE_MAX = 255;

/** A parsed reference: one registry of {@link OCI_REGISTRIES}, a repository, a tag or a digest (a digest wins). */
export interface OciReference {
  registry: OciRegistry;
  /** `owner/name`; Docker Hub's official images under `library/`. */
  repository: string;
  /** Null when a digest pins the reference. */
  tag: string | null;
  digest: string | null;
}

/**
 * Parses a reference as `docker pull` reads it, restricted to the two
 * registries: a bare `name` or `owner/name` is Docker Hub's
 * (`docker.io/library/name`, `docker.io/owner/name`), no tag means `latest`,
 * and a digest drops the tag beside it. Null for anything else.
 */
export function parseOciReference(input: string): OciReference | null {
  if (input.length === 0 || input.length > OCI_REFERENCE_MAX || input.trim() !== input) return null;
  let rest = input;
  let digest: string | null = null;
  const at = rest.indexOf("@");
  if (at !== -1) {
    digest = rest.slice(at + 1);
    rest = rest.slice(0, at);
    if (!OCI_DIGEST.test(digest)) return null;
  }
  let tag: string | null = null;
  const lastSlash = rest.lastIndexOf("/");
  const colon = rest.lastIndexOf(":");
  if (colon > lastSlash) {
    tag = rest.slice(colon + 1);
    rest = rest.slice(0, colon);
    if (!TAG.test(tag)) return null;
  }
  const parts = rest.split("/");
  const first = parts[0] ?? "";
  let registry: string = "docker.io";
  // Docker's rule: the first component names a registry when it holds a dot or a port, or is localhost.
  if (parts.length > 1 && (first.includes(".") || first.includes(":") || first === "localhost")) {
    registry = first;
    parts.shift();
  }
  if (!(OCI_REGISTRIES as readonly string[]).includes(registry)) return null;
  if (parts.length === 0 || !parts.every((p) => COMPONENT.test(p))) return null;
  if (registry === "docker.io" && parts.length === 1) parts.unshift("library");
  return {
    registry: registry as OciRegistry,
    repository: parts.join("/"),
    tag: digest === null ? (tag ?? "latest") : null,
    digest,
  };
}

/** The canonical spelling: `registry/repository@digest`, else `registry/repository:tag`. */
export function formatOciReference(ref: OciReference): string {
  const name = `${ref.registry}/${ref.repository}`;
  return ref.digest !== null ? `${name}@${ref.digest}` : `${name}:${ref.tag ?? "latest"}`;
}

/** Why a registry read failed: what the admission turns into a refusal, or a retry. */
export type OciErrorKind =
  /** The registry says it has no such repository, tag or digest. */
  | "not_found"
  /** The registry asks for a credential: private, or (Docker Hub's answer) nonexistent. */
  | "not_public"
  /** A document the workspace cannot run: no `linux/amd64` entry, a malformed or oversized manifest, a digest mismatch. */
  | "invalid"
  /** The registry could not be reached, or answered an error of its own. */
  | "unavailable";

export class OciError extends Error {
  constructor(
    readonly kind: OciErrorKind,
    message: string,
    /** The registry's HTTP status, when it answered one: the only diagnostic worth quoting. */
    readonly status: number | null = null,
  ) {
    super(message);
    this.name = "OciError";
  }
}

/** One layer, as the manifest lists it: compressed. */
export interface OciLayer {
  digest: string;
  size: number;
}

/** What an admission reads of a `linux/amd64` image (ADR-146 §5). */
export interface OciImage {
  /** `registry/repository@digest`: the manifest's own digest. */
  reference: string;
  digest: string;
  layers: OciLayer[];
  /** The layers and the config, compressed, as the manifest declares them. */
  compressedBytes: number;
  config: OciImageConfig;
}

export interface OciImageConfig {
  architecture: string;
  os: string;
  /** The uncompressed layers' digests, in order: what identifies a base (never a label). */
  diffIds: string[];
  user: string;
  entrypoint: string[] | null;
  cmd: string[] | null;
  labels: Record<string, string>;
}

const MEDIA = {
  ociIndex: "application/vnd.oci.image.index.v1+json",
  dockerList: "application/vnd.docker.distribution.manifest.list.v2+json",
  ociManifest: "application/vnd.oci.image.manifest.v1+json",
  dockerManifest: "application/vnd.docker.distribution.manifest.v2+json",
} as const;
const ACCEPT = [MEDIA.ociIndex, MEDIA.dockerList, MEDIA.ociManifest, MEDIA.dockerManifest].join(", ");

/** A manifest or a config is a few kilobytes; this is far above, and bounded. */
export const OCI_DOCUMENT_MAX_BYTES = 4 * 1024 * 1024;

/** The API host of each registry. */
const API_HOST: Record<OciRegistry, string> = { "ghcr.io": "ghcr.io", "docker.io": "registry-1.docker.io" };
/** Where an anonymous token may be asked: the realm a registry names must be one of these. */
const TOKEN_HOSTS: ReadonlySet<string> = new Set(["ghcr.io", "auth.docker.io"]);

export interface OciClientOptions {
  fetch?: typeof fetch;
  /** Per request; 30 s by default. */
  timeoutMs?: number;
}

export interface OciClient {
  /** The `linux/amd64` manifest's digest of a reference, by tag or by digest (then checked to be amd64). */
  resolve(reference: string): Promise<{ reference: string; digest: string }>;
  /** The `linux/amd64` image a reference names: its layers, sizes and config. */
  image(reference: string): Promise<OciImage>;
}

const hex = (bytes: ArrayBuffer): string => [...new Uint8Array(bytes)].map((b) => b.toString(16).padStart(2, "0")).join("");

async function sha256(bytes: Uint8Array): Promise<string> {
  return `sha256:${hex(await crypto.subtle.digest("SHA-256", new Uint8Array(bytes)))}`;
}

/** `Bearer realm="…",service="…",scope="…"` → its parameters. */
export function parseBearerChallenge(header: string): Record<string, string> | null {
  const m = /^\s*Bearer\s+(.*)$/i.exec(header);
  if (!m?.[1]) return null;
  const params: Record<string, string> = {};
  for (const part of m[1].matchAll(/([A-Za-z_]+)="([^"]*)"/g)) params[(part[1] ?? "").toLowerCase()] = part[2] ?? "";
  return params;
}

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

function stringList(value: unknown): string[] | null {
  return Array.isArray(value) && value.every((v) => typeof v === "string") ? (value as string[]) : null;
}

function descriptor(value: unknown): OciLayer & { mediaType: string; platform: Record<string, unknown> | null } {
  const d = record(value);
  const digest = d?.["digest"];
  const size = d?.["size"];
  if (typeof digest !== "string" || !OCI_DIGEST.test(digest) || typeof size !== "number" || !Number.isSafeInteger(size) || size < 0) {
    throw new OciError("invalid", "a descriptor without a sha256 digest or a size");
  }
  return { digest, size, mediaType: typeof d?.["mediaType"] === "string" ? (d["mediaType"] as string) : "", platform: record(d?.["platform"]) };
}

/** Parses a config blob's JSON into what an admission compares. */
export function parseImageConfig(json: unknown): OciImageConfig {
  const c = record(json);
  const inner = record(c?.["config"]) ?? {};
  const rootfs = record(c?.["rootfs"]);
  const diffIds = stringList(rootfs?.["diff_ids"]);
  if (!c || !diffIds || !diffIds.every((d) => OCI_DIGEST.test(d))) throw new OciError("invalid", "a config without rootfs.diff_ids");
  const labels: Record<string, string> = {};
  for (const [k, v] of Object.entries(record(inner["Labels"]) ?? {})) if (typeof v === "string") labels[k] = v;
  return {
    architecture: typeof c["architecture"] === "string" ? c["architecture"] : "",
    os: typeof c["os"] === "string" ? c["os"] : "",
    diffIds,
    user: typeof inner["User"] === "string" ? inner["User"] : "",
    entrypoint: stringList(inner["Entrypoint"]),
    cmd: stringList(inner["Cmd"]),
    labels,
  };
}

export function createOciClient(options: OciClientOptions = {}): OciClient {
  const doFetch = options.fetch ?? fetch;
  const timeoutMs = options.timeoutMs ?? 30_000;
  /** One anonymous token per repository, until it is refused. */
  const tokens = new Map<string, string>();

  async function send(url: string, headers: Record<string, string>): Promise<Response> {
    try {
      return await doFetch(url, { headers, redirect: "manual", signal: AbortSignal.timeout(timeoutMs) });
    } catch (err) {
      throw new OciError("unavailable", `${new URL(url).host} unreachable: ${(err as Error).message ?? String(err)}`);
    }
  }

  /** The body, at most {@link OCI_DOCUMENT_MAX_BYTES}: refused past it, never read whole. */
  async function body(res: Response): Promise<Uint8Array> {
    const declared = Number(res.headers.get("content-length") ?? "0");
    if (declared > OCI_DOCUMENT_MAX_BYTES) throw new OciError("invalid", "a registry document over its cap");
    if (!res.body) return new Uint8Array(0);
    const reader = res.body.getReader();
    const chunks: Uint8Array[] = [];
    let size = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.length;
      if (size > OCI_DOCUMENT_MAX_BYTES) {
        await reader.cancel().catch(() => undefined);
        throw new OciError("invalid", "a registry document over its cap");
      }
      chunks.push(value);
    }
    const out = new Uint8Array(size);
    let at = 0;
    for (const c of chunks) {
      out.set(c, at);
      at += c.length;
    }
    return out;
  }

  function failure(res: Response, what: string): OciError {
    if (res.status === 404) return new OciError("not_found", `${what}: not found`, res.status);
    if (res.status === 401 || res.status === 403) return new OciError("not_public", `${what}: the registry asks for a credential`, res.status);
    return new OciError("unavailable", `${what}: HTTP ${res.status}`, res.status);
  }

  /** The anonymous token a 401's challenge offers, from an allowed realm only. */
  async function anonymousToken(challenge: string | null, repo: string): Promise<string> {
    const params = challenge ? parseBearerChallenge(challenge) : null;
    const realm = params?.["realm"];
    let url: URL;
    try {
      url = new URL(realm ?? "");
    } catch {
      throw new OciError("not_public", "the registry asks for a credential it does not offer anonymously");
    }
    if (url.protocol !== "https:" || !TOKEN_HOSTS.has(url.host)) throw new OciError("unavailable", `token realm ${url.host} not allowed`);
    if (params?.["service"]) url.searchParams.set("service", params["service"]);
    url.searchParams.set("scope", `repository:${repo}:pull`);
    const res = await send(url.toString(), { accept: "application/json" });
    if (!res.ok) throw failure(res, "anonymous token");
    let parsed: Record<string, unknown> | null;
    try {
      parsed = record(JSON.parse(new TextDecoder().decode(await body(res))));
    } catch (err) {
      if (err instanceof OciError) throw err;
      throw new OciError("unavailable", "the token answer is not JSON");
    }
    const token = parsed?.["token"] ?? parsed?.["access_token"];
    if (typeof token !== "string" || token === "") throw new OciError("not_public", "no anonymous token");
    return token;
  }

  /** A registry GET with the anonymous token flow; redirects followed by hand, without the token, https only. */
  async function get(ref: OciReference, path: string, accept: string): Promise<{ res: Response; bytes: Uint8Array }> {
    const key = `${ref.registry}/${ref.repository}`;
    const url = `https://${API_HOST[ref.registry]}/v2/${ref.repository}/${path}`;
    const headers = (): Record<string, string> => {
      const token = tokens.get(key);
      return { accept, ...(token ? { authorization: `Bearer ${token}` } : {}) };
    };
    let res = await send(url, headers());
    if (res.status === 401) {
      await res.body?.cancel().catch(() => undefined);
      tokens.set(key, await anonymousToken(res.headers.get("www-authenticate"), ref.repository));
      res = await send(url, headers());
      // Still refused with the anonymous token: a credential is required.
      if (res.status === 401) tokens.delete(key);
    }
    for (let hops = 0; res.status >= 300 && res.status < 400 && hops < 5; hops++) {
      const location = res.headers.get("location");
      await res.body?.cancel().catch(() => undefined);
      if (!location) throw new OciError("unavailable", "a redirect without a location");
      const next = new URL(location, url);
      if (next.protocol !== "https:") throw new OciError("unavailable", "a redirect to plain http");
      // Blob storage is signed by its URL: the registry's token never follows.
      res = await send(next.toString(), { accept });
    }
    if (!res.ok) {
      await res.body?.cancel().catch(() => undefined);
      throw failure(res, `${key} ${path}`);
    }
    return { res, bytes: await body(res) };
  }

  function json(bytes: Uint8Array): Record<string, unknown> {
    try {
      const parsed = record(JSON.parse(new TextDecoder().decode(bytes)));
      if (parsed) return parsed;
    } catch {
      // falls through
    }
    throw new OciError("invalid", "a registry document that is not a JSON object");
  }

  /** A manifest by tag or digest, its digest computed (and checked against a pinned one). */
  async function manifest(ref: OciReference, target: string): Promise<{ digest: string; doc: Record<string, unknown>; mediaType: string }> {
    const { res, bytes } = await get(ref, `manifests/${target}`, ACCEPT);
    const digest = await sha256(bytes);
    if (OCI_DIGEST.test(target) && digest !== target) throw new OciError("invalid", "the manifest does not match its digest");
    const doc = json(bytes);
    const mediaType = typeof doc["mediaType"] === "string" ? doc["mediaType"] : (res.headers.get("content-type") ?? "").split(";")[0]?.trim() ?? "";
    return { digest, doc, mediaType };
  }

  const isIndex = (m: { doc: Record<string, unknown>; mediaType: string }): boolean =>
    m.mediaType === MEDIA.ociIndex || m.mediaType === MEDIA.dockerList || (Array.isArray(m.doc["manifests"]) && !Array.isArray(m.doc["layers"]));

  /** The `linux/amd64` image manifest of a reference: an index's entry, or the manifest itself. */
  async function amd64(ref: OciReference): Promise<{ digest: string; doc: Record<string, unknown> }> {
    const top = await manifest(ref, ref.digest ?? ref.tag ?? "latest");
    if (!isIndex(top)) return top;
    const entries = (top.doc["manifests"] as unknown[]).map(descriptor);
    const entry = entries.find((e) => e.platform?.["os"] === "linux" && e.platform["architecture"] === "amd64");
    if (!entry) throw new OciError("invalid", "no linux/amd64 image in the index");
    const inner = await manifest(ref, entry.digest);
    if (isIndex(inner)) throw new OciError("invalid", "an index inside an index");
    return inner;
  }

  function parse(reference: string): OciReference {
    const ref = parseOciReference(reference);
    if (!ref) throw new OciError("invalid", "not a ghcr.io or docker.io image reference");
    return ref;
  }

  return {
    async resolve(reference) {
      const ref = parse(reference);
      const { digest } = await amd64(ref);
      return { reference: formatOciReference({ ...ref, tag: null, digest }), digest };
    },

    async image(reference) {
      const ref = parse(reference);
      const { digest, doc } = await amd64(ref);
      const layersRaw = doc["layers"];
      if (!Array.isArray(layersRaw)) throw new OciError("invalid", "an image manifest without layers");
      const layers = layersRaw.map(descriptor).map(({ digest: d, size }) => ({ digest: d, size }));
      const configDesc = descriptor(doc["config"]);
      const { bytes } = await get(ref, `blobs/${configDesc.digest}`, "application/json, */*");
      if ((await sha256(bytes)) !== configDesc.digest) throw new OciError("invalid", "the config does not match its digest");
      const config = parseImageConfig(json(bytes));
      if (config.diffIds.length !== layers.length) throw new OciError("invalid", "the config's diff_ids do not match the layers");
      return {
        reference: formatOciReference({ ...ref, tag: null, digest }),
        digest,
        layers,
        compressedBytes: layers.reduce((n, l) => n + l.size, configDesc.size),
        config,
      };
    },
  };
}
