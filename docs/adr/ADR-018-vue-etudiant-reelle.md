# ADR-018 — The real student view and stateless preview

## Status

Accepted (2026-09-22), consolidated through 2026-10-01.
[ADR-020](ADR-020-presence-et-verdicts-en-direct.md) changes staff presence only;
[ADR-025](ADR-025-plusieurs-tentatives-exercice.md) extends own-attempt reset to retakes;
[ADR-056](ADR-056-questions-parametrees.md) governs parameter instances.
This consolidation changes no decision. The [historical record](history/ADR-018-vue-etudiant-reelle.md)
retains the original decision numbers and seven UI amendments.

## Context

A real rehearsal must exercise the student's production path without contaminating
class results. A stateless preview answers a different question: whether the
configured evaluation is right, before starting it or freezing its structure.
These are separate modes, not separate implementations of the student player.

## Decision

### Real student view and return

The Teacher/Student switch belongs to the application frame, with account-menu
and command-palette access. It is available to teachers/admins, not students.
It is secondary chrome (no accent, one tier under the page's primary action), so
invariant 2 is untouched.
The mode and return path live in `sessionStorage`: reload preserves one tab's walk
without changing another tab's dashboard. Entering from an evaluation or its live
dashboard goes to that evaluation's `/take/:id`; an existing student route stays,
other pages go to the student home. Return restores the entry route.

The switch does not enroll anyone. A teacher obtains a staff seat explicitly with
Join as student on the classroom page. Without a seat, `/take/:id` answers 404
as it does to a stranger (invariant 6), and its screen explains that path to a
teacher. A teacher who is not staff of the classroom holds no seat and gets the
same 404; this record does not change that. The former evaluation-page button and its
automatic enrollment confirmation are gone.

The real attempt uses the student's lobby, player, content, grading and server
clock, including the normal deadline/410 rules and confined-exam requirements
([ADR-027](ADR-027-tickets-de-lancement-et-sessions-typees.md)). The attempt page
has no ordinary application frame, but a teacher in student view gets the return
banner and, inside the player, a "Back to teacher view" entry in the `Ctrl+K`
palette; returning leaves the attempt open. Students never see that banner.

### Staff attempts

Staff attempts are visible and badged in the dashboard, grading and result tables.
A staff seat without an attempt creates no row. One shared staff-attempt query
identifies them. They count in no completion/success statistic, histogram,
per-question distribution, released grade snapshot or CSV. The export omits the
row completely rather than asking downstream consumers to honor a flag.

Presence is the deliberate exception (ADR-020): a staff member actually sitting
the evaluation is a person in the room. Staff seats with attempts contribute to
the presence denominator; dashboard-only connections do not create presence.

`DELETE /evaluations/:id/attempt` resets only the caller's own staff-seat attempts
(all their attempts when retakes exist), with dependent answers, attempt log and
gradings cascading. Staff access, staff seat and ownership are loaded predicates;
neither a student's nor a colleague's attempt is reachable. The student deadline
write gate does not prohibit deleting one's own rehearsal. Audit:
`attempt.staff_reset`; dashboards receive a refresh hint rather than a synthetic
live row-deletion protocol. Entry remains idempotent; reset is explicit.

### Staff repositories

*Proposed 2026-10-06, [ADR-077](ADR-077-depots-de-test-du-personnel.md).* A
staff seat may accept an individual project to test it. Its repository is
visible and badged on the staff page and counted nowhere: no count, no release,
no gradebook, no notification. A group project is not testable from a staff
seat (ADR-070 §2).

### Stateless evaluation preview

The secondary Preview action opens a new full-screen tab in every evaluation state,
loaded through its staff predicate. No attempt, answer, attempt-log, grading or
audit row is written by preview start/run/simulate/grade. Answers and the countdown
live in memory in the browser. The student's `PlayerView` and reducer are reused,
without autosave or a live stream. A restart draws a new seed.

Start returns a seed, duration, student view and frozen version map. With a supplied
seed it rebuilds that walk. Question order, shuffles and parameter draws are
reconstructed from stored versions on the server; clients supply answers and seed,
never authoritative question content. All student content passes `toStudent`.
The preview countdown uses duration, or common-window length, and none for manual
timing; expiry hands in locally. It is intentionally not a test of the server clock.

Grade validates answers, applies the type's grading rule and evaluation defaults,
and runs all runner cases including hidden cases. It returns the correction outside
the student's feedback policy. Manual/proposed outcomes are not silently treated
as validated marks; an unavailable runner is an item status rather than failure
of the whole correction. The current preview does not call the LLM provider and
reports `llm_unavailable` for that path. Run/Simulate rebuild sources from stored
templates, expose only visible cases, and share the real interactive helpers.
Budgets are in memory per teacher: ten gradings/minute and the question's run
budget; compilation has the separate budget of ADR-024.

Preview does not exercise autosave races, the server clock/deadline gate,
server-side navigation enforcement, pause, real lobby/presence, the attempt log
or persisted grading. Use the real rehearsal for those properties.

### Editing during preview and previewing the lobby

Edit question opens its draft in another tab only when the caller may edit it.
Use the new version uses the ordinary item-update route only while the item list
is editable, rebuilds with the same seed, replaces that question and drops only
its answer. Other order/shuffles/answers remain. Frozen lists explain why no update
is offered. Other item/version changes require Restart to avoid grading content
the teacher did not answer. The countdown continues while editing elsewhere.

The preview uses a ModeBanner saying nothing is saved. Restart asks once answers
exist and is disabled during grading; after correction it is the page's primary
action. Edit and Show the points live with the player's question tools, not in an
alert above the question. Version-change notices appear only when applicable.

The launch-step waiting-room preview renders the pure `LobbyScreen`, never its
connected `Lobby` container: no stream, clock request or presence registration.
It uses already loaded evaluation rules, zero presence and the roster denominator,
never question content. An evaluation that skips the lobby has no such preview.

## Consequences and alternatives

A real staff rehearsal leaves ordinary data but never a student grade. A preview
is cheap and available before launch but cannot certify the exam path. Dedicated
simulation-attempt tables, implicit enrollment on a global toggle, cross-tab mode
storage and trusting question content from the browser were rejected. Current
inline title editing is independent of these modes: safe title changes remain
allowed on a structurally frozen evaluation.

## Implementation references

- `apps/web/src/studentView.ts`, `App.tsx`, `Shell.tsx`: mode, routing and banners.
- `apps/api/src/modules/evaluation/` and `modules/guards.ts`: staff attempts/reset.
- `apps/api/src/modules/preview/routes.ts` and `service.ts`: access, seeds, budgets,
  grading and runner failures; `packages/contracts/src/preview.ts`: payloads.
- `apps/web/src/preview/`: player adapter, edit/version detection and correction.
- `apps/web/src/student/Lobby.tsx`: pure screen versus connected lobby.

## Historical section references

Original numbered decisions and addenda are historical. These compatibility
anchors lead to their full text; apply the consolidated decision above.

Where an old number cited in code or another record now lives:

| Old reference | Current section |
| --- | --- |
| §1 the walk; §2 where it was entered from; §7 the student path; first to third addenda | [Real student view and return](#real-student-view-and-return) |
| §3 shown and badged; §4 counts in nothing; §5 CSV drops the row; §6 own reset | [Staff attempts](#staff-attempts) |
| Fourth addendum (stateless preview) | [Stateless evaluation preview](#stateless-evaluation-preview) |
| Fifth addendum (waiting room); sixth (fixing a question); seventh (preview is a mode) | [Editing during preview and previewing the lobby](#editing-during-preview-and-previewing-the-lobby) |

<a id="adr-018-the-real-student-view-and-the-teachers-own-test-attempt"></a>
- [ADR-018 — The real student view, and the teacher's own test attempt](history/ADR-018-vue-etudiant-reelle.md#adr-018-the-real-student-view-and-the-teachers-own-test-attempt)
<a id="reading-map"></a>
- [Reading map](history/ADR-018-vue-etudiant-reelle.md#reading-map)
<a id="consequences"></a>
- [Consequences](history/ADR-018-vue-etudiant-reelle.md#consequences)
<a id="what-this-adr-does-not-decide"></a>
- [What this ADR does NOT decide](history/ADR-018-vue-etudiant-reelle.md#what-this-adr-does-not-decide)
<a id="rejected-alternatives"></a>
- [Rejected alternatives](history/ADR-018-vue-etudiant-reelle.md#rejected-alternatives)
<a id="addendum-2026-09-22-the-switch-belongs-to-the-frame-and-to-the-window"></a>
- [Addendum (2026-09-22) — the switch belongs to the frame, and to the window](history/ADR-018-vue-etudiant-reelle.md#addendum-2026-09-22-the-switch-belongs-to-the-frame-and-to-the-window)
<a id="context_1"></a>
- [Context](history/ADR-018-vue-etudiant-reelle.md#context_1)
<a id="decision_1"></a>
- [Decision](history/ADR-018-vue-etudiant-reelle.md#decision_1)
<a id="consequences_1"></a>
- [Consequences](history/ADR-018-vue-etudiant-reelle.md#consequences_1)
<a id="rejected-alternatives_1"></a>
- [Rejected alternatives](history/ADR-018-vue-etudiant-reelle.md#rejected-alternatives_1)
<a id="addendum-2026-09-22-second-the-page-button-goes-the-frame-switch-stays"></a>
- [Addendum (2026-09-22, second) — the page button goes, the frame switch stays](history/ADR-018-vue-etudiant-reelle.md#addendum-2026-09-22-second-the-page-button-goes-the-frame-switch-stays)
<a id="addendum-2026-09-24-third-the-way-back-from-the-attempt-itself"></a>
- [Addendum (2026-09-24, third) — the way back from the attempt itself](history/ADR-018-vue-etudiant-reelle.md#addendum-2026-09-24-third-the-way-back-from-the-attempt-itself)
<a id="addendum-2026-09-25-fourth-a-stateless-preview-of-the-whole-evaluation"></a>
- [Addendum (2026-09-25, fourth) — a stateless preview of the whole evaluation](history/ADR-018-vue-etudiant-reelle.md#addendum-2026-09-25-fourth-a-stateless-preview-of-the-whole-evaluation)
<a id="context_2"></a>
- [Context](history/ADR-018-vue-etudiant-reelle.md#context_2)
<a id="decision_2"></a>
- [Decision](history/ADR-018-vue-etudiant-reelle.md#decision_2)
<a id="what-it-does-not-exercise"></a>
- [What it does not exercise](history/ADR-018-vue-etudiant-reelle.md#what-it-does-not-exercise)
<a id="rejected-alternatives_2"></a>
- [Rejected alternatives](history/ADR-018-vue-etudiant-reelle.md#rejected-alternatives_2)
<a id="addendum-2026-09-27-fifth-the-waiting-room-previewed-from-the-launch-step"></a>
- [Addendum (2026-09-27, fifth) — the waiting room previewed from the launch step](history/ADR-018-vue-etudiant-reelle.md#addendum-2026-09-27-fifth-the-waiting-room-previewed-from-the-launch-step)
<a id="context_3"></a>
- [Context](history/ADR-018-vue-etudiant-reelle.md#context_3)
<a id="decision_3"></a>
- [Decision](history/ADR-018-vue-etudiant-reelle.md#decision_3)
<a id="rejected-alternatives_3"></a>
- [Rejected alternatives](history/ADR-018-vue-etudiant-reelle.md#rejected-alternatives_3)
<a id="addendum-2026-09-29-sixth-fixing-a-question-without-losing-the-walk"></a>
- [Addendum (2026-09-29, sixth) — fixing a question without losing the walk](history/ADR-018-vue-etudiant-reelle.md#addendum-2026-09-29-sixth-fixing-a-question-without-losing-the-walk)
<a id="context_4"></a>
- [Context](history/ADR-018-vue-etudiant-reelle.md#context_4)
<a id="decision_4"></a>
- [Decision](history/ADR-018-vue-etudiant-reelle.md#decision_4)
<a id="rejected-alternatives_4"></a>
- [Rejected alternatives](history/ADR-018-vue-etudiant-reelle.md#rejected-alternatives_4)
<a id="addendum-2026-10-01-seventh-the-preview-is-a-mode-not-a-notice"></a>
- [Addendum (2026-10-01, seventh) — the preview is a mode, not a notice](history/ADR-018-vue-etudiant-reelle.md#addendum-2026-10-01-seventh-the-preview-is-a-mode-not-a-notice)
<a id="context_5"></a>
- [Context](history/ADR-018-vue-etudiant-reelle.md#context_5)
<a id="decision_5"></a>
- [Decision](history/ADR-018-vue-etudiant-reelle.md#decision_5)
