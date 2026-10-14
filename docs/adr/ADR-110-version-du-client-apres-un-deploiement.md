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
   means held: a write on the wire, or a screen that declares unsaved work
   (below), which holds the tab while that work exists. Then:
   - **the next screen.** The next move to another screen (a link,
     `navigate`, Back or Forward) is a full page load of that screen's
     address. Past a leave guard the app never full-loads: the move stays
     in the app, and a later one takes the new build.
   - **by itself, when nobody is looking.** The tab reloads its own address
     while it is hidden (after a second, for a write its blur started), or
     within 30 seconds after the update overlay closed (ADR-065's
     `platform.updating`: the reader has just watched the update). It asks
     again when the tab turns stale, when the last hold drops and when the
     tab is hidden; never while the API is away, and only once per server
     build in a tab (a per-tab marker), so a reload that comes back stale
     falls back on the next-screen rule. The reload of the same address
     keeps the page's vertical scroll, restored once the page is tall
     enough (best effort, used once).

   **Unsaved work.** A screen holds while it has work a reload would lose,
   without prompting: the question editor's draft until the server
   acknowledges it (its pending draft is now also sent when the editor
   unmounts, rather than dropped), a grading override or a re-grade note,
   a project's teacher score or a criterion's rationale, the assistant's
   composer, a pasted roster, a poll being written, a new project's form, a
   pool's description. The journal editor's leave guard holds as well, and
   prompts. Other screens commit each control as it changes (the
   evaluation configuration) or hold only a short field in a dialog (a
   rename): those rely on the write hold, and a reload can cost the field
   being typed. State kept in the browser (the notepad) survives a reload.
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
- A tab left open in the background, or watched through an update, is on
  the new build before its reader comes back to it, without a banner (one
  primary action per screen: a "new version" prompt would compete with
  it). A screen with unsaved work that declares none can still lose it to
  that reload; a new editor declares its own.

## Alternatives considered

- **Reload on reconnection.** Loses whatever the screen holds and would
  reload an exam; ADR-065 already refuses it.
- **A service worker holding the old bundle.** A second cache with its own
  update life cycle, for what a directory of kept files does.
- **The build in `/healthz`.** Names the deployed commit to anyone (L21).
- **Keep only the previous build's files.** Two deploys in one sitting
  would break the oldest tabs again.
