import { readFileSync } from "node:fs";

import { expect, it } from "vitest";

/**
 * One source of truth for the seccomp profile (M6-05): the workspace's
 * profile is the runner's plus ONE rule allowing `ptrace`, for gdb. Any other
 * difference — a syscall re-allowed, a rule reordered, a runner tightening not
 * carried over — fails here. To change the workspace's profile, change the
 * runner's and add the `ptrace` rule back after the main allow list.
 */
type Rule = { names: string[] };
type Profile = { syscalls: Rule[] };

const read = (path: string): Profile =>
  JSON.parse(readFileSync(new URL(path, import.meta.url), "utf8")) as Profile;

it("infra/seccomp/codespace.json is the runner's profile plus one ptrace rule", () => {
  const codespace = read("../infra/seccomp/codespace.json");
  const runner = read("../../runner/infra/seccomp/runner.json");
  const isPtrace = (r: Rule) => r.names.includes("ptrace");

  const ptrace = codespace.syscalls.filter(isPtrace);
  expect(ptrace).toHaveLength(1);
  expect(ptrace[0]).toMatchObject({ names: ["ptrace"], action: "SCMP_ACT_ALLOW", args: [] });
  expect({ ...codespace, syscalls: codespace.syscalls.filter((r) => !isPtrace(r)) }).toEqual(runner);
});
