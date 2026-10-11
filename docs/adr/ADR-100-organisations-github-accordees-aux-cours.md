# ADR-100 — GitHub organizations are granted to courses: who may connect, what the staff may read

## Status

Accepted (2026-10-11, orchestrator of security lot B1, on the product
owner's standing authorization for the audit's fixes; audit finding H1).

Scope: which GitHub organization a classroom may be connected to, what the
connect sheet lists, which repositories a course's staff may make Quiz's App
read, and when the staff are invited to a journal repository.

Relations: amends [D27](../merge/08-decisions.md)
(the accepted risk), F-GH-01, F-GH-02 and F-JRN-03 (`docs/spec/02-exigences-fonctionnelles.md`),
[ADR-057 §7](ADR-057-journal-two-modes.md) (GitHub mode: which repositories,
invitations), and the D27 reference of [ADR-035](ADR-035-fusion-de-classroom.md);
relies on [ADR-054](ADR-054-super-powers-admin.md) (Super Powers) and
[ADR-068](ADR-068-roles-de-l-equipe-du-cours.md) (course roles).

## Context

D27 accepted that any member of a connected classroom's staff makes Quiz's
App read any repository of that classroom's organization. Combined with
F-GH-01 ("connected by any member of its course's staff") and F-GH-02 (the
sheet lists every organization where the App is installed), the risk was no
longer one organization's but the platform's: any teacher account — anyone
who creates a course — could list every installed organization, connect a
classroom to one they have nothing to do with, browse and read its
repositories (other courses' solutions, students' repositories) through the
project source picker, and adopt one as a journal, which invited the whole
course staff as `push` collaborators, an invitation that outlives detaching
the journal. GitHub's own permissions were bypassed through the App.

The App's setup return cannot settle who may use an organization: it has no
session, its `state` is a plain classroom id and its `installation_id` comes
from the query, so anything written there is spoofable. Spec 05's sentence
"the setup return links nothing by itself" stays true.

## Decision

1. **Grants, per course.** A table `github_org_grants (org_id, course_id,
   granted_by, granted_at)`, primary key `(org_id, course_id)`, cascading
   with the organization and with the course, owned by the `github` module.
   A classroom may be connected only to an organization granted to its
   course. The unit is the course, not the classroom: two classrooms of a
   course may use different organizations (F-GH-01), which is several rows.
2. **What writes a grant: the connect, never the setup return.** `PUT
   /app/api/classrooms/:id/github` writes the grant itself, in the same
   transaction as the link, when the organization is not yet granted to the
   course and either
   - the caller's linked GitHub account (F-GH-05) is an active **owner**
     (`role: admin`) of the organization, asked of GitHub at that moment
     through the installation (`GET /orgs/{org}/memberships/{username}`,
     the App's organization `members: read`; GitHub's account id must match
     the linked one); or
   - the caller is an admin with active Super Powers (ADR-054).

   Otherwise the connect is refused `403 org_not_allowed`, nothing written.
   A grant written is audited `github_org.grant` (subject the course,
   `via: owner | super_powers`); a refusal `github_org.link_refused`
   (subject the classroom). A GitHub failure while asking is a refusal: an
   ownership GitHub did not confirm grants nothing.
3. **Revocation.** `DELETE /app/api/courses/:id/github/grants/:orgId`, an
   admin with Super Powers only; refused `409 classroom_connected` while a
   classroom of the course is still connected to that organization (the
   pattern of D28); audited `github_org.revoke`. No administration page:
   the route is named in the administration guide.
4. **The sheet's list is the classroom's.** `GET /app/api/github/orgs` is
   removed. `GET /app/api/classrooms/:id/github` carries `orgs`: the
   organizations the App acts on that are granted to the classroom's course,
   plus those the caller's linked account owns (so an owner can serve
   themselves); every one to an admin with Super Powers; none once the
   classroom is connected. A teacher offered none keeps "Connect to GitHub"
   as the accent and reads one line: "Ask an organization owner or an
   administrator". There is no request workflow.
