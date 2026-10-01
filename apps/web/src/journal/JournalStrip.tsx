import { BookOpen, ChevronDown, EyeOff } from "lucide-react";
import { useEffect, useRef, type ReactNode } from "react";

import type { JournalNavNode } from "@quiz/contracts";

import { useT } from "../i18n";
import { cx, isPlainClick, ItemMark, Menu, revealInStrip, useScrollFade, type MenuItem } from "../ui";

/**
 * The navigation of a journal (F-JRN-06), as a strip of page links above the
 * page: the journal's home, then the repository's top level, one entry per
 * page or folder. A folder is a menu of its pages, deeper levels indented —
 * the label a link to its landing page and a chevron opening the menu when it
 * has one, the whole entry the menu when it has none (a folder without a
 * landing page never navigates).
 *
 * Links, not tabs: a `<nav>` of real `href`s with `aria-current="page"`, so a
 * middle click opens a page in a tab and a plain click is routed in the app
 * (through `navigate`, and so through the editor's leave guard).
 *
 * Subordinate to the classroom's tabs above it (their 2 px ink underline):
 * 13 px, no underline; the entry being read — the page, or the folder that
 * holds it — is the ONE accent of the reader, the `accent-soft` chip. Too
 * many entries for the width scroll sideways under a fade, and the current
 * one is scrolled into sight. A page hidden from students (staff payload
 * only) carries an eye, on its own entry, never summed up on a folder.
 */
export function JournalStrip({
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
  const strip = useRef<HTMLUListElement>(null);
  const fade = useScrollFade(strip, `${homePath}|${nodes.map((n) => `${n.path}\u0000${n.title}`).join("|")}`);
  useEffect(() => {
    const box = strip.current;
    const chip = box?.querySelector<HTMLElement>("[data-current]");
    if (box && chip) revealInStrip(box, chip);
  }, [current, nodes]);

  const titleOf = (node: JournalNavNode) => node.title ?? t("journal.untitled");
  const eye = (pagePath: string | null) =>
    pagePath !== null && hiddenPaths.has(pagePath) ? { icon: EyeOff, label: t("journal.hiddenPage") } : undefined;

  /** A link of the strip; a folder's label (`folder`) carries no eye: its pages do, in its menu. */
  const link = (
    pagePath: string,
    label: string,
    selected: boolean,
    { icon = null, folder = false }: { icon?: ReactNode; folder?: boolean } = {},
  ) => (
    <a
      href={hrefOf(pagePath)}
      title={label}
      onClick={(event) => {
        if (!isPlainClick(event)) return;
        event.preventDefault();
        onOpen(pagePath);
      }}
      aria-current={pagePath === current ? "page" : undefined}
      className={cx(entry(selected), folder && "pr-1")}
    >
      {icon}
      <span className={LABEL}>{label}</span>
      {folder ? null : <ItemMark mark={eye(pagePath)} className="opacity-70" />}
    </a>
  );

  const pageItem = (pagePath: string, label: string, depth: number): MenuItem => ({
    label,
    href: hrefOf(pagePath),
    onSelect: () => onOpen(pagePath),
    depth,
    current: pagePath === current,
    mark: eye(pagePath),
  });
  /** A node and what it holds, depth first, as menu items; a folder without a landing page is a heading. */
  const itemsOf = (node: JournalNavNode, depth: number): MenuItem[] => [
    node.pagePath !== null
      ? pageItem(node.pagePath, titleOf(node), depth)
      : { label: titleOf(node), heading: true, depth },
    ...node.children.flatMap((child) => itemsOf(child, depth + 1)),
  ];
  /** A folder's menu: its landing page first, else straight its pages (the entry already names it). */
  const menuOf = (node: JournalNavNode) =>
    node.pagePath !== null ? itemsOf(node, 0) : node.children.flatMap((child) => itemsOf(child, 0));

  return (
    <nav aria-label={t("journal.nav")}>
      <ul ref={strip} className="flex gap-1 overflow-x-auto overflow-y-hidden p-0.5" style={fade}>
        {homePath !== null ? (
          <Entry selected={current === homePath}>
            {link(homePath, t("journal.home"), current === homePath, {
              icon: <BookOpen className="size-3.5 shrink-0" aria-hidden />,
            })}
          </Entry>
        ) : null}
        {nodes.map((node) => {
          const selected = current === node.pagePath || current.startsWith(`${node.path}/`);
          const title = titleOf(node);
          if (node.children.length === 0) {
            return node.pagePath !== null ? (
              <Entry key={node.path} selected={selected}>
                {link(node.pagePath, title, selected)}
              </Entry>
            ) : null;
          }
          const menuLabel = t("journal.folderPages", { name: title });
          return (
            <Entry key={node.path} selected={selected}>
              {node.pagePath !== null ? link(node.pagePath, title, selected, { folder: true }) : null}
              <Menu
                align="start"
                label={menuLabel}
                items={menuOf(node)}
                trigger={
                  <button
                    type="button"
                    title={title}
                    aria-label={node.pagePath !== null ? menuLabel : undefined}
                    aria-current={selected && current !== node.pagePath ? "true" : undefined}
                    className={cx(entry(selected), node.pagePath !== null && "px-1")}
                  >
                    {node.pagePath === null ? <span className={LABEL}>{title}</span> : null}
                    <ChevronDown className="size-3.5 shrink-0 opacity-70" aria-hidden />
                  </button>
                }
              />
            </Entry>
          );
        })}
      </ul>
    </nav>
  );
}

/** One control of the strip, 28 px tall at 13 px; inside the chip it takes the chip's colours. */
const entry = (selected: boolean) =>
  cx(
    "inline-flex h-7 items-center gap-1.5 rounded-field px-2.5 text-[13px] whitespace-nowrap transition-colors",
    !selected && "text-fg-muted hover:bg-surface-2 hover:text-fg",
  );
/** A long title is cut, never wrapped: the full one is in the entry's `title`. */
const LABEL = "max-w-[12rem] truncate";

/** An entry of the strip: the chip when it holds the page being read. */
function Entry({ selected, children }: { selected: boolean; children: ReactNode }) {
  return (
    <li
      data-current={selected || undefined}
      className={cx("flex shrink-0 items-center rounded-field", selected && "bg-accent-soft font-medium text-accent")}
    >
      {children}
    </li>
  );
}
