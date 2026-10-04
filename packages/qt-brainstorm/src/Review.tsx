/** The `brainstorm` review: the ideas given, nothing to judge. */
import type { MarkdownRenderer, ReviewProps, StringOverrides } from "@quiz/core/client";
import { resolveStrings, showsSection } from "@quiz/core/client";
import { caption, markdown, reviewPrompt } from "@quiz/ui";

import type { BrainstormAnswer, BrainstormDetails, BrainstormSolution, BrainstormStudent } from "./schema.js";
import { brainstormReviewStrings, type BrainstormReviewStringKey } from "./strings.js";

type BrainstormReviewProps = ReviewProps<BrainstormStudent, BrainstormAnswer, BrainstormSolution, BrainstormDetails> & {
  strings?: StringOverrides<BrainstormReviewStringKey>;
  renderMarkdown?: MarkdownRenderer;
};

export function BrainstormReview({ student, answer, sections, strings, renderMarkdown }: BrainstormReviewProps) {
  const s = resolveStrings(brainstormReviewStrings, strings);
  const ideas = answer?.ideas ?? [];
  return (
    <div className="flex flex-col gap-3">
      {showsSection(sections, "prompt") ? (
        <p className={reviewPrompt}>{markdown(renderMarkdown, student.prompt)}</p>
      ) : null}
      <div className="flex flex-col gap-1">
        <span className="text-[13px] font-medium text-fg">{s.yourIdeas}</span>
        {ideas.length === 0 ? (
          <span className={caption}>{s.none}</span>
        ) : (
          <ul className="flex flex-wrap gap-1.5">
            {ideas.map((idea, i) => (
              <li key={`${idea}-${i}`} className="rounded-full border border-line bg-surface px-2 py-0.5 text-xs text-fg">
                {idea}
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}
