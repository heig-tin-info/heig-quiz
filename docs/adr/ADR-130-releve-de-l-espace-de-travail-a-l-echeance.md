# ADR-130 — The online workspace is collected at the deadline: read confined, committed by the platform, counted on time

## Status

Accepted (2026-11-16, the product owner's four decisions below, taken
through explicit questions after two students of a supervised lab handed
in nothing). Corrected the same day (Correction 2026-11-16, at the end): the collection reads the
workspace through a confined reader, never `shadow.git`; §1 decision 2, §3,
§4.2, §5 and §8 are amended in place, each change marked. Delivery progress
lives in `changes/`.

Amended 2026-11-16 (below, "Amendment 2026-11-16"), scope: §7, the
student's surface — the workspace's status bar is not built.

Scope: what happens, at a repository's effective deadline (F-PROJ-09), to
the work of an `online` or `online_seb` project (F-PROJ-19) that sits in the
online workspace but was never pushed; the grading target that results
(F-PROJ-11); a correction of what the deadline lock binds.

Relations: amends [ADR-012](ADR-012-gel-note-deux-temps.md) decisions 3
and 4 (a collection's receipt counts at the deadline, §6);
[ADR-078](ADR-078-codespace-git-relay-tokens.md) context fact 1 and §7
(corrected: the lock binds the App, §9) and adds its §13 (the write grant
serves the collection, §5); [ADR-064](ADR-064-echeance-des-projets-baux.md)
(the deadline job collects before it locks or commits, §5);
[ADR-089](ADR-089-kiosque-pour-l-espace-de-travail.md) point 8 (corrected,
§9). Settles [question 61](../spec/06-questions-ouvertes.md) for the
collection only. Reverses, for this one case, the "no ghost commits" choice
of the portal's `apps/codespace/docs/history/analyse.md` §3.3,
without touching the student's repository. Follows
[ADR-075](ADR-075-question-espace-de-travail.md) §6's pattern (Quiz owns the
clock and orders the portal). Invariants 5, 6, 7, 8, 9, 15; the portal's
invariants 1, 8, 10 and 13.

## Context

In the online work modes the workspace is the only write path to the
student's repository (F-PROJ-19): a `git push` lands in the session's
`staging.git` on the engine VM and the relay carries it to GitHub
(ADR-078). Work that was saved but not pushed exists only on the engine VM.
At the deadline the job applies the lock (`hgc-deadline-lock`,
`apps/api/src/github/lock.ts`), a ruleset **without bypass actors**: from
then on GitHub refuses every push, the App's included. On 2026-11-16, in a
supervised lab of 25 (deadline applied 13:40:19, locks 13:40:27–13:40:46),
two students lost their hand-in: one had left a kiosk station seven minutes
before the deadline without pushing, one edited his file during the very
minute of the deadline.

The host already keeps what is needed. `<VOLUMES_ROOT>/<student>/<project>/`
holds `work/` (the container's volume), `staging.git` and `shadow.git`
(`apps/codespace/src/git/staging.ts`): a root timer snapshots the whole work
tree into `shadow.git` every three minutes (`deploy/shadow-snapshot.sh`),
and the portal snapshotted it once more when a session closed (removed by
the correction at the end). `shadow.git` and `staging.git` are
the host's own repositories; the host never reads nor runs git on the
student's `work/.git` (audit L23, the portal's invariant 13). The student's
`.gitignore` applies to the snapshot (`add -A` honours it); `.git` is
excluded.

ADR-078 context fact 1, its §7, ADR-089 point 8 and F-PROJ-09 say the App
bypasses the lock. The code never configured a bypass; they are corrected
here (§9), and no bypass is added.

## Decision

### 1. The owner's four decisions (2026-11-16)

1. **At the deadline**, on the server's clock: the platform takes the
   workspace's state, commits and pushes it, then the deadline applies (the
   lock, or the deadline commit under `commit`). The collection commit counts
   as handed in on time; a student's own late push stays late.
2. **The source is the workspace as the platform reads it**, never a
   commit made inside the session; it works for a session already closed.
   The commit is the platform's (GitHub-signed for the App, #917), labelled
   as a collection, and visible to the staff. *Corrected 2026-11-16 (the correction at the end):
   the decision said "the host's copy (`shadow.git`)"; a host-side read of
   `work/` can be made to follow a link out of the volume, so the platform
   reads it through a confined reader instead. The intent — not a commit
   inside the session, and a closed session collected too — is kept.*
