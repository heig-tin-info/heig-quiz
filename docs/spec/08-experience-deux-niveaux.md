# 8. Two-level experience: novice and expert

The platform serves two profiles of teachers with the same interface. The novice wants to enter a question as in a word processor, click a button to get the answer, and launch the quiz. The expert wants to write markdown, regexes, version questions in git, do everything from the keyboard. Neither must see the other's tools by default.

## 8.1 Principles

1. **Progressive disclosure.** The simple path is the default path. Advanced options sit behind a toggle, a menu or the command palette, never in the main flow.
2. **A single source of truth.** The WYSIWYG and the source view edit the same markdown. The "expected answer" form and the regex matcher write the same configuration. Switching from one mode to the other loses nothing.
3. **The LLM does the thankless work, the teacher decides.** Every "Generate" button produces a proposal in the draft, visible, editable, never published on its own.
4. **Everything the interface does, the API does.** Every screen is built on `/api/v1`. The expert can script what the novice clicks.
5. **Keyboard first for the expert, never required for the novice.** Every shortcut has a clickable equivalent.

## 8.2 Novice mode

| Need | Answer |
|---|---|
| Create a question without learning a syntax | Tiptap editor in WYSIWYG: minimal toolbar with bold, italic, code, list, heading, image, equation. Pasting an image inserts it. Pasting a table from Excel converts it. |
| Write an equation without LaTeX | Equation button with preview, LaTeX entry assisted by a symbol palette, and a "Describe the equation" button that asks the LLM for the translation into LaTeX. |
| Not knowing the question types | "New question" screen with four illustrated cards: choice, short answer, fill in the blanks, code. The advanced types under "More". |
| Create an MCQ quickly | "Paste an MCQ": the teacher pastes a text with lines `A)`, `B)`, `*C)` or `- [x]`, the platform recognises the statement, the choices and the correct answer. |
| Get the correct answer and the explanation | **Generate the answer** button in every editor: the LLM ticks the correct choices, fills in the expected answer, or writes the reference solution for a code question, then writes the explanation. The proposals appear highlighted, with accept or reject. |
| Create test cases without writing a test | For a code question: enter inputs, click "Compute the expected outputs", which runs the reference solution in the runner and fills in the outputs. For `codeimage`, the expected image is produced the same way. |
| Check that the question works | "Try" tab in the editor: the teacher answers as a student would and sees the grading. No publication without a successful try, non-blocking reminder. |
| Configure a quiz without mistakes | Three screens: pick the questions, set the time, start. Named presets: "Graded quiz 20 min", "Exercise of the week", "Poll". Everything else under "Advanced options". |
| Understand a setting | Every option has a help sentence under its label, not a tooltip. |
| Grade effortlessly | Grading panel with the LLM proposals sorted by confidence. "Validate everything with high confidence" in one click, then review of the remaining cases. |
| See what the student sees | "Student preview" button wherever a question or an evaluation is displayed. |

## 8.3 Expert mode

| Need | Answer |
|---|---|
| Write in markdown | "Source" toggle in the editor, `Ctrl+Shift+M`, with highlighting and side-by-side preview. The choice is remembered per user. |
| Precise matchers | In the short answer editor, "Advanced" reveals the list of matchers: regex with a live tester on typed examples, numeric tolerance, units. The simple form remains a single `exact` matcher. |
| Edit the raw configuration | "Edit as YAML" opens the question in the canonical format in a Monaco editor with validation by the type's schema and a diff before saving. |
| Version in git | YAML export and import from the interface, token REST API, `quiz pull` and `quiz push` CLI. The exported folder is readable and diffable. |
| Automate | Personal API tokens in the settings, generated OpenAPI, `curl` examples in the documentation. |
| Do everything from the keyboard | `Ctrl+K` command palette, global shortcuts, `j` `k` navigation in lists, `Enter` to open, `Esc` to close. |
| Process in bulk | Multiple selection in the pool: add a tag, move to a category, export, add to an evaluation. |
| Inspect | Version history with diff, LLM call log, event log of an attempt, raw export of an evaluation as JSON. |
| Plug in one's own LLM | Personal API key, model choice per purpose, prompt templates editable per teacher, phase 3. |
| Write from one's own tool | MCP server, phase 3: create and read drafts from Claude Desktop or Claude Code. |

## 8.4 Command palette

`Ctrl+K` or `Cmd+K` everywhere. A single input field, grouped results, keyboard navigation.

| Group | Examples |
|---|---|
| Navigation | Go to the course, the classroom, the pool, the settings |
| Questions | Full-text search and by tag `#pointers`, by type `type:code`, by difficulty `diff:3`; open, try, add to the evaluation being edited |
| Contextual actions | On an evaluation: start, pause, add 5 minutes, close, release the results. On a question: publish, duplicate, generate a variant, export |
| Creation | New question of type X, new evaluation, new pool |
| Preferences | Theme, language, default source mode |
| Help | Shortcuts, documentation, data and privacy |

The actions are provided by the mounted screens, through a command registry in `packages/ui`. A screen declares its commands with label, shortcut, condition and handler. The palette knows nothing about the modules.

## 8.5 Shortcuts

| Context | Shortcut | Action |
|---|---|---|
| Global | `Ctrl+K` | Palette |
| Global | `?` | List of shortcuts |
| Global | `g` then `p` / `c` / `s` | Go to the pool / the courses / the settings |
| Editor | `Ctrl+S` | Save the draft, already automatic, reassures |
| Editor | `Ctrl+Shift+P` | Publish |
| Editor | `Ctrl+Shift+M` | Toggle WYSIWYG / source |
| Editor | `Ctrl+Enter` | Try the question |
| Code editor | those of VS Code | Monaco |
| Student player | `Alt+→` `Alt+←` | Next / previous question |
| Student player | `Ctrl+Enter` | Mark as done, or run the code in a code question |
| Dashboard | `n` `r` `s` | Toggle names / answers / results |
| Dashboard | `Space` | Pause / resume |
| Grading | `v` `→` | Validate and move on to the next |

## 8.6 Features that make the difference

- **Generate a variant**: same question, other values or other context, as a draft linked to the original by `origin_question_id`.
- **Generate a quiz**: duration, tags, difficulty, and the platform composes a draft evaluation from the answer-time statistics. Phase 3.
- **Session code and QR code** to join a poll or a classroom from a phone.
- **Projection view** without names: presence ring in the waiting room, live distribution for a poll, completion rate during a quiz.
- **Image difference** for `codeimage`, comparison slider and percentage.
- **Attempt history** for support: reconstruction of the sequence of revisions of an answer with server timestamps.
- **Preview of five instantiations** for a question with random values, with a "freeze" button.
- **Statistics in the pool**: on a question's card, success rate and average time per version, to pick the right question at a glance.
- **Paste from Moodle**: a GIFT file dropped on the pool is imported, the non-convertible questions are listed.
- **Batch grading**: filter by confidence, by question, by gap between the LLM proposal and the average score.
- **Zen mode** for the student, one question per screen, progress bar, no unnecessary chrome.
