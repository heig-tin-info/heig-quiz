# 8. Two-level experience: novice and expert

The platform serves two profiles of teachers with the same interface. The novice wants to enter a question as in a word processor, click a button to get the answer, and launch the quiz. The expert wants to write markdown, regexes, version questions in git, do everything from the keyboard. Neither must see the other's tools by default.

## 8.1 Principles

1. **Progressive disclosure.** The simple path is the default path. Advanced options sit behind a toggle, a menu or the command palette, never in the main flow.
2. **A single source of truth.** The WYSIWYG and the source view edit the same markdown. The "expected answer" form and the regex matcher write the same configuration. Switching from one mode to the other loses nothing. The journal's two levels are two modes of the journal itself, In Quiz (the novice, edited in the platform) and In a GitHub repository (the expert, edited in their own tools; ADR-057); within the Quiz editor, the WYSIWYG and the source still edit the same markdown.
3. **The LLM does the thankless work, the teacher decides.** Every "Generate" button produces a proposal in the draft, visible, editable, never published on its own.
4. **Everything the interface does, the API does.** The UI and API tokens share `/app/api`; MCP is exposed at `/app/api/mcp` (ADR-022, ADR-023). Token scopes and route restrictions still apply. A screen's presence does not imply its session-only route is available to an API token.
5. **Keyboard first for the expert, never required for the novice.** Every shortcut has a clickable equivalent.

## 8.2 Novice mode

| Need | Answer |
|---|---|
| Create a question without learning a syntax | Tiptap editor in WYSIWYG: minimal toolbar with bold, italic, code, list, heading, image, equation. Pasting an image inserts it. Pasting a table from Excel converts it. |
| Write an equation without LaTeX | Equation button with preview, LaTeX entry assisted by a symbol palette, and a "Describe the equation" button that asks the LLM for the translation into LaTeX. |
| Not knowing the question types | "New question" screen with four illustrated cards: choice, short answer, fill in the blanks, code. The advanced types under "More". |
| Create an MCQ quickly | "Paste an MCQ": the teacher pastes a text with lines `A)`, `B)`, `*C)` or `- [x]`, the platform recognises the statement, the choices and the correct answer. |
| Get the correct answer and the explanation | **Generate the answer** button in every editor: the LLM ticks the correct choices, fills in the expected answer, or writes the reference solution for a code question, then writes the explanation. *Amended (ADR-059): the proposal fills what is empty and completes the lists, never changing what the teacher wrote; it lands in the draft like an edit, with one Undo until the next edit, and never publishes.* |
| Create test cases without writing a test | For a code question: enter inputs, click "Compute the expected outputs", which runs the reference solution in the runner and fills in the outputs. For `codeimage`, "Try the reference solution" draws the image and "Use as target" makes it the target, no pixel is ever typed. |
| Check that the question works | "Try" tab in the editor: the teacher answers as a student would and sees the grading. No publication without a successful try, non-blocking reminder. |
| Configure a quiz without mistakes | Three screens: pick the questions, set the time, start. The start screen is a checklist that says what blocks the launch, what deserves a look and what happens when the button is pressed, beside a preview of the waiting room the students will read (F-EVAL-23). The time screen asks one question, who drives the clock — Scheduled or Live — and one switch, a time limit per student (F-EVAL-04, [ADR-086](../adr/ADR-086-planifiee-ou-en-direct.md), which replaced the named presets "Graded quiz 20 min" and "Exercise of the week" there). The header of that screen carries the mode, Exam or Exercise, as a switch until students are let in (a badge after), and a change rewrites nothing else but what the new mode forces ([ADR-092](../adr/ADR-092-changer-le-mode-d-une-evaluation.md), 2026-10-09). Everything else under "Advanced options". |
| Understand a setting | Every option has a help sentence under its label, not a tooltip. |
| Grade effortlessly | Grading panel with the LLM proposals sorted by confidence. "Validate everything with high confidence" in one click, then review of the remaining cases. |
| Reuse last year's evaluation | The course's own page (F-ORG-12), opened from its name, lists its evaluation templates; "Save as template" in an evaluation's menu puts one there, and "New template" on that page starts an empty one, edited in place with the evaluation editor's own controls minus everything of a run (F-EVAL-24, F-EVAL-25). The Courses home card lists none, so the home a novice starts from carries no empty "Templates" block for a feature they may never use. On the course page they have a tab of their own (Templates), whose empty state is where a teacher learns how a template is made (ADR-031, addendum of 2026-09-28). |
| Hand out a GitHub lab without knowing GitHub Classroom | **New ▾ › Project** in the classroom asks for a name, a source repository picked from the organization, and a deadline; everything else has its default — one commit per branch, the repository locked at the deadline, the score read from `grading.yml` when the source has one, `criteria.yml`, `README.md` and `grading.yml` protected — under "Advanced options" (F-PROJ-01). Before that, the classroom's Settings walk the teacher through connecting the organization, with a check per thing that is missing (F-GH-02, F-GH-03). The project page then has one primary action at a time: Publish, Sync, Release (F-PROJ-13). |
| See what the student sees | "Student preview" button wherever a question or an evaluation is displayed. For an evaluation it is a stateless walk in its own tab: a random seed, the student's player under a "Preview" banner, the countdown, and the full correction when it is handed in; nothing is stored (ADR-018, fourth addendum). |

