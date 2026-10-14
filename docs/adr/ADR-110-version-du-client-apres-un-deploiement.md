# ADR-110 — The client's version after a deploy: old chunks kept, the new build taken at a safe moment

## Status

Accepted (2026-10-14, product owner decisions after a report of stale tabs).

Scope: how a browser tab opened before a deploy keeps working, learns that
the server runs a newer build, and when it may switch to it.

Relations: amends [ADR-065](ADR-065-reconnection-overlay.md), *Limits*
(asset retention, and an automatic reload outside any attempt), and the
wording of N-RES-02 ([03 §3.2](../spec/03-exigences-non-fonctionnelles.md)).
Keeps [ADR-055](ADR-055-etat-du-systeme.md) amendment L21: `/healthz` names
no build. Depends on [ADR-027](ADR-027-tickets-de-lancement-et-sessions-typees.md)
and [ADR-051](ADR-051-postes-kiosque-attestes.md) for the confined sessions.

## Context

After a hot deploy the reconnection overlay of ADR-065 clears once
`/healthz` answers, and the tab carries on with the bundle it loaded before
the deploy. Nothing compares that bundle with the server's build. A page
the old tab had not opened yet is a lazy chunk the new image no longer
holds, and the SPA fallback answered it with `index.html`: the import
crashes. `index.html` and the hashed assets had no explicit cache policy.

## Decision

1. **Old chunks are kept.** Each environment keeps the content-hashed files
   of `assets/` of the builds it served, for 30 days after the last build
   that contained them (`STATIC_HISTORY_DIR`, a volume of the `app`
   container). The API serves a file of `assets/` from the current build,
   else from that history. A file found in neither is a 404, never
   `index.html`. A failure to keep the history is logged and never stops
   the boot.
2. **Cache policy.** `index.html` is `no-cache` (revalidated on every load),
   the files of `assets/` are `public, max-age=31536000, immutable` (their
   name is their content). Other static files keep the default.
3. **The build is told to signed-in callers only.** The API's answers under
   its prefixes to a request with a session user carry `x-quiz-build: <commit>`
   when the image knows its commit. `/healthz` and every signed-out answer
   stay as they are (L21).
4. **Stale.** A tab is stale when that header names another commit than the
   one it was built from (both known), or when one of its chunks fails to
   load.
5. **When a stale tab may load the new build.** Never during an attempt —
   an exam, an exercise, the drill, a poll, whatever the session type — and
   never in a `seb` or `kiosk` session: there the old client runs on, on
   the kept chunks. Elsewhere, only when nothing is pending, and pending
   means held: a write on the wire, or a screen behind its leave guard,
   which holds the tab until it unmounts. Unsaved work that no leave guard
   declares is not seen (the question editor's debounced draft, until it
   registers one). Where the client can know that nothing is held, it may
   reload by itself; otherwise its next move to another screen (a link,
   `navigate`, Back or Forward) is a full page load of that screen's
   address. Past a leave guard the app never full-loads: the move stays in
   the app, and a later one takes the new build.
6. **A page whose chunk is missing.** Where 5 allows it, the tab loads the
   same address once, after the holds are released (a per-tab marker
   prevents a loop; past it, the crash screen). The rule reads the page
   being opened: on a page where the student answers, or in a confined
   session, a translated message offers the reload, which the reader
   triggers — so a missing chunk on the way into an attempt ends on that
   message too.

The reconnection overlay itself is unchanged: after `platform.updating`
the next signed-in answer tells the tab it is stale.

## Consequences

- An open tab survives a deploy without a white page, and moves to the new
  build at the next screen change outside an attempt.
- The history costs disk: about 20 MB per build whose chunks all changed,
  for 30 days. It is a cache, not backed up; the first deploy that creates
  it only covers the tabs of later builds.
- Frontend/backend compatibility across one deploy is still required: an
  old client keeps talking to the new API until it moves (ADR-065, *Limits*).
- A spontaneous reload of a clean screen, and the registry of unsaved work
  it needs on the teacher editors, are allowed by 5 but delivered
  separately.

## Alternatives considered

- **Reload on reconnection.** Loses whatever the screen holds and would
  reload an exam; ADR-065 already refuses it.
- **A service worker holding the old bundle.** A second cache with its own
  update life cycle, for what a directory of kept files does.
- **The build in `/healthz`.** Names the deployed commit to anyone (L21).
- **Keep only the previous build's files.** Two deploys in one sitting
  would break the oldest tabs again.
