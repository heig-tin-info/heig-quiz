import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

/**
 * One source of truth for the seccomp profile (M6-05): the workspace's
 * profile is the runner's plus ONE rule allowing `ptrace`, for gdb. Any other
 * difference — a syscall re-allowed, a rule reordered, a runner tightening not
 * carried over — fails here. To change the workspace's profile, change the
 * runner's and add the `ptrace` rule back after the main allow list.
 */
type Rule = {
  names: string[];
  action: string;
  args?: unknown[] | null;
  includes?: { caps?: string[] };
};
type Profile = { syscalls: Rule[] };

const read = (path: string): Profile =>
  JSON.parse(readFileSync(new URL(path, import.meta.url), "utf8")) as Profile;

const codespace = read("../../infra/seccomp/codespace.json");
const runner = read("../../../runner/infra/seccomp/runner.json");

describe("infra/seccomp/codespace.json", () => {
  const isPtrace = (r: Rule) => r.names.includes("ptrace");

  it("is the runner's profile plus one unconditional ptrace rule", () => {
    const ptrace = codespace.syscalls.filter(isPtrace);
    expect(ptrace).toHaveLength(1);
    expect(ptrace[0]).toMatchObject({ names: ["ptrace"], action: "SCMP_ACT_ALLOW", args: [] });
    expect({ ...codespace, syscalls: codespace.syscalls.filter((r) => !isPtrace(r)) }).toEqual(
      runner,
    );
  });

  it("allows no namespace or mount syscall unconditionally", () => {
    const allowed = codespace.syscalls
      // `setns` keeps its CAP_SYS_ADMIN rule, which --cap-drop=ALL never meets.
      .filter((r) => r.action === "SCMP_ACT_ALLOW" && !r.args?.length && !r.includes?.caps)
      .flatMap((r) => r.names);
    const denied = ["unshare", "setns", "mount", "umount2", "pivot_root", "fsopen", "keyctl"];
    for (const name of [...denied, "clone", "clone3"]) expect(allowed).not.toContain(name);
  });
});
