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

The theme hides one of the two variants, so a page embeds both:

```markdown
<figure markdown="span">
  ![The courses page](../assets/screenshots/teacher-home-light.png#only-light)
  ![The courses page](../assets/screenshots/teacher-home-dark.png#only-dark)
  <figcaption>The courses page: one card per course.</figcaption>
</figure>
```

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
pnpm seed                                              # PGlite: before the API
pnpm exec tsx --env-file-if-exists=../../.env src/server.ts &
curl localhost:3100/healthz                            # database up, runner up
cd ../..
pnpm docs:screenshots                                  # everything, both themes
```

The code runner on port 3200 is optional. Without it, the code questions are
graded with a proposal marked as runner unavailable, which is what the
grading scenes then show.

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
| `seeded` | exactly what `pnpm seed` left: four evaluations, "Test 0" closed and graded without a runner |
| `graded` | one grading pass with the real runner settled the code answers of "Test 0" |
| `lobby` | the exercise "Quiz d'entraînement" holds all four question types; Léa and Noah wait in its lobby |
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
Last full run: 2026-09-21, commit `828d8d8`, 65 scenes. The `eval-rename`
scene was added after that run and appears here on the next one.

| Scene | Persona | Path | Phase | Action after load | Viewport |
| --- | --- | --- | --- | --- | --- |
| `sign-in` | none | `/` | seeded | Nothing: the page as it loads. | 1440×900 |
| `teacher-home` | teacher | `/` | seeded | Nothing: the page as it loads. | 1440×900 |
| `classroom-evaluations` | teacher | `/classrooms/797acf2d-b3af-4367-aabd-4f5f6159f1aa` | seeded | Nothing: the page as it loads. | 1440×900 |
| `classroom-roster` | teacher | `/classrooms/797acf2d-b3af-4367-aabd-4f5f6159f1aa?tab=roster` | seeded | Nothing: the page as it loads. | 1440×900 |
| `roster-import` | teacher | `/classrooms/797acf2d-b3af-4367-aabd-4f5f6159f1aa?tab=roster` | seeded | Clicked “Add students” on the roster tab. | 1440×900 |
| `help-drawer` | teacher | `/classrooms/797acf2d-b3af-4367-aabd-4f5f6159f1aa` | seeded | Clicked the “Help” icon of the classroom page. | 1440×900 |
| `pools` | teacher | `/pools` | seeded | Nothing: the page as it loads. | 1440×900 |
| `pool` | teacher | `/pools/014cc676-210c-4231-8342-00a0009f060c` | seeded | Nothing: the page as it loads. | 1440×900 |
| `pool-filters` | teacher | `/pools/014cc676-210c-4231-8342-00a0009f060c` | seeded | Clicked “Filters” above the question table. | 1440×900 |
| `pool-share` | teacher | `/pools` | seeded | Opened the row menu of the first pool and picked “Share…”. | 1440×900 |
| `editor-mcq` | teacher | `/questions/10eb3127-c30a-4cde-b8be-05197fa76a8c` | seeded | Nothing: the page as it loads. | 1440×900 |
| `editor-short` | teacher | `/questions/dcaaf3e6-7023-4f27-9dac-38d8212b4177` | seeded | Nothing: the page as it loads. | 1440×900 |
| `editor-cloze` | teacher | `/questions/557c0ffa-9fc0-46aa-b524-dc89ae4af138` | seeded | Nothing: the page as it loads. | 1440×900 |
| `editor-code` | teacher | `/questions/637aca79-7782-4acc-ab32-907876fedddb` | seeded | Nothing: the page as it loads. | 1440×900 |
| `editor-preview` | teacher | `/questions/10eb3127-c30a-4cde-b8be-05197fa76a8c` | seeded | Pressed Ctrl+Shift+M in the editor. | 1440×900, full page |
| `editor-versions` | teacher | `/questions/637aca79-7782-4acc-ab32-907876fedddb?tab=versions` | seeded | Nothing: the page as it loads. | 1440×900 |
| `editor-publish` | teacher | `/questions/10eb3127-c30a-4cde-b8be-05197fa76a8c` | seeded | Pressed Ctrl+Shift+P in the editor. | 1440×900 |
| `try-mcq-graded` | teacher | `/questions/10eb3127-c30a-4cde-b8be-05197fa76a8c?tab=try` | seeded | Chose the first answer, clicked “Grade my answer”. | 1440×900 |
| `try-code` | teacher | `/questions/637aca79-7782-4acc-ab32-907876fedddb?tab=try` | seeded | Clicked “Run” on the visible cases, then “Grade my answer”, with the template as it is. | 1440×900, full page |
| `eval-questions` | teacher | `/evaluations/ec1186d0-1d86-49e2-9d65-989a6a002dc7?step=questions` | seeded | Nothing: the page as it loads. | 1440×900 |
| `eval-timing` | teacher | `/evaluations/ec1186d0-1d86-49e2-9d65-989a6a002dc7?step=timing` | seeded | Nothing: the page as it loads. | 1440×900 |
| `eval-launch` | teacher | `/evaluations/ec1186d0-1d86-49e2-9d65-989a6a002dc7?step=launch` | seeded | Nothing: the page as it loads. | 1440×900 |
| `eval-scheduled` | teacher | `/evaluations/f259b01d-cdb0-4bc5-9484-4e74c186745a` | seeded | Nothing: the page as it loads. | 1440×900 |
| `live-lobby` | teacher | `/evaluations/2d031274-da46-4a00-9f8d-f5056e933cb9/live` | lobby | Nothing: the page as it loads. | 1440×900 |
| `live-running` | teacher | `/evaluations/2d031274-da46-4a00-9f8d-f5056e933cb9/live` | running | Nothing: the page as it loads. | 1440×900 |
| `live-inspect` | teacher | `/evaluations/2d031274-da46-4a00-9f8d-f5056e933cb9/live` | running | Clicked the first student's cell of question 1. | 1440×900 |
| `live-extend` | teacher | `/evaluations/2d031274-da46-4a00-9f8d-f5056e933cb9/live` | running | Clicked “Extend”. | 1440×900 |
| `live-closed` | teacher | `/evaluations/606c9f70-0a92-4ebd-8958-0ade5a342da7/live` | graded | Nothing: the page as it loads. | 1440×900 |
| `grading` | teacher | `/evaluations/606c9f70-0a92-4ebd-8958-0ade5a342da7/grading` | graded | Nothing: the page as it loads. | 1440×900, full page |
| `grading-short` | teacher | `/evaluations/606c9f70-0a92-4ebd-8958-0ade5a342da7/grading` | graded | Moved to the next question (the short answer). | 1440×900, full page |
| `grading-cloze` | teacher | `/evaluations/606c9f70-0a92-4ebd-8958-0ade5a342da7/grading` | graded | Moved three questions forward (the cloze). | 1440×900, full page |
| `grading-code` | teacher | `/evaluations/606c9f70-0a92-4ebd-8958-0ade5a342da7/grading` | graded | Moved four questions forward (the code question). | 1440×900, full page |
| `grading-by-student` | teacher | `/evaluations/606c9f70-0a92-4ebd-8958-0ade5a342da7/grading` | graded | Switched the order to “By student”. | 1440×900, full page |
| `grading-override` | teacher | `/evaluations/606c9f70-0a92-4ebd-8958-0ade5a342da7/grading` | graded | Clicked “Adjust” on the first grading. | 1440×900 |
| `grading-batch` | teacher | `/evaluations/606c9f70-0a92-4ebd-8958-0ade5a342da7/grading` | seeded | Moved to the code question; the batch bar offers to validate its proposals. | 1440×900 |
| `results` | teacher | `/evaluations/606c9f70-0a92-4ebd-8958-0ade5a342da7/results` | graded | Nothing: the page as it loads. | 1440×900, full page |
| `results-questions` | teacher | `/evaluations/606c9f70-0a92-4ebd-8958-0ade5a342da7/results?tab=questions` | graded | Nothing: the page as it loads. | 1440×900, full page |
| `results-release-confirm` | teacher | `/evaluations/606c9f70-0a92-4ebd-8958-0ade5a342da7/results` | graded | Clicked “Publish results”. | 1440×900 |
| `poll-launcher` | teacher | `/polls` | running | Nothing: the page as it loads. | 1440×900 |
| `poll-projection` | teacher | `/evaluations/ef92b717-da38-47f6-b9ba-f5c8009f35ca/poll` | poll-open | Nothing: the page as it loads. | 1440×900 |
| `join-mcq-phone` | guest | `/p/5BC8A7` | poll-open | Nothing: the page as it loads. | 390×844 |
| `poll-revealed` | teacher | `/evaluations/ef92b717-da38-47f6-b9ba-f5c8009f35ca/poll` | poll-revealed | Nothing: the page as it loads. | 1440×900 |
| `join-revealed-phone` | guest | `/p/5BC8A7` | poll-revealed | Nothing: the page as it loads. | 390×844 |
| `poll-ended` | teacher | `/evaluations/ef92b717-da38-47f6-b9ba-f5c8009f35ca/poll` | poll-ended | Nothing: the page as it loads. | 1440×900 |
| `notifications` | teacher | `/` | running | Clicked the bell in the header. | 1440×900 |
| `palette` | teacher | `/` | seeded | Pressed Ctrl+K. | 1440×900 |
| `palette-query` | teacher | `/` | seeded | Pressed Ctrl+K and typed “grad”. | 1440×900 |
| `settings` | teacher | `/settings` | seeded | Nothing: the page as it loads. | 1440×900 |
| `admin` | admin | `/admin` | seeded | Nothing: the page as it loads. | 1440×900 |
| `student-home` | lea | `/` | seeded | Nothing: the page as it loads. | 1440×900 |
| `student-home-phone` | lea | `/` | seeded | Nothing: the page as it loads. | 390×844 |
| `student-lobby` | lea | `/take/2d031274-da46-4a00-9f8d-f5056e933cb9` | lobby | Nothing: the page as it loads. | 1440×900 |
| `player-mcq` | lea | `/take/2d031274-da46-4a00-9f8d-f5056e933cb9` | running | Nothing: the page as it loads. | 1440×900 |
| `player-mcq-phone` | lea | `/take/2d031274-da46-4a00-9f8d-f5056e933cb9` | running | Nothing: the page as it loads. | 390×844 |
| `player-cloze` | lea | `/take/2d031274-da46-4a00-9f8d-f5056e933cb9` | running | Moved to question 3 through the progress strip. | 1440×900 |
| `player-short` | lea | `/take/2d031274-da46-4a00-9f8d-f5056e933cb9` | running | Moved to question 4 through the progress strip. | 1440×900 |
| `player-code` | lea | `/take/2d031274-da46-4a00-9f8d-f5056e933cb9` | running | Moved to question 5 through the progress strip. | 1440×900 |
| `player-run` | lea | `/take/2d031274-da46-4a00-9f8d-f5056e933cb9` | running | Moved to question 5, clicked “Run”, waited for “Compiled”. | 1440×900, full page |
| `player-submit` | lea | `/take/2d031274-da46-4a00-9f8d-f5056e933cb9` | running | Clicked “Hand in”. | 1440×900 |
| `player-done` | noah | `/take/2d031274-da46-4a00-9f8d-f5056e933cb9` | running | Nothing: the page as it loads. | 1440×900 |
| `feedback-pending` | lea | `/attempts/3f4538b5-1a06-4271-8d98-735ab8b03c8f/feedback` | graded | Nothing: the page as it loads. | 1440×900 |
| `results-released` | teacher | `/evaluations/606c9f70-0a92-4ebd-8958-0ade5a342da7/results` | released | Nothing: the page as it loads. | 1440×900, full page |
| `feedback` | lea | `/attempts/3f4538b5-1a06-4271-8d98-735ab8b03c8f/feedback` | released | Nothing: the page as it loads. | 1440×900, full page |
| `feedback-phone` | lea | `/attempts/3f4538b5-1a06-4271-8d98-735ab8b03c8f/feedback` | released | Nothing: the page as it loads. | 390×844, full page |
| `student-settings` | lea | `/settings` | seeded | Nothing: the page as it loads. | 1440×900 |
<!-- scenes:end -->