3. **Whenever the workspace differs from what would be handed in**: the
   latest state wins, even over an earlier deliberate push. Nothing to
   collect, no commit — never an empty one.
4. **Both online modes**, `online` and `online_seb` (any device level).
   Group projects are always `free` and out of scope.

### 2. Which repositories, once per deadline

A repository is **due for collection** when it is live, individual, of an
`online` or `online_seb` project, its effective deadline is applied, its
student launched a workspace (`codespace_launches`), GitHub does not hold a
lock on it (`locked_at` null: a staff lock before the deadline wins), and no
collection is recorded for that repository and that effective deadline. The
record, `codespace_collections` (the `codespace` module's table: repository,
effective deadline, outcome, branch, collected sha, counts, times), is unique
on (repository, effective deadline): a job retried or resumed never collects
twice, and an extension that reopens the repository (F-PROJ-09) gives it a new
deadline, hence a second collection when that one comes. A staff seat's test
repository (ADR-077) is treated like any other.

### 3. What is collected

- **The workspace, read confined** (corrected 2026-11-16: the correction at
  the end holds the rule and its reason). The portal reads `work/` through
  its confined reader, a throwaway platform container; no session is
  involved, the quota is not consulted, a closed session works. It reads
  what `git add -A` would add to an empty index (the student's
  `.gitignore` honoured, a nested repository left out). `shadow.git` is not
  read. No `work/` (no session ever opened): `no_snapshot`. A work tree the
  reader cannot enter: `failed`, `read_failed`. A file or directory it
  cannot read keeps its version in the commit that would otherwise be
  graded, or is left out; the count is shown to the staff.
