# ADR-149 — A fourth work mode: the students' own tools or the online workspace, at their choice

## Status

Accepted (2026-11-26, the product owner's decisions below; what counts as
written outside — a GitHub web commit included — is the orchestrator's
reading of them, after review; the outcome `last_push_local` and the
portal's mapping are the orchestrator's, within them). §7 decided by the
product owner on the same day: the switch after a launch, the widening of
the invitations already sent, the portal's refresh; its job, the signal
to the portal and the refresh's rules are the orchestrator's. Delivered in
two parts, §1–§6 then §7; progress lives in `changes/`.

Scope: the work mode `hybrid` of a project (F-PROJ-19) — who may write to
the student's repository, what the deadline collects, what the portal is
told, what the student and the staff see.

Relations: amends [ADR-047](ADR-047-espace-de-travail-en-ligne.md)
decision 2 and rejected alternative 1 (the student's write access) and its
[M6-06 (A)](ADR-047-espace-de-travail-en-ligne.md#m6-06-2026-10-07-the-work-mode-in-quiz)
(the list of modes, the freeze, "an invitation already sent keeps the
permission it had"); [ADR-130](ADR-130-releve-de-l-espace-de-travail-a-l-echeance.md)
§1 decisions 3 and 4, §2 and §7 (the collection); extends
[ADR-078](ADR-078-codespace-git-relay-tokens.md) §11 (under `commit`, the
workspace follows the repository's writability),
[ADR-132](ADR-132-mise-a-jour-du-projet-greffee-a-la-correction.md) §11
(the teacher's update in the workspace) and
[ADR-089](ADR-089-kiosque-pour-l-espace-de-travail.md) amendment point 2
(the one mapping between the screen and the setting); extends
[ADR-145](ADR-145-depots-seb-ouverts-aux-etudiants.md)'s `project.repos_access`
job to the widening (§7).

## Context

A project is worked either in the students' own tools (`free`: GitHub
`push`, their machine) or in the online workspace (`online`: GitHub `pull`,
only the portal's relay writes; `online_seb`: the same under supervision,
nobody invited). Teachers of a first-year lab want both at once: most
students have a compiler and git installed, a few do not, or not yet, or not
on the machine they have with them. Forcing the whole class into the
workspace takes git away from those who have it; leaving the class in
`free` leaves the others with nothing.

ADR-047 rejected "two write paths on the same repository" because it makes
the content of an **exam** indefensible: nothing distinguishes a commit made
in the supervised session from one pushed from home. That argument holds for
`online_seb` only. An unsupervised `online` lab already defends nothing of
the kind — the student may type there what they wrote elsewhere — and a
`free` project has had a single path, the student's, all along.

What is new is the deadline's collection (ADR-130): it commits the
workspace's state over the student's last push. With two write paths, that
state may be older than a push the student made from their own machine.

## Decision

### 1. The mode

`hybrid` joins `free`, `online` and `online_seb`, a fourth mode
(`WORK_MODES`, `@quiz/domain`). The staff's setting shows three places,
in this order: **Own tools | Either | Online workspace** (fr *Leurs outils |
Au choix | Espace en ligne*); Either is `hybrid` (`workSettingFor`,
`workPlaceOf`). Its device level is always `any`: no Safe Exam Browser, no
kiosk station, and no device selector under it. Like `online`: only an owner
with the workspace grant sets it, the quota holder's quota counts its
workspaces (ADR-047 M6-06 (C)), and a group project refuses it
(`409 work_mode_group`, F-PROJ-06). The database needs nothing: `work_mode`
is a text column without a check on its values, and
`projects_devices_supervised` holds with `any`.

### 2. Two write paths, the last writer wins at the deadline

The student is invited with **`push`**, as in `free`
(`collaboratorPermission`), and may also start the workspace, whose relay
writes as in `online` (`isOnlineMode`: start route, git-token route, image).
Under the `commit` strategy the workspace follows the repository's
writability, as `online` does (ADR-078 §11).

At the effective deadline, a repository otherwise due for collection
(ADR-130 §2: a workspace launched, the deadline applied, no lock) is
weighed: **the last writer wins**. The heads are read newest first — the
branch's head now, then every push received, after the deadline too — and
each one's writer is one of three:

- **the workspace**: a head the portal declared before relaying it
  (ADR-078 §6), or an earlier collection's commit;
- **neutral**: a bot's push (the App's, a workflow's), one of the App's
  own commits (`bot_commits`), or a commit made on **GitHub's web
  interface** — its committer `web-flow`: an edit there, or a pull request
  merged there, the teacher's sync (§4) among them;
- **a machine**: any other head a person pushed.

The neutral heads are skipped; the first other one decides. The
workspace's: the workspace is collected. A machine's: it is not — the push
is the work handed in, and a workspace left behind never overwrites it,
whether the push came before or after the deadline. None left (no push at
all): collected. A pull request merged on GitHub therefore changes nothing
by itself: over a push from the workspace the workspace is collected, over
a push from a machine it is not. The rule is `headWriter` and
`collectsWorkspace` (`@quiz/domain`), the weighing `hasTwoWritePaths`
(`hybrid` only). A branch's head no receipt names yet is a push whose
receipt is not in, weighed like any; without any person's push it is the
handout, left out. The head the signed commit meets after a 422 is weighed
again the same way.

A skipped repository is recorded and audited like any outcome, as
`last_push_local`, with the head it stood on: before the order nothing is
ordered from the portal; after a 422 nothing is signed (never a
`check_refused`, which flags a failure). A GitHub read that fails is
`failed` (`github_failed`), as anywhere in the collection. `online` and
`online_seb` are unchanged: always collected, nothing weighed.

### 3. The portal is told `online`

The portal knows two modes, lab and exam; `hybrid` is its lab mode exactly.
Quiz sends a `hybrid` project as `online` (`portalMode`), and
`CodespaceAssignmentSync.mode` keeps the portal's two values, so the portal
never parses a value it does not know: no portal change, no deploy order.
The workspace's deadline is `portalDeadline`'s, as for `online`.

### 4. The teacher's update reaches both ways

A sync opens its pull request on a `hybrid` student's repository as in
`free` (ADR-073), and the workspace offers the same update as in `online`
(ADR-132 §11, `takesWorkspaceUpdate`).

### 5. The freeze is `online`'s

The mode freezes at the first workspace launched by a student seat
(`409 work_mode_frozen`, ADR-047 M6-06 (A)): `hybrid` alike. Before it,
`free → hybrid` and `online → hybrid` pass like any change. After it,
`online → hybrid` alone stays open (§7).

### 6. What the student and the staff see

- **The student**: once the project is accepted, the repository on GitHub is
  the page's one primary action (invariant 2); *Open workspace* is secondary,
  under "No tools installed? Work in your browser." and a sentence on what
  the deadline hands in. The project's card keeps GitHub's action.
- **The staff**: the setting's sentence says the collection rule; a skipped
  repository's row says "Not collected: the last push came from a personal
  machine" — the last that counts, a commit made on GitHub skipped —,
  without the `not collected` flag (nothing is missing); the
  workspace section (Resync, open workspaces) is shown as for `online`.

### 7. Widening after a launch, and a workspace that sees local pushes

*Product owner, 2026-11-26; the second delivery.*

**The switch.** After a workspace was launched, `online → hybrid` is
allowed: it only widens what students may do — they keep the workspace and
gain their own git (`widensAfterLaunch`, in `workModeRefusal` and so in
`workModeChoices`: the staff's screen offers Either on a launched online
project, and says it is the only change left). `hybrid → online` and
`hybrid → free` stay refused after a launch (`409 work_mode_frozen`), as
every other change; `free → hybrid` has no launch to freeze it;
`online_seb` is unchanged.

**The invitations already sent.** M6-06 (A)'s "an invitation already sent
keeps the permission it had" is amended: a change of mode to one that
invites with `push` from one that invited with less (`widensInvitations`:
`online → hybrid` above all, before or after a launch, and `online → free`
before one) raises what was already given. In the mode's transaction the
project's access revision is bumped and its `repos_access_job_at` lease
claimed — ADR-145's `project.repos_access` job, the project's one runner
of access on GitHub —, and the job, sent after the commit, brings every
live grant of the project's live repositories up to `push`: an accepted
collaborator by GitHub's collaborator PUT (which changes an existing
collaborator's permission, 204), a pending invitation by its PATCH
(`write`); never lowering a higher permission (`holdsAtLeast`: an owner of
the organization keeps `admin`), never inviting anyone (an account neither
in nor invited gets `push` at its next invitation, like every invitation
sent after the switch). Idempotent and retried: a GitHub failure fails the
pass, the lease is backdated, and the ticker runs it again, which finds the
repositories done already unchanged. Each repository whose access changed
is audited (`project_repo.access_widened`: how many seats and invitations),
never a token. A repository deleted, not live or archived is skipped. A
locked one is not: its lock is a ruleset nobody bypasses (F-PROJ-09,
ADR-130 §9), independent of the permission, so `push` changes nothing on
it until the lock is lifted. A narrowing never takes an access back.

**The portal's refresh.** The portal is told that a project's students may
also push from their own machines: `CodespaceAssignmentSync.refreshOnOpen`
(`hasTwoWritePaths`, true for `hybrid`, sent as `online`), optional, false
when absent — an older platform sends none and an older portal ignores it
(the sync's object is not strict), so the platform and the portal deploy in
either order. When a `lab` session of such an assignment opens — a new
one, a resumed one, a live one reopened — and nothing of the workspace
waits for the relay (a pending push is the student's newest work), the
portal brings the session's `staging.git` up to the student's GitHub
repository (`refreshStagingRepo`): the branches fetched into the portal's
own refs (`refs/quiz/forge/*`, hidden from every push, deleted afterwards),
each staging branch created when missing, moved when it is behind
(fast-forward, a compare-and-swap a student's push wins), left as it is
when it diverged — **never forced**, never deleted, no tag, nothing
relayed. With the token the seeding uses (ADR-078), in the environment
only; a failure leaves the workspace as it was and never refuses the
session. The host runs git on `staging.git`, its own repository, never on
the student's `work/.git` (the portal's invariant 13): the student's work
tree takes the new commits with a pull, which the project page says. A
branch that diverged is the relay's rejection path (ADR-078 §6): the next
push is refused, the relay fetches GitHub's head, and `git pull` merges it
(ADR-130 §7).

## Consequences

- Students with tools keep git; students without them have the workspace,
  on the same repository, with no change of mode.
- A student who pushes from their machine and then edits in the workspace
  without pushing from it hands in the push, not the edits. The page says
  so; the rule keeps a deliberate push from being overwritten.
- A commit made on GitHub's web interface decides nothing: the push under
  it does. A student whose last push came from the workspace and who then
  edits a file on GitHub has the workspace collected over the edit
  (ADR-130 §1 decision 3, "the latest state wins"); one whose last push
  came from a machine keeps the edit. The sync's pull request merged there
  is the case this serves.
- One residual window: a student's first push ever, made after the
  deadline and whose receipt is not in when the order leaves, reads as the
  handout, and the workspace is collected over it. Webhooks arrive within
  seconds, and the order leaves some twenty seconds after the deadline.
- The weighing reads the receipts once, and GitHub once per head a person
  pushed until the first that decides (its committer), for `hybrid`
  repositories only.
- The content of a `hybrid` repository is no more defensible than a `free`
  one's: `hybrid` is never offered under supervision.
- The staff's review session (ADR-129) and the distribution's (ADR-147) are
  unchanged; a `hybrid` repository is reviewed as any.

## Alternatives considered

1. **Always collect in `hybrid`**, as in `online`: the workspace's state
   would overwrite a later push from the student's machine with older work.
   Rejected by the product owner.
2. **Never collect in `hybrid`**: the students without tools, whom the mode
   is for, would lose what they saved and never pushed — what ADR-130 was
   written for.
3. **Compare the workspace's snapshot time with the last push**: the
   portal's snapshot time is the portal's clock and says when files were
   read, not when they changed; the push receipt is the server's.
4. **A third mode on the portal**: a contract change the portal parses,
   hence a deploy order between two machines, for a behaviour identical to
   its lab mode.
5. **Giving `online` the `push` permission**: it would end `online`'s
   single write path for every existing project, where the teacher chose it.
