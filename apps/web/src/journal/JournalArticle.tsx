import { useEffect, useRef, type MouseEvent } from "react";

import { isJournalPagePath } from "@quiz/contracts";

import { parsePath, routeToPath } from "../router";
import { isPlainClick } from "../ui";

/**
 * The journal page a link of the article leads to, or null when it leads
 * anywhere else (an asset, a handout, another site, an anchor of this page).
 *
 * The stored HTML links pages RELATIVELY (`../20-x/README.md`, docrender's
 * `relativeHref`), so the href is resolved against the reader's address of
 * the page being read — not against `window.location`, which is the bare
 * `/journal` while the home is shown — and read back by the router, whose
 * journal route decodes and checks the path (`safeJournalPath`).
 */
export function journalLinkTarget(
  href: string,
  classroomId: string,
  pagePath: string,
): { path: string; hash: string } | null {
  if (!href || href.startsWith("#")) return null;
  const origin = window.location.origin;
  const base = new URL(routeToPath({ view: "classroomJournal", id: classroomId, path: pagePath }), origin);
  let url: URL;
  try {
    url = new URL(href, base);
  } catch {
    return null;
  }
  if (url.origin !== origin) return null;
  const route = parsePath(url.pathname);
  if (route.view !== "classroomJournal" || route.id !== classroomId) return null;
  if (!route.path || !isJournalPagePath(route.path)) return null;
  return { path: route.path, hash: url.hash };
}

/**
 * A rendered journal page (F-JRN-09) in the long-form modifier
 * (`.md-body.md-doc`, DESIGN.md › Long-form reading).
 *
 * The HTML is the server's rendering (`packages/docrender`), safe by
 * construction — raw HTML was escaped at ingestion (D15) — so there is no
 * sanitiser and no markdown library here: a student downloads a page, not a
 * parser. The one behaviour added is routing: a plain click on a link to
 * another page of the journal opens it in the app; everything else (an
 * external link in its new tab, an asset, an anchor, a modified click) is
 * the browser's.
 */
export function JournalArticle({
  html,
  classroomId,
  pagePath,
  onOpen,
  keepScroll = false,
}: {
  html: string;
  classroomId: string;
  pagePath: string;
  onOpen: (pagePath: string, hash: string) => void;
  /** A preview inside the editor: a new rendering does not move the window. */
  keepScroll?: boolean;
}) {
  const ref = useRef<HTMLDivElement>(null);

  const onClick = (event: MouseEvent<HTMLDivElement>) => {
    if (!isPlainClick(event)) return;
    const anchor = (event.target as Element).closest("a");
    if (!anchor || anchor.target) return;
    const target = journalLinkTarget(anchor.getAttribute("href") ?? "", classroomId, pagePath);
    if (!target) return;
    event.preventDefault();
    onOpen(target.path, target.hash);
  };

  // A new page starts at its top, or at the anchor its address names — which
  // did not exist yet when the address was set.
  useEffect(() => {
    if (keepScroll) return;
    const id = decodeURIComponent(window.location.hash.slice(1));
    const heading = id ? ref.current?.querySelector(`#${CSS.escape(id)}`) : null;
    if (heading) heading.scrollIntoView({ block: "start" });
    else window.scrollTo({ top: 0 });
  }, [html, keepScroll]);

  return (
    // The click handler only ROUTES links the browser would follow anyway;
    // the keyboard reaches them as links and Enter fires this same click.
    <div
      ref={ref}
      className="md-body md-doc"
      onClick={onClick}
      dangerouslySetInnerHTML={{ __html: html }}
    />
  );
}
