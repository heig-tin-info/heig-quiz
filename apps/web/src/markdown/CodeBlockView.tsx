import type { NodeViewProps } from "@tiptap/core";
import { NodeViewContent, NodeViewWrapper } from "@tiptap/react";

import { useT } from "../i18n";
import { cx, inputClass } from "../ui";

/*
 * The code block of the rich editor, as a Tiptap NODE VIEW (React), for one
 * thing the node cannot say by itself: its LANGUAGE.
 *
 * The language is an attribute — it is the `c` of ```c, it is what the fence
 * serializes with and what colours the block, for the teacher here and for the
 * student in `render.ts` — and until now nothing on the screen showed it or
 * could change it. A teacher who opened a fence without a tag, or with the
 * wrong one, had to go to the markdown source pane to fix four characters.
 *
 * So the block carries a small field at its top-right corner, the same
 * placement the picture's own toolbar uses (`ImageView.tsx`), and for the same
 * reason: a node view owns the element, so `position: absolute` follows the
 * block wherever the document puts it.
 *
 * The CONTENT stays ProseMirror's: `NodeViewContent` is the contenteditable
 * half of the view, and the caret, the selection and the undo history never
 * notice it is rendered by React. The field is outside it, marked
 * `contentEditable={false}`, and it keeps its events to itself — a keystroke
 * that reached the editor from here would be typed into the code.
 */
export function CodeBlockView({ node, updateAttributes, editor, getPos }: NodeViewProps) {
  const t = useT();
  const language = typeof node.attrs.language === "string" ? node.attrs.language : "";

  /** Back to the code, at the first character of this block. */
  function toCode() {
    const pos = getPos();
    if (typeof pos === "number") editor.commands.focus(pos + 1);
  }

  return (
    <NodeViewWrapper className="rt-code">
      <pre>
        {/*
         * `white-space: pre` and not the `pre-wrap` @tiptap/react sets by
         * default: a fenced block scrolls sideways for the student
         * (`.md-body pre`), and a teacher who cannot see that a line is long
         * writes one the student reads through a scrollbar.
         */}
        {/* The type argument is explicit because `as` is a `NoInfer` in the
            signature of @tiptap/react: without it the props are those of the
            default <div>. */}
        <NodeViewContent<"code">
          as="code"
          style={{ whiteSpace: "pre" }}
          {...(language === "" ? {} : { className: `language-${language}` })}
        />
      </pre>
      {editor.isEditable ? (
        <div className="absolute top-1.5 right-1.5" contentEditable={false}>
          <input
            value={language}
            aria-label={t("md.code.language")}
            placeholder={t("md.code.languagePlaceholder")}
            spellCheck={false}
            autoComplete="off"
            className={cx(inputClass, "h-6 w-24 px-2.5 font-mono text-[11px]")}
            // The editor must not see what happens in this field: its own key
            // handlers would type these characters into the block.
            onMouseDown={(e) => e.stopPropagation()}
            onChange={(e) =>
              updateAttributes({ language: e.target.value.replace(/\s+/g, "") || null })
            }
            onKeyDown={(e) => {
              e.stopPropagation();
              if (e.key !== "Enter" && e.key !== "Escape") return;
              // Both ways out of a one-word field lead back to the code: the
              // field is a detour, never a destination.
              e.preventDefault();
              toCode();
            }}
          />
        </div>
      ) : null}
    </NodeViewWrapper>
  );
}
