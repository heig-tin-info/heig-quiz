import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import type { PoolTag } from "@quiz/contracts";

import { mockFetch, ok, renderWithProviders } from "../test/render";
import { TagInput } from "./TagInput";

/*
 * The tag field of the question editor: one box, chips inside it, the
 * vocabulary of the pool suggested under it. What is asserted here is the
 * contract a teacher feels — type and pick, Enter and comma add, Backspace
 * removes, an unknown word is CREATED on purpose — and the ARIA combobox
 * wiring a screen reader needs to follow the same thing.
 */

const VOCABULARY: PoolTag[] = [
  { tag: "malloc", description: "Allocates memory on the heap", count: 1 },
  { tag: "pointers", description: "", count: 7 },
];

function setup(tags: string[] = [], vocabulary: PoolTag[] = VOCABULARY) {
  const onChange = vi.fn();
  const { calls } = mockFetch({
    "GET /app/api/pools/p1/tags": ok(vocabulary),
    "PATCH /app/api/pools/p1/tags/fork": (call) => ok({ tag: "fork", ...(call.body as object), count: 1 }),
    "PATCH /app/api/pools/p1/tags/pointers": (call) =>
      ok({ tag: "pointers", ...(call.body as object), count: 7 }),
  });
  const view = renderWithProviders(<TagInput poolId="p1" tags={tags} onChange={onChange} />);
  return { ...view, onChange, calls, user: userEvent.setup() };
}

const combobox = () => screen.getByRole("combobox");

describe("TagInput", () => {
  it("suggests the tags of the pool with their description and their count", async () => {
    const { user } = setup();
    await user.click(combobox());

    const options = await screen.findAllByRole("option");
    expect(options.map((o) => o.textContent)).toEqual([
      "#malloc1 questionAllocates memory on the heap",
      "#pointers7 questions",
    ]);
    expect(combobox()).toHaveAttribute("aria-expanded", "true");
  });

  it("adds the picked tag and leaves the saving to its caller", async () => {
    const { user, onChange } = setup();
    await user.click(combobox());
    await user.click(await screen.findByText("#malloc"));

    expect(onChange).toHaveBeenCalledWith(["malloc"]);
  });

  it("moves through the suggestions with the arrows and picks with Enter", async () => {
    const { user, onChange } = setup();
    await user.click(combobox());
    await screen.findAllByRole("option");

    // The first row is selected on open; one ArrowDown moves to the second.
    await user.keyboard("{ArrowDown}");
    expect(combobox()).toHaveAttribute(
      "aria-activedescendant",
      screen.getAllByRole("option")[1]!.id,
    );
    await user.keyboard("{Enter}");
    expect(onChange).toHaveBeenCalledWith(["pointers"]);
  });

  it("closes the list on Escape without adding anything", async () => {
    const { user, onChange } = setup();
    await user.click(combobox());
    await screen.findAllByRole("option");

    await user.keyboard("{Escape}");
    expect(screen.queryByRole("listbox")).toBeNull();
    expect(combobox()).toHaveAttribute("aria-expanded", "false");
    expect(onChange).not.toHaveBeenCalled();
  });

  it("offers to create a word the pool does not know, and then to describe it", async () => {
    const { user, onChange, calls } = setup();
    await user.click(combobox());
    await user.type(combobox(), "Fork");

    // The list only offers the creation: no existing tag contains "fork".
    const create = await screen.findByRole("option");
    expect(create).toHaveTextContent("Create “fork”");
    await user.click(create);
    expect(onChange).toHaveBeenCalledWith(["fork"]);

    // The description of a new tag is asked for on the spot, and saved on Enter.
    const description = await screen.findByLabelText("Description of the tag fork");
    await user.type(description, "Creates a child process{Enter}");
    await waitFor(() =>
      expect(calls.find((c) => c.method === "PATCH")).toMatchObject({
        url: "/app/api/pools/p1/tags/fork",
        body: { description: "Creates a child process" },
      }),
    );
  });

  it("adds a typed tag on a comma, normalized like the server stores it", async () => {
    const { user, onChange } = setup();
    await user.type(combobox(), "#Pointers,");
    expect(onChange).toHaveBeenCalledWith(["pointers"]);
  });

  it("removes the last chip on Backspace in an empty input", async () => {
    const { user, onChange } = setup(["malloc", "pointers"]);
    await user.click(combobox());
    await user.keyboard("{Backspace}");
    expect(onChange).toHaveBeenCalledWith(["malloc"]);
  });

  it("never suggests a tag the question already wears", async () => {
    const { user } = setup(["malloc"]);
    await user.click(combobox());
    const options = await screen.findAllByRole("option");
    expect(options.map((o) => o.textContent)).toEqual(["#pointers7 questions"]);
  });

  it("documents an existing tag from the chip itself", async () => {
    const { user, calls } = setup(["pointers"]);
    await user.click(await screen.findByRole("button", { name: "Describe the tag pointers" }));

    const description = screen.getByLabelText("Description of the tag pointers");
    await user.type(description, "What a pointer is{Enter}");
    await waitFor(() =>
      expect(calls.find((c) => c.method === "PATCH")).toMatchObject({
        url: "/app/api/pools/p1/tags/pointers",
        body: { description: "What a pointer is" },
      }),
    );
  });

  it("says so when the pool has no tag at all", async () => {
    const { user } = setup([], []);
    await user.click(combobox());
    expect(await screen.findByText("This pool has no tag yet.")).toBeInTheDocument();
  });
});
