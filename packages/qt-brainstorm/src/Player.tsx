/**
 * The `brainstorm` player: the question, a field to type ONE idea, and the
 * ideas already sent as chips that can be removed. Controlled: every add or
 * remove is the whole answer handed to the host, which autosaves it.
 */
import { useState } from "react";

import type { PlayerProps, StringOverrides } from "@quiz/core/client";
import { resolveStrings } from "@quiz/core/client";
import { BRAINSTORM_IDEA_MAX, ideaKey } from "@quiz/domain";
import { buttonClass, caption, CloseIcon, cx, inputClass, inputSize, isLocked, label, markdown } from "@quiz/ui";

import type { BrainstormAnswer, BrainstormStudent } from "./schema.js";
import { brainstormPlayerStrings, type BrainstormPlayerStringKey } from "./strings.js";

type BrainstormPlayerProps = PlayerProps<BrainstormStudent, BrainstormAnswer> & {
  disabled?: boolean;
  strings?: StringOverrides<BrainstormPlayerStringKey>;
};

export function BrainstormPlayer({
  student,
  answer,
  onChange,
  readOnly,
  disabled,
  strings,
  renderMarkdown,
}: BrainstormPlayerProps) {
  const s = resolveStrings(brainstormPlayerStrings, strings);
  const locked = isLocked(readOnly, disabled);
  const ideas = answer?.ideas ?? [];
  const [draft, setDraft] = useState("");
  const full = ideas.length >= student.maxIdeas;
  const max = String(student.maxIdeas);

  const add = () => {
    const idea = draft.replace(/\s+/g, " ").trim();
    if (idea === "" || full) return;
    // The same idea twice counts once anyway: do not let it look like two.
    if (!ideas.some((given) => ideaKey(given) === ideaKey(idea))) onChange({ ideas: [...ideas, idea] });
    setDraft("");
  };

  return (
    <div className="flex flex-col gap-4">
      <p className="text-lg leading-relaxed text-fg">{markdown(renderMarkdown, student.prompt)}</p>
      {locked ? null : (
        <form
          className="flex flex-col gap-1.5"
          onSubmit={(e) => {
            e.preventDefault();
            add();
          }}
        >
          <label className={label} htmlFor="brainstorm-idea">
            {s.label}
          </label>
          <div className="flex gap-2">
            <input
              id="brainstorm-idea"
              type="text"
              autoComplete="off"
              enterKeyHint="send"
              maxLength={BRAINSTORM_IDEA_MAX}
              className={cx(inputClass, inputSize.md, "min-w-0 flex-1")}
              placeholder={s.placeholder}
              value={draft}
              disabled={full}
              onChange={(e) => setDraft(e.target.value)}
            />
            <button type="submit" className={buttonClass("primary", "md")} disabled={full || draft.trim() === ""}>
              {s.add}
            </button>
          </div>
          <p className={caption}>{(full ? s.full : s.hint).replace("{max}", max)}</p>
        </form>
      )}
      {ideas.length === 0 ? null : (
        <ul className="flex flex-wrap gap-2" aria-label={s.list}>
          {ideas.map((idea, i) => (
            <li
              key={`${idea}-${i}`}
              className="inline-flex items-center gap-1 rounded-full border border-line bg-surface-2 py-1 pr-1 pl-3 text-sm text-fg"
            >
              <span className="break-all">{idea}</span>
              {locked ? null : (
                <button
                  type="button"
                  className="grid size-6 place-items-center rounded-full text-fg-muted hover:bg-surface-3 hover:text-fg"
                  aria-label={`${s.remove} ${idea}`}
                  onClick={() => onChange({ ideas: ideas.filter((_, j) => j !== i) })}
                >
                  <CloseIcon />
                </button>
              )}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
