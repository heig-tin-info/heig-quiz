import { createRequire } from "node:module";

import { describe, expect, it } from "vitest";

/**
 * The student image's debugged-program terminal (#1103): the part of the
 * status-bar extension that needs no `vscode`. The rest, with gdb and the
 * real debug adapter, is images/quiz-base/test-toolchain.sh § 4.
 */
type Config = Record<string, unknown>;
const debugIo = createRequire(import.meta.url)("../images/quiz-base/extension/debugIo.js") as {
  programTerminalConfig: (config: Config, tty: string) => Config;
  sharedPending: <T>(create: () => Promise<T>) => () => Promise<T>;
};

describe("programTerminalConfig", () => {
  const launch = { type: "gdb", request: "launch", target: "./main", terminal: "", autorun: ["break main"] };

  it("prepends set inferior-tty and drops an external terminal", () => {
    expect(debugIo.programTerminalConfig(launch, "/dev/pts/3")).toEqual({
      type: "gdb",
      request: "launch",
      target: "./main",
      autorun: ["set inferior-tty /dev/pts/3", "break main"],
    });
  });

  it("leaves alone an attach, an ssh launch, a configuration that chose its tty, and a name that is not a pts", () => {
    const cases: Config[] = [
      { type: "gdb", request: "attach", target: "1234" },
      { ...launch, ssh: { host: "h" } },
      { ...launch, autorun: ["set inferior-tty /dev/pts/9"] },
      { type: "lldb-mi", request: "launch" },
    ];
    for (const config of cases) expect(debugIo.programTerminalConfig(config, "/dev/pts/3")).toBe(config);
    expect(debugIo.programTerminalConfig(launch, "/dev/pts/3; shell id")).toBe(launch);
  });
});

describe("sharedPending", () => {
  it("runs one creation for concurrent callers, and a new one once it settled", async () => {
    let runs = 0;
    let release: (value: string) => void = () => {};
    const ensure = debugIo.sharedPending(
      () =>
        new Promise<string>((resolve) => {
          runs += 1;
          release = resolve;
        }),
    );
    const first = ensure();
    const second = ensure();
    await Promise.resolve();
    release("/dev/pts/1");
    expect(await Promise.all([first, second])).toEqual(["/dev/pts/1", "/dev/pts/1"]);
    expect(runs).toBe(1);
    const third = ensure();
    await Promise.resolve();
    release("/dev/pts/2");
    expect(await third).toBe("/dev/pts/2");
    expect(runs).toBe(2);
  });
});
