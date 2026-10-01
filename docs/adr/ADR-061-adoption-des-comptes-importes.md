# ADR-061 — Login adoption of the accounts imported from heig-classroom

## Status

Accepted (2026-10-01, settled by the product owner in conversation;
`docs/merge/08-decisions.md` D08 and its addendum). Implemented by merge
task M1-06: the rule `decideMatch` (`packages/domain/src/identityMatch.ts`),
`apps/api/src/auth/adoption.ts` (`findAdoption`, `applyAdoption`), called
by `signIn` (`auth/login.ts`), the audit actions `auth.account_adopted` and
`auth.adoption_ambiguous`, and the import's placeholder subjects
(`apps/api/scripts/import-classroom/identity.ts`). Tested by
`identityMatch.test.ts` and `auth/adoption.db.test.ts`. Completes ADR-035 (the merge) and §2.4 of
`docs/merge/02-data-and-migration.md`.

## Context

The heig-classroom import brings the people of the mapped classrooms into
Quiz (merge task M1-06). Most of them are matched to a Quiz account by
`swiss_edu_id` or by a verified address; the others — 49 of 121 in
production (`docs/merge/measures-2026-09-28.md`) — have never signed in to
Quiz, so the import creates their account.

It cannot key that account on the person's Quiz `oidc_sub`: Switch edu-ID
gives each client registration its own subject. Of the 55 people present
in both databases, none had the same `sub` on both sides. The import knows
only classroom's `sub`, which Quiz will never see.

Without anything else, such a person's first Quiz login finds no row with
its `sub`, inserts a second account, and their roster lines, staff seats
and GitHub link stay on the imported one, which nobody can ever sign in to.

## Decision

1. **A placeholder subject.** An account the import creates gets
   `oidc_sub = 'classroom:<heig-classroom sub>'` (`placeholderSub`). No IdP
   issues a subject of that form, and a login whose own `sub` has that
   shape is refused (`loginAdmits`, then `signIn` itself throws): it would
   otherwise land on the placeholder through the upsert. The prefix is what
   marks the row as waiting for its person. The import never creates one
   for a heig-classroom development account (`dev:`): it leaves them out.

2. **One rule, two callers.** Which account a person is follows ONE pure
   function, `decideMatch` (`packages/domain/src/identityMatch.ts`, unit
   tested), applied by the import (02 §2.4) and by the adoption; each
   caller only loads the rows:
   - **first key**: the eligible accounts with the person's `swiss_edu_id`,
     which must be non-null; one is a match, several are ambiguous;
   - **then a verified address**: an address asserted by the home
     organization (`swissEduIDLinkedAffiliationMail`,
     `swissEduPersonOrganizationalMail`: `institutionalAddressesOf`) reaches
     every eligible account holding it, whoever else does; any other
     address only when it is unique — exactly one verified holder in the
     whole database, eligible or not, anonymized or not, of whatever
     `swiss_edu_id` — and that holder eligible;
   - an account reached by address must not carry a `swiss_edu_id` that
     contradicts the person's. For the **adoption** it must carry none at
     all: a placeholder with a `swiss_edu_id` is adopted through that key
     or not at all, so a login that does not release
     `swissEduPersonUniqueID` cannot take it by an address;
   - exactly one candidate and no other account in doubt: a match; none:
     none; anything else: ambiguous.

   For the adoption, *eligible* means a non-anonymized `classroom:` row, and
   the search runs **only when no row holds `claims.sub`**, after the
   staging allowlist (ADR-028, unchanged, checked first). For the import,
   it means any account that is neither `dev:` nor anonymized, and every
   address must be unique (the institutional exception is the adoption's).

3. **One transaction, one conditional write.** In `signIn`, the search
   (`findAdoption`, reads only), the adoption (`applyAdoption`) and the
   upsert run in one transaction. Adopting is `UPDATE users SET oidc_sub =
   <sub> WHERE id = <candidate> AND oidc_sub LIKE 'classroom:%' AND
   anonymized_at IS NULL`: of two first logins at once, the second finds the
   row already adopted, adopts nothing, and its upsert lands where it would
   have without adoption (on the adopted row for the same `sub`, a new row
   for another). The upsert then writes the login's profile over the
   imported one, as at every login.

4. **Outcomes.**
   - one candidate: adopted, audited `auth.account_adopted` (subject the
     user, `payload.key`: `swiss_edu_id`, `institutional_address` or
     `private_address`, `payload.previousSub`);
   - none: the ordinary insert, nothing audited;
   - several, or an account in doubt (a private address not unique, a
     placeholder that carries a `swiss_edu_id` reached by address): the
     ordinary insert, and `auth.adoption_ambiguous` (subject the new
     account, `payload.candidates`) for a person to resolve. Nothing is
     ever merged on a guess.

5. **What it never touches.** A row that is not a `classroom:`
   placeholder — an account that ever signed in, a `dev:` persona — nor an
   anonymized placeholder.

6. **Permanent.** An adopted account is an ordinary account; the
   placeholder is gone and nothing undoes it. The import's `id_map` keeps
   the correspondence with the classroom id.

7. **Cost, and no index.** Every login now opens a transaction and runs one
   more indexed SELECT (`oidc_sub`, unique) before the upsert; the rest of
   the search runs only when the `sub` is unknown — once per person, at
   their first login — over a table of a few hundred rows, the address
   lookup on `user_emails_email_idx`. An index on `users.swiss_edu_id`
   would serve no measured need.

8. **Two choices of the import, accepted at review** (merge task M1-06):
   the import names the Quiz admin who runs it (`--actor`, required, an
   admin), recorded on the run and as the creator of a teacher grant whose
   heig-classroom creator is not imported; and it imports a teacher grant
   only when it sits on a verified address of a person it imports, never
   the grants of people outside the mapped classrooms.

## Consequences

- A student imported from heig-classroom signs in to Quiz and finds their
  classrooms, staff seats and GitHub link, with no action from anyone.
- The identity rule of the import (02 §2.4) and that of the adoption are
  the same function (`decideMatch`), read from the two ends: `swiss_edu_id`,
  then a verified address, never `sub`. A change to one is a change to both.
- An ambiguous first login leaves two accounts, one of them a placeholder.
  The audit names both; resolving it is a person's job (an admin merge is
  not built: production measured no ambiguous identity).
- A placeholder no one ever adopts stays a placeholder: a student who left
  keeps their history, attached to an account nobody signs in to.
- `signIn` now opens a transaction for the user row; the address set, the
  claims, the role and the roster claims follow outside it, as before.

## Alternatives considered

- **Keying the import on `sub`.** Impossible: the subjects are pairwise
  (0 of 55 equal).
- **Merging at the first login into a NEW account** (move every row of the
  placeholder onto it). Touches every table that references a user, and
  every future one; rewriting one column of one row does the same.
- **Matching private addresses like institutional ones.** A private
  mailbox may be shared (a family address) or recycled; the person chose
  it. Accepted only when unique on both sides.
- **Adopting on every login, not only the first.** An account that already
  signed in is a person's; adopting another row into it would be a merge,
  which this decision refuses.