## 8.3 Expert mode

| Need | Answer |
|---|---|
| Write in markdown | "Source" toggle in the editor, `Ctrl+Shift+M`, with highlighting and side-by-side preview. The choice is remembered per user. |
| Precise matchers | In the short answer editor, "Advanced" reveals the list of matchers: regex with a live tester on typed examples, numeric tolerance, units. The simple form remains a single `exact` matcher. |
| Edit the raw configuration | "Edit as YAML" opens the question in the canonical format in a Monaco editor with validation by the type's schema and a diff before saving. |
| Version in git | YAML export and import from the interface, token REST API, `quiz pull` and `quiz push` CLI. The exported folder is readable and diffable. |
| Automate | Personal API tokens in the settings, generated OpenAPI, `curl` examples in the documentation. |
| Do everything from the keyboard | `Ctrl+K` command palette, global shortcuts, `j` `k` navigation in lists, `Enter` to open, `Esc` to close. |
| Process in bulk | Multiple selection in the pool: add a concept (ADR-081), move to a category, export, add to an evaluation. |
| Inspect | Version history with diff, LLM call log, event log of an attempt, raw export of an evaluation as JSON. |
| Use LLM assistance | The administrator configures one institutional provider key, model and daily cap; teachers use that gateway. No personal key or per-teacher model configuration (ADR-058). |
| Run a project like a repository | The advanced options of a project: the source's whole history, a deadline commit instead of a lock, review checkpoints dated relative to the deadline (J−3), groups copied from another project; a sync of the source as a pull request into every repository; the runs of each repository, "grade now", a lock per repository (F-PROJ). |
| Write from one's own tool | MCP server: create and read drafts from Claude Desktop or Claude Code. Planned for phase 3, shipped early with the personal API tokens (ADR-022, ADR-023). |

## 8.4 Command palette

`Ctrl+K` or `Cmd+K` everywhere. A single input field, grouped results, keyboard navigation.

| Group | Examples |
|---|---|
| Navigation | Go to the course (its page, F-ORG-12), the classroom, the pool, the settings |
| Questions | Full-text search and by concept `#pointers` (any concept the word may designate, ADR-081), by type `type:code`, by difficulty `diff:3`; open, try, add to the evaluation being edited |
| Contextual actions | On an evaluation: start, pause, add 5 minutes, close, release the results. On a question: publish, duplicate, generate a variant, export |
| Creation | New question of type X, new evaluation, new pool |
| Preferences | Theme, language, default source mode |
| Help | Shortcuts, documentation, data and privacy |

The actions are provided by the mounted screens, through the command registry in `apps/web/src/screenCommands.ts`, combined with global commands by `apps/web/src/commands.ts`. A screen declares its commands with label, shortcut, condition and handler. The palette knows nothing about the modules.

