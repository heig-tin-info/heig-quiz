import type { MouseEvent, ReactNode } from "react";

/**
 * Minimal Markdown renderer for the help panels and the assistant's answers
 * (ADR-080): headings, paragraphs, bullet and numbered lists, bold, inline
 * code and links. Small and dependency-free (the same reasoning as the
 * hand-rolled timeline). Rendered to React elements, never raw HTML; a link
 * gets an `href` only when its policy admits it, because a model's answer is
 * not content we author and a `javascript:` URL must stay text.
 *
 * - `web` (the help we write): any http(s) link, opened in a new tab.
 * - `same-origin` (the assistant's answers, ADR-080 P2 amendment, item 8):
 *   only a link to this app's own origin is clickable; anything else stays
 *   text. A model that read text someone else wrote (a question, a title)
 *   could be steered into a link that carries what it read off to another
 *   site: that link is never one click away.
 */
export type LinkPolicy = "web" | "same-origin";

/** Where a Markdown link may lead under `policy`, or null when it must stay text. */
export function linkTarget(href: string, policy: LinkPolicy): { href: string; external: boolean } | null {
  if (policy === "web") return /^https?:\/\//i.test(href) ? { href, external: true } : null;
  const origin = window.location.origin;
  let url: URL;
  try {
    url = new URL(href, origin);
  } catch {
    return null;
  }
  if (!/^https?:$/.test(url.protocol) || url.origin !== origin) return null;
  return { href: `${url.pathname}${url.search}${url.hash}`, external: false };
}

/** How the links of a text behave: which ones may be links, and how an in-app one moves the app. */
interface LinkOptions {
  policy: LinkPolicy;
  /** Moves the app to an in-app path without a reload; absent, the browser follows the link. */
  onNavigate?: ((path: string) => void) | undefined;
}

/**
 * An in-app link's click, through the app's router: a plain left click only.
 * A modified or middle click (a new tab, a new window) keeps the browser's own.
 */
function inAppClick(href: string, onNavigate: (path: string) => void) {
  return (e: MouseEvent<HTMLAnchorElement>) => {
    if (e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
    e.preventDefault();
    onNavigate(href);
  };
}

function inline(text: string, keyBase: string, { policy, onNavigate }: LinkOptions): ReactNode[] {
  const nodes: ReactNode[] = [];
  const re = /(\*\*([^*]+)\*\*)|(`([^`]+)`)|(\[([^\]]+)\]\(([^)]+)\))/g;
  let last = 0;
  let m: RegExpExecArray | null;
  let i = 0;
  while ((m = re.exec(text)) !== null) {
    if (m.index > last) nodes.push(text.slice(last, m.index));
    const target = m[6] !== undefined ? linkTarget(m[7]!.trim(), policy) : null;
    if (m[2] !== undefined) {
      nodes.push(<strong key={`${keyBase}-${i}`}>{m[2]}</strong>);
    } else if (m[4] !== undefined) {
      nodes.push(
        <code
          key={`${keyBase}-${i}`}
          className="rounded bg-surface-3 px-1 py-0.5 font-mono text-[0.85em]"
        >
          {m[4]}
        </code>,
      );
    } else if (m[6] !== undefined && target === null) {
      nodes.push(m[6]);
    } else if (m[6] !== undefined && target !== null) {
      nodes.push(
        <a
          key={`${keyBase}-${i}`}
          href={target.href}
          {...(target.external
            ? { target: "_blank", rel: "noreferrer" }
            : onNavigate
              ? { onClick: inAppClick(target.href, onNavigate) }
              : {})}
          className="text-accent hover:underline"
        >
          {m[6]}
        </a>,
      );
    }
    last = m.index + m[0].length;
    i += 1;
  }
  if (last < text.length) nodes.push(text.slice(last));
  return nodes;
}

export function Markdown({
  source,
  links = "web",
  onNavigate,
}: {
  source: string;
  links?: LinkPolicy;
  /** For `same-origin` links: how a click moves the app (its router), instead of a reload. */
  onNavigate?: (path: string) => void;
}) {
  const blocks = source.trim().split(/\n{2,}/);
  const opts: LinkOptions = { policy: links, onNavigate };
  return (
    <>
      {blocks.map((block, bi) => {
        const trimmed = block.trim();
        if (trimmed.startsWith("## ")) {
          return (
            <h3 key={bi} className="text-sm font-semibold text-fg">
              {inline(trimmed.slice(3), `h${bi}`, opts)}
            </h3>
          );
        }
        if (trimmed.startsWith("# ")) {
          // The drawer already shows the title; skip a leading h1.
          return null;
        }
        if (/^[-*] /.test(trimmed)) {
          const items = trimmed.split("\n").map((l) => l.replace(/^[-*] /, ""));
          return (
            <ul key={bi} className="list-disc space-y-1 pl-5">
              {items.map((it, ii) => (
                <li key={ii}>{inline(it, `l${bi}-${ii}`, opts)}</li>
              ))}
            </ul>
          );
        }
        if (/^\d+[.)] /.test(trimmed)) {
          const items = trimmed.split("\n").map((l) => l.replace(/^\d+[.)] /, ""));
          return (
            <ol key={bi} className="list-decimal space-y-1 pl-5">
              {items.map((it, ii) => (
                <li key={ii}>{inline(it, `o${bi}-${ii}`, opts)}</li>
              ))}
            </ol>
          );
        }
        return <p key={bi}>{inline(trimmed.replace(/\n/g, " "), `p${bi}`, opts)}</p>;
      })}
    </>
  );
}
