import { screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";

import type { VersionRow } from "@quiz/contracts";

import { renderWithProviders } from "../test/render";
import { VersionHistory } from "./VersionHistory";

/*
 * The published versions of a question. The server hands them over newest
 * first, which is how a history is read; the table keeps that order until the
 * teacher asks for another one, and the change note — prose — never sorts.
 */

const version = (over: Partial<VersionRow> = {}): VersionRow => ({
  number: 3,
  publishedAt: "2026-09-20T08:00:00.000Z",
  publishedBy: null,
  changeNote: "Typo",
  deprecatedAt: null,
  deprecationNote: null,
  ...over,
});

const VERSIONS = [
  version({ number: 3, publishedAt: "2026-09-20T08:00:00.000Z" }),
  version({ number: 1, publishedAt: "2026-09-01T08:00:00.000Z" }),
  version({ number: 2, publishedAt: "2026-09-10T08:00:00.000Z" }),
];

/** The version cell of every row, in the order the table draws them. */
const numbers = () =>
  screen
    .getAllByRole("row")
    .slice(1)
    .map((row) => within(row).getAllByRole("cell")[0]?.textContent ?? "");

describe("VersionHistory", () => {
  it("keeps the order the versions arrived in, then sorts on a click", async () => {
    renderWithProviders(<VersionHistory questionId="q1" versions={VERSIONS} />);
    expect(numbers().map((c) => c.trim())).toEqual(["v3current", "v1", "v2"]);

    await userEvent.click(screen.getByRole("button", { name: "Version" }));
    expect(numbers()[0]).toContain("v1");
    expect(screen.getByRole("columnheader", { name: "Version" })).toHaveAttribute(
      "aria-sort",
      "ascending",
    );

    await userEvent.click(screen.getByRole("button", { name: "Version" }));
    expect(numbers()[0]).toContain("v3");
    expect(screen.getByRole("columnheader", { name: "Version" })).toHaveAttribute(
      "aria-sort",
      "descending",
    );
  });

  it("sorts by the date it was published, and never by the change note", async () => {
    renderWithProviders(<VersionHistory questionId="q1" versions={VERSIONS} />);

    await userEvent.click(screen.getByRole("button", { name: "Published" }));
    expect(numbers()[0]).toContain("v1");

    const note = screen.getByRole("columnheader", { name: "What changed" });
    expect(within(note).queryByRole("button")).toBeNull();
  });
});
