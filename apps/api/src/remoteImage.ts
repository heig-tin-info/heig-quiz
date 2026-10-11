/**
 * A third party's picture, fetched by the server and served from Quiz's own
 * origin, so that a viewer's browser never loads it from elsewhere and the
 * CSP admits no foreign image (N-SEC-02; audit 2026-10-10, §6): a GitHub
 * organization's avatar (`github/service.ts`) and the IdP's `picture` claim
 * (`modules/avatar.ts`). ONE policy for both, the upload's (B-19):
 *
 * - https only, to a host NAMED in public DNS: an IP literal, `localhost`
 *   and a single-label or `.local`/`.internal`/`.localhost` name are refused
 *   before any request. A public name that resolves to a private address is
 *   not caught here: an allow-list of picture hosts is the follow-up;
 * - no redirect followed, five seconds at most;
 * - at most {@link REMOTE_IMAGE_MAX_BYTES}, read capped;
 * - the BYTES decide the type, never the declared header: JPEG, PNG or WebP
 *   (`AvatarMime`), never SVG nor anything else.
 */
import { isIP } from "node:net";

import type { FastifyBaseLogger } from "fastify";

import { AvatarMime } from "@quiz/contracts";

import { readCapped } from "./cappedBody.js";
import { sniffImage } from "./modules/pool/assets.js";

export interface RemoteImage {
  bytes: Buffer;
  mime: string;
}

/** The cap of one picture: an avatar drawn at most 48 px, at 2x, is far below. */
export const REMOTE_IMAGE_MAX_BYTES = 256 * 1024;
const TYPES: ReadonlySet<string> = new Set<string>(AvatarMime.options);
const TIMEOUT_MS = 5_000;

/** Whether `hostname` (a URL's) names a machine of the public DNS: no IP literal, no local name. */
function publicName(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/^\[|\]$/g, "").replace(/\.$/, "");
  if (isIP(host) !== 0 || !host.includes(".")) return false;
  return !/(^|\.)(localhost|local|internal)$/.test(host);
}

/** The picture at `url` under the policy above, or null for anything else. */
export async function fetchImage(url: string): Promise<RemoteImage | null> {
  if (!URL.canParse(url)) return null;
  const { protocol, hostname } = new URL(url);
  if (protocol !== "https:" || !publicName(hostname)) return null;
  const res = await fetch(url, { redirect: "error", signal: AbortSignal.timeout(TIMEOUT_MS) });
  if (!res.ok) return null;
  const bytes = await readCapped(res, REMOTE_IMAGE_MAX_BYTES);
  const mime = bytes === null ? undefined : sniffImage(bytes)?.mime;
  return bytes !== null && mime !== undefined && TYPES.has(mime) ? { bytes, mime } : null;
}

/** How long a fetched picture is kept: a new one shows within a day, with no refresh job. */
const TTL_MS = 24 * 3_600_000;
/** At most this many pictures per cache, the oldest dropped first: 500 × 256 KB bounds it. */
const MAX_ENTRIES = 500;

/**
 * The pictures of one kind, in this process's memory by key: no column and
 * no migration, a restart only refetches; concurrent reads share one fetch.
 * A failure is NOT kept — the next request asks again — so a transient
 * error never hides a picture for the TTL; the price is one bounded request
 * per view of a picture that stays broken.
 */
export function remoteImageCache<K>() {
  const entries = new Map<K, { at: number; image: Promise<RemoteImage | null> }>();
  return {
    async get(key: K, url: string, now: number, log: FastifyBaseLogger): Promise<RemoteImage | null> {
      const hit = entries.get(key);
      if (hit && now - hit.at < TTL_MS) return hit.image;
      entries.delete(key);
      if (entries.size >= MAX_ENTRIES) entries.delete(entries.keys().next().value!);
      const entry = {
        at: now,
        image: fetchImage(url).catch((err: unknown) => {
          log.warn({ err }, "fetching a remote picture failed");
          return null;
        }),
      };
      entries.set(key, entry);
      const image = await entry.image;
      if (!image && entries.get(key) === entry) entries.delete(key);
      return image;
    },
    /** Test hook. */
    clear: () => entries.clear(),
  };
}
