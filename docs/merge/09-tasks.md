# 9. Task cards

One card = one branch = one PR. Ids are `M<phase>-<nn>`; `L-<nn>` are
after the merge. `‖` = can run in parallel with the tasks named. Section
references (§3.1…) point into this folder.

The cards of the tasks `done` or `dropped` in [`PROGRESS.md`](PROGRESS.md)
are in [`history/09-tasks-delivered.md`](history/09-tasks-delivered.md),
under the same headings and anchors; this file keeps the open ones.

## The brief to hand to an agent

Replace `<ID>` and paste as the agent's prompt; the card carries the rest.

> You implement task **<ID>** of the heig-classroom → Quiz merge (ADR-035).
> Read, in this order: `CLAUDE.md`, `AGENTS.md`, `docs/merge/README.md`,
> the row of <ID> in `docs/merge/PROGRESS.md` and its handoff notes, the
> card <ID> in `docs/merge/09-tasks.md`, the sections it references, and the
> decisions it depends on in `docs/merge/08-decisions.md` (stop if one is
> `open`). Classroom's code is read in a detached reference checkout (see
> README "Sources"); never edit `~/heig-classroom`.
> Work in a worktree on branch `merge/<ID>-<slug>`. First commit: set <ID>
> to `in progress` in `PROGRESS.md` with your branch; push; open a **draft**
> PR titled `<ID>: …` whose body has a **State** section (done / next /
> blocked) that you update at every push. Follow `/feature`: plan,
> implement, run `lean-reviewer` and `invariant-reviewer`, fix. Run tests
> per package (`AGENTS.md` §7). Last commit: `PROGRESS.md` row to `done`
> with the PR number and a one-line handoff for the next task; add to
> `07-incompatibilities.md` anything new you found. Do not merge: report
> back.

**Every code task also**: keeps its migrations additive (one migration per
PR); adds its tables' import step and fixture rows to the import script
(from M1-06 on); forwards classroom fixes newer than the sync point for the
files it ports; writes en + fr for every string.

---

## M3 — Projects

The pilot's two open follow-ups have no card of their own; their findings
were recorded on the card [M3-14](history/09-tasks-delivered.md#m3-14-pilot-and-load-test)
(2026-10-06), and are carried here.

### M3-14f — Drop the `ANTHROPIC_API_KEY` organization-secret check
- **Depends on**: the final review moved to Quiz's own LLM.
- **Note** (pilot finding 3): NOT NOW (product owner, 2026-10-06): removed
  progressively once Quiz's own LLM does the final review.

### M3-14g — Leaving the course staff ends one's staff seats
- **Depends on**: M3-14c.
- **Note** (ADR-077 Q7): leaving the course staff keeps one's staff seats
  today; a follow-up (product owner, 2026-10-06: keep as is for now).

The pilot's load test (100 repositories at a deadline applied in < 5 min,
the tick with 100 due projects) was deferred (product owner, 2026-10-06).

## M6 — Online workspace and SEB (after the cutover if D09 says so)

### M6-07 — SEB for projects
- **Depends on**: M6-02, M6-06.
- **Goal**: §6.3 points 2–5.
- **Acceptance**: route sweep covers project routes; `/launch` refused in
  exam mode without a valid header; `simulated` impossible in production;
  **proof B recorded** before the first SEB project.
