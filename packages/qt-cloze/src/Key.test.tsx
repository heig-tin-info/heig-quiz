/**
 * The `cloze` answer key of the debrief (ADR-033, ADR-109): the text with
 * each blank holding the key, the share that filled it in while hidden, the
 * right / wrong split once revealed — and no split for a parameterized one.
 */
import { render, screen, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { keyHostProps } from "@quiz/ui/testing";

import { ClozeKey } from "./Key.js";
import { clozeServer } from "./server.js";
import { config } from "./test/fixtures.js";

const student = clozeServer.toStudent(config("Free with {{free}}."), { seed: 0, itemId: "i", shuffle: false });

const stats = {
  outcomes: { correct: 2, partial: 0, wrong: 1, blank: 1 },
  distribution: [
    { key: "0:free", label: "free", count: 2, correct: true, part: 0 },
    { key: "0:delete", label: "delete", count: 1, correct: false, part: 0 },
  ],
};

const draw = (revealed: boolean, over: Partial<typeof stats> & { parameterized?: boolean } = {}) =>
  render(
    <ClozeKey
      {...keyHostProps({ ...stats, ...over })}
      student={student}
      solution={{ blanks: [{ index: 0, expected: "free" }] }}
      revealed={revealed}
      prompt={<p>the prompt</p>}
      rows={<p>the rows</p>}
      statement={(body) => <section aria-label="statement">{body}</section>}
    />,
  );

describe("ClozeKey", () => {
  it("draws its text in the host's statement frame, in place of the prompt and the rows", () => {
    draw(true);
    expect(within(screen.getByRole("region", { name: "statement" })).getByText(/Free with/)).toBeVisible();
    expect(screen.queryByText("the prompt")).toBeNull();
    expect(screen.queryByText("the rows")).toBeNull();
  });

  it("keeps the key out of sight while hidden, and the share that filled the blank in", () => {
    draw(false);
    const key = screen.getByText("free");
    expect(key).toHaveAttribute("aria-hidden", "true");
    expect(within(key.parentElement!).getByRole("img")).toHaveAccessibleName("filled in: 3");
  });

  it("splits the filled share into right and wrong once revealed, the empty blank the track", () => {
    draw(true);
    const hole = screen.getByText("free").parentElement!;
    expect(within(hole).getByRole("img")).toHaveAccessibleName("correct: 2 · wrong: 1");
  });

  it("draws a parameterized blank's example key without a bar (ADR-056 §9)", () => {
    draw(true, { distribution: [], parameterized: true });
    expect(within(screen.getByText("free").parentElement!).queryByRole("img")).toBeNull();
  });
});
