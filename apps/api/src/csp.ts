/**
 * The Content-Security-Policy (N-SEC-02, #319) and the framing header, set by
 * the API on every response that did not choose its own policy (uploaded
 * images keep `default-src 'none'; sandbox`). The one source: Caddy sets
 * neither. Every source beyond `'self'` says which feature needs it; scripts
 * get no `'unsafe-inline'` and no `'unsafe-eval'`.
 */
import type { FastifyInstance } from "fastify";

/**
 * The Teams tab (ADR-030): Teams frames `/teams` on its own origins, so that
 * one page admits Microsoft's documented tab hosts (learn.microsoft.com,
 * "Requirements for building tabs") and no one else. Not "anyone": a sibling
 * *.chevallier.io site is same-site, so Lax cookies would reach a frame it
 * embeds.
 */
const TEAMS_HOSTS = [
  "https://teams.microsoft.com",
  "https://*.teams.microsoft.com",
  "https://*.cloud.microsoft",
  "https://*.microsoft365.com",
  "https://*.office.com",
  "https://outlook.office365.com",
];

/** The one path Teams may frame, exactly: the manifest's `contentUrl` (`router.ts`). */
const TEAMS_TAB_PATH = "/teams";

/**
 * `@microsoft/teams-js` fetches the list of valid Teams host origins from
 * Microsoft's CDN when the tab starts (it falls back to a copy of its own when
 * the fetch fails). The tab only; no other page loads teams-js.
 */
const TEAMS_VALID_DOMAINS = "https://res.cdn.office.net";

interface PageSources {
  frameAncestors: string[];
  connect: string[];
}

function policy({ frameAncestors, connect }: PageSources): string {
  const directives: Record<string, string[]> = {
    // Everything not named below: our own origin only.
    "default-src": ["'self'"],
    // `wasm-unsafe-eval`: the browser runner compiles clang, wasm-ld, Python
    // and the student's program with `WebAssembly.compile*` (ADR-015); it
    // allows WebAssembly compilation and nothing of JavaScript's eval. Zod
    // runs without its `new Function` JIT (`apps/web/src/jitless.ts`).
    "script-src": ["'self'", "'wasm-unsafe-eval'"],
    // `'unsafe-inline'`: style ATTRIBUTES and injected `<style>` elements,
    // which the app cannot avoid — KaTeX's HTML carries `style="…"`, Monaco,
    // Tiptap and MathLive inject their stylesheets at run time, and the dev
    // login page is one inline sheet. CSS cannot run script; the XSS surface
    // is `script-src`, which admits no inline code.
    "style-src": ["'self'", "'unsafe-inline'"],
    // `data:`: the fonts the bundler inlines into our CSS (KaTeX's smallest,
    // Monaco's codicon font).
    "font-src": ["'self'", "data:"],
    // `https:`: the OIDC `picture` claim is a URL on whatever host the IdP
    // chose (the avatar fallback, `modules/avatar.ts`). `blob:`: the avatar
    // editor previews the picked file (`URL.createObjectURL`). `data:`:
    // Monaco's CSS draws its squiggles and glyphs as data-URL SVGs. An image
    // cannot run script.
    "img-src": ["'self'", "data:", "blob:", "https:"],
    // Our API and its SSE stream (ADR-005), plus what one page needs.
    "connect-src": ["'self'", ...connect],
    "object-src": ["'none'"],
    "base-uri": ["'self'"],
    // The only form posts are ours (the development persona picker); the
    // OAuth consent leaves by `location.assign`, not by a form.
    "form-action": ["'self'"],
    "frame-ancestors": frameAncestors,
  };
  return Object.entries(directives)
    .map(([name, sources]) => `${name} ${sources.join(" ")}`)
    .join("; ");
}

/** The policy of every page but the Teams tab: framed by nobody but us. */
export const CSP = policy({ frameAncestors: ["'self'"], connect: [] });
/** The policy of `/teams`: the same, framable by Teams, and teams-js's one fetch. */
export const TEAMS_TAB_CSP = policy({
  frameAncestors: ["'self'", ...TEAMS_HOSTS],
  connect: [TEAMS_VALID_DOMAINS],
});

/** The CSP and the legacy framing header for a request path (query stripped). */
function securityHeaders(path: string): Record<string, string> {
  if (path === TEAMS_TAB_PATH) return { "content-security-policy": TEAMS_TAB_CSP };
  // `X-Frame-Options` for the browsers that predate `frame-ancestors`; it is
  // left off the Teams tab, where it would override the list above.
  return { "content-security-policy": CSP, "x-frame-options": "SAMEORIGIN" };
}

/** Sets the headers on every response that did not choose its own policy. */
export function registerSecurityHeaders(app: FastifyInstance): void {
  app.addHook("onSend", async (req, reply, payload) => {
    if (!reply.hasHeader("content-security-policy")) {
      const path = req.url.split("?", 1)[0] ?? "";
      for (const [name, value] of Object.entries(securityHeaders(path))) reply.header(name, value);
    }
    return payload;
  });
}
