import { screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { renderWithProviders } from "../test/render";
import { ConditionsList } from "./ConditionsList";

/* ADR-144 §7: the documents an evaluation provides, counted among what is provided — never named. */

describe("the conditions' documents line", () => {
  it("counts the documents provided, singular and plural, under Provided", () => {
    const { unmount } = renderWithProviders(
      <ConditionsList
        conditions={{
          announced: [],
          imposed: [
            { key: "notepad", kind: "provided" },
            { key: "documents", kind: "provided", count: 3 },
          ],
        }}
      />,
    );
    expect(screen.getByRole("heading", { name: "Provided" })).toBeInTheDocument();
    expect(screen.getByText("3 documents provided")).toBeInTheDocument();
    unmount();
    renderWithProviders(
      <ConditionsList conditions={{ announced: [], imposed: [{ key: "documents", kind: "provided", count: 1 }] }} />,
      { locale: "fr" },
    );
    expect(screen.getByText("1 document fourni")).toBeInTheDocument();
  });
});