- **The branch** (pure rule `collectionBranch` of `@quiz/domain`, Quiz's): the host
  cannot know which branch `work/` has checked out, so it is the branch of
  the student's last push received (a non-bot receipt) when it is handed
  out (`project.branches`), the first handed-out branch when the student
  never pushed, and none — `branch_not_handed_out`, nothing collected —
  when the last push went to a branch that was not handed out.
- **The tree**: the snapshot's tree, except the **kept paths**, taken from
  the branch's current head on GitHub (the *base*): the project's protected
  files (F-PROJ-08; `criteria.yml` under `criteria`) and `.github/workflows/`
  always (a `contents`-only grant cannot change it, and the restore would
  only put it back). Pure rule `collectionKeptPaths` of `@quiz/domain`, the
  matching `pathWithin`'s; the portal applies it to Quiz's list again, so the
  workflows stay kept whatever the list says. A symbolic link is carried as a link, never
  followed; a gitlink (a repository the student cloned inside `work/`) is
  left out, and so is a workspace file standing where a kept entry needs a
  directory (`composeCollectionTree`).
- **The condition** (decision 3): collected when that tree differs from the
  tree of the commit that would otherwise be graded — the last student push
  on that branch received by the deadline (`lastStudentPush`), else the
  base. Equal: `unchanged`, no commit. When the base is a student's late
  push that already carries the same tree, the collection commit repeats its
  parent's tree: it is no empty collection, it hands in on time what only a
  late push held.
- **Size**: the workspace's files (those the listing names) over
  `WORKSPACE_PUSH_MAX_BYTES` in all (100 MiB, the cap of one student push,
  which no file over GitHub's 100 MiB limit fits under): `too_large`,
  nothing pushed. *Corrected 2026-11-16: the cap counted the blobs the base
  did not hold; it now bounds the archive the reader streams, so a
  workspace whose handed-out files and own files together pass 100 MiB is
  `too_large` too, and so is a workspace over `COLLECTION_ENTRIES_MAX`
  (20 000) paths, counted in the listing and again once unreadable
  directories are filled from the graded commit.*

### 4. Who does what

1. **Quiz orders.** The deadline job sends the portal, per due repository,
   `POST /api/assignments/:projectId/collections`, a service token bound to
   the request and single use (ADR-078 §10; `ServiceTokenClaims.method`
   gains `POST`), whose body is `CodespaceCollectionRequest` of
   `@quiz/contracts` (both sides; the portal parses it with that schema
   before anything runs): the user, the repository, the base sha (the
   head of the branch §3 chose), the target sha, the kept paths, and the
   temporary ref Quiz names (`refs/quiz/collect/<repository id>-<deadline epoch>`).
2. **The portal builds and carries the tree** (`apps/codespace/src/git/collect.ts`),
   within one time budget of 45 s. *Corrected 2026-11-16 (the correction
   at the end):* the workspace comes from the confined reader, as data; the
   collection writes only a temporary bare repository under
   `<VOLUMES_ROOT>/.collect/`, borrowing `staging.git`'s objects, removed on
   every exit and swept at startup: the workspace's blobs, the base and the
   target fetched from GitHub when missing, the tree composed in a
   temporary index, compared, and one throwaway commit of it on the base
   pushed to the temporary ref — a new ref, never a branch, never forced,
   no head declared, no `PushEvent` — with the write grant it already
   holds (§5). One collection at a time per (student, assignment); the
   portal's record is one log line per order with its outcome. It answers
   `CodespaceCollectionResult`: `pushed` (the tree), `unchanged`,
   `too_large`, `no_snapshot` or `failed` with a closed reason (`timeout`
   and `read_failed` among them), and the time it read the workspace and
   its unreadable count. **`pushed` means only that a throwaway commit sits
   on a temporary ref**: only Quiz knows whether a collection followed.
3. **Quiz checks, then commits.** Before signing anything, Quiz reads the
   pushed commit on the temporary ref and verifies that (a) its tree is the
   `tree` the portal reported and its parent the base, and (b) every entry
   under the kept paths — `collectionKeptPaths` of the project's protected
   files — equals the base's, none added, none removed; otherwise `failed`,
   nothing signed. Then `signedCommit` of that tree on the branch's current
   head, read before every try, the first included — after the kept entries
   are checked against that head. A student's late push relayed between the
   order and the commit is that head: its changes are not in the collected
   tip, it keeps its own later receipt and stays late (decision 3). Message
   `Collected from the online workspace at the deadline (<local time>)`;
   the receipt (§6) and the collection row written; then the branch moved,
   `force: false`. A 422 (the head moved: a student's push relayed in the
   meantime, received late) withdraws that commit's receipt — a commit that
   never reached the branch is never a target — and gets a new signed commit
   of the same tree on the new head, three times at most, then `failed`. **After every order, whatever
   its outcome** — collected, a failed check, `unchanged`, a timeout, a
   failure of any kind — Quiz deletes the temporary ref it named, best
   effort, as the sync's (`github/sync.ts`): a push the portal's budget cut
   may still have landed on GitHub, and the ref's name is Quiz's, so no
   answer is needed to find it.
4. **Then the deadline**: the lock, or under `commit` the deadline commit,
   in the same job, whatever the collection's outcome.

### 5. Bounds: the lock is never held hostage

- **Timing.** The job first settles the collections a crash left unsettled
  (§4.3), then collects its due repositories in waves of at most 16 in
  flight — a wave starts its next repository as soon as one finishes — and
  only then settles each repository as before, four at a time (ADR-064).
  With a portal answering in seconds, a class of 25 to 50 is ordered within
  the first minute after the deadline. A slow portal pushes the tail of the
  class past the 120 s bound below: those repositories are `too_late`, not
  collected, and flagged. The worst case to the first lock, whatever the
  class: no order leaves after 120 s and the last ones are waited for at
  most 60 s, so about three minutes after the deadline (the job claims
  within 20 s of it), then the locks four at a time. Edits made
  between the deadline and a snapshot are included; edits after it are not
  handed in (§7).
- **How late the content may be.** Quiz sends an order only within 120 s
  of the repository's effective deadline, judged on Quiz's clock when the
  order is sent — never on the portal's `snapshotAt`, the engine VM's clock.
  Later than that (Quiz down at the deadline, a job that waited) the outcome
  is `too_late`, flagged for the staff, whose remedy is the repository's own
  deadline (F-PROJ-09 (1)): a collection at the new one.
- **The lease and live collections.** The collection phase runs through
  the job's `each`, which renews the job's lease after every repository. A
  row claimed less than five minutes ago (`COLLECTION_ALIVE_MS`: past the
  120 s order bound, the 60 s wait for the portal and the GitHub calls
  after it) is presumed alive and never settled as interrupted; a row is
  settled once, by the run that settles it first, and only that run
  audits. A run that loses the settlement after its commit landed keeps the
  commit's receipt: what is on the branch decides.
- **Per repository**: the portal stops at its 45 s budget and pushes nothing
  more; Quiz's call times out at 60 s; any failure or timeout records
  `failed` with its cause and the repository is locked regardless. Never a
  forced push of a branch, never a branch deleted.
- **The reader** (corrected 2026-11-16, see the correction at the end): one throwaway container per
  collection, so at most 16 at once, each 64 MiB, 32 pids and one CPU in
  `codespace.slice`; its only process sleeps for the time left in the
  budget and it is started `--rm`, so it ends on its own within the 45 s
  even if the portal dies; the portal removes it on every exit path, a
  timeout included. Its failure is `failed` with reason `read_failed` (it
  could not start, or its listing or archive was refused); its timeout,
  `timeout`.
- **The write grant, unchanged (ADR-078 §13).** The portal asks Quiz for its
  token as for a relay (`POST /app/codespace/git-token`); check 5 already
  grants it until the effective deadline plus the grace, and a collection is
  only ordered well within that window (the 120 s above). Under `commit`,
  ADR-078 §11's bound applies as it stands. No new permission, no new route
  for the token, the audit `codespace.git_token_issued` as for any grant.
- **GitHub or the portal down at the deadline**: `failed`, locked anyway.
  Nothing waits in `staging.git` for a relay (the throwaway commit is no
  `PushEvent`). The state stays in the workspace (and in `shadow.git`, the
  staff's untrusted safety net: the correction at the end); the staff extend the
  repository's deadline (F-PROJ-09 (1)) to have it collected at the new one.
- **25 to 50 repositories at the same second**: one git push each from the
  engine VM, five REST calls each from Quiz (read the base, the signed
  commit, the move, the ref's deletion, the receipt's lookups are local),
  within the installation's limits; N-PERF-07's five minutes for 100 locks
  stays the target.

### 6. The grading target (amends ADR-012 decisions 3 and 4)

Before moving the branch, Quiz writes the collection commit's receipt
itself: a `push_receipts` row, `collected` true (a new column), `is_bot`
false, `received_at` **the effective deadline it was collected for** — the
instant decision 1 says it stands for. The webhook's later receipt of the
same head is a no-op (the first receipt stands). The real times stay
recorded: the collection row's `collected_at` and the webhook delivery.
`pushAuthor` reads a push of the App whose head has a collected receipt as
`collection`: the student's last commit, a receipt that is not a bot's,
runs on it eligible (`isEligible`), and no protected-file check (§3 kept
them). It is never a `bot_commits` row. Every reader of the receipt time —
`receivedLate`, `lastStudentPush`, the freeze's pointer, the CI pass's
target (ADR-106 §3, ADR-119 §6) — then needs no case of its own; on equal
times the collected receipt is the later. A student's own push received
after the deadline stays late (F-PROJ-11).

Only the deadline job's collection path writes a `collected` receipt, after
the check of §4.3, its `received_at` computed by Quiz from the repository's
effective deadline — never taken from the portal's answer (`snapshotAt` is
the engine VM's clock and only informs the staff). No other route, job or
webhook can set `collected`: the intake writes it false, and a redelivery
never changes a receipt. No repository is frozen while a collection of it
is claimed and not settled (`freezeDue`): its receipt may still name a
commit on no branch; the deadline job keeps the project's work open until
the row is settled.

### 7. What the student and the staff see

- **The staff**: the repository's row on the project page says "Collected
  at the deadline" with the time, or why not (`unchanged` says nothing;
  `no_snapshot`, `branch_not_handed_out`, `too_large`, `too_late`, `failed`
  are flagged), and the unreadable count; the commit on
  GitHub is the App's, signed, its message naming the collection. Audited
  `project_repo.workspace_collected` (outcome, sha, reason); the
  `project.deadline_enforced` tally gains `collected`.
- **The student**: the project page in Quiz says the work was collected at
  the deadline and that changes made after it are not handed in; the
  workspace's status bar says the same (`push-status` gains `collected`,
  from what Quiz recorded — the portal's `pushed` is no collection by
  itself). The Quiz project page does not depend on the workspace's image.
  *(Amended 2026-11-16: the status bar is not built; see the amendment.)*
- **Resuming later** (an extension, a reopen): nothing is rewritten in
  `work/`. The student's next push is refused as a non-fast-forward, the
  relay fetches GitHub's head into `staging.git` (ADR-078 §6, as for a
  restore), and `git pull` merges the collection commit — whose tree is the
  student's own work at the deadline, so the merge is clean unless the same
  lines changed since. At a new session start an `online` workspace's
  staging mirror brings it in already. No other mechanism.

