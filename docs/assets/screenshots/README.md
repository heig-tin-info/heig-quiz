# Screenshots of the user guide

The PNG files in this folder illustrate the user guide (`docs/`). They are
taken from the real application, on a fresh `pnpm seed`, by
`apps/web/scripts/docs-screenshots.mjs` — never by hand, so that the whole
set can be retaken in one command when a screen changes.

## Naming

```
<scene>-light.png          1440 × 900, light theme
<scene>-dark.png           1440 × 900, dark theme
<scene>-phone-light.png    390 × 844, where the scene has a phone variant
<scene>-phone-dark.png
```

A page of the guide shows the pair through zensical's image suffixes:

```markdown
![The teacher's home](../assets/screenshots/teacher-home-light.png#only-light)
![The teacher's home](../assets/screenshots/teacher-home-dark.png#only-dark)
```

The UI is in English in every screenshot; the demo content (course,
questions, names) is the seed's, in French.

## `manifest.json`

One entry per screenshot pair: the caption, the persona signed in, the URL,
the viewport, whether the whole page was taken, what was clicked or typed
after the page loaded (`action`), which prepared state of the demo world the
page shows (`state`, and the `phase` that state belongs to), the two file
names, the date, the commit and the base URL. It is derived from the scene
list in the script, which is the source of truth: to add or change a
screenshot, edit the scene there, not the manifest.

## Regenerating

The script wants an ISOLATED instance of the API, serving the built SPA on a
seed of its own — never the `pnpm dev` you work with. The header of
`apps/web/scripts/docs-screenshots.mjs` spells the whole procedure out; in
short:

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

The script moves the demo world through one-way phases (the code answers
of the closed test are graded by the runner, an exercise is started and
answered, a poll is run and ended, results are published) and takes the
scenes of each phase before the next one. To retake one scene:

```bash
pnpm docs:screenshots -- --only=grading-code           # merges into the manifest
pnpm docs:screenshots -- --only=poll --dark
pnpm docs:screenshots -- --list
```

A scene that needs an earlier phase than the instance is in (the lobby, for
instance, once the exercise has started) needs a fresh seed: stop the
instance, delete `apps/api/.data/pglite-docs`, seed and start again.
