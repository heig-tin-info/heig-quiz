/**
 * The teacher's update (ADR-132 §11): the part of the status-bar extension
 * that needs no `vscode`, tested by apps/codespace/src/workspaceUpdate.test.ts
 * on real repositories.
 *
 * The portal announces, in `push-status`, the commit a teacher's sync handed
 * out for the session's branch (its sha from the platform, never from a
 * ref), once its staging repository holds it on `refs/quiz/update/<branch>`.
 * Here, inside the container and as the student:
 *
 *   - {@link isTaken}: the update is already in the student's history
 *     (`git merge-base --is-ancestor <sha> HEAD`), so nothing is offered;
 *   - {@link applyUpdate}: one click merges it into the student's branch,
 *     locally — ALWAYS a merge commit (`--no-ff`) with a fixed English
 *     message and the student's identity (the container's `GIT_*`): the
 *     update's commit is in Quiz's `bot_commits(sync)`, so a pushed head
 *     equal to it would read as the App's push, not the student's. It
 *     applies cleanly or not at all: a conflict is found BEFORE anything is
 *     touched (`git merge-tree`), uncommitted changes the merge would
 *     overwrite make git refuse before it writes anything, and should a
 *     merge stop on a conflict all the same it is aborted (`git merge
 *     --abort`) — never a conflict state left by the button, never a stash.
 *     The student then pushes as any work; GitHub sees a fast-forward and
 *     marks the sync's pull request merged.
 *
 * The teacher's message is plain text, shown through {@link plainText}:
 * VS Code reads `[text](link)` in a notification and `$(icon)` in places,
 * so both are broken by an invisible space; nothing is ever rendered as
 * Markdown or HTML.
 */
"use strict";

const { execFile } = require("node:child_process");

/** The merge commit's message: English, like every text the platform writes into git (D12). */
const MERGE_MESSAGE = "Merge the teacher's update";
/** As the platform's contract: a full SHA-1, a branch name that cannot read as an option or a range. */
const SHA = /^[0-9a-f]{40}$/;
const BRANCH = /^[A-Za-z0-9._/-]{1,200}$/;
/** The message's longest text (`SYNC_MESSAGE_MAX`). */
const MESSAGE_MAX = 500;
/** What a message never shows: the controls but tab and line feed, the bidirectional overrides. */
// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u0008\u000b-\u001f\u007f-\u009f‪-‮⁦-⁩]/g;

/** `push-status`'s `update`, checked: `{ branch, sha, message: { text, at } | null }`, or null. */
function parseUpdate(status) {
  const update = status && status.update;
  if (!update || typeof update.sha !== "string" || !SHA.test(update.sha)) return null;
  const branch = update.branch;
  if (typeof branch !== "string" || !BRANCH.test(branch) || branch.startsWith("-") || branch.includes("..")) return null;
  const m = update.message;
  const message =
    m && typeof m.text === "string" && typeof m.at === "string" ? { text: m.text.slice(0, MESSAGE_MAX), at: m.at } : null;
  return { branch, sha: update.sha, message };
}

/** Text any VS Code surface shows as it is: no control character, no link nor icon syntax. */
function plainText(text) {
  return String(text).replace(CONTROL, "").replace(/\]\(/g, "]​(").replace(/\$\(/g, "$​(");
}

/** `git <args>` in `cwd`, in English (the messages are parsed), never prompting: `{ code, stdout, stderr }`. */
function gitRunner(cwd, env = process.env) {
  return (args) =>
    new Promise((resolve) => {
      execFile(
        "git",
        args,
        { cwd, env: { ...env, LC_ALL: "C", GIT_TERMINAL_PROMPT: "0" }, timeout: 60_000, maxBuffer: 4 * 1024 * 1024 },
        (err, stdout, stderr) => {
          const code = err ? (typeof err.code === "number" ? err.code : 1) : 0;
          resolve({ code, stdout: String(stdout), stderr: String(stderr) });
        },
      );
    });
}

/** The update is in the student's history: nothing to offer. A commit not fetched yet is not. */
async function isTaken(run, sha) {
  return (await run(["merge-base", "--is-ancestor", sha, "HEAD"])).code === 0;
}

/** The paths after git's "…would be overwritten by merge:" lines. */
function overwrittenFiles(stderr) {
  const files = [];
  let listing = false;
  for (const line of String(stderr).split("\n")) {
    if (/would be overwritten by merge:\s*$/.test(line)) listing = true;
    else if (listing && /^\s+\S/.test(line)) files.push(line.trim());
    else listing = false;
  }
  return [...new Set(files)];
}

/** NUL-separated paths, deduplicated; `skipFirst` drops `merge-tree`'s tree id. */
function nulList(stdout, skipFirst) {
  const parts = String(stdout).split("\0").filter((p) => p !== "");
  return [...new Set(skipFirst ? parts.slice(1) : parts)];
}

const firstLine = (text) => String(text).trim().split("\n")[0] || "";

/**
 * Merges the update into the student's branch, or changes nothing. The
 * outcome: `applied`; `current` (already in the history); `unavailable`
 * (the commit could not be fetched from the portal); `otherBranch` (the
 * work tree is not on the update's branch); `busy` (a merge of the
 * student's own is in progress); `dirty` (uncommitted changes the merge
 * would overwrite, `files`); `conflict` (`files`); `failed` (`detail`, git's
 * first line).
 */
async function applyUpdate(run, update) {
  const fetched = await run(["fetch", "--quiet", "--no-tags", "origin", `refs/quiz/update/${update.branch}`]);
  if (fetched.code !== 0 || (await run(["cat-file", "-e", `${update.sha}^{commit}`])).code !== 0) {
    return { outcome: "unavailable" };
  }
  const head = await run(["symbolic-ref", "--quiet", "--short", "HEAD"]);
  if (head.code !== 0 || head.stdout.trim() !== update.branch) return { outcome: "otherBranch" };
  if (await isTaken(run, update.sha)) return { outcome: "current" };
  // The student's own merge is theirs to finish: never aborted by the button.
  if ((await run(["rev-parse", "--quiet", "--verify", "MERGE_HEAD"])).code === 0) return { outcome: "busy" };

  const preview = await run(["merge-tree", "--write-tree", "--name-only", "--no-messages", "-z", "HEAD", update.sha]);
  if (preview.code === 1) return { outcome: "conflict", files: nulList(preview.stdout, true) };
  if (preview.code !== 0) return { outcome: "failed", detail: firstLine(preview.stderr) };

  const merged = await run(["merge", "--no-ff", "--no-edit", "-m", MERGE_MESSAGE, update.sha]);
  if (merged.code === 0) return { outcome: "applied" };
  if ((await run(["rev-parse", "--quiet", "--verify", "MERGE_HEAD"])).code === 0) {
    // Not foreseen by merge-tree: still never left in a conflict state.
    const files = nulList((await run(["diff", "--name-only", "-z", "--diff-filter=U"])).stdout, false);
    await run(["merge", "--abort"]);
    return { outcome: "conflict", files };
  }
  const blocking = overwrittenFiles(merged.stderr);
  if (blocking.length > 0) return { outcome: "dirty", files: blocking };
  return { outcome: "failed", detail: firstLine(merged.stderr) };
}

module.exports = { MERGE_MESSAGE, applyUpdate, gitRunner, isTaken, overwrittenFiles, parseUpdate, plainText };
