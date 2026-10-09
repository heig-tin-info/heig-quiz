# ADR-075 — The workspace question: an advanced exam question worked in the online workspace, collected by the server

## Status

Proposed (2026-10-05), on the product owner's decisions of the same day and
the spec challenge. Accepted when the product owner settles the open points
of [question 52](../spec/06-questions-ouvertes.md). Nothing is implemented:
`apps/codespace` itself is not present (M6 is `todo`).

Scope: a new question type, `qt-workspace`, worked in the online workspace
of a **supervised evaluation**; how its file is collected, graded and
cleaned up.

Relations: depends on [ADR-047](ADR-047-espace-de-travail-en-ligne.md) (the
portal, its two HS256 messages) and extends it from projects to evaluations;
ADR-047's `work_mode` of a project is untouched. Reuses
[ADR-016](ADR-016-runner-sur-vm-separee.md) (the runner) for grading,
[ADR-027](ADR-027-tickets-de-lancement-et-sessions-typees.md) (`seb`
sessions, the signed-token exception) and
[ADR-051](ADR-051-postes-kiosque-attestes.md) (`kiosk`). Amends
`docs/spec/01-glossaire-et-domaine.md` (Online workspace),
`docs/spec/00-cadre-et-perimetre.md` §0.6 and F-PROJ-19. The `code` type
([ADR-015](ADR-015-execution-navigateur-correction-serveur.md)) is unchanged.

See also [ADR-089](ADR-089-kiosque-pour-l-espace-de-travail.md)
(proposed, 2026-10-09): kiosk stations for `online_seb` projects, which
frame the portal from Quiz. §11 below still governs the kiosk for this
question in evaluations.

## Context

The `code` question (04 §4.7) is one Monaco editor over a locked template,
run in the browser (WASI) or in the runner. It cannot offer what an advanced
exam needs: several files, a real compiler and a debugger, the workflow of a
developer. The merge brings a VS Code workspace (`apps/codespace`, ADR-047,
`docs/merge/06-codespace-seb-infra.md` §6.2), built for projects: one
long-lived hardened container per student and assignment, a git channel to
GitHub, a per-teacher quota of sessions.

The product owner decided on 2026-10-05: an advanced question opens that
workspace with a compiler, and the server collects a file at the end;
**supervised exams only** (SEB or kiosk), never exercises; graded by the
teacher's tests run by the existing runner on the collected file, as a
**proposed** score the teacher validates or corrects.

Constraints:

- The glossary says the workspace is never a "session" and ties it to
  projects; 00 §0.6 and F-PROJ-19 scope it to projects.
- Invariant 4: content reaches a student only through `toStudent`. A
  workspace volume is a second exit if anything but the student view seeds
  it.
- Invariant 5: the server owns the clock. The codespace is a separate
  process on another VM; it must never decide when an attempt ends.
- Invariants 10–14 bind `apps/runner`. `apps/codespace` has two sanctioned
  divergences (a persistent work volume, a git channel on an internal
  bridge). An exam workspace needs the first and **not** the second.
- Invariant 14 (spirit): what is graded is fetched by the server, never
  uploaded by a client.
- Capacity is about 2 sessions today; M6-05 will measure the engine VM. An
  exam puts a whole class on it at once.

## Decision

1. **A new type, `qt-workspace`** (`packages/qt-workspace`, id `workspace`),
   registered through both registry entry points (`./server`, `./client`);
   `core` imports nothing from it. It is not a mode of `code`: the player
   (a link to the portal and a status), the answer (a blob reference, not
   regions) and the grading flow differ. It reuses `code`'s test-case shape,
   comparison rule and the runner; how it shares that code without one
   `qt-*` package importing another is decided by M6-09 (an export of
   `packages/core`, or `packages/domain` for the pure part).
2. **Supervised evaluations only.** Publication refuses the type in an
   exercise, a poll, a drill, a practice and an exam that requires neither
   SEB nor kiosk (`workspace.requires_supervision`). An evaluation that
   holds a question of this type cannot drop its supervision afterwards.
3. **One workspace per attempt, not per student.** It is created when the
   student opens the question (a launch token minted by Quiz, ADR-047 §6),
   keyed by attempt and item; another attempt gets a fresh volume. No
   student appears in a per-teacher quota: the quota of classroom's projects
   does not apply to exams. Until M6-05 measures the engine VM, an
   evaluation holds **at most 30 workspaces** (`workspace.capacity`, checked
   when the evaluation is opened).
4. **The seed is the student view of the question.** The volume receives the
   teacher's template (locked regions kept), the extra files and the
   **visible** cases only. Hidden cases and the reference solution never
   enter the volume. The seed payload is built from `toStudent`'s output and
   nothing else (invariant 4). A test passes a fully configured question
   through the seed builder and searches the serialized payload and the
   resulting file tree for the hidden `stdin`/`expected` values and the
   reference solution (05 §5.7).
5. **No git channel, network closed.** An exam workspace is created in a
   portal mode that opens no git channel and attaches no network
   (`--network none`, like the runner): the divergence "git channel on an
   internal bridge" does not apply, and collection never uses git. The one
   divergence kept is the writable work volume, a volume of this attempt,
   destroyed after collection (§8). No credential enters the container
   (invariant 10) and no GitHub App is involved.