- **As delivered** (branch `merge/M6-07-seb-projects`). Migrations
  `0080_seb_projects` (Quiz) and the portal's `0002_platform_seb`.
  **Proof B is pending**: the manual procedure is 06 §6.3, "Proof B, by
  hand", for the product owner; nothing opens SEB projects to students
  before it is recorded here.
  - Point 2, the platform builds every `.seb`: `auth/seb.ts`
    `sendLaunchFile` (ticket, `auth.seb_launch`, file) serves both the
    evaluation's and the project's (`GET /app/api/projects/:id/seb`, the
    `codespace` module: own portal session, a claimed seat in the
    classroom of a published `online_seb` project, `sebProjectSeat`). The
    start URL is the ticket route for both; `sebAllowedHosts(config,
    activity)` adds the portal's host for a project, then
    `SEB_EXTRA_ALLOWED_HOSTS` (new Quiz setting, host names, `*`
    wildcards but never wildcards alone, empty by default) for both — empty, the evaluation's bytes
    and Config Key are unchanged (`seb.snapshot.test.ts` untouched). The
    ticket route checks the header against either file before consuming
    the ticket, then against the ticket's own; a project's session lands
    on `/projects/:id`. What differs between the two activities is one
    table, `SEB_ACTIVITY`; the ticket's activity is read without consuming
    it (`pendingLaunchTicket`), so the header is checked against that
    activity's file and a wrong one never burns the ticket.
  - Point 3, one activity: `sessions.project_id` and
    `launch_tickets.project_id` (cascade, a check: never both with
    `evaluation_id`); `SessionAuth.projectId` (required, like
    `evaluationId`); the route config gains
    `activities` (absent: evaluation): `serves()` refuses a confined
    session whose activity the route does not list, so `SITTING` stays
    the evaluation's and `PROJECT_SEB` (`GET /app/api/student/projects/:id`,
    `GET /app/codespace/start/:id`) the project's; `GET /me` lists both
    and says `projectId`. `findStudentProjectView` reads THIS project for
    its `seb` session, through its seat, as a portal session would
    (`sebProjectSession`); any other confined session stays the 404.
    `sebProjectSeat` is that same loader plus the `online_seb` and
    classroom checks.
    Supersession and the mismatch audit are per activity (subject
    `project`). `seb.db.test.ts` now runs with the App and the portal
    configured: its sweeps walk every project route, and a project's
    session has its own sweep (`PROJECT_SEB_ROUTES`).
  - Point 4: from that session the start route mints the launch token
    with `seb: {configKey}` (the session's stored key) — `workspaceStartRefusal`
    gained `fromSeb`; `seb_required` is now "from the portal" only; the
    audit adds `seb: true`, never the key. The portal's `/launch` in exam
    mode refuses a token without the claim, then verifies the header
    against the claim's key (`@quiz/seb`), then the BEKs if any, then sets
    its IP-bound `exam_session`.
  - Point 5: BEKs optional on the portal (an empty list is the Config Key
    alone, the exam no longer refused without one); `online_seb` is synced
    (`isOnlineMode`; `syncsToPortal` removed) with `browserExamKeys: []`,
    the resync's `seb_required` lifted. **BEK list: after proof B step 7
    (per-student `.seb` likely gives per-student BEKs)**: SEB's BEK covers
    the configuration, and Quiz's file is per student (the ticket in its
    start URL), so a staff-typed list is expected to match nobody. The Quiz
    side (column, route, staff field) was written then removed at review;
    evaluations have none either.
  - Portal: `src/seb/` keeps `verify.ts` (on `@quiz/seb`'s hashes and
    headers, imported from there, BEKs optional) and `check.ts` (the proxy's cookie check, the outside-SEB
    page); its plist, Config Key, `.seb` file, `/exam/:id.seb` route and
    vectors are deleted (the vectors live in `packages/seb`); its
    `SEB_EXTRA_ALLOWED_HOSTS`, `config_key` and `seb_config` are gone. The
    PUT answers `configKey: null, sebLink: null`.
  - Web: the student's *Open in Safe Exam Browser* (`SebLaunchModal`,
    workspace copy) on an `online_seb` project; inside SEB the app renders
    that project page only (*Open workspace* its one action, no GitHub
    action, the page framing itself); the staff's Resync under SEB. en/fr;
    mock `?sebproject=1` and the `pj-draft-manual` SEB project; scenes
    `project-workspace-seb`,
    `student-project-workspace-seb-launch`, `student-project-in-seb`.
  - Plan B (an auto-submitted POST to the portal) not built: Quiz's CSP
    forbids inline scripts, and the portal would need a `POST /launch`;
    it waits for proof B's evidence (06 §6.3).

