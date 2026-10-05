# ADR-069 — A calculator provided on the student's screen

## Status

Accepted (2026-10-04; asked by the product owner, who settled in
conversation the name "provided", the order of operations in both modes
and where the calculator appears). Implemented by `calculatorOn` and the
engine in `packages/domain/src/calculator.ts`, `settings.calculator` in
`packages/contracts/src/evaluation.ts`, and the keypad and its dock in
`apps/web/src/calculator/`. Requirement F-EVAL-32.

## Amendment — reverse Polish notation (2026-10-05)

A user may switch the calculator to RPN in their settings (`users.rpn_calculator`,
`PATCH /app/api/me`, a row "RPN calculator"). The teacher's choice of mode
(none, standard, scientific) is untouched: the setting only changes how the
same keypad reads its keys, so it is the student's, never the evaluation's, and
it changes nothing in grading. It lives on the account, not in the browser, so
it follows a student to the exam station. Engine: `packages/domain/src/rpn.ts`
(a stack; `3 Enter 4 +` gives 7; `Enter` with nothing typed duplicates the top;
`CE` clears x). On the keypad `=` becomes Enter, and the keys only an
expression needs (`%`, parentheses) give way to swap (`x⇄y`) and roll (`R↓`).

## Context

Some exams and exercises need a calculator. Letting students bring any
calculator is a problem for the teacher: a programmable one holds notes,
and a phone holds everything. The product owner asked for a calculator in
the player itself, in two modes modelled on the Windows calculator
(standard, and scientific with the trigonometry on the same surface rather
than in a submenu), chosen per evaluation under the advanced options.

Three facts constrain it:

- A portal session cannot stop a student from using another tool. Only a
  trusted client (Safe Exam Browser, ADR-027; a kiosk station, ADR-051)
  confines the machine, and the student's own pocket calculator is out of
  the platform's reach entirely (00 §0.6).
- The CSP (`apps/api/src/csp.ts`) refuses `eval` and `new Function`, which
  rules out the expression evaluators that compile to JavaScript.
- `mathjs` is already a dependency of `@quiz/domain`, but kept out of the
  web bundle on purpose (ADR-056 §2).

## Decision

1. **A setting of the evaluation**, `settings.calculator`: `none`,
   `standard` or `scientific`. Absent is `none`; read through
   `calculatorOn(mode, setting)`, never raw. It sits in the settings JSON
   column, so it needed no migration. It travels with the settings when an
   evaluation is duplicated or saved as a template (F-EVAL-14, F-EVAL-18),
   and a pull keeps the instance's (F-EVAL-26). It is frozen with the rest
   of the settings. A poll has nothing to compute: the
   server refuses the setting there (`422 calculator_not_allowed`) and reads
   it as `none`.
2. **It provides; it forbids nothing.** The setting is labelled "Calculator
   provided". Its description says that only Safe Exam Browser or a kiosk
   station keeps a student from another tool. The platform makes no claim
   it cannot enforce.
3. **Where it appears**: in the player of an exam or an exercise while the
   attempt is open, as the teacher's student preview and an impersonation
   session show it too (they render the same player). Not in the drill,
   whose cards come from many evaluations. The waiting room announces it,
   as it announces negative marking (F-EVAL-16), so that a student knows
   where it is before the clock runs.
4. **The order of operations in both modes.** Windows's standard mode
   computes from left to right (`2 + 3 × 4 = 20`); here both modes give 14.
   One engine, one behaviour to learn, and the arithmetic of a mathematics
   lesson. Otherwise the keys follow Windows: the expression above, the
   number below, a function applied to the number at once (`sin(30°)` reads
   0.5), `%` a share of what precedes after `+` or `−`.
5. **Our own engine**, pure, in `@quiz/domain` (invariant 8): a reducer from
   a state and a key to the next state, tested key by key. Binary floats,
   written with 15 significant digits so that `0.1 + 0.2` reads 0.3. A sum
   that cancels to float noise is 0, and a degree angle on a quarter turn is
   exact. Degrees by default, with a DEG/RAD toggle on the scientific keypad.
   The factorial is defined on the integers 0 to 170 only.
6. **On screen**: a round button at the bottom right of the player opens a
   non-modal panel above it. The student reads the question and types the
   answer while it is open. The keyboard drives the calculator only while
   focus is inside the panel, so digits typed in an answer field stay
   there; Escape closes it. Closed, the panel keeps its number for the rest
   of the attempt (a reload starts it over).
7. **Nothing is recorded.** The calculator lives in the browser: no request,
   no attempt event, no audit entry. The teacher does not see it being used.

## Consequences

- A new key in the settings, the waiting room's `LobbyView.calculator`, one
  domain module, two components, a z-index step (`Z.tool`, under the pause
  overlay) and `--player-footer-h` so the button clears the phone footer.
- The toasts rise above the button (`--tool-dock-h`) while it is on screen.
- An answer still has to be typed by hand: the result is selectable, but
  there is no "insert into the answer" link between the panel and a
  question type. That would be a contract between the player and every
  type, and nobody has asked for it.
- An exam that must exclude every other calculator still needs SEB or a
  kiosk station; the teacher guide says so.

## Alternatives considered

- **A ready-made React calculator.** The packages on npm are demonstrations
  with their own look, and none follows `apps/web/DESIGN.md` or its two
  themes. Restyling one would cost more than the keypad.
- **mathjs or expr-eval as the evaluator.** mathjs is about 170 kB gzipped
  in a bundle that keeps it out on purpose. expr-eval had a remote code
  execution flaw in 2025 and is barely maintained. Our expressions are a
  handful of operators over numbers, which a shunting-yard of forty lines
  covers.
- **Windows's left-to-right standard mode.** Two engines and a result a
  student would call wrong. Refused by the product owner.
- **A decimal library** (decimal.js) for exact decimal arithmetic. Rounding
  the display to 15 digits removes the visible noise for the operations a
  calculator offers, at no cost in size.
- **A calculator setting per question.** The tools of a sitting are the
  evaluation's, like negative marking; a calculator that comes and goes
  between questions would confuse more than it would help.
