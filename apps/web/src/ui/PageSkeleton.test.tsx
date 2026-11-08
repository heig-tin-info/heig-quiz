import { describe, expect, it } from "vitest";

import { renderWithProviders } from "../test/render";
import { PageSkeleton } from ".";

describe("PageSkeleton", () => {
  const blocks = (container: HTMLElement) => [...container.firstElementChild!.children];

  it("is a title and a block by default, hidden from assistive technology", () => {
    const { container } = renderWithProviders(<PageSkeleton />);
    expect(blocks(container)).toHaveLength(2);
    for (const el of container.firstElementChild!.children) {
      expect(el).toHaveAttribute("aria-hidden");
    }
  });

  it("adds the bar under the title and the summary over the block on request", () => {
    const { container } = renderWithProviders(
      <PageSkeleton header="title-and-bar" body="summary-and-block" className="max-w-180" />,
    );
    expect(container.firstElementChild).toHaveClass("max-w-180");
    expect(blocks(container)).toHaveLength(4);
  });
});
