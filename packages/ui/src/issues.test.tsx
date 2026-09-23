import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { IssueList } from "./issues.js";

describe("IssueList", () => {
  it("draws nothing without an issue", () => {
    const { container } = render(<IssueList issues={[]} />);
    expect(container.innerHTML).toBe("");
  });

  it("lists every message verbatim, in the danger ink", () => {
    render(
      <IssueList
        issues={[
          { path: ["prompt"], message: "prompt.empty" },
          { path: ["prompt"], message: "prompt.too_long" },
        ]}
      />,
    );
    const items = screen.getAllByRole("listitem");
    expect(items.map((li) => li.textContent)).toEqual(["prompt.empty", "prompt.too_long"]);
    expect(screen.getByRole("list").className).toContain("text-danger");
  });
});
