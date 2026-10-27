/**
 * A graded run's `results` artifact (ADR-119 §6), read through the App
 * (`actions: read`, a permission it already holds): GitHub answers the
 * download with a redirect to a signed blob URL whose `sig=` and `se=` are
 * a credential. That URL is never logged, stored nor put in an error: it
 * lives in this file's locals only, every failure's message passes through
 * `redactTokens` (which knows `sig=`) with any URL removed, and it is
 * fetched without credentials and without following a further redirect.
 *
 * The archive is read under budgets, never trusted: the download capped at
 * {@link ARTIFACT_MAX_BYTES}; exactly ONE entry, `results.json` at the
 * root — no directory, no `..`, no absolute path, no link, no encryption,
 * stored or deflated only —; its inflation counted while it runs and
 * stopped past `RESULTS_FILE_MAX_BYTES` (a zip bomb ends there). Anything
 * else is `refused`: the pass's reason `no_result`, never an exception.
 *
 * Not fflate's `unzipSync`: it inflates to the size the entry's header
 * declares, which a zip bomb lies about; this reader counts while inflating.
 */
import { inflateRawSync } from "node:zlib";

import type { Octokit } from "octokit";

import { RESULTS_FILE_MAX_BYTES } from "@quiz/domain";

import { readCapped } from "../cappedBody.js";
import { redactTokens } from "../redact.js";

/** The artifact a graded run uploads. */
export const ARTIFACT_NAME = "results";
/** Its one entry. */
export const RESULTS_ENTRY = "results.json";
/** The zip downloaded, at most (choice g). */
export const ARTIFACT_MAX_BYTES = 1024 * 1024;
const DOWNLOAD_TIMEOUT_MS = 60_000;

/** GitHub, or the blob store, failing: a message without any URL nor credential. */
export class ArtifactUnavailable extends Error {
  constructor(what: string) {
    super(`the run's artifact could not be read: ${redactTokens(what).replace(/https?:\/\/\S+/g, "<url>")}`);
    this.name = "ArtifactUnavailable";
  }
}

const messageOf = (err: unknown) => (err instanceof Error ? err.message : String(err));
const statusOf = (err: unknown) => (err as { status?: unknown } | null)?.status;

/**
 * The `results.json` bytes of run `runId`'s `results` artifact: `absent`
 * when the run has none (or several, or it expired), `refused` when the
 * archive breaks a rule above. GitHub or the blob store failing throws
 * {@link ArtifactUnavailable}: the caller tries again (a webhook's retry,
 * the reconciliation), until the 24 h settle the pass.
 */
export async function fetchResultsArtifact(octokit: Octokit, owner: string, repo: string, runId: number): Promise<Uint8Array | "absent" | "refused"> {
  let artifacts: { id: number; name: string; expired: boolean; size_in_bytes: number }[];
  try {
    const { data } = await octokit.request("GET /repos/{owner}/{repo}/actions/runs/{run_id}/artifacts", {
      owner,
      repo,
      run_id: runId,
      name: ARTIFACT_NAME,
      per_page: 10,
      request: { retries: 0 },
    });
    artifacts = data.artifacts.filter((a) => a.name === ARTIFACT_NAME && !a.expired);
  } catch (err) {
    throw new ArtifactUnavailable(`GitHub answered ${String(statusOf(err) ?? messageOf(err))}`);
  }
  if (artifacts.length !== 1) return "absent";
  const [artifact] = artifacts as [(typeof artifacts)[number]];
  if (artifact.size_in_bytes > ARTIFACT_MAX_BYTES) return "refused";
  let location: string | undefined;
  try {
    const res = await octokit.request("GET /repos/{owner}/{repo}/actions/artifacts/{artifact_id}/{archive_format}", {
      owner,
      repo,
      artifact_id: artifact.id,
      archive_format: "zip",
      request: { redirect: "manual", parseSuccessResponseBody: false, retries: 0 },
    });
    await (res.data as unknown as ReadableStream | null)?.cancel().catch(() => undefined);
    location = res.headers.location;
  } catch (err) {
    // 410: expired meanwhile — nothing left to read.
    if (statusOf(err) === 410) return "absent";
    throw new ArtifactUnavailable(`GitHub answered ${String(statusOf(err) ?? messageOf(err))}`);
  }
  const zip = await download(blobUrl(location));
  return zip === null ? "refused" : unzipResults(zip);
}