### M6-08 — Freeze and collect contract on the portal (ADR-075)
- **Depends on**: M6-03, M6-05. ‖ M6-06.
- **Goal**: an exam mode of `apps/codespace` (no git channel, `--network none`,
  work volume only, per attempt); a `workspace.freeze` HS256 service message
  and a single-use signed collect endpoint (one file or a capped tar of
  declared names); destruction of the volume after Quiz acknowledges the
  hash; a safety cap; the `apps/codespace` `CLAUDE.md` records that this mode
  drops the git-channel divergence; contracts in `packages/contracts`
  (M6-01).
- **Acceptance**: a frozen workspace refuses any write; collect is single use
  and refused without a valid token; no container of this mode has a network
  or a credential (closed list asserted); a destroyed volume is gone;
  integration against a stub Quiz.

### M6-09 — `qt-workspace` type and Quiz side (ADR-075)
- **Depends on**: M6-06, M6-08; D21's `.seb` filter (M6-07) for SEB.
  Kiosk use waits for proof B.
- **Goal**: `packages/qt-workspace` through both registry entry points
  (04 §4.15); publication checks (`workspace.requires_supervision`,
  `workspace.capacity`); seed builder from `toStudent`'s output; the
  deadline + 3 s freeze-and-collect job (singleton per attempt, the
  attempt's deadline with accommodations); blob answer with server-stamped
  hash; two-phase grading on the runner, `proposed` state; grading panel
  shows the file; audit events; en/fr; the `code` fallback swap.
- **Acceptance**: a fully configured question through the seed builder, the
  serialized payload and file tree searched for hidden cases and the
  reference; a late write is impossible after the freeze; an exercise
  refuses the type; portal-down opening is refused with the fallback
  offered; `invariant-reviewer` finds no second exit of question content.

## M8 — Migration and cutover

### M8-06 — Rehearsal
- **Depends on**: M8-01…05, D22, and #655 (the import in the production
  image, runbook O6) deployed.
- **Goal**: on staging (`srvstg`) with the staging App and a fresh
  production dump of both databases: the whole of the runbook's §2, timed.
- **Steps**: [`10-cutover-runbook.md`](10-cutover-runbook.md) §7.
- **Acceptance**: parity report clean; timings recorded in `PROGRESS.md`;
  go/no-go written; §2's target times filled in the runbook.
- **Carried from the delivered cards**:
  - M8-01 (ADR-077 Q8, product owner 2026-10-06): this rehearsal is the
    import's dry run on a production dump; it COUNTS, per classroom, the
    staff-seat repositories classroom let its teachers accept and reports
    the number; the product owner decides then whether they are imported
    (runbook O4, §1.3).
  - M8-03: the freeze from C1 to C8 measured here decides M8-03b, the
    read-only flag in classroom, built only past 2 h (runbook §0).

### M8-07 — The cutover
- **Who**: the product owner, with an agent following the runbook
  ([`10-cutover-runbook.md`](10-cutover-runbook.md) §2).
- **Depends on**: M8-06 go, D20, the runbook's open decisions O1–O5.

## M9 — Decommission

### M9-01 — Point of no return and decommission
- **Goal**: §6.5 E; redirects to 308 (the runbook's §5: 308 keeps the
  method, 301 may not); issue #143 closed.

## Loose ends recorded on delivered cards

Not tasks of their own; each is on its delivered card.

- [M8-02](history/09-tasks-delivered.md#m8-02-legacy-url-resolver): not
  done, the HMAC-honouring of an old unsubscribe link and an absolute
  `Location`; the non-blocking follow-ups of the code review of #547.

## L — After the merge

- **L-01** Platform `llm` module (qt-rich, the `short` LLM matcher,
  projects).
- **L-02** Runner grading of a project (tarball at the frozen sha, size
  cap, toolchain images, network closed).
- **L-03** `packages/ui-kit` extraction (what ADR-029 wanted, as a
  workspace package).
- **L-04** WYSIWYG journal editor (RichText adapter: repository-path
  images, no markdown normalisation, round-trip tests).
- **L-05** Project templates at course level.
