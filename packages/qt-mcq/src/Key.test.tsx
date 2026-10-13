/**
 * The `mcq` answer key of the debrief (ADR-033, ADR-109): every choice in the
 * served order with its letter, its ticks counted, and a bar named with its
 * verdict once revealed — never before.
 */
import { render, screen, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { keyHostProps } from "@quiz/ui/testing";

import { McqKey } from "./Key.js";
import type { McqStudent } from "./schema.js";

const student: McqStudent = {
  prompt: "What is `sizeof(char)`?",
  // Served shuffled: the letters follow the screen, the ticks the canonical id.
  choices: [
    { id: 1, text: "`2` bytes" },
    { id: 0, text: "`1` byte" },
  ],
  mode: "single",
} as McqStudent;

const host = keyHostProps({
  outcomes: { correct: 3, partial: 0, wrong: 1, blank: 1 },
  distribution: [
    { key: "0", label: "0", count: 3, correct: true, part: null },
    { key: "1", label: "1", count: 1, correct: false, part: null },
  ],
});

const draw = (revealed: boolean) =>
  render(
    <McqKey
      {...host}
      student={student}
      solution={{ correct: [0] }}
      revealed={revealed}
      prompt={<p>the prompt</p>}
      rows={<p>the rows</p>}
    />,
  );

describe("McqKey", () => {
  it("keeps the prompt and draws its choices in place of the answer groups", () => {
    draw(true);
    expect(screen.getByText("the prompt")).toBeVisible();
    expect(screen.queryByText("the rows")).toBeNull();
  });

  it("letters the choices as served and counts each one's ticks", () => {
    draw(false);
    const items = within(screen.getByRole("list")).getAllByRole("listitem");
    expect(items.map((li) => li.textContent)).toEqual(["A`2` bytes1", "B`1` byte3"]);
  });

  it("names every bar 'ticked' while hidden, without a verdict", () => {
    draw(false);
    expect(screen.getAllByRole("img").map((bar) => bar.getAttribute("aria-label"))).toEqual(["ticked: 1", "ticked: 3"]);
  });

  it("names the key and the distractor once revealed", () => {
    draw(true);
    expect(screen.getAllByRole("img").map((bar) => bar.getAttribute("aria-label"))).toEqual([
      "wrong answer · ticked: 1",
      "correct answer · ticked: 3",
    ]);
  });
});
