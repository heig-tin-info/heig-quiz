#!/usr/bin/env node
// PreToolUse guard for the mechanical rules of AGENTS.md. Reads the hook
// payload on stdin; exit 2 blocks the tool call and shows stderr to the agent.
//
//   Bash:        refuses `git add -A|.|--all` and `git commit -a|--all`, and a
//                commit that leaves a modified pnpm-lock.yaml or
//                pnpm-workspace.yaml behind while a package.json goes in.
//   Edit/Write:  refuses editing a tracked file in a checkout on `main`.
//
// QUIZ_ALLOW_MAIN=1 in the environment lifts the `main` rule, for the person
// merging in the main checkout.
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, isAbsolute, resolve } from "node:path";

const input = JSON.parse(readFileSync(0, "utf8"));
const cwd = input.cwd ?? process.cwd();

function block(message) {
  process.stderr.write(`Blocked by .claude/hooks/guard.mjs (AGENTS.md): ${message}\n`);
  process.exit(2);
}

function git(dir, ...args) {
  try {
    return execFileSync("git", ["-C", dir, ...args], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    return null;
  }
}

// Splits a shell command into simple commands, each a list of words. Handles
// quotes and the separators && || ; | and newlines; enough for git commands.
function simpleCommands(command) {
  const commands = [[]];
  let word = null;
  let quote = null;
  const flush = () => {
    if (word !== null) commands.at(-1).push(word);
    word = null;
  };
  for (let i = 0; i < command.length; i++) {
    const c = command[i];
    if (quote) {
      if (c === quote) quote = null;
      else if (c === "\\" && quote === '"' && i + 1 < command.length) word += command[++i];
      else word += c;
    } else if (c === "'" || c === '"') {
      quote = c;
      word ??= "";
    } else if (c === "\\" && i + 1 < command.length) {
      word = (word ?? "") + command[++i];
    } else if (/\s/.test(c) && c !== "\n") {
      flush();
    } else if (c === "\n" || c === ";" || c === "&" || c === "|") {
      flush();
      if (commands.at(-1).length) commands.push([]);
    } else {
      word = (word ?? "") + c;
    }
  }
  flush();
  return commands.filter((words) => words.length);
}

// For `git [-C dir] [-c k=v] <sub> args…`: { dir, sub, args }, or null.
function parseGit(words, baseDir) {
  const start = words.findIndex((w) => w === "git" || w.endsWith("/git"));
  if (start < 0) return null;
  let dir = baseDir;
  let i = start + 1;
  while (i < words.length && words[i].startsWith("-")) {
    if (words[i] === "-C") dir = resolve(dir, words[++i] ?? ".");
    else if (words[i] === "-c") i++;
    i++;
  }
  return i < words.length ? { dir, sub: words[i], args: words.slice(i + 1) } : null;
}

// `git commit` short options that take a value: the rest of the cluster, or
// the next word, is that value.
const COMMIT_VALUE_OPTIONS = new Set(["m", "F", "C", "c", "t", "S"]);

function commitsAll(args) {
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === "--") return false;
    if (a === "--all") return true;
    if (!/^-[^-]/.test(a)) continue;
    for (let j = 1; j < a.length; j++) {
      if (a[j] === "a") return true;
      if (COMMIT_VALUE_OPTIONS.has(a[j])) {
        if (j === a.length - 1) i++;
        break;
      }
    }
  }
  return false;
}

function checkBash(command) {
  let dir = cwd;
  const pendingAdds = [];
  for (const words of simpleCommands(command)) {
    if (words[0] === "cd" && words[1]) {
      dir = resolve(dir, words[1]);
      continue;
    }
    const g = parseGit(words, dir);
    if (!g) continue;
    if (g.sub === "add") {
      const all = g.args.some((a) => a === "-A" || a === "--all" || a === "." || a === ":/" || a === "-u" || a === "--update");
      if (all) {
        block(
          "stage by path: `git add <the files you touched>`. `git add -A`, `.`, `-u` sweep in other agents' work.",
        );
      }
      pendingAdds.push(...g.args.filter((a) => !a.startsWith("-")).map((a) => resolve(g.dir, a)));
    }
    if (g.sub === "commit") {
      if (commitsAll(g.args)) {
        block("`git commit -a` sweeps in other agents' work: stage by path, then `git commit`.");
      }
      checkLockfile(g.dir, pendingAdds);
    }
  }
}

// A package.json going into the commit while pnpm-lock.yaml or
// pnpm-workspace.yaml has changes left out of it: CI's frozen install fails.
function checkLockfile(dir, pendingAdds) {
  const top = git(dir, "rev-parse", "--show-toplevel");
  if (!top) return;
  const staged = (git(top, "diff", "--cached", "--name-only") ?? "").split("\n").filter(Boolean);
  const going = new Set([...staged.map((p) => resolve(top, p)), ...pendingAdds]);
  const touchesManifest = [...going].some((p) => p.endsWith("/package.json"));
  if (!touchesManifest) return;
  for (const name of ["pnpm-lock.yaml", "pnpm-workspace.yaml"]) {
    if (git(top, "status", "--porcelain", "--", name) && !going.has(resolve(top, name))) {
      block(`a package.json is committed but ${name} has changes left out: stage it in the same commit.`);
    }
  }
}

function checkEdit(filePath) {
  if (process.env.QUIZ_ALLOW_MAIN === "1" || !filePath) return;
  const file = isAbsolute(filePath) ? filePath : resolve(cwd, filePath);
  let dir = dirname(file);
  while (!existsSync(dir) && dir !== dirname(dir)) dir = dirname(dir);
  const top = git(dir, "rev-parse", "--show-toplevel");
  if (!top) return; // outside any repository: scratch files, memory
  if (git(top, "branch", "--show-current") !== "main") return;
  if (git(top, "check-ignore", "-q", file) !== null) return; // .env, .data/
  const tracked = git(top, "ls-files", "--error-unmatch", file) !== null;
  const inRepoTree = !file.startsWith(resolve(top, ".claude/worktrees"));
  if (inRepoTree && (tracked || !existsSync(file))) {
    block(
      `${top} is on \`main\`, which receives merges, never edits. Work in a worktree of your own ` +
        "(`git worktree add ../heig-quiz-<subject> -b <subject>`, or EnterWorktree). " +
        "The person merging may set QUIZ_ALLOW_MAIN=1.",
    );
  }
}

const tool = input.tool_name;
const ti = input.tool_input ?? {};
if (tool === "Bash") checkBash(ti.command ?? "");
else if (tool === "Edit" || tool === "Write" || tool === "NotebookEdit") checkEdit(ti.file_path ?? ti.notebook_path);
process.exit(0);
