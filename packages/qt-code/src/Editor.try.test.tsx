/**
 * The reference try's divergence check: on a `runno` question the server
 * grades the reference, the browser runs it too, and the editor warns when
 * the two judge a case differently — the students' trials run on the one,
 * their grade comes from the other (ADR-015).
 *
 * The host callbacks are fakes; no runner of either kind is involved.
 */
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { browserDivergence, CodeEditor, type CodeTryOutcome } from "./Editor.js";
import type { CodeConfig } from "./schema.js";
import { codeConfig, outcome } from "./test/fixtures.js";

/** Two editable regions in the fixture: the reference is cut in two. */
const runnoConfig = (runtime: CodeConfig["runtime"] = "runno"): CodeConfig => ({
  ...codeConfig(),
  runtime,
  referenceSolution: ["#include <stdio.h>", "/* @@next */", "    return 6;"].join("\n"),
});

/** The fixture's three cases, all passing. */
const passing = () =>
  outcome([{ stdout: "6\n" }, { stdout: "0\n" }, { stdout: "5 (hidden-expected-marker)" }]);

const serverPassesAll = async (): Promise<CodeTryOutcome> => ({
  graded: { compileOk: true, passed: 3, total: 3, cases: [true, true, true] },
});

const TRY = { name: "Try the reference solution" };

function setup(props: Partial<React.ComponentProps<typeof CodeEditor>>) {
  render(
    <CodeEditor
      config={runnoConfig()}
      onChange={() => {}}
      uploadAsset={async () => "asset:none"}
      monaco={false}
      onTry={serverPassesAll}
      {...props}
    />,
  );
}

describe("the reference try on a browser-run question", () => {
  it("warns when the browser disagrees with the server", async () => {
    const onTryInBrowser = vi.fn(async () =>
      outcome([{ stdout: "6\n" }, { stdout: "1\n" }, { stdout: "5 (hidden-expected-marker)" }]),
    );
    setup({ onTryInBrowser });
    fireEvent.click(screen.getByRole("button", TRY));
    expect(await screen.findByText("3 of 3 cases pass.")).toBeInTheDocument();
    expect(
      screen.getByText(
        'The browser and the server disagree on 1 case — students\' trials may mislead them. Consider "Same as grading".',
      ),
    ).toBeInTheDocument();
    expect(onTryInBrowser).toHaveBeenCalledTimes(1);
  });

  it("says nothing when they agree", async () => {
    const onTryInBrowser = vi.fn(async () => passing());
    setup({ onTryInBrowser });
    fireEvent.click(screen.getByRole("button", TRY));
    expect(await screen.findByText("3 of 3 cases pass.")).toBeInTheDocument();
    expect(onTryInBrowser).toHaveBeenCalledTimes(1);
    expect(screen.queryByText(/disagree/)).toBeNull();
  });

  it("says nothing when the browser cannot run it, or fails to", async () => {
    setup({ onTryInBrowser: async () => "unavailable" });
    fireEvent.click(screen.getByRole("button", TRY));
    expect(await screen.findByText("3 of 3 cases pass.")).toBeInTheDocument();
    expect(screen.queryByText(/disagree/)).toBeNull();
  });

  it("keeps the server's verdict when the browser run throws", async () => {
    setup({
      onTryInBrowser: async () => {
        throw new Error("worker crashed");
      },
    });
    fireEvent.click(screen.getByRole("button", TRY));
    expect(await screen.findByText("3 of 3 cases pass.")).toBeInTheDocument();
    expect(screen.queryByText(/disagree/)).toBeNull();
  });

  it("does not run the browser on a question the server runs", async () => {
    const onTryInBrowser = vi.fn(async () => passing());
    setup({ config: runnoConfig("backend"), onTryInBrowser });
    fireEvent.click(screen.getByRole("button", TRY));
    expect(await screen.findByText("3 of 3 cases pass.")).toBeInTheDocument();
    expect(onTryInBrowser).not.toHaveBeenCalled();
  });

  it("has nothing to compare when the browser itself answered the try", async () => {
    // The server had no runner: the host fell back to the browser, whose raw
    // outcome is the only verdict there is.
    const onTryInBrowser = vi.fn(async () => passing());
    setup({ onTry: async () => passing(), onTryInBrowser });
    fireEvent.click(screen.getByRole("button", TRY));
    expect(await screen.findByText("3 of 3 cases pass.")).toBeInTheDocument();
    expect(onTryInBrowser).not.toHaveBeenCalled();
  });
});

describe("browserDivergence", () => {
  it("counts a browser build failure against every case the server passed", () => {
    const failed = outcome([], { ok: false, stderr: "error" });
    expect(browserDivergence(runnoConfig(), [true, false, true], failed)).toBe(2);
  });

  it("cannot compare lists that do not line up", () => {
    expect(browserDivergence(runnoConfig(), [true], passing())).toBeNull();
    expect(browserDivergence(runnoConfig(), [true, true, true], "unavailable")).toBeNull();
  });
});