5. **Inside a granted organization, the grant is the boundary.** The staff
   of a course granted an organization can make the App read **every**
   repository of it: D27 shrinks from "the platform" to "the courses
   granted that organization". As defence in depth, the journal's "use", the
   project source picker's list and the source's reading (and so a
   project's creation) treat as missing a repository Quiz knows as a
   course's — a project's source, distribution or student repository, or a
   journal's (`projects.source_repo_id`, `projects.distribution_repo_id`,
   `project_repos.github_repo_id`, `classroom_journals.github_repo_id`) —
   when the caller holds a seat on **none** of the courses it is known for.
   The same course, or another course the caller teaches, stays allowed:
   reusing last year's journal (F-JRN-03) is the normal case. A caller with
   Super Powers is not filtered. The refusal is the one of a missing
   repository (`409 repo_not_found`, a 404, `422 source_not_found`), as
   invariant 6 wants.
6. **No invitation on "use".** The staff are invited as `push`
   collaborators only to a repository Quiz created for the classroom
   (`journal.create`), never to one chosen with "use" (`journal.use`).
   Invitations already sent on "use" are not revoked by the platform, which
   never writes into a chosen repository (ADR-057); the product owner lists
   them from the audit log and revokes by hand.
7. **At deploy.** The migration (`0106_github_org_grants`) grants every
   course the organizations its classrooms are already connected to, granted
   by the earliest link's author at that moment, so nothing breaks; it
   thereby also legitimizes any link made through the hole, which is why the
   `github_org.link` audit entries are reviewed before production. The demo
   seed connects no classroom, so it writes no grant. The heig-classroom
   import (F-PROJ-20) writes none either: its classrooms are connected
   beforehand by an owner of the organization or by an admin, which grants
   their courses. Staging, refreshed from production, carries grants of
   organizations whose installation is cleared (N-SEC-18): harmless, the App
   acts on none of them.

## Consequences

- A grant carries over the years: next year's classrooms of the course
  connect with no further check.
- An assistant added to the course later inherits its grants, like its
  classrooms (ADR-068).
- A new course has no grant: its first connect needs an owner of the
  organization with a linked GitHub account, or an admin.
- The owner check needs the App's organization permission `members: read`,
  which the manifest already asks for (`apps/api/src/github/manifest.ts`);
  an installation that has not approved it answers 403, and the owner is
  then refused until an admin connects.
- The sheet's list costs GitHub calls: the installations' listing, once a
  minute whoever asks, and one membership read per installed organization
  not granted, per linked account, kept a minute; a connect asks afresh.
- Residual risk, accepted: inside a granted organization, every member of
  the course's staff makes the App read any repository Quiz does not know as
  another course's — a repository created outside Quiz, or one of a course
  that no longer exists in Quiz, included. The staff of two courses granted
  the same organization share that reach; the defence in depth of §5 only
  hides the repositories Quiz knows to be the other course's.
- A renamed GitHub account is not recognized as an owner until its link
  follows the rename (a false negative only: GitHub's id is compared).

## Alternatives considered

- **Granting at the setup return** with a signed `state` carrying the
  course: the return has no session, and whoever installs the App is not
  necessarily a teacher of that course; it would also make the install link
  a bearer of rights. Rejected; the connect, under `staffAccess`, decides.
- **Granting per classroom**: every year's classroom would need the check
  again, and F-GH-01 already lets two classrooms of a course differ. The
  course is the unit of the staff.
- **Checking the caller's own GitHub rights on each repository read**: the
  platform holds no user token (F-GH-05, N-SEC-16), and asking GitHub per
  read would make the picker depend on each teacher's linked account.
- **A request-and-approve workflow for teachers who own nothing**: no
  demand yet; the line in the sheet names who can open an organization.
