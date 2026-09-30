import { BookOpen, ChevronRight, EyeOff } from "lucide-react";
import { useEffect, useState, type ReactNode } from "react";

import type { JournalNavNode } from "@quiz/contracts";

import { useT } from "../i18n";
import { navRowClass } from "../navTree";
import { cx, isPlainClick } from "../ui";

/**
 * The navigation of a journal (F-JRN-06): the repository's own tree, one
 * level of indentation per folder, the journal's home above it.
 *
 * The page being read is the ONE accent of the reader — the `accent-soft`
 * chip. Strip the red and it is still the one filled row. Every row that
 * opens a page is a real link (`href` = the reader's address of that page),
 * so a middle click opens it in a tab; a plain click is routed in the app.
 * A folder without a landing page is a heading that folds, never a link to
 * nowhere. A page hidden from students (staff only) carries an eye.
 */
export function JournalNav({
  nodes,
  homePath,
  current,
  hiddenPaths,
  hrefOf,
  onOpen,
}: {
  nodes: JournalNavNode[];
  homePath: string | null;
  /** The page being read. */
  current: string;
  /** The pages the students do not see; empty in the student payload. */
  hiddenPaths: ReadonlySet<string>;
  /** The reader's address of a page. */
  hrefOf: (pagePath: string) => string;
  onOpen: (pagePath: string) => void;
}) {
  const t = useT();
  const link = (pagePath: string, children: ReactNode, className = "") => {
    const active = pagePath === current;
    return (
      <a
        href={hrefOf(pagePath)}
        onClick={(event) => {
          if (!isPlainClick(event)) return;
          event.preventDefault();
          onOpen(pagePath);
        }}
        aria-current={active ? "page" : undefined}
        className={cx(
          navRowClass,
          "min-w-0 flex-1",
          active ? "bg-accent-soft font-medium text-accent" : "text-fg-muted hover:bg-surface-2 hover:text-fg",
          className,
        )}
      >
        {children}
        {hiddenPaths.has(pagePath) ? (
          <EyeOff className="size-3.5 shrink-0 text-fg-faint" aria-label={t("journal.hiddenPage")} role="img" />
        ) : null}
      </a>
    );
  };
  return (
    <div className="space-y-0.5">
      {homePath
        ? link(
            homePath,
            <>
              <BookOpen className="size-3.5 shrink-0" aria-hidden />
              <span className="min-w-0 flex-1 truncate">{t("journal.home")}</span>
            </>,
          )
        : null}
      <NavList nodes={nodes} depth={0} current={current} link={link} />
    </div>
  );
}

type Link = (pagePath: string, children: ReactNode) => ReactNode;

function NavList({
  nodes,
  depth,
  current,
  link,
}: {
  nodes: JournalNavNode[];
  depth: number;
  current: string;
  link: Link;
}) {
  return (
    <ul className={cx("space-y-0.5", depth > 0 && "ml-3 border-l border-line pl-1.5")}>
      {nodes.map((node) => (
        <NavItem key={node.path} node={node} depth={depth} current={current} link={link} />
      ))}
    </ul>
  );
}

function NavItem({
  node,
  depth,
  current,
  link,
}: {
  node: JournalNavNode;
  depth: number;
  current: string;
  link: Link;
}) {
  const t = useT();
  const holdsCurrent = current === node.pagePath || current.startsWith(`${node.path}/`);
  const [open, setOpen] = useState(holdsCurrent);
  // Arriving on a page inside a folded section unfolds it: the chip must show.
  useEffect(() => {
    if (holdsCurrent) setOpen(true);
  }, [holdsCurrent]);
  const title = <span className="min-w-0 flex-1 truncate">{node.title ?? t("journal.untitled")}</span>;
  const folds = node.children.length > 0;

  return (
    <li>
      <div className="flex items-center gap-0.5">
        {node.pagePath !== null ? (
          link(node.pagePath, title)
        ) : (
          // A folder without a landing page: its heading folds it.
          <button
            type="button"
            onClick={() => setOpen((v) => !v)}
            aria-expanded={open}
            className={cx(navRowClass, "min-w-0 flex-1 font-medium text-fg hover:bg-surface-2")}
          >
            {title}
            <ChevronRight className={cx("size-3.5 shrink-0 text-fg-faint transition-transform", open && "rotate-90")} />
          </button>
        )}
        {folds && node.pagePath !== null ? (
          <button
            type="button"
            onClick={() => setOpen((v) => !v)}
            aria-expanded={open}
            aria-label={node.title ?? t("journal.untitled")}
            className="shrink-0 rounded-full p-1 text-fg-faint transition-colors hover:bg-surface-2 hover:text-fg"
          >
            <ChevronRight className={cx("size-3.5 transition-transform", open && "rotate-90")} />
          </button>
        ) : null}
      </div>
      {folds && open ? <NavList nodes={node.children} depth={depth + 1} current={current} link={link} /> : null}
    </li>
  );
}