## 8.5 Shortcuts

| Context | Shortcut | Action |
|---|---|---|
| Global | `Ctrl+K` | Palette |
| Global | `?` | List of shortcuts |
| Global | `g` then `p` / `c` / `s` | Go to the pool / the courses / the settings |
| Pool | `P` | Preview the focused question in the reading pane (Enter opens the editor) |
| Pool | `Space` | Star or unstar the focused question, a personal favourite found again in the question picker (F-POOL-10) |
| Editor | `Ctrl+S` | Save the draft, already automatic, reassures |
| Editor | `Ctrl+Shift+P` | Publish |
| Editor | `Ctrl+Shift+M` | Toggle WYSIWYG / source |
| Editor | `Ctrl+Enter` | Try the question |
| Code editor | those of VS Code | Monaco |
| Circuit canvas | `Ctrl+Z` / `Ctrl+Y` · `R` `H` `V` · `W` · `1`–`9` · `Del` | Undo / redo · rotate / mirror · wire tool · pick the nth part of the palette · delete. Also bound, not listed in the strip: `Space` (rotate), `Backspace`, `Ctrl+Shift+Z`, `Ctrl+D` (duplicate), `Ctrl+A` (select all), `Esc` (unwinds the wire, the tool, the selection). While the canvas has the focus and is editable, its lines join the sidebar strip of the question editor and the side column of the student player (issue #549, ADR-046 addendum 2026-10-07) |
| Diagram canvas | `Ctrl+Z` / `Ctrl+Y` · `I` · `1`–`9` · `Del` | Undo / redo · reverse the selected link · pick the nth tool · delete. Also bound, not listed: `Backspace`, `Ctrl+Shift+Z`, `Ctrl+D`, `Ctrl+A`, `Esc`. Shown as for the circuit canvas |
| Student player | `Alt+→` `Alt+←` | Next / previous question |
| Drill card | `0`–`4` | How sure you are, before the correction; the same digit again clears it. Not while typing in a field of the answer (ADR-085) |
| Student player | `Ctrl+Enter` | "Validate and continue", where the navigation has one (`forward_only`, a checkpoint question in `milestones`); it opens the same confirmation as the button. Nothing in `free`, where a question is answered as soon as it holds an answer (issue #89) |
| Dashboard | `n` `r` `s` | Toggle names / answers / results |
| Dashboard | `Space` | Pause / resume |
| Grading | `←` `→` · `↑` `↓` · `Enter` · `V` · `A` | Previous / next question · previous / next answer · open it · validate it · adjust it (ADR-044) |

## 8.6 Features that make the difference

- **Generate a variant**: same question, other values or other context, as a draft linked to the original by `origin_question_id`.
- **Generate a quiz**: duration, concepts, difficulty, and the platform composes a draft evaluation from the answer-time statistics. Phase 3.
- **Session code and QR code** to join a poll from a phone. Classrooms use the teacher-managed roster and matching edu-ID address, without an entry code (ADR-053).
- **Projection view** without names: presence ring in the waiting room, live distribution for a poll, completion rate during a quiz.
- **Image difference** for `codeimage`: the target, the student's image and a green / red difference, one grid or two side by side, with the share of correct pixels.
- **Attempt history** for support: reconstruction of the sequence of revisions of an answer with server timestamps.
- **Preview of five instantiations** for a question with random values, computed by the API (ADR-056 §8); a "freeze" button, turning one instance into a static question, comes later.
- **Statistics in the pool**: on a question's row or card, success rate and time spent per question, to pick the right question at a glance (ADR-038, ADR-039); the filter sheet bounds both, to find the questions that are too easy, too hard or too long (F-STAT-03).
- **Paste from Moodle**: a GIFT file dropped on the pool is imported, the non-convertible questions are listed.
- **Batch grading**: filter by confidence, by question, by gap between the LLM proposal and the average score.
- **Zen mode** for the student, one question per screen, progress bar, no unnecessary chrome.