/** The redirect's target, over HTTPS only. */
function blobUrl(location: string | undefined): string {
  let url: URL;
  try {
    url = new URL(location ?? "");
  } catch {
    throw new ArtifactUnavailable("no redirect to follow");
  }
  if (url.protocol !== "https:") throw new ArtifactUnavailable("a redirect off HTTPS");
  return url.href;
}

/** The zip at the signed `url`, without credentials, never following further; null past the cap. */
async function download(url: string): Promise<Buffer | null> {
  let res: Response;
  try {
    res = await fetch(url, { redirect: "error", signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS) });
  } catch (err) {
    throw new ArtifactUnavailable(messageOf(err));
  }
  if (!res.ok || res.body === null) {
    await res.body?.cancel().catch(() => undefined);
    throw new ArtifactUnavailable(`the download answered ${res.status}`);
  }
  return readCapped(res, ARTIFACT_MAX_BYTES).catch((err: unknown) => {
    throw new ArtifactUnavailable(messageOf(err));
  });
}

const EOCD = 0x06054b50;
const CENTRAL = 0x02014b50;
const LOCAL = 0x04034b50;
/** The unix file type bits of an entry's external attributes, and a regular file's. */
const S_IFMT = 0o170000;
const S_IFREG = 0o100000;

/**
 * The bytes of the zip's one entry, `results.json`, or `refused`: not a zip
 * (or a ZIP64 one), any number of entries but one, another name (a
 * directory, a path, `..`), a link or any non-regular file, an encrypted
 * entry, a method other than stored or deflated, an entry out of the
 * archive's bounds, or an inflation past `RESULTS_FILE_MAX_BYTES` — counted
 * while inflating, so a bomb stops there.
 */
export function unzipResults(zip: Uint8Array): Uint8Array | "refused" {
  const buf = Buffer.from(zip.buffer, zip.byteOffset, zip.byteLength);
  // The end of central directory: 22 bytes, then a comment of at most 65535.
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 22 - 0xffff); i--) {
    if (buf.readUInt32LE(i) === EOCD) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) return "refused";
  const entries = buf.readUInt16LE(eocd + 10);
  const cdOffset = buf.readUInt32LE(eocd + 16);
  // One entry; a ZIP64 marker (0xffff…) is refused with it.
  if (entries !== 1 || buf.readUInt16LE(eocd + 8) !== 1 || cdOffset + 46 > eocd) return "refused";
  if (buf.readUInt32LE(cdOffset) !== CENTRAL) return "refused";
  const madeBy = buf.readUInt16LE(cdOffset + 4);
  const flags = buf.readUInt16LE(cdOffset + 8);
  const method = buf.readUInt16LE(cdOffset + 10);
  const compressed = buf.readUInt32LE(cdOffset + 20);
  const nameLength = buf.readUInt16LE(cdOffset + 28);
  const attributes = buf.readUInt32LE(cdOffset + 38);
  const localOffset = buf.readUInt32LE(cdOffset + 42);
  if (cdOffset + 46 + nameLength > eocd) return "refused";
  const name = buf.toString("latin1", cdOffset + 46, cdOffset + 46 + nameLength);
  if (name !== RESULTS_ENTRY || (flags & 0x1) !== 0 || (method !== 0 && method !== 8)) return "refused";
  // Unix attributes (made by host 3): a regular file only — a symbolic link, a device, a directory are refused.
  const type = (attributes >>> 16) & S_IFMT;
  if (madeBy >> 8 === 3 && type !== 0 && type !== S_IFREG) return "refused";
  if (localOffset + 30 > cdOffset || buf.readUInt32LE(localOffset) !== LOCAL) return "refused";
  const localName = buf.toString("latin1", localOffset + 30, localOffset + 30 + buf.readUInt16LE(localOffset + 26));
  if (localName !== RESULTS_ENTRY) return "refused";
  const start = localOffset + 30 + buf.readUInt16LE(localOffset + 26) + buf.readUInt16LE(localOffset + 28);
  if (start + compressed > cdOffset) return "refused";
  const data = buf.subarray(start, start + compressed);
  if (method === 0) return data.length > RESULTS_FILE_MAX_BYTES ? "refused" : new Uint8Array(data);
  try {
    return new Uint8Array(inflateRawSync(data, { maxOutputLength: RESULTS_FILE_MAX_BYTES }));
  } catch {
    // Past the budget (a RangeError) or not a deflate stream: either way no result.
    return "refused";
  }
}
