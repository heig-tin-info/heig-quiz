# ADR-058 — The LLM gateway: one institutional key, a daily cap, a call log

## Status

Accepted (2026-10-01, decisions of the product owner). First of three
phases of LLM assistance; [ADR-059](ADR-059-generer-la-reponse.md) (the
"Generate" wand of the editor) and [ADR-060](ADR-060-revue-llm-des-questions.md)
(the nightly review of the questions) build on it and are only proposed.

Delivers F-LLM-04 (the call log) and N-SEC-08 (the key encrypted at rest)
for the platform's own key. Delivered with `apps/api/src/modules/llm/`
(`gateway.ts`, `service.ts`, `anthropic.ts`, `crypto.ts`, `routes.ts`),
`@quiz/domain/llm`, `@quiz/contracts/llm`, the migration `llm_gateway`
(which inserts the settings row), the check `llm.budget`, the audit actions
`llm.settings` and `llm.test`, and the "AI" tab of the Administration page.
Amends:

- **F-LLM-01** (docs/spec/02): one provider (Anthropic) and one
  **institutional** key, entered by an administrator; no per-teacher key and
  no OpenAI-compatible client for now. The interface stays provider-agnostic
  so that both can come back.
- **Open question 13** (docs/spec/06), now settled: the institution pays, and
  one model serves every purpose, Claude Sonnet by default.
- **docs/spec/05** §5.3 (`llm_calls` gains the purposes `test` and `review`,
  a `status`, and a nullable `user_id`; `providers` becomes the singleton
  `llm_settings`) and §5.6 (the default model is Sonnet for every purpose,
  grading included).
- **docs/spec/00**, risk table: the per-teacher key was the mitigation of the
  provider's cost; the daily cap (§5) replaces it.
- **[ADR-010](ADR-010-stockage-secrets.md)**, rejected alternative 3 ("secrets
  in the database"): one secret, the provider key, is stored in the database,
  ENCRYPTED by a master key that lives in the environment like every other
  secret (§3).
- **[ADR-045](ADR-045-service-llm-de-correction.md)**: unchanged in effect.
  The grading pass keeps its `LlmService` chosen by `LLM_PROVIDER` (`none` or
  the development `stub`); the gateway is NOT wired into grading in this
  phase (§8).

Defers N-DATA-05's "no-retention mode" and the data-protection review of
what is sent to the provider to a new open question (docs/spec/06, row 43).

## Context

ADR-045 gave the grading pass a call path and a deterministic stub, and
left the real provider for later. Three features now want a model: the
grading proposals (F-GRADE-02), the "Generate" buttons of the editor
(F-LLM-02, ADR-059) and a review of the published questions (ADR-060). They
need the same things first: a key, a model, a record of what each call cost,
and a guard against a bug that loops on a paid API overnight.

The spec planned a provider list with a key per teacher (F-LLM-01) and Opus
for grading (question 13). The product owner decided otherwise on
2026-10-01: the platform pays, the use is small (teachers authoring), and the
current Sonnet is good enough for every purpose. A quota per teacher is not
wanted; a ceiling against runaway spending is.

## Decision

### 1. One gateway, called by purpose, with a validated output

The `llm` module owns an `LlmGateway` with one method:

```ts
complete({ purpose, userId, system, prompt, schema, maxTokens }) → Promise<T>
```

`purpose` is a closed union (`test`, `grade`, `generate`, `review`), `userId`
the teacher the call is made for (null for a call no person made), `schema`
a zod schema the reply must satisfy. The gateway asks the provider for a
STRUCTURED output (JSON matching the schema), parses it, retries once on an
invalid reply, and returns the parsed value or throws a typed `LlmError`
whose `code` comes from a closed vocabulary (`not_configured`,
`key_unreadable`, `budget_exhausted`, `auth_failed`, `rate_limited`,
`refused`, `invalid_output`, `timeout`, `provider_error`; `LLM_ERROR_CODES`
of `@quiz/contracts`).

A provider is an adapter behind `LlmProvider` (`apps/api/src/modules/llm/`);
the only one is Anthropic, through the official SDK. An OpenAI-compatible
adapter, or a European or local model, is a second adapter and a second
value of the `provider` column, nothing else.

**No sampling parameters.** The current Anthropic models refuse a
`temperature` other than the default (a 400 on Sonnet 5.5). A reproducible,
sober answer comes from the structured output, its zod validation and a low
`effort` for the short purposes, not from a temperature.

### 2. One settings row, a model per purpose, one model in the screen

The table `llm_settings` holds ONE row (`id = 'default'`, a CHECK): the
provider (`anthropic`), the encrypted key and its last four characters, the
model per purpose (`models` jsonb, `{ purpose → model id }`), the daily cap
in USD, who changed it and when. The administration screen offers ONE model
select and writes it for every purpose; a per-purpose choice is a screen
change, not a schema change.

The selectable models are a closed list in `@quiz/domain` (`LLM_MODELS`),
each with its price per million input and output tokens: Claude Sonnet 5.5
(the default), Claude Opus 5.5 and Claude Haiku 4.5. A model leaves the list
the day the provider retires it; the list is code, reviewed like code.

### 3. The key: encrypted with a master key from the environment

- `LLM_KEY_SECRET` (at least 32 characters) is the master key. It is a
  secret of ADR-010: in the environment file, in the age vault, never in
  the repository. Without it the gateway is off, the settings screen says so,
  and a stored ciphertext is ignored.
- The provider key is encrypted with AES-256-GCM under a key derived from
  `LLM_KEY_SECRET` (HKDF-SHA-256), with a fresh 12-byte nonce per write and
  the provider id as additional authenticated data. The row stores the
  nonce, the ciphertext and the tag, never the key.
- The key is **write-only**: the API accepts it, stores it, and returns only
  its last four characters. It is never sent back, never logged, never in
  an audit payload. The log redaction (`apps/api/src/redact.ts`) learns
  `sk-ant-` and the `x-api-key` header, with a test.
- A lost or changed master key loses nothing but the key: the gateway reports
  `key_unreadable`, and an administrator enters the key again.
- Under `NODE_ENV=production`, `config.ts` refuses a `LLM_KEY_SECRET` shorter
  than 32 characters or equal to a development value, like the other
  secrets (invariant 3).

### 4. Every call is logged, never its content

`llm_calls` (owned by the `llm` module): `id`, `created_at`, `user_id`
(nullable), `purpose`, `provider`, `model`, `input_tokens`,
`output_tokens`, `cost_usd`, `duration_ms`, `status` (`pending`, `ok`,
`error`), `error` (the `LlmError` code). Never the prompt, never the reply
(F-LLM-04). The cost is computed when the row is written, from the price of
the model the provider says answered, and stored: a later price change does
not rewrite history. It is labelled an ESTIMATE everywhere it is shown.

### 5. A daily cap against runaway spending, checked before the call

The cap is not a quota. It exists so that a bug that loops cannot spend
thousands overnight, and is set generously enough that no legitimate day
reaches it.

- Default **20 USD per day**, editable by an administrator in the settings,
  bounded by `LLM_DAILY_CAP_MAX_USD` (environment, default 100), so that a
  bug in the settings route cannot lift the ceiling either.
- The day is the calendar day in `Europe/Zurich`, of the server's clock
  (`app.clock`, invariant 5), computed by the database's `date_trunc`.
- **Reserve, then call.** Under a transaction-scoped advisory lock, the
  gateway sums today's `cost_usd` and inserts a `pending` row whose cost is
  the call's WORST case (`maxTokens` at the output price plus the prompt's
  length at the input price). Over the cap, the call fails with
  `budget_exhausted` and nothing reaches the provider; the day's first
  refusal is logged, at no cost, and no later one.
  After the call the row gets its real tokens, cost and status. Parallel
  calls therefore cannot overshoot together.