### 8. What it does not do

No per-project switch. No collection of a group project, of a `free`
project, of a repository whose student never launched a workspace, of a
review session (ADR-129). No commit, tag or branch in the student's `work/`.
No session container started, entered or counted to collect. *Corrected
2026-11-16 (the correction at the end): this said "no container started to collect"; the
collection now starts one platform reader per order — never a session,
never in the quota, never on the session network.*

### 9. Corrections: the lock binds the App

`hgc-deadline-lock` has no `bypass_actors`: once it is applied nobody pushes,
Quiz's App included; an organization owner can still remove the ruleset.
F-PROJ-09 (corrected here), ADR-078 context fact 1 and §7 and ADR-089 point 8
said otherwise; under `lock` a push relayed after the lock is refused by
GitHub and takes the terminal `rejected` state, it is not received late
within the grace. That is why the collection precedes the lock instead of
relying on a bypass, which would also widen ADR-078 §9's blast radius past
the lock. The header comment of `github/lock.ts` is corrected with the code.

## Consequences

- An online student who saved but did not push hands in what was in the
  workspace at the deadline; today's two losses become impossible, a
  closed session or a station left early included.
- The graded commit may be the App's (signed, labelled), not the
  student's; the staff can tell them apart on GitHub and on the project
  page. Its receipt time is a stated convention (the deadline), not an
  observation; the observation is kept beside it.
