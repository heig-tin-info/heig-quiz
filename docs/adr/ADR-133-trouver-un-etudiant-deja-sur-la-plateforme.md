# ADR-133 — Finding a student already on the platform

## Status

Proposed (2026-11-18). The principle is the product owner's (2026-11-17):
search within the teacher's own institution, never across. Points 1, 3, 4
and 7 below were assumed by the orchestrator, to be confirmed by the owner
before production; staging runs them meanwhile.

Scope: the manual add of the "Add students" sheet, and the name of a roster
line added by its address alone.

Relations: amends [F-ORG-04 and F-ORG-05](../spec/02-exigences-fonctionnelles.md#f-org-courses-classrooms-rosters)
and point 1 of the [ADR-053 addendum of 2026-10-11](ADR-053-retrait-des-codes-d-entree.md#addendum-2026-10-11-a-line-is-attached-only-when-the-person-acts);
reads [ADR-111 §2](ADR-111-admission-a-la-connexion.md#2-who-is-admitted),
[ADR-030](ADR-030-canaux-de-notification.md) (its amendment of 2026-10-28,
the institutional address), [ADR-117 §3](ADR-117-pseudonymisation-d-un-compte-sur-demande.md),
[ADR-113](ADR-113-portee-des-jetons-personnels.md), [ADR-080](ADR-080-assistant-enseignant.md),
[ADR-034](ADR-034-agir-en-tant-qu-etudiant.md), [ADR-054](ADR-054-super-powers-admin.md)
and [ADR-018](ADR-018-vue-etudiant-reelle.md); open question 74 of [06](../spec/06-questions-ouvertes.md).

## Context

The manual add asked for a last name, a first name and an address. The
names typed there stay on the line forever (the claim never touches them),
and they may disagree with what Switch edu-ID will say of the person. When
the student already signed in once, the platform knows their name: the
teacher should find them rather than type them.

A search over every account was avoided so far: once the platform is open
to every HES-SO school (`LOGIN_DOMAINS`, ADR-111), any teacher could list
anyone the platform knows. The owner's answer: a teacher may institutionally
know the name of every student and employee of their own school, so the
search is fine inside the teacher's tenant, and only there.

No column stores an institution. The affiliation edu-ID releases is scoped
`hes-so.ch` for every HES-SO school (F-AUTH-02), so it cannot tell two
schools apart, and `LOGIN_DOMAINS` is an admission list, not a tenant.

## Decision

1. **The tenant is the school** (assumed). The one per-school signal is the
   domains of the institutional addresses the LAST login asserts:
   `institutionalAddressesOf(user_idp_claims.claims)`, the rule of
   `notifications/address.ts` (ADR-030, amendment of 2026-10-28), not
   `user_emails.source`, frozen at first sight. The caller's tenant is that
   set of domains, matched exactly as ADR-111 §2 does (`heig-vd.ch` never
   admits `mail.heig-vd.ch`); a candidate qualifies by the same rule on
   their own claims. A caller with no institutional address gets no search,
   only the address path. Whether the tenant should be HES-SO as a whole is
   open question 74.
2. **Matched and returned.** A search matches the given name, the family
   name and the candidate's school addresses in the caller's tenant, never
   `users.email`: the login address is often private, and matching it would
   tell whether a private address has an account, and whose. A result is the
   name and one such school address: no account id, no picture, no last
   sign-in, no GitHub login. A search takes three characters, blanks and
   accents aside, and offers ten people at most. Left out: pseudonymized
   accounts (`anonymized_at`), accounts without claims (the heig-classroom
   placeholders), dormant ones (`inactivity_notified_at`, ADR-117 §3),
   anyone who claimed a line of this roster or whose school address (in the
   tenant) is on it, and the course's staff (they take a seat through *Join
   as student*, ADR-018). Never by another address of the person: a line
   under a private address would otherwise remove its holder from the
   results, and so tell whose address it is. Two pending lines of one person
   end as a claim conflict (AU-21), as any other two.
3. **Who may search** (assumed). A caller whose role holds in its own right
   (an admin, a teacher grant, a staff affiliation), never by a course seat
   alone: a student assistant seated on a course does not search the school.
   From the caller's own `portal` session only: no personal token (ADR-113),
   no MCP, no help assistant (ADR-080), no impersonation (ADR-034). Super
   Powers (ADR-054) do not widen the tenant. The classroom is loaded first
   by the staff loader (invariant 6). A caller who may not search finds
   nobody (an empty list, the sheet unchanged) and adds by address; a pick
   they send is refused, `403 student_search_unavailable`.
4. **The name at the claim** (assumed). A line's names are the staff's: a
   typed or imported name is never overwritten, and official names keep
   coming by CSV. The claim fills only a line whose name is blank, from the
   account's name. Existing lines are not migrated.
5. **Names optional in the manual add.** The sheet asks one field, "Name or
   e-mail", plus the extra time. A picked result writes its name and school
   address; an address typed with no result writes a nameless line. The CSV
   import and the pasted list are unchanged. A nameless line is shown as its
   address by every staff reader: `displayName` (`@quiz/domain`) in the web
   app, its SQL encoding `staffShownNom` (`db/org.ts`) in the API readers.
   Never by a student reader (invariant 4): the students' group view sends
   a nameless classmate with a blank name, counted in their group, and shows
   "Name to come".
6. **A line added from a result stays pending.** The staff action writes no
   `user_id`; the person's next own request claims the line, as every other
   (ADR-053 addendum §2). The pick is the school address, and the server
   checks it again against the same filter: the client cannot add, by a
   pick, anyone the search would not have offered it (`404
   student_not_found`). An address typed gets the same answer whatever
   account it belongs to: the path never reads an account.
7. **The privacy page** (assumed wording) says, under "Who sees what":
   teachers of your school can find you by name and school address to add
   you to a class.
8. **"Fuzzy"** is case-, accent- and word-order-insensitive: every typed
   word appears in the name or the school address. No typo tolerance, and no
   Postgres extension (PGlite runs the real migrations): the database
   prefilters with `translate()`, the pure rule (`studentSearch.ts` of
   `@quiz/domain`) decides.
9. **Audit.** Each line added by hand is `roster.add`, with the address and
   whether it was picked. A search is not audited, as the teacher picker's.
10. **Homonyms.** Every result shows its school address, and a pick only
    fills the field: the line is added by the button, never by Enter on the
    first match.

The search is its own function (`org/studentSearch.ts`), not the staff
directory (`directory.ts`), where a student still never appears.

### Amendments

- **F-ORG-04** (2026-11-18): one student may also be added by hand, by
  their name if they already signed in, or by an address alone.
- **F-ORG-05** (2026-11-18): "the roster shows nothing of any account"
  holds, save the name and the school address of a line picked from the
  search, which the teacher picked.
- **ADR-053 addendum, point 1**: a line added from a search result is a
  staff write and attaches nobody. It carries the account's name, which the
  teacher saw in the search; nothing else of the account.

## Consequences

- `user_idp_claims`, documented as read once (`db/auth.ts`), gains a second
  server-side reader. It still never leaves the server: what a search shows
  is a derived school address, never a claim.
- The search scans the accounts with claims, prefiltered in SQL; the
  platform holds thousands of accounts, not millions. A larger platform
  would want an indexed column of school domains. The prefilter reads at
  most 100 accounts before the domain rule decides, and its fold covers
  U+00C0–U+024F: either can hide a true match (a rarer letter, a common
  word), never show one that should not be.
- Staging's copied data carries claims `'{}'` (`scripts/staging-pseudonymize.sql`):
  there the search finds only the people who signed in to staging
  themselves. The development personas carry HEIG-VD claims, and the seed
  adds three students on no roster.
- The search for teachers (`searchTeachers`, `directory.ts`) has no tenant
  filter; that is out of scope here and reported, not changed.
- F-ORG-04 says "at least the edu-ID email" while the import parser requires
  the names: reported, unchanged.

## Alternatives considered

- **`LOGIN_DOMAINS` as the tenant.** Rejected: it is the admission list, and
  will list every school.
- **The affiliation scope.** Rejected: `hes-so.ch` for every HES-SO school.
- **Matching the login address.** Rejected: an oracle on private addresses.
- **Returning the account id as the pick.** Rejected: an id the client could
  replace by any other; the address is checked again by the same filter.
- **Overwriting a line's names at the claim.** Rejected: official names come
  from GAPS, and the teacher corrects a list (the privacy page says so).
- **`pg_trgm` or `unaccent`.** Rejected: an extension PGlite would need too,
  for a typo tolerance nobody asked for.
