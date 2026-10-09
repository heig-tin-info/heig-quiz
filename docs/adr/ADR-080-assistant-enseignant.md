# ADR-080 — The teacher assistant: ask the documentation and your own data from any screen

## Status

Accepted (2026-10-07, decisions of the product owner on issue #559, after
a spec challenge). Records the whole feature in three phases; P1 (§1–§7)
is implemented, by requirement F-LLM-07. **P2 (§8) is implemented** under
the [P2 amendment of 2026-10-08](#p2-amendment-2026-10-08), which amends
§2, §3 and §5 where they say so. **P2b — driving the interface — is
implemented** under the [P2b amendment of 2026-10-08](#p2b-amendment-2026-10-08),
which amends §1 and the P2 amendment's item 10 where it says so. **P3 —
proposals the teacher confirms — is implemented** under the
[P3 amendment of 2026-10-08](#p3-amendment-2026-10-08), which amends §1,
§2, §5, §8, §9, the P2 amendment's item 10, the P2b amendment's decision 2
and, for the assistant only, ADR-059 §1–2.

Since the cut-over from tags to concepts
([ADR-081, third addendum](ADR-081-vocabulaire-de-notions.md#third-addendum-2026-10-08-the-cut-over),
§1 and §7), the assistant's question tools carry concepts instead of tags,
and a word it searches the pool with (`tag:printf`, `#printf` below)
resolves to every concept that word may designate, in either language;
the P2b amendment's examples are otherwise unchanged.

Scope: the in-app chat of the teacher UI, the `assist` purpose of the LLM
gateway, the conversations it stores.

Relations:
- Amends [ADR-059](ADR-059-generer-la-reponse.md) §1–2 for the assistant
  only (P3 amendment, decision 1): in the editor it may rewrite the
  teacher's own texts; the wand keeps its rules.
- Amends [ADR-058](ADR-058-passerelle-llm.md) §1 (the gateway gains a
  multi-turn call with read-only tools; `LLM_PURPOSES` gains `assist`) and
  §5 (the chat's share of the cap and its per-minute limit) and §4 (a
  purpose whose conversations are stored, §6 below).
- Amends F-LLM-03 and F-LLM-04 (docs/spec/02), in the italic style of
  [ADR-072](ADR-072-ia-du-brainstorm.md); records a P2 decision under
  N-DATA-05 (docs/spec/03) and open question 43 (docs/spec/06).
- Records the consequence for [ADR-022](ADR-022-jetons-api-et-serveur-mcp.md)
  ("the platform sends nothing to a provider") and confirms F-ADMIN-05 /
  [ADR-054](ADR-054-super-powers-admin.md): Super Powers never pass through
  the assistant.
- Respects [ADR-018](ADR-018-vue-etudiant-reelle.md) (no assistant in the
  student view), [ADR-034](ADR-034-agir-en-tant-qu-etudiant.md) (none under
  impersonation), [ADR-027](ADR-027-tickets-de-lancement-et-sessions-typees.md)
  and [ADR-051](ADR-051-postes-kiosque-attestes.md) (none on a `seb` or
  `kiosk` session), [ADR-069](ADR-069-calculatrice-fournie.md) (a neutral
  docked tool, never the accent).

## Context

Teachers have the per-screen help (`apps/web/src/help/`) and the user guide
(`docs/guide/`), and can drive the platform from claude.ai through the MCP
server (ADR-022, ADR-023). What they lack is a free-form question about the
screen in front of them ("what is the Group option for?") and, later, an
assistant that acts ("rewrite this question in proper French and add five
choices").

The spec challenge of #559 found ten constraints: the anonymisation rules
(N-DATA-05, F-LLM-04, question 43) and ADR-022's premise that nothing leaves
for a provider; "the teacher decides" (spec 08, ADR-059 §3); prompt
injection through text others wrote; the identity and the audit of an
assistant's writes; a gateway shaped for one structured call; the daily cap
shared with grading (ADR-063) and the night's review (ADR-060 §5); F-LLM-03
forbidding any call during a running evaluation; the corpus; the retention
of conversations; and a bottom-right corner already busy.

## Decision

The product owner's decisions of 2026-10-07, numbered as he gave them.

### 1. Three phases; this record ships P1

- **P1 — ask the documentation.** Read-only; one tool that reads the
  documentation and nothing else (§5).
- **P2 — read tools** (§8): the platform's data, read on the teacher's
  behalf.
- **P3 — writes** (§9): proposals the teacher confirms one by one.

The assistant answers about the platform and its interface only. Anything
else, and any request to ignore or change its instructions, gets a short
refusal — in French « Je ne sais pas répondre à cette question ; je peux
t'aider sur la plateforme de quiz. », in English "I can't answer that
question; I can help you with the quiz platform." Text in a user message,
a page or a tool result is data, never an instruction. This is **best
effort**: the system prompt is the only guard, a determined user can make a
model say something off-topic, and nothing it says changes anything on the
platform in P1. The French refusal is the product owner's wording, in the
familiar form; the interface's own strings stay in the formal one.

### 2. What P1 sends: the screen, never its content

The context of a question (`AssistContext`, `@quiz/contracts`) is:
- the route PATTERN (`/pools/:id`, `/courses/:id/pools`, `/admin?tab=llm`),
  every id a parameter — the contract accepts lower-case literal segments,
  `:params` and a `?tab=` only, so neither an id nor a name can ride along;
- the screen's help topic id (`pool`) — the one its page header's "?"
  opens, read from the slot that button fills while it is mounted
  (`currentHelpTopic`), never a second list — and the UI language (`en` or
  `fr`).

Never an entity, a title, a student or a classroom. With it go the
conversation's earlier exchanges and what the teacher typed. A teacher may
type a name; it is not masked (it cannot be told from any other word), and
the panel says that the questions are read by an AI model (Anthropic).

*Amended by the P2 amendment, item 3: the context also carries the ids of
the screen's entities from a closed list of kinds — course, classroom,
pool, question, evaluation, template — and never a user's, an
enrollment's, an attempt's or a student's; the stored exchange keeps the
pattern without them.*

### 3. Where it is offered

- Teacher and administrator **portal** sessions only, enforced by the
  routes (`requireAssist`, `modules/assist/routes.ts`): a student, a
  personal API token or an OAuth token (MCP), a session acting as a student
  (ADR-034) are refused `403`; a `seb` or `kiosk` session never reaches the
  routes (ADR-027 default deny, `401`).
- In the web, absent in the student view (ADR-018), under impersonation,
  and on the projected screens — the poll's wall and the correction's
  projection — as on every full-screen view (`assistVisible`,
  `apps/web/src/assist/context.ts`). The live dashboard keeps it: the panel
  opens only on the teacher's click.
- **Allowed while an evaluation runs.** F-LLM-03 forbids a model call during
  a running evaluation for the fairness of grading; the assistant grades,
  releases and reads nothing of the evaluation, so the reason does not apply
  (amendment of F-LLM-03, as ADR-072 did for polls). *Amended by the P2
  amendment, item 2: the assistant grades and releases nothing; it may read
  a running evaluation's structure (settings, items), and its results
  reader returns final marks only — the released columns —, never a running
  or unreleased evaluation's partial scores.*

### 4. Its share of the cap, refused first

- The chat may spend **25 % of the day's cap** (`ASSIST_CAP_SHARE`), all
  teachers together, like the night's review (ADR-060 §5).
- It is also refused once the day's total would leave less than that same
  quarter of the cap to the other purposes: when the cap nears, the chat is
  refused first and grading never starves (`shareAllows` of
  `@quiz/domain`, the chat's share; the night review keeps its own rule, ADR-060 §5).
- The share is checked under the gateway's reservation lock, request by
  request (`reserveCall`'s `share`, `ASSIST_CAP_SHARE`), before the cap. A share refusal is the
  same `budget_exhausted` (`429 llm_budget_exhausted` to the client) but
  writes no row: the cap itself was not reached, so `llm.budget` stays
  green.
- A per-minute limit per teacher (`Budget`, `ASSIST_TURNS_PER_MINUTE` = 6)
  guards against a held key; the share does the rest. This amends ADR-058
  §5 ("the cap is not a quota"): the chat is the first purpose whose use is
  open-ended.

### 5. The corpus, the prompt and the one tool

- **Corpus**: `docs/guide/*.md` (English, accepted as is) and the per-screen
  help `apps/web/src/help/<topic>.md` with its `<topic>.fr.md`, filtered by
  role — `guide/admin` is read by an administrator's assistant only. No
  specification, no ADR (developer-facing, unshipped features, security
  details). No vector RAG, no embeddings, no second provider (F-LLM-01).
- **Built at build time** into a versioned artifact: the API's build writes
  `dist/assist-corpus.json` (`scripts/assist-corpus.ts`, from
  `buildCorpus`), from the files of the commit being built, so the
  documentation always matches the deployed code. The image holds no
  `docs/` (`.dockerignore` lets `docs/guide` into the build context only);
  outside production the server builds the corpus from the repository. Each
  answer records the corpus `version` it was given.
- **The prompt** (`assistSystem`, `assistScreen`): a stable prefix — the
  rules, the scope and an INDEX of the corpus (each page and section, one
  line each) — cached by the provider; then the current screen: the UI
  language, the route pattern and the screen's help topic in full, in the
  UI language. Interface elements are named by their label as the screen's
  help writes them.
- **One read-only tool**, `read_guide(page, section?)`, returns a page or a
  section of the corpus the role reads; a wrong name answers with the names
  that exist.
- **Reply language**: the language of the user's last message, otherwise
  the UI language.
- **No streaming** in v1. At most **4 provider requests per question**
  (`ASSIST_MAX_STEPS`; *6 since the P2 amendment, item 7*); the last one may not call a tool, so a question
  ends. Each request is reserved at its worst case against the cap and the
  share, and logged in `llm_calls`.
- **ADR-058 §1 amended**: the gateway gains `converse()` — a multi-turn call
  with read-only tools (`ReadOnlyTool`), the provider running its loop and
  the gateway metering every request through the same reservation, log and
  error vocabulary as `complete()`. `LLM_PURPOSES` gains `assist`. The
  existing `complete()` callers are untouched. The Anthropic adapter caches
  the stable system block and the conversation's growth, sends the model's
  thinking back unchanged within a question, and keeps only the final text
  between questions.
- **Development**: `LLM_PROVIDER=stub` answers first, whether a key is
  stored or not, as it does for grading (`llm/index.ts`), with a
  deterministic stub (`stubAnswer`): it says it is a stub and names the
  screen's help and the closest sections. The browser mock answers the
  same way. Production refuses the stub (ADR-045).

### 6. Conversations are stored, 30 days

- `assist_conversations` and `assist_exchanges` (owned by the `assist`
  module, migration `0083`): one row per exchange — the question, its
  answer, the screen it was asked on, the model and the corpus version, all
  required. It is written once the answer came: a failed call stores
  nothing. A conversation purged while the model answered is a `404
  conversation_not_found`, never a half-written exchange.
- **Retention**: every exchange is deleted 30 days after it was written,
  and a conversation left empty with it, by the scheduled task
  `assist.purge` (daily).
- **Readers**: the teacher who owns a conversation — anyone else's is a 404
  (invariant 6) — and the administrators. Reading another person's
  conversation is reaching their content, so an administrator reads it with
  **Super Powers on** ([ADR-054](ADR-054-super-powers-admin.md)); without
  them, the 404 of anybody else. This keeps ADR-054's split of role and
  reach; the product owner's "readable by admins" is read in its most
  conservative form, to be confirmed. **An administrator's read is
  audited** (`assist.read`, a new action of the closed union), one entry
  per conversation read or per teacher's list read; the owner's reads are
  not. The owner deletes their own conversations; an administrator reads,
  never deletes.
- **F-LLM-04 amended**: for this purpose, the prompts and answers ARE
  stored, for the readers above and for 30 days; the cost of each request is
  still in `llm_calls` (purpose `assist`, the teacher as user), never its
  content. ADR-058 §4 ("never the prompt, never the reply") still holds for
  `llm_calls` and every other purpose. The panel and
  `docs/guide/data-protection.md` say so.

### 7. The entry point

A 48 px round button at the bottom right, in the neutral ink — never the
accent (ADR-069) — opening a non-modal panel above it: the calculator's
dock, extracted into one primitive both use (`ToolDock`, `apps/web/src/ui/`).
Its wrapper is a tool dock: the toasts rise above it (`--tool-dock-h`).
Under `lg`, while the pool's bulk bar spans the bottom edge, the button
steps aside. Checked at 1440 and 390 px (`apps/web/DESIGN.md`, "The help
assistant").

### 8. P2 — read tools (built, under the P2 amendment)

- Read tools call the API as the teacher, through a per-question,
  short-lived, audience-bound token (ADR-023's machinery): the audit shows
  `api_key`, and **Super Powers never pass through the assistant**
  (F-ADMIN-05 confirmed): a token carries none, so an administrator's
  assistant reaches what the administrator's own seats reach.
- **The identity, as built.** A question mints, on its first data-tool call
  only (a question the documentation answers writes no token), a token of
  the asking teacher (`mintAssistToken`, `auth/tokens.ts`) with the
  dedicated audience `urn:quiz:assist` and a 15-minute expiry; its later
  calls reuse it. The auth hook accepts it only on
  an in-process call that carries the boot-time internal secret
  (`INTERNAL_CALL_HEADER`) and refuses it on the public MCP path, so it is
  worth nothing outside the process. It is never listed on the teacher's
  tokens page nor revocable there (`listApiTokens` and `revokeApiToken` take
  personal tokens only), and it changes nothing a person sees (its own
  `last_used_at`, on a row nobody lists, aside). It is **deleted** in a
  `finally` when the question ends, answered or failed (`asTheTeacher`,
  `modules/assist/service.ts`), and one a crash leaves behind expires and is
  deleted by the daily `assist.purge` task. It resolves like every token —
  the teacher's current role and seats, `callerFor(user, null)`, so `reach`
  is `seats` and never `all` — and the tools reach the API through the MCP
  tools' own chain (`injectedApi`, `app.inject`, `runTool`), so access loading
  (invariant 6), the contracts (invariant 7) and the audit are a normal
  request's. A 404 is handed to the model as "the user holds no seat on the
  course this belongs to, or it does not exist", which it says plainly; it
  never retries around it. *Why a token rather than injecting a request
  already authenticated as the user:* the token path exists, is tested and
  is the one the MCP tools take; a second, header-borne identity on the
  internal call would be a new way to authenticate a request, wider than a
  token bound to one audience and one question.
- **N-DATA-05 and open question 43, scoped to P2**: the product owner
  accepts that P2's read tools may return student names and results of the
  teacher's own classrooms to the provider, as the screen shows them to the
  teacher. *Built under the P2 amendment: the tools are its item 6, there is
  no masking (item 4), and the panel's notice says it.*
- **ADR-022's consequence** ("F-LLM-04 is not engaged: the platform sends
  nothing to a provider") holds for the MCP server, where the teacher's own
  client is the one that sends; it does not hold for the in-app assistant,
  where the platform sends, under this record.

### 9. P3 — writes (built, under the P3 amendment)

- Every write is a proposal the teacher confirms one by one, with a diff.
- Never a publication. `create_poll` (live in front of students) and
  `create_course` are excluded.
- In the question editor, a rewrite or "add five choices" follows the
  ADR-059 proposal path: merged into the draft, one Undo, the teacher
  publishes.
- Writes made on the assistant's behalf get a new `assistant` actor in
  `audit.ts`'s `actorType` (invariant 9). P1 and P2 write nothing on the
  assistant's behalf, so neither adds it.

### P2 amendment (2026-10-08)

The product owner's decisions of 2026-10-08 (1–4) and the spec challenge's
(5–10), for P2. They amend §2, §3, §5 and §8 where those say so, F-LLM-03
and F-LLM-07 (docs/spec/02), N-DATA-05 and N-DATA-07 (docs/spec/03), and
ADR-022's consequence.

1. **The results reader is the assistant's alone.** `get_classroom_results`
   reads the staff gradebook route (`GET /classrooms/:id/gradebook`)
   through the same in-process chain as the other tools, and is NOT in the
   MCP catalogue (`modules/mcp/tools.ts`): the grants and personal tokens
   already given to MCP clients never gain it (ADR-022's promise). It
   returns final marks only: each released column, each student by name
   with a grade per column (`absent` for a1.0) and the gradebook's mean
   (`assistResults`, `@quiz/domain`).
2. **During a running evaluation** the assistant may read the evaluation's
   structure; the results reader returns the released columns only, so
   neither a running nor an unreleased evaluation's partial scores — nor a
   staff mark standing in such a column — ever reach the model. F-LLM-03
   is amended accordingly (§3).
3. **The screen's ids** (`AssistContext.entities`): a closed list of kinds
   — course, classroom, pool, question, evaluation, template — each a uuid,
   checked by the contract, which refuses any other key (a student, a user,
   an enrollment, an attempt) rather than dropping it. The web derives them
   from the route by a closed table (`routeEntities`), never from a field
   it does not know. The prompt lists them under "On screen"; the stored
   exchange keeps the route pattern, the topic and the language only
   (`assistScreenOf`).
4. **No masking.** The panel says, in both languages, that to answer about
   the teacher's classrooms the assistant reads their data as the teacher
   sees it, students' names and results included, and sends it to
   Anthropic (`assist.notice`). N-DATA-07 and the data-protection guide say
   so to the students.
5. **Identity**: §8, "The identity, as built".
6. **A closed allowlist of tools**, pinned by a test
   (`assist.tools.db.test.ts`): `read_guide`; the MCP read tools that carry
   no student data — `list_courses`, `get_course`, `list_pools`,
   `get_pool`, `get_pool_question_stats`, `list_questions`,
   `find_similar_questions`, `get_question`, `describe_question_types`,
   `list_evaluations`, `get_evaluation`, `list_templates` — reusing their
   schemas and handlers with the assistant's own descriptions (no authoring
   nudge); and the results reader. No write tool is handed to the model,
   an unknown name is an error it reads, and the client the tools are given
   refuses every write before sending it (`readOnly`).
7. **Bounds.** Every tool result is cut at 24,000 characters (about 8k
   tokens) with a "narrow your request" marker (`capToolResult`);
   `ASSIST_MAX_STEPS` is 6; each request is still reserved at its worst case
   against the cap and the 25 % share (§4).
8. **Links.** In an answer, only a link to the app's own origin is
   clickable (`Markdown links="same-origin"`); any other renders as its text,
   so a page or a title that steers the model into a link carrying what it
   read off to another site is never one click away.
9. **What is stored** is the question and the answer, never a tool call nor
   its result. A student's name the answer quotes may stay in the teacher's
   conversation up to 30 days after that student's erasure;
   `docs/guide/data-protection.md` says so.
10. **The prompt** lets the assistant answer about the user's own data from
    what a tool returned; it still declines anything off-topic, never claims
    to have changed anything (no writes until P3), and explains how to do it
    in the interface when asked to change something.

Deferred: the results reader over MCP, opaque handles instead of uuids in
the context, per-attempt detail (an answer, a paper), streaming, and the
writes of P3.

### P2b amendment (2026-10-08)

The product owner's need of 2026-10-08: asked "show me the questions of the
Sandbox pool", the assistant listed 28 questions in prose. It should DRIVE
THE INTERFACE instead — open the pool's screen, searched when asked ("only
the printf ones" is the pool's search `tag:printf`), switch a tab ("the
roster of PRG1-2026"), run the screen's own palette commands. His decisions,
numbered as he gave them:

1. **Navigation happens directly, with no confirmation.** The assistant
   opens the screen and says so in one line; the browser's Back returns.
   The router's leave guard (`useLeaveGuard`, unsaved work) still asks
   before the screen is left. The panel stays open across the navigation.
2. **It may run the current screen's palette commands that have no
   effect** — open a preview, switch to a tab, open a sheet, go to the
   results… Commands that change anything (publish, delete, start or close
   an evaluation, release, grade…) are not runnable in P2b; they come with
   P3, with a confirmation.
3. **P2b ships before P3** (writes), which will reuse this action mechanism.

The design, as built:

- **The browser acts; the server checks.** Two tools are handed to the
  model after the read tools: `open_screen(screen, ids, params)` and
  `run_screen_command(id)`. The server runs nothing for them: it checks the
  call (`AssistUiTurn`, `checkOpenScreen` of `@quiz/domain`), answers the
  model a short "done by the browser after your answer" — or the refusal,
  naming what is allowed —, and returns the checked actions with the reply
  (`AssistReply.actions`, `@quiz/contracts`). The turn goes on, so the
  model still answers in text. The browser runs the actions in order once
  the answer is on screen (`apps/web/src/assist/actions.ts`). **At most one
  screen per answer, at most three commands, and no command once a screen
  is being opened** (the commands are the current screen's, which the
  navigation leaves). The gateway's loop is unchanged: the two tools are
  `ReadOnlyTool`s that read nothing either.
- **The screen catalogue is held to the router.** It is written once, in
  `@quiz/domain` (`ASSIST_SCREENS`, `assistScreens.ts`), one line per
  screen — pattern, ids and their entity kinds, parameters, English title,
  help topic, administrator-only —, beside the tab lists the screens and
  the router now read from there (`POOL_TABS`, `CLASSROOM_QUERY_TABS`,
  `COURSE_TABS`, …). The web classifies every view of the router in
  `ASSIST_SCREEN_LABELS` (`apps/web/src/assist/screens.ts`), a table mapped
  over the `Route` union — a view added to the router and not classified is
  a compile error —: the label a screen of the catalogue is named by, or
  `null` — a student's screen, a projection, a preview, a guest's or a
  station's page, a creation form, a page whose ids no read tool returns (a
  project, a group set). Its test holds the two to each other and to the
  router: the same screens, each pattern the router's own (`routePattern`),
  each id of the kind the P2 table gives (`routeEntities`), each title the
  label's English text. The administration is offered to an administrator's
  assistant only.
- **Checks.** One rule, `checkOpenScreen` (`@quiz/domain`), on both sides:
  a screen of the role's catalogue, exactly its ids, and only its
  parameters — a tab from its list, the pool's search as one line of at
  most 200 characters, a category or an item id. The server requires uuids;
  the browser requires each id to be a plain path segment, and the route's
  path to parse back to that screen (`parsePath`). Otherwise nothing moves
  and the answer says "Could not open this screen" — never a silent jump
  to the home. The router's `navigate` resolves whether the app moved: when
  the leave guard kept it on the screen, the answer says "Stayed on this
  screen", never "Opened".
- **Filtering reuses the screens' own address state.** The parameters a
  route does not carry go on the query string (`navigate`'s new `query`
  option), where the screen reads them with `useSearchParam`. The pool
  screen gains `?q=`, its search box as typed, in the grammar of
  `pool/searchSyntax.ts` (`tag:`, `type:`, `difficulty:`, `version:`); it is
  also kept in the address when the teacher types, so a reload keeps it.
- **Commands carry an effect.** A screen command (`ScreenCommand`,
  `useScreenCommands`) must declare `effect: "none" | "write"`, so every
  one is classified where it is written. Classified `none`: the editor's preview and "try it", the
  live dashboard's "configure", the grading's and the results' links to
  each other, the pool's "new question of type …" (it opens the creation
  sheet; nothing exists until the teacher saves), the classroom's "connect
  to GitHub" (it opens the sheet). Classified `write`: publish, start,
  pause, extend, close, grade, regrade, release. The client sends the
  screen's commands as `{id, label, effect}` in the context
  (`AssistContext.commands`); the server lists the `none` ones to the model
  in the screen part of the prompt and accepts only those; the browser runs
  a command only while it is still registered and still `none`. A command
  that needs a real user gesture — the editor's preview opens a new tab,
  which a browser blocks as a pop-up after an asynchronous answer — is
  marked `gesture` and offered in the answer as a button the teacher
  clicks, never run on its own.
- **A command's label is screen chrome.** It reaches the model, so a screen
  command's label never embeds an entity's name or content (a title, a
  student, a question); a command that would need one uses a generic label.
  The rule is written on `ScreenCommand`.
- **Nothing is stored.** The exchange keeps its text and the screen
  (pattern, topic, language): never the commands nor the actions, as for
  the tool calls of P2 (item 9). The panel shows "Opened: <screen>",
  "Stayed on this screen" or "Done: <command>" under the answer, for this
  tab only.
- **The prompt prefers showing over listing**: asked to see, show, open or
  display something, the assistant finds its id with its read tools, opens
  the screen (searched or on a tab when the teacher narrows it) and replies
  in one short sentence, without enumerating what the screen shows. The
  catalogue is in the cached prefix (it depends on the role only); the
  screen's commands in the screen part.
- **Prompt injection is bounded by construction.** Whatever a page, a title
  or a tool result steers the model into, an action can only move the
  teacher's own browser to one of the app's own screens of the closed
  catalogue — which reads with the teacher's own seats — or run an
  effect-free command the screen offers; it never writes, never leaves the
  origin, and the leave guard still protects unsaved work. The prompt also
  says to act only because the user asked.
- **The development stub** (`stubTurn`, shared by the API and the browser
  mock) opens a pool the question names when it asks to see something,
  searched by its `tag:x` or `#x`; the API checks its action like a
  model's.
- **§1 and the P2 amendment's item 10 amended**: the assistant still changes
  nothing on the platform, and now acts on the teacher's interface.

Deferred to P3: commands with an effect (behind a confirmation), and a
navigation whose result the model reads back.

### P3 amendment (2026-10-08)

The product owner's decisions of 2026-10-08 (1–5) and the orchestrator's
(6–11), for P3: the assistant PROPOSES changes, and only the teacher's
Apply or Confirm makes them. They amend §1, §2, §8 and §9 where they say
so, the P2 amendment's item 10 and the P2b amendment's decision 2,
[ADR-059](ADR-059-generer-la-reponse.md) §1–2 for the assistant only, and
F-LLM-07 (docs/spec/02).

1. **In the question editor the assistant may rewrite the teacher's own
   texts**: the statement, the choices' texts, the explanation, and the
   type's other free-text fields as the type declares them
   (`QuestionTypeServer.assistText`, `@quiz/core`: `mcq` its choices,
   `categorize` its columns' labels and cards' texts, `cloze` its text; any
   other type its `prompt`), each with the label the diff names it by
   (`ASSIST_TEXT_LABELS`: statement, choice, column, card). Never an id, a setting, the key (an mcq tick),
   the scoring, the variables, a `[[…]]` expression, a cloze's `{{…}}`
   blank nor an `asset:` reference: a rewrite keeps every such token
   verbatim and as many times, or it is refused. "Add N choices" uses
   ADR-059's fill-and-append — the empty rows first, then appended, never a
   text already there (the wand's own rule of "the same item",
   `sameItemText` of `@quiz/core`), never past the type's maximum — and an added choice
   is UNTICKED (`append.item`): the key stays the teacher's. *This amends
   ADR-059 §1–2 for the assistant only: the wand keeps its own rules (it
   writes only what is empty, and may propose a key).*
2. **An editor proposal is a diff the teacher applies.** The panel shows
   each field before and after, with **Apply to the draft**; Apply merges it
   into the open draft as ONE edit, which **Undo** reverses while nothing
   else changed the draft; the autosave stores it; nothing publishes it. A
   proposal whose base is no longer the editor's draft (a keystroke, another
   tab) is dropped and says so. Before a question asked from the editor,
   the client FLUSHES the autosave, and sends the draft's config and
   explanation with the question (`AssistAsk.editor`) — on the editor
   screen only: the contract (`AssistAsk`) refuses it, `editor_off_screen`,
   on any other screen or for another question. *This amends §2: from the
   question editor, the context carries the teacher's own text, never
   stored; the prompt shows the model the draft's free texts only, by path,
   not its key nor its settings.*
3. **No server-side `update_question`.** An existing question changes only
   in its own editor, through (1) and (2).
4. **The writes, each confirmed one by one**, a closed list
   (`ASSIST_WRITE_TOOLS`, `@quiz/domain`): `create_question` — FORCED to a
   draft (its schema as handed to the model has no `publish`, and a
   `publish: true` is dropped), after a `find_similar_questions` in the same
   answer (refused otherwise), its config checked by the type's schema —,
   `create_category`, `create_template` (no questions, or published ones
   only), `add_questions_to_template` (published ones only),
   `link_pool_to_course` (its card names who gains access: the course's
   whole staff, each by name). **Excluded**, never handed to the model and
   pinned by a test: `update_question`, `update_evaluation`,
   `add_questions_to_evaluation`, `create_evaluation`,
   `instantiate_template`, `create_pool`, `create_classroom`, `create_poll`,
   `create_course`.
5. **The screen's write commands, behind a confirmation.** A palette
   command with `effect: "write"` is listed to the model as such and, named
   by it, comes back as a card naming the command (`confirm_command`); the
   browser runs it on **Confirm** only, and only while the screen still
   registers it as a write. Its own confirmation dialog, if any, still asks.
   *This amends the P2b amendment's decision 2.* Every write command the
   screens register today is offered (see the classification below); none
   deletes. A deletion is never lent to the assistant as a screen command
   unless the command itself asks its own `danger` confirmation.
6. **An editor proposal is a tool**, `propose_question_edit`, offered only
   when the editor's draft rides with the question: the server reads the
   question AS THE TEACHER (a question they cannot read has no editor, and
   no tool), checks the patch (`proposeQuestionEdit`, `@quiz/domain`: text
   fields only, the rest of the config the base's by construction, the
   preserved tokens kept) and the proposed config against the type's
   `configSchema` on the fields it changed (the draft's own issues
   elsewhere are the draft's, D16), and returns it as an action
   (`edit_question`, with its `base`). Nothing is written on the server.
7. **A write the model asks for is not executed.** The call is checked —
   its arguments parsed by the MCP tool's own schema, each entity read back
   as the teacher (a 404 is a refusal the model reads) — and FROZEN as a
   pending write, IN MEMORY (`PendingWrites`, `modules/assist/pending.ts`),
   keyed by the teacher and the conversation, ten minutes
   (`ASSIST_PENDING_TTL_MS`), taken once. **A deploy or a restart forgets
   every pending write**: nothing was written, the teacher asks again. One
   card per write call, at most three per answer (`ASSIST_MAX_WRITES`), and
   the turn ENDS after a step that prepared one: the gateway's next request
   is the last and may not call a tool (`ConverseRequest.endAfter`, an
   amendment of §5's loop), so the model only says what it prepared. The
   card is rendered by the SERVER from the frozen arguments, the titles
   resolved (`AssistPendingWrite.lines`, labelled by the browser in the UI
   language), never from the model's prose. **Confirm**
   (`POST /app/api/assist/writes/:id/confirm`, with the conversation; the
   same guard as a question: a teacher's or an administrator's own portal
   session, never an impersonation) mints a fresh assist-audience token for
   that single call, runs EXACTLY the frozen arguments through the MCP
   tool's handler (`runTool`), deletes the token, and answers the app's path
   of the result for the card's link. A write that is not this teacher's
   and this conversation's, already spent, cancelled or expired is one
   answer, `404 write_not_found`; a refusal of the route is `422
   write_failed` with a reason code (`AssistWriteFailed`, `@quiz/contracts`:
   `not_found`, `refused`, `invalid`, `failed`) the browser words in the UI
   language. **Cancel**
   (`…/cancel`) forgets it. Confirm does not resume the model. Super Powers
   never pass: the token resolves the teacher's own seats (§8).
8. **Audit.** `assistant` joins the closed `actorType` list
   (`AUDIT_ACTOR_TYPES`, `db/auth.ts`; invariant 9). A request
   authenticated by an assist-audience token (`authVia: "assistant"`) is
   audited as `assistant`, the teacher as `actor_user_id`, and the tool's
   name in the payload (`assistTool`) where the route traces through
   `tracer` (the header `ASSIST_TOOL_HEADER`, read beside that token on an
   internal call only). The column is text, its list the schema's, so the
   change needs no migration (`pnpm db:generate`: no schema change). *P2's
   reads write no audit rows* — a GET is not audited —, and an editor
   proposal applied or a write command confirmed in the browser is the
   teacher's own edit or action, on their own session, audited as `user`
   where the route audits at all. *This completes §9's last point.*
9. **Drafts cannot go into templates.** Asked to put a draft into a
   template, the assistant prepares nothing and says to publish it in the
   editor, then to ask again. It never publishes through a server tool; a
   publish palette command the teacher confirms (5) is the teacher's own
   action.
10. **The panel.** A proposal is a card under the answer; **Confirm** or
    **Apply** is the card's own primary, the `ink` button variant — never
    the accent (ADR-069) —, **Cancel** secondary; after a confirmed write, a
    link opens the result. Strings in English and French. The P2b
    leftover is fixed: the screen part of the prompt says which command
    opens a new tab (offered as a button) and which changes data, and the
    tool's answer says so, so the model's wording is right.
11. **The prompt** lets the assistant propose edits and prepare writes for
    confirmation; it says what it prepared and that nothing happens until
    the teacher confirms or applies it; it never claims a write happened;
    it still declines anything off-topic and explains how to make any
    change it may not propose. *This amends the P2 amendment's item 10.*

The screens' write commands, classified (decision 5):

| Command | Screen | Offered behind the card | Its own confirmation |
|---|---|---|---|
| `question:publish` | question editor | yes | the publish dialog |
| `live:start` | live dashboard | yes | none (the start itself) |
| `live:pause` (pause or resume) | live dashboard | yes | none |
| `live:extend` (+5 min for all) | live dashboard | yes | none |
| `live:close` | live dashboard | yes | the `danger` close dialog |
| `grading:run` | grading | yes | none |
| `grading:regrade` | grading | yes | the regrade dialog |
| `results:release` | results | yes | the release dialog |

The development stub (`stubTurn`) proposes a tidied statement in the
editor ("rewrite …", `stubRewrite`) and prepares a quoted category on a
pool ("create the category «…»"), through the same tools as a model's; the
browser mock does the same.

Deferred: a write's result read back by the model (Confirm does not resume
it), pending writes that survive a deploy, writes over MCP that need the
teacher's confirmation, and an editor proposal for a field a type does not
declare.

## Consequences

- A teacher asks a question from any teacher screen and gets an answer that
  names the screen's labels, without leaving the screen; in development,
  with the stub.
- Each question costs up to six metered requests (four before P2); with the prefix cached,
  a question costs a few cents with Sonnet. The chat cannot spend
  more than a quarter of the cap, nor the last quarter of it.
- A new personal-data table about staff (their questions), read by its
  owner and the administrators, audited for the latter, kept 30 days.
- The guide becomes part of the product's behaviour: a stale page is a
  confidently wrong answer. The corpus is rebuilt from the commit at every
  build, so it is never older than the code; the guide's English is the
  model's to translate.
- The gateway has two shapes of call; a new provider implements both.
- Since P3, the assistant proposes and the teacher decides, change by
  change: an editor rewrite is a diff applied to the draft, a write is a
  card confirmed within ten minutes, a write command a card confirmed in
  the browser. A deploy forgets the pending writes; the audit log tells the
  assistant's confirmed writes (`assistant`) from the teacher's own.
- An offline evaluation prompt set (`apps/api/src/modules/assist/eval-prompts.json`:
  off-topic, jailbreak and legitimate questions, in French and English)
  waits for the stub-free evaluation; it is not run in CI.

## Alternatives considered

- **Nothing stored, history in the tab** (the spec challenge's default).
  Rejected by the product owner: a teacher comes back to an answer, and an
  administrator must be able to see what the assistant told a teacher. The
  30-day retention and the audited read bound it.
- **Vector RAG with embeddings.** Anthropic has no embeddings API; a second
  provider contradicts F-LLM-01, and the corpus fits an index plus a tool.
- **The whole corpus in the prompt.** About 80 k tokens per question,
  cached or not; the index with `read_guide` sends a tenth of it.
- **An entry in the help drawer or the command palette only.** Rejected
  for the floating button, which stays on every screen; the help drawer and
  the palette are unchanged.
- **Streaming.** Deferred: a reply of a few sentences arrives in seconds,
  and a streaming tool loop needs the gateway to settle a reservation
  mid-stream.
- **The specification and ADRs in the corpus.** Developer-facing, describe
  unshipped work and security details.
