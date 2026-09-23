import { screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { UserMinus } from "lucide-react";
import { describe, expect, it, vi } from "vitest";

import { renderWithProviders } from "../test/render";
import { PeopleStack, PersonPill, type Person } from "./people";

/*
 * A row of discs says WHO; everything else about one person waits behind the
 * disc. These are the two promises that makes: the row never grows past its
 * cap, and what is hidden is one gesture away.
 */

const NAMES = [
  "Dupont",
  "Martin",
  "Rochat",
  "Favre",
  "Bovet",
  "Chappuis",
  "Monnier",
  "Perret",
  "Girard",
  "Roulet",
  "Blanc",
  "Mercier",
];

const people: Person[] = NAMES.map((familyName, i) => ({
  userId: `u${i + 1}`,
  givenName: `Prof${i + 1}`,
  familyName,
  email: `prof${i + 1}.${familyName.toLowerCase()}@heig-vd.ch`,
  avatarUrl: null,
}));

describe("PeopleStack", () => {
  it("draws the first ten and hides the rest behind a +2", () => {
    renderWithProviders(<PeopleStack people={people} />);
    for (const p of people.slice(0, 10)) {
      expect(screen.getByRole("button", { name: `${p.givenName} ${p.familyName}` })).toBeVisible();
    }
    expect(screen.queryByRole("button", { name: "Prof11 Blanc" })).toBeNull();
    expect(screen.getByRole("button", { name: "2 more" })).toHaveTextContent("+2");
  });

  it("lists everyone in the overflow card, the hidden ones included", async () => {
    renderWithProviders(<PeopleStack people={people} />);
    await userEvent.click(screen.getByRole("button", { name: "2 more" }));
    const card = screen.getByRole("dialog", { name: "2 more" });
    expect(within(card).getAllByRole("listitem")).toHaveLength(12);
    expect(within(card).getByText("Prof12 Mercier")).toBeVisible();
  });

  it("draws every disc while the row fits, and nothing at all for nobody", () => {
    const { unmount } = renderWithProviders(<PeopleStack people={[]} />);
    expect(screen.queryByRole("button")).toBeNull();
    unmount();

    renderWithProviders(<PeopleStack people={people.slice(0, 4)} />);
    expect(screen.getAllByRole("button")).toHaveLength(4);
  });
});

describe("PersonPill", () => {
  it("opens on the name and the address", async () => {
    const person = people[0]!;
    renderWithProviders(<PersonPill person={person} />);
    await userEvent.click(screen.getByRole("button", { name: "Prof1 Dupont" }));
    const card = screen.getByRole("dialog", { name: "Prof1 Dupont" });
    expect(within(card).getByText("Prof1 Dupont")).toBeVisible();
    expect(within(card).getByText(person.email)).toBeVisible();
  });

  it("runs the person's own action from inside the card", async () => {
    const onSelect = vi.fn();
    renderWithProviders(
      <PersonPill
        person={people[0]!}
        actions={[
          { label: "Remove from the staff", icon: UserMinus, danger: true, onSelect },
        ]}
      />,
    );
    await userEvent.click(screen.getByRole("button", { name: "Prof1 Dupont" }));
    const card = screen.getByRole("dialog", { name: "Prof1 Dupont" });
    // One action is one icon button, not a menu inside a card.
    await userEvent.click(within(card).getByRole("button", { name: "Remove from the staff" }));
    expect(onSelect).toHaveBeenCalledTimes(1);
  });

  it("leaves the card read-only when the person has no action", async () => {
    renderWithProviders(<PersonPill person={people[0]!} actions={[]} />);
    await userEvent.click(screen.getByRole("button", { name: "Prof1 Dupont" }));
    const card = screen.getByRole("dialog", { name: "Prof1 Dupont" });
    expect(within(card).queryByRole("button")).toBeNull();
  });
});
