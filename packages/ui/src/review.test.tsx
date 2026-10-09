import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { ReviewPrompt, HeadRow, Th } from "./review.js";

describe("ReviewPrompt", () => {
  it("draws the statement in a div, through the host's markdown", () => {
    const { container } = render(<ReviewPrompt prompt="Why?" sections={undefined} renderMarkdown={(s) => <em>{s}</em>} />);
    expect(container.innerHTML).toBe('<div class="text-sm font-medium text-fg"><em>Why?</em></div>');
  });

  it("keeps a program's line breaks", () => {
    const { container } = render(<ReviewPrompt prompt={"a\nb"} sections={{ prompt: true }} renderMarkdown={undefined} preWrap />);
    expect(container.innerHTML).toBe('<div class="whitespace-pre-wrap text-sm font-medium text-fg">a\nb</div>');
  });

  it("draws nothing when the reader hid the statement", () => {
    const { container } = render(<ReviewPrompt prompt="Why?" sections={{ prompt: false }} renderMarkdown={undefined} />);
    expect(container.innerHTML).toBe("");
  });
});

describe("HeadRow", () => {
  it("is one header row of column headers, a number column right-aligned", () => {
    const { container } = render(
      <table>
        <HeadRow>
          <Th>Case</Th>
          <Th right>Points</Th>
        </HeadRow>
      </table>,
    );
    expect(container.querySelector("thead")?.outerHTML).toBe(
      '<thead class="text-left text-xs text-fg-muted"><tr><th scope="col" class="px-3 py-2 font-medium">Case</th><th scope="col" class="px-3 py-2 font-medium text-right">Points</th></tr></thead>',
    );
  });
});
