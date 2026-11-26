# ADR-147 — The distribution repository opened in the workspace by an owner, and reviews in the project's image

## Status

Accepted (2026-11-26, product owner: §1, §2, §3, §6 and the risks of §8,
answered the same day; the model of §4–§5 and §7 is the orchestrator's,
stated in this record). Delivery progress lives in `changes/`.

Scope: an owner's read-only workspace session on a project's distribution
repository (who, when, the launch, the token grant, the portal's
assignment), and which image every staff review session runs. Not the
students' sessions, not a write path, not the deadline collection's reader.

Relations: amends [ADR-129](ADR-129-depot-ouvert-par-l-equipe-dans-l-espace-de-travail.md)
§2, §4, §5, §6, §9, §10 and §11 (a second kind of review target; reviews
run the project's image); amends [ADR-078](ADR-078-codespace-git-relay-tokens.md)
§2 check 3 and §12 (a staff read grant on the distribution in every mode)
and §9 (the blast radius); reverses, for review sessions only,
[ADR-146](ADR-146-images-publiques-de-l-espace-de-travail.md) §3 and the
sentence of §9 "Decision 3 keeps the staff's review sessions out of it";
reads [ADR-127](ADR-127-etat-planifie-des-projets.md) (the scheduled state),
[ADR-068](ADR-068-roles-de-l-equipe-du-cours.md) (owner and assistant),
[ADR-062](ADR-062-depot-de-distribution.md) (the distribution repository),
[ADR-054](ADR-054-super-powers-admin.md) (Super Powers),
[ADR-047](ADR-047-espace-de-travail-en-ligne.md) rule 4 (the grant);
leaves [open question 70](../spec/06-questions-ouvertes.md) open.

## Context

The product owner, 2026-11-26: *"Pour tester l'image on peut peut-être
rajouter sur un travail schéduled. Une icone pour voir l'espace de travail
sur le dépot squashed. Comme ça même en scheduled je peux lancer
l'environnement et tester de build pour voir."* Then, on ADR-146 §3: *"la
règle du 25 novembre pose un problème il faut la changer"* — the rule that
review sessions, like the collection's reader, always run `quiz-base`,
never a course image.

What exists bears on it:

1. A course image (ADR-146) is picked per project and admitted by the
   portal, but nothing lets a teacher run it before a student does: the
   staff's review session (ADR-129) opens a student's repository only, and
   runs `quiz-base`.
2. A draft or scheduled project has a distribution repository (ADR-062) and
   no student repository: no session of any kind can open on it today.
3. The review session already has everything a read-only session needs: its
   own audience and route on the portal, a read token through ADR-078's
   route, a staging repository that refuses `git-receive-pack`, a volume
   wiped at close, one live review per staff member and a cap per quota
   holder.

## Decision

### 1. A read-only session on the distribution

*Product owner, 2026-11-26.* An owner opens the project's distribution
repository in the online workspace: it builds and tests, may commit
locally, and nothing goes back to GitHub. The distribution changes only
through Sync (F-PROJ-12). The session tests what the students receive, on
the handed-out default branch (`projects.branches[0]`), not the source's
latest edit; v1 shows no staleness warning.

### 2. Who

*Product owner, 2026-11-26.* **The course's owners only**, by the existing
rule and no new one: the loader reaches the project through `staffAccess`
(anyone else the 404 of a missing project, invariant 6), then
`requireCourseRole(owner)` answers an assistant `403 owner_required`
(ADR-068). That rule makes an administrator with active Super Powers an
owner (`effectiveCourseRole`, ADR-054), so they may open it too. From the
caller's own portal session only, as ADR-129 §4 says for every review. The
page shows the action to an owner only (`ProjectWorkspace.distributionReview`,
computed by `isCourseOwner`, the same rule). ADR-129's repository reviews
keep their reach: any staff seat, or an administrator with Super Powers.

### 3. When

*Product owner, 2026-11-26.* **In every unarchived state**: draft,
scheduled, published, locked or closed, `online_seb` included, whatever the
work mode. One pure rule of `@quiz/domain`, `distributionReviewRefusal`,
for the launch, the token route and the page, sharing its first two rows
with `staffReviewRefusal`:

| # | Condition | Answer |
|---|---|---|
| 1–3 | As ADR-129 §5 rows 1–3, on the project | `401`, `403`, `404` |
| 3d | A staff seat that is not an owner | `403 owner_required` |
| 4 | The quota holder holds no enabled workspace grant | `409 review_not_granted` |
| 5 | The classroom or the project is archived | `409 review_archived` |
| 6 | No distribution repository built (its name or GitHub id not stored) | `409 review_distribution_missing` |
| — | Otherwise | `200 { url }` |

On the page the action is absent for rows 4–6 and for a caller who is not
an owner.

### 4. A second target of the review session

*The orchestrator's model.* The distribution session **is** a review
session of ADR-129 with another target, keyed by the project, since the
distribution has no `project_repos` row:

- **Route**: `POST /app/api/projects/:id/workspace/distribution`, a
  session write, no body, `{ url }` with `Cache-Control: no-store`, the
  portal's `/review?token=…`.
- **Record**: `codespace_distribution_reviews` (`user_id`, `project_id`,
  `grant_until`), the twin of `codespace_reviews`, the same window
  (`REVIEW_GRANT_MINUTES`, ADR-129 §6).
- **Token**: `ReviewLaunchTokenClaims` with `projectRepoId: null`; `repo`
  is the distribution and its handed-out default branch. A portal older
  than this record refuses the null, so the session never opens as some
  repository's review.
- **Portal**: assignment `review-dist-<projectId>` (the reserved `review-`
  prefix, so the sync's `400 reserved_id`, the wipe at close and the
  startup sweep of ADR-129 §10 apply unchanged), `reviewOf: { projectId,
  projectRepoId: null }`. One review slot per staff member: opening the
  distribution closes their other review and the reverse; the holder's
  `REVIEW_SESSIONS_PER_HOLDER` cap and quota count it.
- **Never** marks the project launched, writes `codespace_launches`, asks a
  sync or freezes the work mode (ADR-129 §5). Read-only staging as ADR-129
  §10.

### 5. The token grant

`GitTokenRequestClaims` gains `reviewDistribution: true`, never beside
`reviewRepoId` (the contract refuses both). A request carrying it is
decided after check 1 by: (1) a fresh `codespace_distribution_reviews` row
of this user on the request's project; (2) the user's **ownership**
re-read now (`userOwnsCourse`: Super Powers held in a session of their
own, or an owner seat while the stored role is staff), so a grant never
outlives the owner seat; (3) the stored `distribution_full_name` equals the
request's `repository`; (4) `distributionReviewRefusal` on facts read now —
`review_not_granted` and `review_distribution_missing` → `404 not_found`,
`review_archived` → `409 closed`; (5) GitHub, `503`. The grant is
`contents: read` on the stored `distribution_repo_id`, `useUntil` =
`expiresAt`. No relay declaration exists for it.

### 6. Every review runs the project's image

*Product owner, 2026-11-26, reversing ADR-146 §3 for reviews.* Both kinds
of review session run the project's image: the digest in service of the
course image the project picks (`codespace_projects.image_id`), carried in
the review token's `image` claim; null — the default, `quiz-base` — for a
project with none and for a `free` project. An image the portal has not
admitted refuses the start with the portal's existing page (worded for the
staff: the course's Images tab). The deadline collection's confined
reader, the review wipe container and the admission container stay on the
default: they are the platform's runs, not sessions.

### 7. Audit

A new member of the closed union, `codespace.distribution_review_launched`:
subject the project, payload `{ repository, jti, reach, image }`, never
the token. Each grant writes `codespace.git_token_issued` with
`permission: "read"` and `reviewDistribution: true`.

### 8. The residual risks, accepted by the product owner (2026-11-26)

ADR-129 §9 and ADR-146 §9 stated the shared-origin risk (audit L24). This
record widens it on two points, both accepted in writing:

- **(a) A course image reaches a staff member's browser across courses.**
  A course image controls what code-server serves on the shared origin
  (`code.chevallier.io`, beside `quiz.chevallier.io`); a staff member's
  review or distribution session of course A now runs A's image, and the
  same browser may hold their sessions of course B (a test workspace, a
  workspace of their own). ADR-146 §9 bounded that reach to one course's
  own sessions; it no longer is.
- **(b) Student content in a staff browser.** A review session in an image
  that brings notebook support back renders a student's notebook outputs
  in the staff member's browser.
- ADR-129 §10's mitigation, *automatic tasks off*, is the image's machine
  settings: a course image's author can defeat it, and the admission checks
  (ADR-146 §5) catch accidents, not the author.

The fix stays one origin per session, [open question 70](../spec/06-questions-ouvertes.md)
(issue #1217), now also the prerequisite for removing risk (a).

### 9. The web

An icon button beside the distribution repository's link, on the draft and
scheduled page's *Work handed out* card and the published page's *Source*
tile, labelled *Open in workspace, read-only* / *Ouvrir dans l'espace de
travail, en lecture seule* (German and Italian beside them). Secondary; the
page's primary action is unchanged (invariant 2). Its state is
`ProjectWorkspace.distributionReview` and `distributionReviewRefusal`
applied to the page's facts, never a second derivation. A refusal is shown
by its code.

## Consequences

- An owner tries a lab, its tests and its course image before the students
  receive it, in a draft or a scheduled project.
- **Blast radius (ADR-078 §9).** A compromised portal may also obtain read
  tokens on a project's distribution within the window after an owner
  launched a session on it, while that owner's ownership holds, in any mode
  and state — contents the students of a published project already read;
  in a draft or scheduled project, the handout before publication.
- Reviews and distribution sessions share one slot per staff member and the
  holder's cap: a teacher testing the image takes one of the holder's two
  review places.
- One table and one migration in the API, one audit action, no portal
  migration (`reviewOf` is JSON), no new secret.

## Alternatives considered

- **A new session kind with its own audience and route on the portal.**
  Rejected: everything a read-only session needs is ADR-129's; a second
  kind would duplicate the quota, the wipe, the sweep and the read-only
  staging.
- **Extend `codespace_reviews` with a nullable repository and a project
  column.** Rejected: a nullable member of the primary key and a check
  constraint, for a row the token route reads by another key anyway.
- **Open the source repository instead.** Rejected: students receive the
  distribution (protected files, the squash); the session tests that.
- **Any staff seat, like a repository review.** Rejected by the product
  owner: owners only.
- **Keep reviews on `quiz-base`.** Rejected by the product owner: a lab
  whose toolchain is in the course image cannot be built in `quiz-base`.
