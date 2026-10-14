# Screenshots

Every screenshot of the [guide](../guide/index.md) is taken from the real
application by one script, on a fresh demo world, in a light and a dark
variant. Nothing is captured by hand, so the whole set can be retaken in one
command when a screen changes, and every image carries the metadata needed
to retake it alone.

## Where things are

| What | Where |
| --- | --- |
| The scene list, the source of truth | `apps/web/scripts/docs-screenshots.mjs` |
| The images | `docs/assets/screenshots/<scene>-light.png` and `<scene>-dark.png` |
| Phone variants (390 px wide) | `<scene>-phone-light.png` and `<scene>-phone-dark.png` |
| The metadata of every image | `docs/assets/screenshots/manifest.json` |
| The table below | generated from the manifest by `apps/web/scripts/docs-screenshots-index.mjs` |

A scene is a data record in the script: a name, a caption, the persona
signed in, the URL, the viewport, an optional action performed after the
page loaded (a click, a keystroke, a typed word) and the phase of the demo
world it needs. The manifest is derived from that list at the end of a run
and adds the date, the commit and the base URL. To add or change a
screenshot, edit the scene in the script, never the manifest.

## How a page shows an image

A screenshot taken in one palette looks wrong in the other, so a page
embeds both variants, each with a fragment naming its palette:

```markdown
<figure markdown="span">
  ![The courses page](../assets/screenshots/teacher-home-light.png#only-light)
  ![The courses page](../assets/screenshots/teacher-home-dark.png#only-dark)
  <figcaption>The courses page: one card per course.</figcaption>
</figure>
```

The fragment is not part of the file name: the browser requests
`teacher-home-light.png` and the theme's stylesheet hides the image whose
fragment does not match the active palette, so the reader sees exactly one
of the two, and switching the palette swaps it in place. Write the same
alt text on both lines; only one is ever visible.

## Regenerating

The script needs an isolated instance of the API, serving the built
single-page application on a seed of its own. It must never run against the
`pnpm dev` you work with: the phases below move the demo world forward, and
PGlite is single-process. The header comment of the script spells out the
procedure; in short:

```bash
pnpm --filter @quiz/web build
cd apps/api
export DATABASE_URL=pglite://.data/pglite-docs ASSETS_DIR=.data/assets-docs
export PORT=3100 PUBLIC_URL=http://localhost:3100 AUTH_DEV_LOGIN=1
export STATIC_DIR=$PWD/../web/dist RUNNER_MODE=http RUNNER_URL=http://localhost:3200
export LLM_PROVIDER=stub                               # the essays' AI proposals
pnpm seed                                              # PGlite: before the API
pnpm exec tsx --env-file-if-exists=../../.env src/server.ts &
curl localhost:3100/healthz                            # database up, runner up
cd ../..
pnpm docs:screenshots                                  # everything, both themes
```

The code runner on port 3200 is optional. Without it, the code,
code-to-picture and circuit questions are graded with a proposal marked as
runner unavailable, which is what the grading scenes then show. The stub
LLM provider is not: without `LLM_PROVIDER=stub` on BOTH the seed and the
instance, the essays of "Test 0" are 0-point placeholders and the
`grading-essay` and `grading-batch` scenes lose their AI proposals (the
instance re-proposes them when a scene reruns the grading pass).

One scene, or one theme, can be retaken alone. The manifest is merged, not
rewritten:

```bash
pnpm docs:screenshots -- --list
pnpm docs:screenshots -- --only=grading-code
pnpm docs:screenshots -- --only=poll --dark
```

### The phases

The script walks the demo world through one-way phases and takes the scenes
of each phase before moving on. The light and dark variants of a scene are
captured back to back, so they show the same state.

| Phase | What the world looks like |
| --- | --- |
| `seeded` | exactly what `pnpm seed` left: four evaluations, "Test 0" closed and graded without a runner (its essays by the stub LLM) |
| `graded` | one grading pass with the real runner settled the code answers of "Test 0"; the instance needs `LLM_PROVIDER=stub` too, or the pass turns the essays back into placeholders |
| `lobby` | the exercise "Quiz d'entraînement" holds a multiple choice, a short answer, a cloze and a code question; Léa and Noah wait in its lobby |
| `running` | the teacher started it; Noah handed in, Léa answered two questions, Emma one, Louis only opened it |
| `poll-open` | a live poll on a multiple-choice question, three students answered through the join code |
| `poll-revealed` | the teacher revealed the answer |
| `poll-ended` | the teacher ended the poll |
| `released` | the results of "Test 0" are published |

