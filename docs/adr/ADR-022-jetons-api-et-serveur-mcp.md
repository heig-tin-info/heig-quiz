# ADR-022 — Personal API tokens, and an MCP server that is one more client of the API

## Status

Accepted (2026-09-23, asked for by the product owner: "connect Claude or
OpenAI to the portal and have it write a quiz"). It brings forward two items
the specification had placed later — the personal tokens of docs/08 §8.3
(phase 2) and the MCP server of F-LLM-06 (phase 3) — and settles how they are
built.

Amended 2026-09-29 (F-STAT-03, the follow-up ADR-038 §7 announced): the
reading tool `get_pool_question_stats` joins the closed list of §C.

Amended by [ADR-052](ADR-052-questions-bonus.md) (2026-09-30): the items
`get_evaluation` returns carry `bonus`, and `update_evaluation`'s grade
scale is linear only (its rounding).

Amended 2026-10-01 (templates first, decided with the product owner): the
reading tool `list_templates` and the writing tools `create_template`,
`add_questions_to_template` and `instantiate_template` join the closed
list of §C, and a new quiz is made
as a template of the course by default; and the reading tool
`find_similar_questions` joins it too, so that an assistant looks for an
existing question before writing a new one — see the two addenda at the
end of §C.

**Amended 2026-10-11 (security audit L6, product owner's decision of
2026-10-10), scope: §A.** Tokens stay admitted on the administration routes
(the MCP tools depend on them), but only a token that expires: `adminGuard`
answers a personal token made with no lifetime `403 token_expiry_required`,
after the role check, and the rest of the API still takes it. An
administrator cannot create such a token any more (`422
token_expiry_required`; the settings offer them no "Never"). A teacher's
token may still never expire. Super Powers keep refusing any token
(ADR-054). Known gap: two rules read the admin ROLE outside the
administration routes — editing an approved concept (`patchConcept`) and
seeing any account's picture (`seesUser`) — and an endless admin token
keeps them; neither reaches a student's work.

**Amended 2026-10-12 (asked for by the product owner), scope: §C.** The
reading tools `get_journal` and `get_journal_page` join the closed list, so
that an assistant reads a classroom's journal; the staff journal payload
gains `files`, each page and asset with the last change of its content —
see the addendum at the end of §C.

**Amended 2026-10-13 (issue #788, product owner's decision of 2026-10-13),
scope: §C, and the project routes' "own portal session only" rule of merge
task M3-02.** The reading tools `list_projects` and `list_project_sources`
and the writing tool `create_project` join the closed list, so an assistant
creates a GitHub project as a draft; three project routes now take a
personal or OAuth token — see the addendum at the end of §C.

**Amended 2026-10-15 by [ADR-113](ADR-113-portee-des-jetons-personnels.md)
(issue #871, product owner's decisions of 2026-10-15), scope: §A's "There
is no scope", the L6 amendment's parenthesis, and the rejected alternative
"Scoped tokens".** A personal token carries one of three scopes chosen at
its creation: `quiz` (the default, the MCP endpoint and its tools), `quiz:read`
(its reading tools) or `api` (the whole API, always expiring); the tokens
issued before are `api`. The L6 parenthesis "the MCP tools depend on them"
is stale: no tool calls an administration route; the rule it introduces
stands.

**Amended 2026-10-29 (issue #960, product owner's decisions of
2026-10-29), scope: §C's "No deletion", its closed list, and the consent's
"cannot delete".** Removing an item from an evaluation's or a template's
list is an edit, not a deletion: the reading tool `get_template` and six
item tools join the closed list, and the in-process client reaches a
closed list of DELETE routes — see the addendum at the end of §C.

## Context

A teacher wants to ask an assistant — Claude Desktop, Claude Code, ChatGPT,
the OpenAI Responses API — something like *"make me a ten-question general
culture quiz in French, university level, vary the question types; create a
pool if there is none and an exercise for the class Français 2026"*, and find
the result in the portal.

The Model Context Protocol is how those clients call tools on a remote
server. Two things were missing: a credential a program can hold (the API
only knew browser sessions with double-submit CSRF), and the tools
themselves.

The specification already says what the tools must be: "an MCP server
exposing the same operations as the API" (docs/05 §5.2), and "everything the
UI does, the API does" (docs/08 §8.1, principle 4).

## Decision

### A. Personal API tokens

- Table `api_tokens` (auth module): `token_hash` (SHA-256), `prefix` (the
  first 15 characters, for the list), `name`, `expires_at` (30, 90, 365 days
  or never; 90 by default), `last_used_at` (refreshed at most once a minute),
  `revoked_at` (revocation stamps, it does not delete). The plaintext
  `quiz_pat_<43 base64url chars>` is returned once, by the creation.
- `Authorization: Bearer quiz_pat_…` is read on `/app/api/*` only. When the
  header is present it is the whole credential: an unknown, revoked or
  expired token is anonymous, and a session cookie riding along is ignored.
- A token resolves to its owner's `users` row on every request, so the role,
  the staff seats and the pool memberships it acts under are the owner's
  current ones. There is no scope: a token can do what its owner can do
  through the API. *Amended 2026-10-15 by ADR-113: a personal token's
  reach is the scope chosen at its creation, the MCP endpoint by default.*
- A token-authenticated request is exempt from the double-submit CSRF check:
  a browser never attaches a bearer header on its own, which is the attack
  CSRF defends against.
- `/app/api/me/tokens` (list, create, revoke) is teacher-only and refuses a
  token-authenticated caller (`403 session_required`): a leaked token cannot
  mint its own replacement or revoke the others. Managing tokens takes a
  browser session, therefore edu-ID.
- The audit log records a write made through a token with
  `actor_type = 'api_key'` — the value the inherited schema already reserved.
  `api_token.create` and `api_token.revoke` join the closed union.

### B. The MCP server is a client of `/app/api`, in process

`POST /app/api/mcp` speaks MCP over the Streamable HTTP transport, stateless,
answering in `application/json` (no SSE stream, no `Mcp-Session-Id`; `GET`
is `405`, which the transport allows). It accepts a bearer token only — a
browser session gets `401` — and a teacher or admin only.

Each tool is a few lines that call the existing routes through
`app.inject()`, carrying the caller's own `Authorization` header. So every
guarantee of those routes holds unchanged: the access loaders (invariant 6 —
another teacher's pool is a `404` through the tool too), the contract
validation (invariant 7), the audit entries, the SSE refresh hints that make
an open browser tab show the new question at once. Nothing in `modules/mcp`
touches the database.

The protocol layer is written by hand (`modules/mcp/protocol.ts`, four
methods: `initialize`, `ping`, `tools/list`, `tools/call`), not taken from
`@modelcontextprotocol/sdk`: the SDK's transport wants to own the HTTP
response, which Fastify already owns, and what is needed is a hundred lines of
JSON-RPC. Tool input schemas are zod, composed from `@quiz/contracts`, and
converted with `z.toJSONSchema`.

### C. What the tools are, and what they are not

Reading: `list_courses`, `get_course`, `list_pools`, `get_pool`,
`get_pool_question_stats`, `find_similar_questions`, `list_questions`,
`get_question`, `list_evaluations`, `get_evaluation`,
`describe_question_types`, `list_templates`, `get_template`, `get_journal`,
`get_journal_page`, `list_projects`, `list_project_sources`.

Writing: `create_course`, `create_classroom`, `create_pool`,
`link_pool_to_course`, `create_category`, `create_question`,
`update_question`, `create_evaluation`, `add_questions_to_evaluation`,
`update_evaluation`, `create_poll`, `create_template`,
`add_questions_to_template`, `instantiate_template`, `create_project`,
`remove_question_from_evaluation`, `remove_question_from_template`,
`update_evaluation_item_versions`, `update_template_item_versions`,
`update_evaluation_item`, `update_template_item`.

- `describe_question_types` hands the model the JSON Schema of the type's
  `configSchema` — generated, so it cannot drift from the publication gate —
  with authoring rules and a valid example (`modules/mcp/questionTypes.ts`).
  A test asserts that every example passes the gate.
- `create_question` validates the config with that same gate BEFORE creating
  anything, so a malformed config costs one round trip and leaves no
  half-written question. It then creates, saves the draft and publishes.
- `create_evaluation` creates a `draft` and adds its items. It never opens,
  schedules or starts anything.
- **No deletion, and no transition of a live evaluation** (start, pause,
  close, grade, release) is exposed. A model prepares work; a teacher runs it.
  The one exception is `create_poll`, which starts a poll because that is
  what creating a poll is (F-LIVE-13); its description tells the model to
  call it only when the teacher wants to poll now. *Amended 2026-10-29: a
  deletion removes an entity or a student's work; removing an item from a
  quiz's list is an edit (see the last addendum).*
- Every write returns the web app's `url` of what it made, so the assistant
  can hand the teacher a link.
- `get_pool_question_stats` (amendment of 2026-09-29) is one call to the
  pool screen's `GET /pools/:id/question-stats` (ADR-038), whole pool at
  once, like the screen. It returns what that route returns and nothing
  more: the threshold of ten answers is the route's, so a question under it
  is absent for the model as for the browser. Its figures are aggregates
  over EVERY class that used the question, other teachers' included — the
  reading ADR-038 §5 already grants anyone who can read the pool. It gives
  no student, no individual grade and no count under the threshold, so it
  stays within "no student data beyond what its owner can read": the
  owner of the token reads the same figures in the side panel. A pool-level
  tool rather than a per-question one, because the route is pool-level and
  a model choosing questions compares them.

**Addendum of 2026-10-01 — templates first.** Reading gains
`list_templates`; writing gains `create_template`,
`add_questions_to_template` and `instantiate_template`. Each is a thin client of the template routes of
ADR-031, unchanged: `GET` and `POST /courses/:id/templates` (F-EVAL-24),
`POST /templates/:id/items` (F-EVAL-25) and `POST /templates/:id/instances`.
`create_template` takes the arguments of `create_evaluation` with a course
in place of a classroom, creates the template with the same preset, then
adds the questions through the template's item route, so the rules on
published questions from the course's linked pools are the route's. Their
refusals reach the model like any other: a teacher without a seat on the
course's staff gets the `404` of `loadTemplate` / `accessibleCourse`, and
an instantiation whose question sits in a pool the course no longer links
gets `422 template_pool_unlinked`.

- **Why template first.** A quiz is reused year to year. Made directly in a
  classroom, it lives in that year's class and has to be found and copied
  next year; made as a template, it stays in the course, and each year's
  classroom takes its own instance (ADR-031). So when a teacher asks the
  assistant for a new quiz, exam or exercise, the assistant makes a
  template, and instantiates it into a classroom when the teacher wants it
  there.
- **Steered, not gated.** `create_evaluation` stays, for the teacher who
  explicitly asks for an evaluation in a classroom. The steering is the tool
  descriptions and the server's `instructions` only; no tool refuses the
  other path. There is no fallback between the two: a classroom is reached
  through its course's staff (`staffAccess`, invariant 6), so a teacher
  refused a template of a course is refused an evaluation in its classrooms
  with the same `404`.
- **One writer, two homes.** `create_template` and `create_evaluation` share
  their arguments and their body (create with the mode's preset, add the
  items through the home's own item route, read the detail back). A refused
  item leaves the template created and empty, as it leaves the evaluation:
  the model is told not to create it again but to fix the cause and add the
  questions with `add_questions_to_template`, the twin of
  `add_questions_to_evaluation` over the same template item route (a new
  revision, never a change to an instance: F-EVAL-25, F-EVAL-26).

**Addendum of 2026-10-01 — look before writing a question.** An assistant
asked for ten questions writes ten new ones, even when the course's pools —
or a colleague's public pool — already hold the same question with years of
exam statistics behind it. The copy starts from zero answers (ADR-038), and
the pools fill with near-duplicates.

- **A read tool over a route.** `find_similar_questions({ courseId, text,
  type? })` is one call to `GET /app/api/courses/:id/similar-questions`
  (pool module), which the web app may call too (docs/08 §8.1, principle 4).
  The course is loaded through the staff predicate, the questions through
  the caller's `poolAccess`, published and live only. A hit says whether
  its pool is linked to the course and whether the caller may link it
  (ADR-013), and carries the pool screen's own statistics, so the
  ten-answer threshold and the exams-only rule hold unchanged.
- **Linked pools first, then every reachable pool** (decided with the
  owner): reuse inside the course costs nothing, a link widens the staff's
  write access, a copy loses the statistics.
- **The ranking.** The index is a `simple` tsvector, without stemming or
  stop words. The statement is cut into words of three characters or more,
  outside a short French and English stop list (`similarityTerms`,
  `@quiz/domain`), matched as an OR against the LATEST published version and
  ordered by `ts_rank(search, query, 1)`: it grows with each distinct word
  shared, and the normalisation divides by `1 + log(length)` so that a long
  code template does not win by bulk. `ts_rank_cd` was not taken: on an OR
  query each occurrence is its own cover, so it counts repetitions rather
  than shared words. Top `limit` (10 by default), no threshold: the model
  judges the excerpts.
- **No refusal in `create_question`** (decided with the owner). It does not
  demand that a search ran (no `reviewedSimilar` flag). A model prepares and
  a teacher decides (§C): whether a close question is "the same" is a
  judgement this server cannot make, and a gate a model satisfies by passing
  `true` protects nothing. The steering is the tool's description,
  `create_question`'s and the handshake instructions; `modules/mcp` still
  touches no database.

**Addendum of 2026-10-12 — read a classroom's journal.** An assistant
preparing a quiz for a week of the course should read what that week
covered, and the journal (ADR-049, ADR-057) is where it is written.

- **Two read tools over the journal's own routes.** `get_journal({
  classroomId })` is `GET /classrooms/:id/journal`, `get_journal_page({
  classroomId, path })` is `GET /classrooms/:id/journal/pages/*`. Both load
  the classroom through `readableClassroom` (invariant 6): a token's owner on
  the course's staff gets the staff payload — drafts and pages not yet
  visible included, as in their browser — and anyone else the 404 of a
  missing classroom. Only a teacher holds a token (§A), and a teacher off
  the staff reads nothing; the student payload stays `studentView.ts`'s
  alone (invariant 4).
- **The page without its HTML.** `get_journal_page` drops the rendered
  `html`: the markdown says the same thing at a fraction of the size.
- **When each file last changed.** The staff payload gains `files`: every
  page and asset of the copy with its `updatedAt`, which moves only when the
  content does (a GitHub ingestion that leaves a blob as it was keeps its
  row's date; a Quiz-mode save stamps its own). No writing tool: the journal
  is edited in the web app, or on GitHub.

**Addendum of 2026-10-13 — create a GitHub project as a draft** (#788,
decided by the product owner). A teacher asked the assistant for a lab and
it had to fall back on the web form.

- **Three tools over three routes.** `list_projects({ classroomId })` is
  `GET /classrooms/:id/projects`, `list_project_sources({ classroomId })`
  `GET /classrooms/:id/projects/sources` (the organization's repositories a
  project may hand out, students' repositories left out), and
  `create_project({ classroomId, …ProjectCreate })` `POST
  /classrooms/:id/projects`, each through `app.inject` like every tool (§B):
  the classroom is loaded through its course's `staffAccess` (invariant 6),
  the body validated by `ProjectCreate` (invariant 7), the creation audited
  `project.create` as `api_key`.
- **The narrowed M3-02 rule.** Every project route served the caller's own
  portal session only, and a Bearer token got the 404 of a missing entity.
  Those three routes now take a personal or OAuth token too (loader
  `projectsAuthoringClassroom`, `authVia: "token"`); every other project
  route — the project page, its patch, publication, archive, deletion, a
  source's detail, the grading — stays portal-only, and the help assistant's
  token (ADR-080 §8) reaches none of them.
- **Manual publication only.** `create_project` takes `ProjectCreate`
  without `publishMode` and `startAt`: the project is a `draft` the teacher
  publishes from the web app. A `scheduled` one would be published by the
  ticker and its class notified with no teacher in the loop. Its deadline is
  `deadlineAt` or `durationMinutes` from the publication.
- **A draft with an effect on GitHub.** The creation already builds the
  distribution repository in the classroom's organization (ADR-062), never
  deleted by Quiz; the tool's description says so and steers the model to
  `list_projects` first.
- **Without Quiz's App** the project routes do not exist (`app.ts`); the
  three tools then refuse with a reason a model can repeat ("GitHub projects
  are not enabled"), rather than a 404 it would read as "not accessible".

**Addendum of 2026-10-29 — edit a quiz's items** (#960, decided by the
product owner). After `update_question`, a quiz still played the old
version, and no tool could move, change or remove its items.

- **What a deletion is.** A deletion removes an entity — a course, a
  classroom, a pool, a question, an evaluation, a template, a project — or
  a student's work. Removing an item from an evaluation's or a template's
  list is an edit of that list: the question stays in its pool. It cannot
  be undone (the item's points, intro, frozen version and position go with
  it), so its tools carry `destructiveHint`.
- **Seven tools over the item routes of F-EVAL-03 and F-EVAL-25.** Reading
  gains `get_template` (`GET /templates/:id`), so a model sees a
  template's item ids as `get_evaluation` shows an evaluation's. Writing
  gains, for each home, `remove_question_from_evaluation` /
  `_template` (`DELETE …/items/:itemId`), `update_evaluation_item_versions`
  / `update_template_item_versions` (`POST …/items/update-versions`) and
  `update_evaluation_item` / `update_template_item` (`PATCH
  …/items/:itemId`, `ItemPatch`: points, normal or bonus, milestone,
  intro). An item is addressed by its id, never its question's: the same
  question may sit twice. No reorder; replacing a question is a removal
  and an addition. Neutralizing stays a grading act of the web app
  (ADR-108): `ItemPatch` has no such value, and a stray key is refused.
- **A draft evaluation only.** The routes accept `scheduled` too, but a
  scheduled evaluation opens by the ticker with no further check; the tools
  refuse an evaluation past `draft` with a reason the model can repeat. A
  template is always editable. Editing an instance never reaches its
  template, nor a template its instances until the teacher pulls the
  revision (F-EVAL-26); each description says so.
- **No false success.** An evaluation's item routes answer an unknown item
  as a success (`204`), so each tool first reads the quiz, refuses an item
  it does not hold, and answers the quiz's detail after the write.
- **A closed list of DELETE routes.** The in-process client had no
  `delete`, which was what kept every DELETE route out of reach. It now has
  one that reaches only `DELETABLE_PATHS` (`modules/mcp/service.ts`): an
  item of an evaluation's or a template's list; any other path is refused
  before a request is made, which a test asserts. The help assistant
  (F-LLM-07, ADR-080 §8) still reaches no DELETE: its reading client and
  the client of a confirmed write both refuse one unsent, and none of the
  new tools is among the writes it may prepare.
- **Consent.** The consent screen's "cannot delete" line now names what it
  cannot delete, and a line says it can change a quiz's questions; tokens
  granted before are not asked again, as for `create_project` (#788).

## Consequences

- Claude Code connects with
  `claude mcp add --transport http quiz https://<host>/app/api/mcp --header "Authorization: Bearer quiz_pat_…"`;
  the OpenAI Responses API with an `mcp` tool and the same header; Claude
  Desktop and any stdio-only client through `mcp-remote`. The settings screen
  shows the address and the Claude Code line next to the token, once.
- The claude.ai and ChatGPT **web** connectors require OAuth 2.1. This ADR
  does not provide it; ADR-023 does, as an authorization server in front of
  the same tokens — the tools did not change.
- The public `/api/v1` surface of D18 is still not there. Bearer tokens work
  on `/app/api/*`, which is the surface D18 said they would alias.
- An LLM author can create as much as its owner can. The audit log's
  `api_key` rows are how to tell afterwards what an assistant did.
- F-LLM-04 (anonymisation of what is sent to a provider) is not engaged: the
  platform sends nothing to a provider (true of this server; the in-app
  assistant of [ADR-080](ADR-080-assistant-enseignant.md) §8 is the platform sending); the teacher's own client reads what
  its owner can read. The tools expose no student data beyond what
  `get_course` (staff names) and `get_evaluation` return; the question
  statistics of `get_pool_question_stats` are anonymous aggregates of ten
  answers or more. *Amended by ADR-080's P2 amendment (2026-10-08): the
  in-app assistant's results reader (`get_classroom_results`, students'
  names and final grades) is wired through the same in-process chain but is
  NOT in this catalogue, so an existing OAuth grant or personal token never
  gains it; exposing it over MCP would be a decision of its own.*

## Rejected alternatives

- **A separate stdio MCP package (`packages/mcp`) calling the HTTP API.**
  Needs Node on the teacher's machine and a published package, and cannot be
  used by a remote client (the OpenAI API, claude.ai) at all. The in-process
  endpoint serves both, and stdio clients bridge with `mcp-remote`.
- **Tools calling the services directly.** Faster by a few milliseconds, and
  a second copy of every route's access check, audit line and refresh hint —
  the exact duplication invariant 6 exists to prevent.
- **Accepting the session cookie on `/app/api/mcp`.** Nothing in a browser
  should speak MCP, and a cookie is the credential a cross-site request
  carries without asking.
- **Scoped tokens (read-only, pools-only).** No consumer asked for it yet; a
  scope column can be added without breaking a token already issued.
  *Taken up on 2026-10-15 by ADR-113, with scopes cut along the MCP
  catalogue rather than by content.*
