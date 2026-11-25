# Workspace images

The online workspace of a project (see [Projects](projects.md#the-online-workspace)) runs an image: the tools a student finds when the workspace opens. By default it is **quiz-base**, the platform's image: Debian, VS Code in the browser (code-server) with clangd and the *Native Debug* extension, `gcc`, `g++`, `gdb`, `make`, `git`, Python 3 with `pytest`, the man pages, and Baygon 0.7. A lab that needs something else (another language, a newer Baygon, a database client, an extension) runs an image of the course's own, **derived from quiz-base**.

Quiz never builds an image. You build it in a repository of your own, publish it as a **public** image on GitHub Container Registry (`ghcr.io`) or Docker Hub (`docker.io`), and give its reference to the course. Quiz downloads it, checks it, and offers it to the course's projects once it is ready. *(ADR-146.)*

!!! warning "A public image is public content"
    Anyone can download a public image and read every file in it. Never put hidden tests, solutions or exam data in an image: they stay in the distribution repository, as for any project. Never put a token, a key or any other credential in it either: no secret passed as a build argument, no `.env` copied in. A layer keeps what a later step deletes.

## Who does what

A course holds at most **five** images, on its **Images** tab. The tab exists only where the platform has the online workspace.

- An **owner** of the course whose account the administrator enabled for the workspace adds, refreshes, renames and removes the images, and picks one for a project.
- The rest of the course's staff reads the list: each image, its state, its size and the projects that use it.
- The administrator sees every image the workspace holds on its disk, in **Administration**, **System** tab.

## Derive an image from quiz-base

An image starts `FROM ghcr.io/heig-tin-info/quiz-base:latest`, the last release. Derive from `latest`, not from a version tag: a version tag may be a candidate the platform has not released yet, and an image built on it is refused (*not built on a released quiz-base*) until production has switched to that version. Quiz accepts an image only when it keeps what makes a workspace work:

- its first layers are those of a released quiz-base: build `FROM` it, and never flatten or squash the result;
- the user, the entrypoint and the command are quiz-base's: end on `USER 1000:1000`, and set no `ENTRYPOINT` nor `CMD`;
- it is built for `linux/amd64`;
- it takes at most about 4 GB on disk;
- the files and settings that protect the platform are unchanged (below).

Everything a lab needs is installed **when the image is built**: a workspace has no network, so `apt install` or `pip install` from a student's terminal fails.

A Containerfile (or Dockerfile) that adds Go and its VS Code extension:

```dockerfile
FROM ghcr.io/heig-tin-info/quiz-base:latest

USER root

# 1. Packages, from Debian.
RUN apt-get update \
 && apt-get install -y --no-install-recommends golang-go \
 && rm -rf /var/lib/apt/lists/*

# 2. An extension, from Open VSX, into the read-only extensions directory,
#    and the lock file that lists what is installed (the status-bar extension
#    of quiz-base must stay in it).
RUN chmod -R u+w /opt/code-server/extensions \
 && code-server --extensions-dir /opt/code-server/extensions --user-data-dir /tmp/cs-build \
      --install-extension golang.go \
 && code-server --extensions-dir /opt/code-server/extensions --user-data-dir /tmp/cs-build \
      --list-extensions --show-versions > /etc/code-server/extensions.lock \
 && rm -rf /tmp/cs-build /root/.config/code-server /root/.local \
 && chmod -R a-w /opt/code-server

# 3. Allow it in the machine settings, the other keys untouched.
RUN /usr/lib/code-server/lib/node -e ' \
      const f = "/etc/code-server/settings.json"; const fs = require("fs"); \
      const s = JSON.parse(fs.readFileSync(f, "utf8")); \
      s["extensions.allowed"]["golang.go"] = true; \
      s["go.toolsManagement.autoUpdate"] = false; \
      fs.writeFileSync(f, JSON.stringify(s, null, 2));'

USER 1000:1000
```

### The machine settings

The machine settings, `/etc/code-server/settings.json`, are yours to extend: allow one more extension in `extensions.allowed`, set a language's options, a theme. Leave these keys as quiz-base sets them, or the image is refused:

| Key | Value |
| --- | --- |
| `task.allowAutomaticTasks` | `"off"` |
| `chat.disableAIFeatures` | `true` |
| `telemetry.telemetryLevel` | `"off"` |
| `update.mode` | `"none"` |
| `extensions.autoUpdate` | `false` |
| `extensions.allowed` | `"*": false`, no other wildcard, `"heig.codespace-statusbar": true` |

The files quiz-base owns (its entrypoint, the status-bar extension that shows the deadline, the Safe Exam Browser workarounds, the name resolution) are checked byte for byte: do not replace them. The check catches accidents, not intent: what protects the platform (no network, the session's limits, the user) is enforced when the workspace runs, whatever the image holds.

!!! note "Notebooks"
    quiz-base has no notebook support; an image may add it (the Jupyter extension and a kernel). Its scripts then run on the workspace's address, beside the other workspaces your students open in the same browser.

## Publish it from GitHub Actions

Keep the Containerfile in a repository of your organization, with a workflow that builds and pushes the image on every change of `main`. `.github/workflows/image.yml`:

```yaml
name: image
on:
  push:
    branches: [main]
  workflow_dispatch:
permissions:
  contents: read
  packages: write
jobs:
  image:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: docker/login-action@v3
        with:
          registry: ghcr.io
          username: ${{ github.actor }}
          password: ${{ secrets.GITHUB_TOKEN }}
      - uses: docker/build-push-action@v6
        with:
          context: .
          platforms: linux/amd64
          pull: true
          push: true
          tags: ghcr.io/my-org/prog-go:latest
```

The image's name is in lower case. `pull: true` builds on the latest quiz-base each time. After the first run, make the package public: on GitHub, the organization's **Packages**, the image, **Package settings**, **Change visibility**, **Public**. A private image is refused (*not public*). On Docker Hub, push to a public repository instead.

## Add it to the course

On the course page, **Images** tab, click **Add image**. Give it a name your colleagues recognise (it is the name the project's setting shows) and its reference, by tag (`ghcr.io/my-org/prog-go:latest`) or by digest (`…@sha256:…`). The dialog shows the quiz-base release to build from.

Quiz reads the reference at once: a reference the registry does not know, or a private image, is refused in the dialog. Otherwise the image appears in the list, **downloading…**, then **checking…**, then **ready**, in a few minutes; the tab follows it by itself. Quiz keeps the digest the tag pointed to: a later push to the tag changes nothing until you refresh it.

When an image is **refused**, its row says why, with the check's own words quoted under it:

| Refused because | What to do |
| --- | --- |
| The registry knows no image at this reference | Check the name and the tag; the image may not be pushed yet. |
| The image is not public | Make the package public on the registry, then refresh. |
| The image is too large | Install less; clean the package caches in the same `RUN`. |
| Not built on a released quiz-base | Build `FROM ghcr.io/heig-tin-info/quiz-base:latest`, without flattening, then refresh. |
| It changes the user, entrypoint or command, or is not `linux/amd64` | End on `USER 1000:1000`, set no `ENTRYPOINT` nor `CMD`, build for `linux/amd64`. |
| It breaks the workspace's contract | A protected setting or file changed: the quoted line names it. |
| The disk is full | Ask an administrator to free space. |
| The download failed, or the check was interrupted | Refresh to try again. |

## Pick it for a project

In the project's **Settings**, **Where students work** set to the online workspace, choose the **Image**: **Default (quiz-base)** or one of the course's ready images. The choice may change at any time: a workspace started afterwards (a new one, a resume, a restart) runs the new image, and a workspace already running keeps its own. An image a project uses cannot be removed from the course.

Your own **Open in workspace** on a student's repository, and the reading of a workspace at the deadline, always run quiz-base.

## Update it: Refresh

After a push that changes the image (a new package, a new quiz-base), open the row's menu and click **Refresh**. Quiz reads the tag again, downloads and checks the new version; once it is ready, every workspace started afterwards runs it, in every project that uses the image, a lab under Safe Exam Browser included. Refresh is never refused, so avoid one in the middle of a lab test.

If the new version is refused, the row says so, and **the previous version keeps running**: nothing changes for the students until a refresh passes.

## Obsolete images

When the platform releases a new quiz-base, an image built on an older one is marked **Obsolete**. It still runs. Build it again (run the workflow: with `pull: true` it picks up the new quiz-base), then **Refresh**.

## Remove an image

**Remove**, in the row's menu, takes the image off the course's list once no project uses it; otherwise Quiz names the projects to change first. The workspace keeps its copy on disk until an administrator frees the space, by hand, with the teachers concerned.