- The latest state wins over a deliberate earlier push, as decided: a
  student who pushed a clean version then broke the code before the
  deadline hands in the broken one.
- The student's local history diverges by one commit when work resumes;
  the existing rejection path covers it.
- The deadline's lock comes a few seconds later than today for online
  projects (the snapshots, then one more GitHub write per collected
  repository).
- Files the reader cannot read are taken from the commit that would
  otherwise be graded, which may be much older than the workspace (the
  handout, for a student who never pushed); the count says so. The read
  may include edits from the seconds between the deadline and Quiz's
  order.
- Code: a pure rule pair in `@quiz/domain`, contracts for one portal route,
  one migration of Quiz's (`codespace_collections`, `push_receipts.collected`;
  the portal keeps no table for it), the
  portal's route and git plumbing, a step in the deadline job, two surfaces
  and their strings in `en` and `fr`.

## Alternatives considered

- **A commit made inside the session** (as the student, through
  `engine.exec`): needs a running container and the quota, cannot work for a
  closed session, interferes with a merge or rebase in progress
  (analyse.md §3.3), and is the student's commit made by the platform. The
  owner chose the host's copy.
- **A bypass of the lock for the App, then collect after it**: the relay's
  write grant would outlive the lock, widening ADR-078 §9; the lock would
  stop being a guard.
- **The portal pushing its own commit to the branch** (declared like a
  relay): unsigned, attributed to no one, and a second kind of declaration;
  Quiz's commits are GitHub-signed (#917).
- **Sending the files to Quiz to build the commit through the Git Data
  API**: one REST call per changed file, up to 100 MiB through Quiz; the
  temporary-ref pattern already exists (`github/sync.ts`).
- **The root timer's last snapshot only**: up to three minutes stale — the
  very edit of the second student lost; and a host-side read (the correction at the end).
- **`podman exec` into the session's container to read** (the correction at the end): no container
  for a closed session, so two paths; the student's processes share its
  cgroup and limits; the session's state would matter to a collection. One
  fresh reader serves every case.
- **Reading `work/` on the host with care** (`O_NOFOLLOW`, `openat` walks,
  excluding nested `.git` beforehand, as PR #1128 does for the snapshot):
  narrows the window, cannot close it on a tree the student writes while it
  is read, and git's own `add` re-resolves paths after its walk.
- **Comparing with GitHub's head rather than with the graded target**: a
  student who pushed a few seconds late would hand in less than one who
  never pushed.
- **A receipt kind read by every rule** instead of a receipt dated at the
  deadline: the same rule in four readers, each a place to forget it.

## Amendment 2026-11-16: the student's surface is Quiz's

§7's student bullet, amended. The workspace's status bar does not say the
collection: it is not built. The student is told on Quiz's project page and
activity card, through the project's student view (the one exit,
invariant 4), which says only whether the repository was collected at its
current effective deadline. A collection commit is not counted among the
student's commits, and a collected repository counts as handed in for the
staff's figures.

Why: no channel carries Quiz's record to the portal. The portal keeps no
table for collections (§4.2), and its `push-status` reads only the relay's
own record of the session's pushes; its `pushed` answer to an order means
a throwaway commit on a temporary ref, not a collection (§4.2), so the
status bar cannot read it without saying something false when Quiz's check
refuses the commit or GitHub refuses the move.

