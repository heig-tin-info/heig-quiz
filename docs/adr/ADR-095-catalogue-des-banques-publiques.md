# ADR-095 — Public pool catalogue: subscriptions, read-only course links, unpublishing

## Status

Accepted (2026-10-10, product owner, issue #680; the six defaults of the review confirmed the
same day). Delivery progress is in `docs/merge/PROGRESS.md` and `changes/`.

Scope: how a teacher finds and follows a colleague's public pool, how a course draws from it
without making its staff contributors, and what taking a pool out of the catalogue ends.

Relations: amends [ADR-013](ADR-013-partage-des-pools.md) §2 (who reaches a pool is unchanged,
what a teacher's list shows is not) and §3 rule 3 (course staff are contributors through an
`edit` link only); supersedes the wording of F-POOL-06 (open question 9); uses the gateway of
[ADR-058](ADR-058-passerelle-llm.md), the nightly cadence of
[ADR-060](ADR-060-revue-llm-des-questions.md) and the normalisation of
[ADR-081](ADR-081-vocabulaire-de-notions.md).

## Context

A public pool showed in every teacher's pool list: noise, and the only way to use a colleague's
questions was to be invited or to copy them (copies diverge, their statistics restart). A course
can only draw from pools linked to it (`coursePoolIds`), and linking takes `contributor`
because a link makes the whole staff contributors (rule 3 of ADR-013): a teacher could read a
public pool but never use its questions.

## Decision

1. **"My pools" is a shelf, not the reach.** `GET /pools`, MCP `list_pools`, the assistant's
   `userPools` and the SSE `pool:` topics list the pools the caller owns, sits on, reaches
   through a linked course (either mode) or subscribed to (`myPools` in `guards.ts`). Reach
   itself (`poolAccess`) is unchanged: every teacher still reads any public pool, and
   `find_similar_questions` and the similar-question search still span all of them.
   `canLink` is true for a public pool.
2. **Subscriptions** (`pool_subscriptions(pool_id, user_id, created_at)`, PK on the pair, the
   pool module's table). Any teacher may subscribe to a public pool they neither own nor sit
   on; it joins their shelf and nothing else changes — never a `pool_members` reader row, which
   would enter the succession by seniority (ADR-013 §5), flip the visibility and clutter the
   roster. Idempotent; `409 pool_not_public` for a pool that is not public, `409 already_member`
   for its owner and members. Audited `pool.subscribe` / `pool.unsubscribe`.
3. **Subscribers are listed by name only**, to the owner and the members of the pool (an admin
   under Super Powers reads as an owner): no id, no address, no avatar, so `seesUser` (ADR-013
   §7) is not widened. The owner cannot remove one: the subscriber would still read the public
   pool. A card shows a discreet counter (lucide `users`, never a star, which means question
   favourites in ADR-040) of subscribers plus members, on public pools only.
4. **Link modes.** `course_pools.mode` is `edit` (the default, as before) or `read`. Course
   staff are contributors only through an `edit` link; a `read` link makes them `reader`.
   Rule 3 is resolved in one place, `linkedCourseStaff(match, mode?)`: `poolAccess` and the
   derived visibility read any link, the role facts and `poolRoleOf` read `edit` only.
   - Any owner of a course may create a `read` link to a public pool they reach, without
     subscribing. A `read` link to a pool that is not public is refused (`409 pool_not_public`).
   - A NEW `edit` link, and the upgrade of a `read` link to `edit`, still need `mayLinkPool`
     (`contributor` or above on the pool).
   - `PUT /courses/:id/pools` carries `{ poolId, mode }[]`. A link already there keeps its mode
     unless the body asks for a stronger one; a pool sent twice takes the stronger.
     Downgrading is done by unlinking and linking again.
   - Unsubscribing does not drop a link. `moveQuestions` keeps an existing `read` link `read`.
     MCP `link_pool_to_course` gains `mode` (default `edit`, as before).
   - Audit: the `course.pools_update` payload records each link's mode (`links`).
5. **Unpublishing** a pool (`PATCH isPublic: false`). The owner first reads a count
   (`GET /pools/:id/unpublish-impact`): the subscribers, the courses linked `read`, and the
   templates of those courses that use the pool's questions. Nothing to count, nothing to
   confirm. Unpublishing then, in one transaction, drops the `read` links and all
   subscriptions; once committed it notifies each subscriber and the owners of each read-linked
   course (`pool_unpublished`, one kind with three sentences: `unpublished`, `course`,
   `deleted`) and closes their streams (`accessRevoked`), as `removeMember` does. `edit` links
   survive: they were granted by someone who could edit. Evaluations keep their pinned
   versions; the templates of the read-linked courses will report `template_pool_unlinked`
   (422) when instantiated next year, which is why the confirmation counts them.
   Deleting an unused public pool tells its subscribers the same way (state `deleted`). The
   notification carries no pool id: the pool is gone or out of reach.
   `pool_question_added` stays members-only: a subscriber is not told of new questions.
6. **The catalogue** is a panel of the pools page listing `is_public` pools only, regardless of
   Super Powers, with the owner beside each name. Its search covers the name, the description,
   the inferred domain and the `labelFr` and `labelEn` of the concepts of the pool's
   published, non-deleted questions, with the `similarityTerms` normalisation of ADR-081 and
   `ILIKE`, no `pg_trgm` (tests run on PGlite). The ranking is subscribers plus members, then
   `usedCount`.
7. **The domain** of a pool is one short label in both languages (`domain_fr`, `domain_en`),
   inferred by the model from the concept labels of its published questions (purpose `domain`,
   ADR-058 gateway), recomputed when the pool is published and by the nightly job (ADR-060
   cadence), never on every edit. Only concept labels are sent (open question 43). It is shown
   on the card and in the catalogue; the owner does not edit it.
8. **Consequences kept on purpose.** ADR-017 refuses a move out of a pool whose question a
   classroom the owner does not reach plays, so a subscriber's classroom can block a move. A
   pool whose versions are pinned anywhere cannot be deleted (F-POOL-09).

## Consequences

- Teachers lose the public pools they never followed from their shelf at the upgrade; the
  catalogue finds them again. Pools linked through a course stay.
- A subscriber to a pool is not told of its changes; the owner learns who follows by name only.
- Rule 3 has one implementation to keep; a new link mode only needs the `mode` argument.
- One more LLM flow (open question 43) and one more nightly pass, bounded by the gateway's cap.

## Alternatives considered

- **A `reader` row in `pool_members`.** Rejected by the product owner: succession, visibility
  and roster side effects (above).
- **Copying the pool's questions.** Statistics restart and copies diverge; this is the status quo
  the catalogue replaces.
- **A closed list of domains.** Rejected by the product owner; the domain is inferred and
  free.
- **`pg_trgm` for the search.** Not available on PGlite, and a normalised `ILIKE` over a few
  hundred public pools is enough.
- **Dropping every link on unpublishing.** Rejected: an `edit` link was granted by a writer of
  the pool, who may keep working in it.