6. **Quiz owns the clock; the codespace never decides.** At the attempt's
   deadline **plus 3 s** (invariant 5, the ticker of ADR-006) Quiz orders
   the portal to **freeze** the workspace and **collect** its file through an
   HS256 service token (the M6-01 contracts, a new `workspace.freeze`
   message), as a pg-boss job with a singleton key per attempt. Freezing
   makes the editor read-only and stops the container's processes. The
   deadline is the **attempt's** own, accommodations and extra time
   included: a student with extra time is frozen later, and a reconnect
   never moves it. A student's own hand-in orders the same freeze. The
   portal keeps no timer of its own beyond a safety cap (a workspace older
   than the evaluation's longest possible duration plus a margin is frozen
   and flagged, not collected).
7. **The server pulls the file; the client never uploads.** Quiz calls a
   signed portal endpoint (service token, single use) that returns the one
   collected file, or a tar of the paths the teacher declared, capped in
   size (a path from a request is a name, never a path). Quiz stores it as
   a blob and writes the **answer as a blob reference** with a
   **server-stamped hash** (SHA-256 of the received bytes) and the server's
   receipt time. A failed collection is retried by the job; when the retries
   are exhausted the answer is empty and flagged for the teacher
   (`details.reason: collect_failed`), and the volume is kept until a human
   decides (the one exception to §8).
8. **The volume is destroyed after collection**, once Quiz has stored the
   hash. The student keeps nothing: no repository, no export, no copy, and
   the workspace address is dead after the freeze.
9. **Grading: the teacher's tests on the existing runner, a proposed
   score.** After the close, `grade` returns a pending runner request like
   `code` (two-phase pattern): the server rebuilds the program from the
   teacher's template and the collected file (a source, never an
   executable; invariant 14), runs **all** cases, visible and hidden, in
   `apps/runner` and derives the points from them. The result is
   `state: proposed`; the teacher **validates or corrects** it in the
   grading panel (ADR-044), which shows the collected file beside the case
   verdicts. A compile failure proposes zero. No file earns a validated zero
   (`reason: empty`). An unavailable runner is handled as for `code`.
10. **Portal down means no workspace.** The portal's health is a check of
    the system status (ADR-055). When it is down at the evaluation's
    opening, the evaluation does not open for this question and the teacher
    is told; the teacher may swap in the in-browser `code` question as the
    fallback. When the portal fails mid-exam, the container survives (it
    does not need Quiz) and the deadline freeze retries until it succeeds;
    the teacher sees the incident.
11. **SEB and kiosk.** The evaluation's `.seb` filter adds the codespace
    host when it holds a workspace question (06 §6.3, D21); a `seb` session
    mints the launch token with its `seb: {configKey}` claim and the portal
    checks it. A `kiosk` session reaches the portal across hosts only after
    **proof B** on the unified flow (M6-07) and a check of the cross-host
    cookie; until then the type is refused on a kiosk-only evaluation. The
    launch token grants no role.
12. **Audit and student payloads.** The audit union gains
    `workspace.launch_issued`, `workspace.frozen`, `workspace.collected`,
    `workspace.collect_failed` and `workspace.destroyed` (by attempt, never
    a token or a path). The student view carries the question's status and
    its launch link, never the hidden cases, the reference solution, the
    hash or a blob id.

## Consequences

- Exams can test real development work; projects and exams share one
  codespace infrastructure, one image, one engine, one seccomp profile.
- The portal joins the exam's critical path for this question only; the
  `code` question stays the dependency-free fallback.
- The portal gains a second mode (no git channel, no network, freeze and
  collect) and one message; the `apps/codespace` `CLAUDE.md` records that
  the exam mode drops the second sanctioned divergence.
- Hidden-case secrecy holds by construction (the seed is the student view),
  not by trust in the portal.
- Capacity is the hard limit: 30 per exam is a ceiling, not a measurement,
  and M6-05 may lower it. A class larger than the ceiling is split into
  sittings until then.
- A one-file answer is graded by tests that assume one program. A
  multi-file question is a later extension: the tar form exists, the
  rebuild rule for several files is not settled (question 52).
- Costs: a package, a portal mode, a job, a contract, an editor and a
  player, and proof B before any kiosk use.

## Alternatives considered

1. **A mode of `qt-code`** (`runtime: workspace`). Rejected: the answer
   shape, the player, the supervision requirement and the collection flow
   all differ, every `code` call site would branch on the mode, against the
   one-concept-per-type rule of ADR-021.
2. **The client uploads its file** at the end. Rejected: the browser would
   decide what is graded and when, a late or altered upload would race the
   deadline, and the server fetches what it grades (invariant 14).
3. **Collection through a git push** (the project flow of ADR-047).
   Rejected: it needs the git channel this ADR removes, a GitHub App and a
   repository per attempt, and it leaves the student a copy of the exam.
4. **A per-student volume** reused across attempts and evaluations.
   Rejected: a previous attempt's files would leak into the next, the
   absence of hidden cases could not be guaranteed, and the volume would
   outlive the exam. The unit that matters is the attempt.
5. **The portal decides the end of the exam** from its own timer. Rejected:
   invariant 5; accommodations and a teacher's manual closing live in Quiz
   only.
