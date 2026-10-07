/**
 * Verification of the SEB provenance, on `/launch` in exam mode and nowhere
 * else.
 *
 * The hashes and the header names are `@quiz/seb`'s (D21, merge task M6-07):
 * the platform builds every `.seb`, and this portal keeps only the check it
 * still needs. Two implementations behind one interface: `real`, which
 * checks the headers SEB adds, and `simulated`, which accepts a development
 * header and which `createSebVerifier` refuses to build in production
 * (invariant 5 of this portal's `CLAUDE.md`).
 *
 * - The Config Key is the one of the student's own `.seb`, which the platform
 *   signs into the launch token's `seb` claim (the file carries the
 *   student's one-time ticket, so every student's key differs).
 * - The Browser Exam Keys are optional per assignment (D21 point 5): an
 *   empty list means the Config Key alone, the platform's default; a
 *   non-empty one demands `X-SafeExamBrowser-RequestHash` for one of them.
 *
 * References:
 *   [SPEC-CK] https://safeexambrowser.org/developer/seb-config-key.html
 *             « the LMS creates a SHA256 hash value from the absolute URL
 *             without Fragment part with appended Config Key hash string »
 *   [SPEC-IN] https://safeexambrowser.org/developer/seb-integration.html
 *             (Browser Exam Key, one BEK per platform and per version)
 *   [AM]      mod/quiz/accessrule/seb/classes/seb_access_manager.php
 *             `check_key()`, `check_browser_exam_keys()`
 *
 * Invariant 6 of this portal's `CLAUDE.md`: nothing but `/launch` ever reads
 * a SEB header. The proxy to code-server only knows the cookie of
 * examSession.ts.
 */
import {
  CONFIG_KEY_HEADER,
  REQUEST_HASH_HEADER,
  anyKeyMatches,
  expectedHash,
  hashesEqual,
} from "@quiz/seb";

export { CONFIG_KEY_HEADER, REQUEST_HASH_HEADER, expectedHash, hashesEqual };
export const DEV_HEADER = "x-dev-seb";

/** What the verifier needs to know about an HTTP request. */
export interface SebRequestFacts {
  /** Path and query as received, for instance `/launch?token=…`. */
  readonly url: string;
  /** Headers in lower case, the way Fastify and Node expose them. */
  readonly headers: Readonly<Record<string, string | string[] | undefined>>;
}

/** The keys a launch is checked against. */
export interface AssignmentSebKeys {
  /** The Config Key of the student's `.seb` (the launch token's `seb` claim). */
  readonly configKey: string;
  /** One Browser Exam Key per (platform, version) pair; empty: the Config Key alone. */
  readonly beks: readonly string[];
}

export type SebRefusal =
  | "url-unreconstructible"
  | "missing-config-key-header"
  | "missing-request-hash-header"
  | "config-key-mismatch"
  | "browser-exam-key-mismatch"
  | "missing-dev-header";

export type SebVerdict =
  | { readonly ok: true; readonly url: string }
  | { readonly ok: false; readonly reason: SebRefusal; readonly url: string | null };

export interface SebVerifier {
  readonly mode: "real" | "simulated";
  verifyStart(req: SebRequestFacts, keys: AssignmentSebKeys): SebVerdict;
}

// --- Reconstruction of the absolute URL ------------------------------------

/**
 * SEB hashes the **absolute URL the browser asked for**, without the fragment.
 * Behind a TLS front end, Node only sees the path and a `Host` that may be the
 * front end's as well as the backend's; so it has to be reconstructed.
 *
 * - `publicOrigin`: a fixed origin (`https://codespace.heig-vd.ch`). That is
 *   the safe setting in production: nothing the client sends enters the
 *   computation, so nothing can be tampered with.
 * - `trustForwarded`: read `X-Forwarded-Proto` and `X-Forwarded-Host`. Only to
 *   be turned on when the front end rewrites them systematically, otherwise a
 *   client picks the origin in place of the portal.
 * - otherwise: `Host` and the default protocol.
 */
export interface RequestUrlOptions {
  readonly publicOrigin?: string;
  readonly trustForwarded?: boolean;
  readonly defaultProtocol?: "http" | "https";
}

function firstHeader(
  headers: SebRequestFacts["headers"],
  name: string,
): string | undefined {
  const raw = headers[name];
  if (raw === undefined) return undefined;
  const value = Array.isArray(raw) ? raw[0] : raw;
  if (value === undefined) return undefined;
  const trimmed = value.trim();
  return trimmed === "" ? undefined : trimmed;
}