- A refusal turns the health check of §7 red for the rest of the day. Each
  caller words it for its reader: the connection test answers
  `{ ok: false, error: "budget_exhausted" }`; the routes of ADR-059 will
  answer `429 llm_budget_exhausted`.

### 6. The connection test

`POST /app/api/admin/llm/test`, admin only, asks the configured model "What
is the capital of France?" with a schema `{ answer: string }`, and succeeds
when the answer is Paris. It answers `{ ok, model, latencyMs, error? }`, goes
through the gateway (logged, capped, purpose `test`, the admin as user),
is limited to a few per minute (`Budget`), and is audited as `llm.test`.
Saving the settings is audited as `llm.settings` (never with the key).

### 7. The system status reads, never calls

The periodic health checks (ADR-055) never call the provider: a check that
spends money every five minutes would spend it for nothing. `service.llm`
reads what the process saw of its own calls (`tracked`, ADR-055 §6), and is
`not_configured` without a master key (and without the grading stub); with a
master key but no stored key it reads `unused`, since that verdict is
synchronous, from the configuration alone. A new check, `llm.budget`, reads
today's spend against the cap: warn from 80 %, fail at the cap or once the
cap refused a call today (`HEALTH_THRESHOLDS.llmBudgetWarn`). Neither names a
person (ADR-055 §1).

### 8. Not wired into grading yet

*Superseded (2026-10-02) by [ADR-063](ADR-063-correction-llm.md), which wires the grading pass to the gateway after the product owner accepted sending student answers.*

The grading pass keeps `app.llm`, chosen by `LLM_PROVIDER` as ADR-045 says:
`stub` in development, `none` in production. A stored key does NOT make the
essays graded by Anthropic. Before it does, the grading needs what ADR-045's
consequences list: the `grading.llm` queue, the scrubbing of names typed
into answers (N-DATA-05), the provider shown beside each proposal and a
reply per criterion. Phase 1 sends no student content and no question
content to the provider: the connection test is its only caller.

### 9. Usage, per teacher, for the administrators

A tab of the Administration page shows the settings (key, model, cap, test),
today's spend against the cap, and the current month's usage per person and
in total: calls, input and output tokens, estimated cost. It is personal
data about staff, read by administrators only, like the user list.

## Consequences

- An administrator pastes a key, picks a model, presses Test, and sees it
  green in the system status, without SSH.
- Every later feature calls `complete()` and inherits the log, the cap and
  the error vocabulary; ADR-059 and ADR-060 add purposes, not plumbing.
- One secret is added to the vault (`LLM_KEY_SECRET`), and one secret lives,
  encrypted, in the database and therefore in its backups: the master key
  stays out of both.
- The price table goes stale when the provider changes its prices; the cost
  is an estimate, said so, and the cap carries a margin.
- The OpenAI-compatible client, the teacher's own key and a per-teacher quota
  are not built. Each is an addition to this design, not a change of it.

## Alternatives considered

- **The key in the environment** (`ANTHROPIC_API_KEY`), as ADR-010 would
  have it. Simpler — no crypto, no form — but a rotation needs SSH and a
  restart, and the product owner wants the key managed from the console.
  The master key keeps ADR-010's principle where it matters: what decrypts
  the key is never in the database.
- **A per-teacher quota now.** Not wanted: the use is small and a quota
  would block a teacher for an administrator's decision. The log already
  attributes every call, so a quota is a query away.
- **A cap checked after the call.** Simpler, but N parallel calls all see the
  same total and overshoot together; the reservation costs one lock.
- **The test inside the periodic health checks.** A paid call every five
  minutes, counted against the cap, to learn what the last real call
  already says.
