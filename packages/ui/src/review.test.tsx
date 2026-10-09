import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { ReviewPrompt, TableHead, Th } from "./review.js";

describe("ReviewPrompt", () => {
  it("draws the statement in the type's element, through the host's markdown", () => {
    const { container } = render(<ReviewPrompt prompt="Why?" sections={undefined} renderMarkdown={(s) => <em>{s}</em>} as="p" />);
    expect(container.innerHTML).toBe('<p class="text-sm font-medium text-fg"><em>Why?</em></p>');
  });

  it("keeps a program's line breaks, and is a div by default", () => {
    const { container } = render(<ReviewPrompt prompt={"a\nb"} sections={{ prompt: true }} renderMarkdown={undefined} preWrap />);
    expect(container.innerHTML).toBe('<div class="whitespace-pre-wrap text-sm font-medium text-fg">a\nb</div>');
  });

  it("draws nothing when the reader hid the statement", () => {
    const { container } = render(<ReviewPrompt prompt="Why?" sections={{ prompt: false }} renderMarkdown={undefined} />);
    expect(container.innerHTML).toBe("");
  });
});

describe("TableHead", () => {
  it("is one header row of column headers, a number column right-aligned", () => {
    const { container } = render(
      <table>
        <TableHead>
          <Th>Case</Th>
          <Th right>Points</Th>
        </TableHead>
      </table>,
    );
    expect(container.querySelector("thead")?.outerHTML).toBe(
      '<thead class="text-left text-xs text-fg-muted"><tr><th scope="col" class="px-3 py-2 font-medium">Case</th><th scope="col" class="px-3 py-2 font-medium text-right">Points</th></tr></thead>',
    );
  });
});