A scene that needs an earlier phase than the instance is in, such as the
lobby once the exercise has started, needs a fresh seed: stop the instance,
delete `apps/api/.data/pglite-docs`, seed and start again.

## Every scene

The table is rewritten from the manifest at the end of each run. Paths
contain the identifiers of that run's seed; the script discovers them over
the API, so they change from one seed to the next.

<!-- scenes:start -->
Last full run: 2026-10-14, commit `75d362c1`, 76 scenes.

| Scene | Persona | Path | Phase | Action after load | Viewport |
| --- | --- | --- | --- | --- | --- |
| `sign-in` | none | `/` | seeded | Nothing: the page as it loads. | 1440×900 |
| `teacher-home` | teacher | `/` | seeded | Nothing: the page as it loads. | 1440×900 |
| `classroom-evaluations` | teacher | `/classrooms/2902563f-bee7-4aec-b3e6-4c662b331dc3` | seeded | Nothing: the page as it loads. | 1440×900 |
| `classroom-roster` | teacher | `/classrooms/2902563f-bee7-4aec-b3e6-4c662b331dc3?tab=roster` | seeded | Nothing: the page as it loads. | 1440×900 |
| `roster-import` | teacher | `/classrooms/2902563f-bee7-4aec-b3e6-4c662b331dc3?tab=roster` | seeded | Clicked “Add students” on the roster tab. | 1440×900 |
| `help-drawer` | teacher | `/classrooms/2902563f-bee7-4aec-b3e6-4c662b331dc3` | seeded | Clicked the “Help” icon of the classroom page. | 1440×900 |
| `pools` | teacher | `/pools` | seeded | Nothing: the page as it loads. | 1440×900 |
| `pool` | teacher | `/pools/7a41c236-bf5b-424c-9823-f21eff8d66ae` | seeded | Nothing: the page as it loads. | 1440×900 |
| `pool-filters` | teacher | `/pools/7a41c236-bf5b-424c-9823-f21eff8d66ae` | seeded | Clicked “Filters” above the question table. | 1440×900 |
| `pool-share` | teacher | `/pools/7a41c236-bf5b-424c-9823-f21eff8d66ae?tab=settings` | seeded | Opened the pool's Settings tab. | 1440×900 |
| `editor-mcq` | teacher | `/questions/339336b0-d256-4030-ac44-d19355c49ab6` | seeded | Nothing: the page as it loads. | 1440×900 |
| `editor-short` | teacher | `/questions/eb5ecf94-5e63-4efa-8b3a-02fc66c8520b` | seeded | Nothing: the page as it loads. | 1440×900 |
| `editor-cloze` | teacher | `/questions/fba50495-791d-4d60-b6e5-9c80382ddd1d` | seeded | Nothing: the page as it loads. | 1440×900 |
| `editor-code` | teacher | `/questions/43f3ffaf-582d-47b3-b296-b860e077a1c3` | seeded | Nothing: the page as it loads. | 1440×900 |
| `editor-blocks` | teacher | `/questions/a38c1007-d3be-4ef6-8e84-6edbda1567d2` | seeded | Nothing: the page as it loads. | 1440×900, full page |
| `editor-preview` | teacher | `/questions/339336b0-d256-4030-ac44-d19355c49ab6` | seeded | Pressed Ctrl+Shift+M in the editor. | 1440×900, full page |
| `editor-versions` | teacher | `/questions/43f3ffaf-582d-47b3-b296-b860e077a1c3?tab=versions` | seeded | Nothing: the page as it loads. | 1440×900 |
| `editor-publish` | teacher | `/questions/339336b0-d256-4030-ac44-d19355c49ab6` | seeded | Pressed Ctrl+Shift+P in the editor. | 1440×900 |
| `try-mcq-graded` | teacher | `/questions/339336b0-d256-4030-ac44-d19355c49ab6?tab=try` | seeded | Chose the first answer, clicked “Grade my answer”. | 1440×900 |
| `try-code` | teacher | `/questions/43f3ffaf-582d-47b3-b296-b860e077a1c3?tab=try` | seeded | Clicked “Run the tests” on the visible cases, then “Run all the tests”, with the template as it is. | 1440×900, full page |
| `try-blocks` | teacher | `/questions/a38c1007-d3be-4ef6-8e84-6edbda1567d2?tab=try` | seeded | Opened the Try tab and clicked “Test on every warehouse”, with the starter as it is. | 1440×900, full page |
| `eval-questions` | teacher | `/evaluations/51337bd3-8f80-40f9-8388-850fd15c4161?step=questions` | seeded | Nothing: the page as it loads. | 1440×900 |
| `eval-timing` | teacher | `/evaluations/51337bd3-8f80-40f9-8388-850fd15c4161?step=timing` | seeded | Nothing: the page as it loads. | 1440×900 |
| `eval-launch` | teacher | `/evaluations/51337bd3-8f80-40f9-8388-850fd15c4161?step=launch` | seeded | Nothing: the page as it loads. | 1440×900 |
| `eval-rename` | teacher | `/evaluations/51337bd3-8f80-40f9-8388-850fd15c4161?step=questions` | seeded | Clicked the title, which turns the heading into a field. | 1440×900 |
| `eval-scheduled` | teacher | `/evaluations/d55a1c2a-932c-4f78-912e-70283ba3452f` | seeded | Nothing: the page as it loads. | 1440×900 |
| `live-lobby` | teacher | `/evaluations/bd8b4237-e854-47af-968d-07265e72de08/live` | lobby | Nothing: the page as it loads. | 1440×900 |
| `live-running` | teacher | `/evaluations/bd8b4237-e854-47af-968d-07265e72de08/live` | running | Nothing: the page as it loads. | 1440×900 |
| `live-inspect` | teacher | `/evaluations/bd8b4237-e854-47af-968d-07265e72de08/live` | running | Clicked the first student's cell of question 1. | 1440×900 |
| `live-extend` | teacher | `/evaluations/bd8b4237-e854-47af-968d-07265e72de08/live` | running | Clicked “Extend”. | 1440×900 |
| `live-closed` | teacher | `/evaluations/bb2b617a-f6a3-41c5-8583-6c36a5a847be/live` | graded | Nothing: the page as it loads. | 1440×900 |
| `grading` | teacher | `/evaluations/bb2b617a-f6a3-41c5-8583-6c36a5a847be/grading` | graded | Nothing: the page as it loads. | 1440×900, full page |
| `grading-short` | teacher | `/evaluations/bb2b617a-f6a3-41c5-8583-6c36a5a847be/grading` | graded | Moved to the next question (the short answer). | 1440×900, full page |
| `grading-cloze` | teacher | `/evaluations/bb2b617a-f6a3-41c5-8583-6c36a5a847be/grading` | graded | Moved three questions forward (the cloze). | 1440×900, full page |
| `grading-code` | teacher | `/evaluations/bb2b617a-f6a3-41c5-8583-6c36a5a847be/grading` | graded | Moved four questions forward (the code question). | 1440×900, full page |
| `grading-categorize` | teacher | `/evaluations/bb2b617a-f6a3-41c5-8583-6c36a5a847be/grading` | graded | Moved five questions forward (the categorize question). | 1440×900, full page |
| `grading-codeimage` | teacher | `/evaluations/bb2b617a-f6a3-41c5-8583-6c36a5a847be/grading` | graded | Moved six questions forward (the code-to-picture question). | 1440×900, full page |
| `grading-circuit` | teacher | `/evaluations/bb2b617a-f6a3-41c5-8583-6c36a5a847be/grading` | graded | Moved seven questions forward (the circuit). | 1440×900, full page |
| `grading-essay` | teacher | `/evaluations/bb2b617a-f6a3-41c5-8583-6c36a5a847be/grading` | graded | Moved eight questions forward (the essay). | 1440×900, full page |
| `grading-ai-justification` | teacher | `/evaluations/bb2b617a-f6a3-41c5-8583-6c36a5a847be/grading` | graded | Moved to the essay and opened the first AI proposal. | 1440×900 |
| `grading-override` | teacher | `/evaluations/bb2b617a-f6a3-41c5-8583-6c36a5a847be/grading` | graded | Opened the first answer and clicked “Adjust” in its panel. | 1440×900 |
| `grading-batch` | teacher | `/evaluations/bb2b617a-f6a3-41c5-8583-6c36a5a847be/grading` | seeded | Moved to the essay and hovered the primary button, which offers to validate its four proposals. | 1440×900 |
| `results` | teacher | `/evaluations/bb2b617a-f6a3-41c5-8583-6c36a5a847be/results` | graded | Nothing: the page as it loads. | 1440×900, full page |
| `results-questions` | teacher | `/evaluations/bb2b617a-f6a3-41c5-8583-6c36a5a847be/results?tab=questions` | graded | Nothing: the page as it loads. | 1440×900, full page |
| `results-release-confirm` | teacher | `/evaluations/bb2b617a-f6a3-41c5-8583-6c36a5a847be/results` | graded | Clicked “Publish results”. | 1440×900 |
| `poll-launcher` | teacher | `/polls` | running | Nothing: the page as it loads. | 1440×900 |
| `poll-projection` | teacher | `/evaluations/27535a88-d4df-4512-80dd-9f40c9f158a6/poll` | poll-open | Nothing: the page as it loads. | 1440×900 |
| `join-mcq-phone` | guest | `/p/JUWYPA` | poll-open | Nothing: the page as it loads. | 390×844 |
| `poll-revealed` | teacher | `/evaluations/27535a88-d4df-4512-80dd-9f40c9f158a6/poll` | poll-revealed | Nothing: the page as it loads. | 1440×900 |
| `join-revealed-phone` | guest | `/p/JUWYPA` | poll-revealed | Nothing: the page as it loads. | 390×844 |
| `poll-ended` | teacher | `/evaluations/27535a88-d4df-4512-80dd-9f40c9f158a6/poll` | poll-ended | Nothing: the page as it loads. | 1440×900 |
| `notifications` | teacher | `/` | running | Opened the account menu and clicked “Notifications”. | 1440×900 |
| `palette` | teacher | `/` | seeded | Pressed Ctrl+K. | 1440×900 |
| `palette-query` | teacher | `/` | seeded | Pressed Ctrl+K and typed “grad”. | 1440×900 |
| `settings` | teacher | `/settings` | seeded | Nothing: the page as it loads. | 1440×900 |
| `settings-token-created` | teacher | `/settings` | seeded | Clicked “New token”, named it “Claude Desktop”, clicked “Create token”. | 1440×900 |
| `oauth-consent` | teacher | `/settings` | seeded | Registered a client named “Claude” and opened its authorization URL. | 1440×900 |
| `admin` | admin | `/admin` | seeded | Nothing: the page as it loads. | 1440×900 |
| `student-home` | lea | `/` | seeded | Nothing: the page as it loads. | 1440×900 |
| `student-home-phone` | lea | `/` | seeded | Nothing: the page as it loads. | 390×844 |
| `student-lobby` | lea | `/take/bd8b4237-e854-47af-968d-07265e72de08` | lobby | Nothing: the page as it loads. | 1440×900 |
| `player-mcq` | lea | `/take/bd8b4237-e854-47af-968d-07265e72de08` | running | Nothing: the page as it loads. | 1440×900 |
| `player-mcq-phone` | lea | `/take/bd8b4237-e854-47af-968d-07265e72de08` | running | Nothing: the page as it loads. | 390×844 |
| `player-cloze` | lea | `/take/bd8b4237-e854-47af-968d-07265e72de08` | running | Moved to question 3 through the progress strip. | 1440×900 |
| `player-short` | lea | `/take/bd8b4237-e854-47af-968d-07265e72de08` | running | Moved to question 4 through the progress strip. | 1440×900 |
| `player-code` | lea | `/take/bd8b4237-e854-47af-968d-07265e72de08` | running | Moved to question 5 through the progress strip. | 1440×900 |
| `player-run` | lea | `/take/bd8b4237-e854-47af-968d-07265e72de08` | running | Moved to question 5, clicked “Run the tests”, waited for “Compiled”. | 1440×900, full page |
| `player-submit` | lea | `/take/bd8b4237-e854-47af-968d-07265e72de08` | running | Clicked “Hand in”. | 1440×900 |
| `player-done` | lea | `/take/bb2b617a-f6a3-41c5-8583-6c36a5a847be` | graded | Nothing: the page as it loads. | 1440×900 |
| `feedback-pending` | lea | `/attempts/bd851343-8bc4-4c4a-bb5b-e681bdc32fad/feedback` | graded | Nothing: the page as it loads. | 1440×900 |
| `results-released` | teacher | `/evaluations/bb2b617a-f6a3-41c5-8583-6c36a5a847be/results` | released | Nothing: the page as it loads. | 1440×900, full page |
| `feedback` | lea | `/attempts/bd851343-8bc4-4c4a-bb5b-e681bdc32fad/feedback` | released | Nothing: the page as it loads. | 1440×900, full page |
| `feedback-phone` | lea | `/attempts/bd851343-8bc4-4c4a-bb5b-e681bdc32fad/feedback` | released | Nothing: the page as it loads. | 390×844, full page |
| `student-grades` | lea | `/grades` | released | Nothing: the page as it loads. | 1440×900 |
| `student-grades-phone` | lea | `/grades` | released | Nothing: the page as it loads. | 390×844 |
| `student-settings` | lea | `/settings` | seeded | Nothing: the page as it loads. | 1440×900 |
<!-- scenes:end -->