/**
 * A browser never sends the fragment; it is stripped anyway, so that the
 * hashed value stays the one of the specification should an exotic client send
 * one.
 */
function stripFragment(url: string): string {
  const hash = url.indexOf("#");
  return hash < 0 ? url : url.slice(0, hash);
}

/** Reconstructs the absolute URL without the fragment, or `null` if impossible. */
export function absoluteRequestUrl(
  req: SebRequestFacts,
  options: RequestUrlOptions = {},
): string | null {
  const target = stripFragment(req.url);
  if (options.publicOrigin !== undefined && options.publicOrigin !== "") {
    return new URL(target, options.publicOrigin).toString();
  }
  const forwardedHost = options.trustForwarded === true
    ? firstHeader(req.headers, "x-forwarded-host")
    : undefined;
  const host = forwardedHost ?? firstHeader(req.headers, "host");
  if (host === undefined) return null;
  const forwardedProto = options.trustForwarded === true
    ? firstHeader(req.headers, "x-forwarded-proto")
    : undefined;
  // "https, http" when several front ends have added themselves: the first
  // one is the one that talked to the client.
  const proto = (forwardedProto?.split(",")[0]?.trim() ?? options.defaultProtocol ?? "https");
  if (proto !== "http" && proto !== "https") return null;
  try {
    return new URL(target, `${proto}://${host}`).toString();
  } catch {
    return null;
  }
}

// --- Implementations -------------------------------------------------------

class RealSebVerifier implements SebVerifier {
  readonly mode = "real" as const;
  constructor(private readonly urlOptions: RequestUrlOptions) {}

  verifyStart(req: SebRequestFacts, keys: AssignmentSebKeys): SebVerdict {
    const url = absoluteRequestUrl(req, this.urlOptions);
    if (url === null) return { ok: false, reason: "url-unreconstructible", url: null };

    const configKeyHash = firstHeader(req.headers, CONFIG_KEY_HEADER);
    if (configKeyHash === undefined) {
      return { ok: false, reason: "missing-config-key-header", url };
    }
    if (!hashesEqual(expectedHash(url, keys.configKey), configKeyHash)) {
      return { ok: false, reason: "config-key-mismatch", url };
    }
    // D21 point 5: no Browser Exam Key recorded is the Config Key alone.
    if (keys.beks.length === 0) return { ok: true, url };
    const requestHash = firstHeader(req.headers, REQUEST_HASH_HEADER);
    if (requestHash === undefined) {
      return { ok: false, reason: "missing-request-hash-header", url };
    }
    // [AM:check_browser_exam_keys]: at least one of the accepted BEKs, every
    // one compared (`anyKeyMatches`), so the duration does not tell which.
    if (!anyKeyMatches(url, keys.beks, requestHash)) {
      return { ok: false, reason: "browser-exam-key-mismatch", url };
    }
    return { ok: true, url };
  }
}

class SimulatedSebVerifier implements SebVerifier {
  readonly mode = "simulated" as const;
  constructor(private readonly urlOptions: RequestUrlOptions) {}

  verifyStart(req: SebRequestFacts, _keys: AssignmentSebKeys): SebVerdict {
    const url = absoluteRequestUrl(req, this.urlOptions);
    if (url === null) return { ok: false, reason: "url-unreconstructible", url: null };
    if (firstHeader(req.headers, DEV_HEADER) !== "ok") {
      return { ok: false, reason: "missing-dev-header", url };
    }
    return { ok: true, url };
  }
}

export interface SebVerifierConfig {
  readonly mode: "real" | "simulated";
  /** Passed explicitly rather than read here: the configuration is validated at startup. */
  readonly nodeEnv: string;
  readonly url?: RequestUrlOptions;
}

export class SebConfigurationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SebConfigurationError";
  }
}

/**
 * Invariant 5 of this portal's `CLAUDE.md`: the `simulated` mode is
 * impossible under `NODE_ENV=production`. The refusal is an exception at
 * startup, not a silent fallback to `real`: a misconfigured production must
 * fail to start.
 */
export function createSebVerifier(config: SebVerifierConfig): SebVerifier {
  if (config.mode === "simulated" && config.nodeEnv === "production") {
    throw new SebConfigurationError(
      "SEB_VERIFIER=simulated is forbidden when NODE_ENV=production",
    );
  }
  const urlOptions = config.url ?? {};
  return config.mode === "real"
    ? new RealSebVerifier(urlOptions)
    : new SimulatedSebVerifier(urlOptions);
}
