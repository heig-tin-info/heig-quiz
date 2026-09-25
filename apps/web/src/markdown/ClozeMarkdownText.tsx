import { useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";

import { CLOZE_SENTINEL_PATTERN } from "@quiz/domain/cloze";
import type { ClozeTextRenderer } from "@quiz/qt-cloze/client";

import { useT } from "../i18n";
import { HOLE_ATTR, renderMarkdown } from "./render";

/**
 * The text of a `cloze` question through the app's OWN markdown pipeline —
 * the `renderText` a `qt-cloze` surface accepts (decision D5).
 *
 * Without it the player and the review fall back to the package's small
 * renderer (paragraphs, tables, fences, bold, italic, code), and a list in
 * the text reached the student as one line of `- a ; - b` (issue #100).
 * With it, a cloze text reads exactly like every other prompt: lists,
 * headings, links, images, maths, the same `.md-body` stylesheet.
 *
 * `render.ts` turns each sentinel into an empty `<span data-cloze-hole>`; the
 * blank the question type draws there is a React element, portalled into
 * it. React never rewrites the sanitised HTML while its string is unchanged,
 * so the portal hosts stay where they are between renders.
 *
 * A blank the markdown gave no text to sit in — inside a link URL, an alt
 * text, a comment — has no hole. It is drawn after the text instead: a
 * student must be able to answer every blank the grader will mark.
 */
export const ClozeMarkdownText: ClozeTextRenderer = ({ template, renderBlank }) => (
  <ClozeMarkdown template={template} renderBlank={renderBlank} />
);

function ClozeMarkdown({
  template,
  renderBlank,
}: {
  template: string;
  renderBlank: (index: number) => ReactNode;
}) {
  const t = useT();
  const codeLabel = t("markdown.codeBlock");
  const html = useMemo(
    () => renderMarkdown(template, codeLabel, { holes: true }),
    [template, codeLabel],
  );
  // A stable object, so React compares the string and never re-parses it.
  const inner = useMemo(() => ({ __html: html }), [html]);
  const root = useRef<HTMLDivElement>(null);
  const [hosts, setHosts] = useState<{
    html: string;
    list: { index: number; element: HTMLElement }[];
  } | null>(null);
  const indices = useMemo(
    () =>
      [...new Set(Array.from(template.matchAll(new RegExp(CLOZE_SENTINEL_PATTERN, "g")), (m) => Number(m[1])))],
    [template],
  );

  useLayoutEffect(() => {
    const found = Array.from(root.current?.querySelectorAll<HTMLElement>(`[${HOLE_ATTR}]`) ?? []);
    setHosts({
      html,
      list: found.map((element) => ({ index: Number(element.getAttribute(HOLE_ATTR)), element })),
    });
  }, [html]);

  // Only once the holes of THIS html are known, so nothing flashes twice.
  const settled = hosts !== null && hosts.html === html;
  const placed = new Set(settled ? hosts.list.map((h) => h.index) : []);
  const orphans = settled ? indices.filter((index) => !placed.has(index)) : [];

  if (!html) return null;
  return (
    <>
      <div
        ref={root}
        className="md-body md-cloze"
        // Sanitised by `renderMarkdown` (see render.ts); the hole elements are
        // written after sanitisation and hold nothing of the document.
        dangerouslySetInnerHTML={inner}
      />
      {settled
        ? hosts.list.map(({ index, element }, i) =>
            createPortal(renderBlank(index), element, `hole-${i}-${index}`),
          )
        : null}
      {orphans.length > 0 ? (
        <p className="mt-3 flex flex-wrap items-center gap-2" data-cloze-orphans="">
          {orphans.map((index) => (
            <span key={index}>{renderBlank(index)}</span>
          ))}
        </p>
      ) : null}
    </>
  );
}
