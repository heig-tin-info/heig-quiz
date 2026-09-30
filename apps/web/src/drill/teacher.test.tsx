import { screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

import { makeClassroomDetail } from "../test/fixtures";
import { makeEvaluationDetail } from "../test/grading-fixtures";
import { mockFetch, ok, renderWithProviders } from "../test/render";
import { ClassroomDrillSetting } from "./ClassroomDrillSetting";
import { EvaluationDrillSetting } from "./EvaluationDrillSetting";

/*
 * The teacher's two drill switches (ADR-041 §6, §10 item 3): the classroom's
 * drill, which says what the backfill made, and an evaluation's "Allow
 * drill", with the note the product owner requires beside it and the
 * explicit, confirmed removal of its cards.
 */

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("the classroom's drill switch", () => {
  it("turns the drill on and says how many cards the past evaluations gave", async () => {
    const user = userEvent.setup();
    const { calls } = mockFetch({
      "PUT /app/api/classrooms/r1/drill": ok({ enabled: true, enabledAt: new Date().toISOString(), cardsCreated: 42 }),
    });
    const { rerender } = renderWithProviders(<ClassroomDrillSetting room={makeClassroomDetail()} />);

    const toggle = screen.getByRole("switch", { name: "Drill" });
    expect(toggle).toHaveAttribute("aria-checked", "false");
    await user.click(toggle);

    expect(await screen.findByText("Drill on.")).toBeVisible();
    // The classroom, read again, has the drill on: the row keeps the count.
    rerender(<ClassroomDrillSetting room={makeClassroomDetail({ drillEnabled: true })} />);
    expect(screen.getByText("42 cards created from past evaluations.")).toBeVisible();
    expect(calls.find((c) => c.method === "PUT")?.body).toEqual({ enabled: true });
  });

  it("turns it off", async () => {
    const user = userEvent.setup();
    const { calls } = mockFetch({
      "PUT /app/api/classrooms/r1/drill": ok({ enabled: false, enabledAt: null, cardsCreated: 0 }),
    });
    renderWithProviders(<ClassroomDrillSetting room={makeClassroomDetail({ drillEnabled: true })} />);
    await user.click(screen.getByRole("switch", { name: "Drill" }));
    expect(await screen.findByText("Drill off.")).toBeVisible();
    expect(calls.find((c) => c.method === "PUT")?.body).toEqual({ enabled: false });
  });
});

describe("an evaluation's Allow drill", () => {
  const detail = makeEvaluationDetail();
  const id = detail.evaluation.id;
  const url = `/app/api/evaluations/${id}/drill`;

  it("says, next to the switch, that the key is shown and the latest version served", async () => {
    const user = userEvent.setup();
    const { calls } = mockFetch({
      [`GET ${url}`]: ok({ allowDrill: false, cards: 0 }),
      [`PUT ${url}`]: ok({ allowDrill: true, cards: 0 }),
    });
    renderWithProviders(
      <EvaluationDrillSetting evaluation={{ ...detail.evaluation, state: "draft", allowDrill: false }} />,
    );

    expect(screen.getByText("Students will see the key of these questions after each review.")).toBeVisible();
    expect(screen.getByText(/serves the latest published version of each question/)).toBeVisible();
    await user.click(screen.getByRole("switch", { name: "Allow drill" }));
    await vi.waitFor(() => expect(calls.find((c) => c.method === "PUT")?.body).toEqual({ allowDrill: true }));
    // No card yet: nothing to remove.
    expect(screen.queryByRole("button", { name: /remove these questions/i })).toBeNull();
  });

  it("freezes the switch once released, and removes the cards only after a confirmation that counts them", async () => {
    const user = userEvent.setup();
    const { calls } = mockFetch({
      [`GET ${url}`]: ok({ allowDrill: true, cards: 3 }),
      [`DELETE ${url}/cards`]: ok({ removed: 3 }),
    });
    renderWithProviders(
      <EvaluationDrillSetting evaluation={{ ...detail.evaluation, state: "released", allowDrill: true }} />,
    );

    expect(screen.getByRole("switch", { name: "Allow drill" })).toBeDisabled();
    expect(screen.getByText("The results are released: this setting no longer changes.")).toBeVisible();
    expect(await screen.findByText("3 drill cards come from this evaluation")).toBeVisible();

    await user.click(screen.getByRole("button", { name: "Remove these questions from the drill" }));
    const dialog = await screen.findByRole("dialog", { name: "Remove 3 cards from the drill?" });
    expect(calls.some((c) => c.method === "DELETE")).toBe(false);
    await user.click(within(dialog).getByRole("button", { name: "Remove these questions from the drill" }));

    expect(await screen.findByText("3 cards removed from the drill.")).toBeVisible();
    expect(calls.filter((c) => c.method === "DELETE")).toHaveLength(1);
    expect(screen.queryByText("3 drill cards come from this evaluation")).toBeNull();
  });

  it("removes nothing when the teacher cancels", async () => {
    const user = userEvent.setup();
    const { calls } = mockFetch({ [`GET ${url}`]: ok({ allowDrill: false, cards: 1 }) });
    renderWithProviders(<EvaluationDrillSetting evaluation={{ ...detail.evaluation, state: "closed" }} />);
    await user.click(await screen.findByRole("button", { name: "Remove these questions from the drill" }));
    await user.click(within(await screen.findByRole("dialog")).getByRole("button", { name: "Cancel" }));
    expect(calls.some((c) => c.method === "DELETE")).toBe(false);
  });
});
