# Writing the documentation

This site is built by [zensical](https://zensical.org), the successor of
mkdocs-material, from the Markdown files under `docs/`. The published copy
at <https://heig-tin-info.github.io/heig-quiz/> is rebuilt by GitHub
Actions; a local copy is one command away.

## Building it locally

zensical is a Python tool. Install it once, either as an isolated tool or
into any Python environment:

```bash
uv tool install zensical      # or: pip install zensical
```

Then, from the root of the repository:

```bash
pnpm docs:serve               # zensical serve: live reload on http://127.0.0.1:8000
pnpm docs:build               # zensical build: the static site in site/ (gitignored)
```

`uvx zensical serve` works too, without installing anything.

## Where things are

| Path | What |
| --- | --- |
| `zensical.toml` | the site configuration: title, theme, Markdown extensions, and the navigation |
| `docs/index.md` | the home page |
| `docs/spec/` | the product specification, nine chapters |
| `docs/adr/` | the architecture decision records |
| `docs/development/` | these pages |
| `docs/PLAN-MVP.md` | the implementation plan |
| `docs/assets/screenshots/` | the screenshots, two files per image (see below) |

A page appears in the site only when it is listed in the `nav` array of
`zensical.toml`; adding a file under `docs/` is not enough. Links between
pages are relative Markdown links to the `.md` file
(`../spec/05-architecture.md`, `deployment.md#rollback`); zensical rewrites
them at build time and warns about a target that does not exist, which is
the check to read after `pnpm docs:build`.

## Publication

`.github/workflows/docs.yml` runs on every push to `main` that touches
`docs/**`, `zensical.toml` or the workflow itself, and on the matching pull
requests. It installs Python 3.12 and zensical, runs `zensical build`, and
on a push deploys the `site/` directory to GitHub Pages. A pull request only
builds, which is enough to catch a broken link or a bad admonition before
merging. The workflow can also be started by hand from the Actions tab
(`workflow_dispatch`).

## Language and style

Everything on this site is in English, like everything else in the
repository that is not a string a user reads (invariant 1). The
specification and the decision records were written in French and have
been translated; the file names under `docs/spec/` and `docs/adr/` keep
their original French slugs, so existing links and the `nav` keep working.

The style of these pages: precise prose in short paragraphs, a table where
things are parallel, a fenced code block for every command, and no
paraphrase of a source file when a link to it will do. Section headings
are sentence case.

The Markdown extensions enabled in `zensical.toml` include admonitions
and collapsible blocks:

```markdown
!!! note "Optional title"

    Body, indented by four spaces.

!!! warning

    Same syntax, different colour.

??? info "Click to expand"

    A collapsible block, closed by default. `???+` opens it by default.
```

Also available: footnotes, definition lists, task lists, `attr_list` and
`md_in_html` (which is what the card grid on the home page uses), fenced
code blocks with syntax highlighting and a copy button, and Mermaid
diagrams in a ```` ```mermaid ```` fence. Content tabs are not enabled;
use headings or a table instead.

## Images in light and dark

The site has a light and a dark palette, and a screenshot of the
application taken in one of them looks wrong in the other. Every
screenshot therefore exists twice, `<name>-light.png` and
`<name>-dark.png`, and a page embeds both with a fragment that tells the
theme which palette each one belongs to:

```markdown
![The grading panel](../assets/screenshots/grading-light.png#only-light)
![The grading panel](../assets/screenshots/grading-dark.png#only-dark)
```

The fragment is not part of the file name: the browser requests
`grading-light.png` and the theme's stylesheet hides the image whose
fragment does not match the active palette, so the reader sees exactly one
of the two, and switching the palette swaps it in place. Write the same
alt text on both lines; only one is ever visible.

The screenshots are not taken by hand. The pipeline that produces both
files for every screen, and the manifest that lists them, is described on
its own page: [screenshots](screenshots.md).