The smallest future design, left to the owner: the assignment sync
(`PUT /api/assignments/:id`) carries the collected-at instant per student,
and `push-status` reads it from there.

## Correction 2026-11-16: the collection reads through a confined reader

**The rule** (the portal's invariant 15): nothing published comes from a
host-side read of `work/`.

**Why.** The first build (#1121, #1124) published `shadow.git`, written by
`git --git-dir=shadow.git --work-tree=work add -A` on the host — by the
portal when a session closed and on its own timer, and by a root timer
every three minutes. `work/` is written by the student's container at the
same time, so host-side path resolution is racy by nature: `git add`
checks an entry's type, then opens it by path, and an entry swapped for a
symbolic link in between is followed, storing as an ordinary blob a file
outside the volume — anything the reading identity reaches (as root, any
host file; as the portal, the instance's database, other volumes, its own
process's environment); a nested gitfile makes git open a repository at a
path the student chose. Before this ADR a snapshot was a safety net; the
collection published it. No production collection had run (the deploy was
held); staging had.

**What changes.**

1. **The source** (§1 decision 2, §3): the confined reader
   (`apps/codespace/src/engine/reader.ts`), a throwaway container with the
   sessions' hardening (`hardeningArgs`), `--network none`, no variable of
   ours, the image's unprivileged user and the volume mounted read-only,
   never `:U`. Its filesystem holds the platform's image, the volume and the
   container's own `/proc`, `/run` and `/tmp`. Whatever a link, a gitfile
   or a race resolves to in there is **something the student can read
   already**: their own files, or bytes of the image or of the reader's own
   kernel views (a directory swapped for a link to `/etc` between the
   listing and the archive publishes the image's `/etc/passwd`, which the
   student's container shows anyway). None is a secret; none is the host's.
   It runs two fixed commands: `git ls-files -z --others --exclude-standard`
   in a throwaway repository, then GNU tar of exactly the listed paths.
2. **The host treats both as data** (§4.2): the listing must hold relative
   paths git prints (a name a path here cannot carry is counted and left
   out); the archive is read as a stream (`git/workArchive.ts`, with the
   runner's header helpers and path rule from `@quiz/core`): regular files
   and links only, a link's target kept as bytes, never followed; listed
   paths only, once; checksums, the cap, the end marker. The host opens no
   path under `work/`; it asks only whether `work/` exists.
3. **What the reader could not read** (§3) keeps its version in the commit
   that would otherwise be graded (`withUnreadableKept`), or is left out;
   counted. A work tree it cannot enter, or a list of closed directories it
   could not read whole: `read_failed`. More than `COLLECTION_ENTRIES_MAX`
   paths (`apps/codespace/src/git/workTree.ts`) — the listing's names,
   skipped ones included, the listing stopped as soon as it passes; then
   the workspace once unreadable directories are filled from the graded
   commit — `too_large`. That one cap bounds the portal's own synchronous
   work, which no budget can interrupt once it runs; the rules that run
   over the entries are linear in their number times their depth.
4. **Outcomes**: `stale_snapshot` is removed with the fallback it
   described; `read_failed` joins the portal's failure reasons. A stored
   value no list holds any more reads as `failed` with no reason
   (`storedCollection`), so no migration is needed.
5. **The reader is no session** (§5, §8): its own name and labels, no
   session label, not in the quota; it sleeps only for the budget left,
   runs `--rm`, is removed on every exit path and swept at startup.
6. **`shadow.git`**: the portal takes no snapshot any more (on close nor on
   a timer); the root timer, which walks every volume, open and closed
   sessions alike, is its only writer, in a systemd sandbox that bounds what
   its race reaches (only the instance's volumes under an empty `/srv`, the
   known secret locations denied, no home, device, network or other
   process). Development, which has no timer, keeps no `shadow.git`.
   `shadow.git` is never published by the platform, but it **does leave the
   engine VM**: the daily backup exports the volumes, `shadow.git` included,
   to the application VM. Its content is untrusted there as here; a staff
   member recovering work from it reads it with git only and checks what
   they hand back (`apps/codespace/deploy/RUNBOOK.md`). It stays in the
   backup: it is the recovery net.

What this does not cover: a host-made hard link from inside a volume to an
outside file (the student cannot make one); a breakout from Podman or the
kernel; and `shadow.git`'s own race, bounded only by the sandbox.
