/**
 * The teacher's update (ADR-132 §11 owns the rule): the part of the
 * status-bar extension that needs no `vscode`, run as the student inside
 * the container, tested on real repositories by
 * apps/codespace/src/workspaceUpdate.test.ts. Always a merge commit (a pushed
 * head equal to the sync's commit would read as the platform's), applied
 * cleanly or not at all, never a stash. The teacher's text goes through
 * {@link plainText}: VS Code reads `[text](link)` in a notification and
 * `$(icon)` in places, so both are broken by an invisible space.
 */
"use strict";

const { execFile } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");

/** The merge commit's message: English, like every text the platform writes into git (D12). */
const MERGE_MESSAGE = "Merge the teacher's update";
/** As the platform's contract: a full SHA-1, a branch name that cannot read as an option or a range. */
const SHA = /^[0-9a-f]{40}$/;
const BRANCH = /^[A-Za-z0-9._/-]{1,200}$/;
/** What a message never shows: the controls but tab and line feed, the bidirectional overrides. */
// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u0008\u000b-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/g;

/** `push-status`'s `update`, checked: `{ branch, sha, message: { text, at } | null }`, or null. */
function parseUpdate(status) {
  const update = status && status.update;
  if (!update || typeof update.sha !== "string" || !SHA.test(update.sha)) return null;
  const branch = update.branch;
  if (typeof branch !== "string" || !BRANCH.test(branch) || branch.startsWith("-") || branch.includes("..")) return null;
  const m = update.message;
  const message = m && typeof m.text === "string" && typeof m.at === "string" ? { text: m.text, at: m.at } : null;
  return { branch, sha: update.sha, message };
}

/** Text any VS Code surface shows as it is: no control character, no link nor icon syntax. */
function plainText(text) {
  return String(text).replace(CONTROL, "").replace(/\]\(/g, "]\u200b(").replace(/\$\(/g, "$\u200b(");
}

/** A git call is killed past this; the merge itself gets {@link MERGE_TIMEOUT_MS}. */
const GIT_TIMEOUT_MS = 60_000;
/** Long enough that a slow merge is never killed half-way, leaving an `index.lock` behind. */
const MERGE_TIMEOUT_MS = 600_000;

/**
 * `git <args>` in `cwd` (its `cwd` property), in English (the messages are
 * parsed), never prompting: `{ code, stdout, stderr }`.
 */
function gitRunner(cwd, env = process.env) {
  const run = (args, timeout = GIT_TIMEOUT_MS) =>
    new Promise((resolve) => {
      execFile(
        "git",
        args,
        { cwd, env: { ...env, LC_ALL: "C", GIT_TERMINAL_PROMPT: "0" }, timeout, maxBuffer: 4 * 1024 * 1024 },
        (err, stdout, stderr) => {
          const code = err ? (typeof err.code === "number" ? err.code : 1) : 0;
          resolve({ code, stdout: String(stdout), stderr: String(stderr) });
        },
      );
    });
  run.cwd = cwd;
  return run;
}

/** A merge, cherry-pick, revert or rebase of the student's own is under way: theirs to finish. */
async function inProgress(run) {
  for (const ref of ["MERGE_HEAD", "CHERRY_PICK_HEAD", "REVERT_HEAD"]) {
    if ((await run(["rev-parse", "--quiet", "--verify", ref])).code === 0) return true;
  }
  for (const dir of ["rebase-merge", "rebase-apply"]) {
    const where = (await run(["rev-parse", "--git-path", dir])).stdout.trim();
    if (where && fs.existsSync(path.resolve(run.cwd || ".", where))) return true;
  }
  return false;
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
 * (the commit could not be fetched from the portal); `busy` (a merge,
 * cherry-pick, revert or rebase of the student's own is under way, never
 * aborted by the button); `otherBranch` (the work tree is not on the
 * update's branch); `dirty` (uncommitted changes the merge would overwrite,
 * `files`); `conflict` (`files`); `failed` (`detail`, git's first line).
 */
async function applyUpdate(run, update) {
  const fetched = await run(["fetch", "--quiet", "--no-tags", "origin", `refs/quiz/update/${update.branch}`]);
  if (fetched.code !== 0 || (await run(["cat-file", "-e", `${update.sha}^{commit}`])).code !== 0) {
    return { outcome: "unavailable" };
  }
  if (await inProgress(run)) return { outcome: "busy" };
  const head = await run(["symbolic-ref", "--quiet", "--short", "HEAD"]);
  if (head.code !== 0 || head.stdout.trim() !== update.branch) return { outcome: "otherBranch" };
  if (await isTaken(run, update.sha)) return { outcome: "current" };

  const preview = await run(["merge-tree", "--write-tree", "--name-only", "--no-messages", "-z", "HEAD", update.sha]);
  if (preview.code === 1) return { outcome: "conflict", files: nulList(preview.stdout, true) };
  if (preview.code !== 0) return { outcome: "failed", detail: firstLine(preview.stderr) };

  const merged = await run(["merge", "--no-ff", "--no-edit", "-m", MERGE_MESSAGE, update.sha], MERGE_TIMEOUT_MS);
  if (merged.code === 0) return { outcome: "applied" };
  const merging = await run(["rev-parse", "--quiet", "--verify", "MERGE_HEAD"]);
  // A merge the student started meanwhile, in the terminal: theirs, never aborted.
  if (merging.code === 0 && merging.stdout.trim() !== update.sha) return { outcome: "busy" };
  if (merging.code === 0) {
    // A merge stopped by something else than a conflict merge-tree foresaw — a
    // student's hook (`pre-merge-commit`, `commit-msg`) —: aborted, never left half-done.
    const files = nulList((await run(["diff", "--name-only", "-z", "--diff-filter=U"])).stdout, false);
    await run(["merge", "--abort"]);
    return files.length > 0 ? { outcome: "conflict", files } : { outcome: "failed", detail: firstLine(merged.stderr) };
  }
  const blocking = overwrittenFiles(merged.stderr);
  if (blocking.length > 0) return { outcome: "dirty", files: blocking };
  return { outcome: "failed", detail: firstLine(merged.stderr) };
}

module.exports = { MERGE_MESSAGE, applyUpdate, gitRunner, isTaken, overwrittenFiles, parseUpdate, plainText };
