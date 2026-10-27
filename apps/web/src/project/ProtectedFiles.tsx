import { AlertTriangle, ChevronRight } from "lucide-react";
import { useState } from "react";

import type { ProjectSourceDetail } from "@quiz/contracts";
import { GRADING_WORKFLOW, isProtected, pathWithin, PROTECTED_DIRECTORIES, type TreeEntry } from "@quiz/domain";

import { useT } from "../i18n";
import { Alert, Badge, Checkbox, cx } from "../ui";

/** A row of the picker: an entry of the tree, its depth and whether it holds others. */
interface Row extends TreeEntry {
  depth: number;
  name: string;
}

const parentOf = (path: string): string | null => (path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : null);

/**
 * The rows the picker draws: the handed-out tree, and any protected path it
 * does not hold (a path the source lost, a forced entry), as a file at its
 * place. Directories first at each level, then files, by name.
 */
export function pickerRows(tree: readonly TreeEntry[], listed: readonly string[]): Row[] {
  const byPath = new Map<string, TreeEntry["type"]>();
  // Each path with its directories, which a truncated tree or a listed path may lack.
  const add = (path: string, type: TreeEntry["type"]) => {
    if (!byPath.has(path)) byPath.set(path, type);
    for (let p = parentOf(path); p !== null && !byPath.has(p); p = parentOf(p)) byPath.set(p, "tree");
  };
  for (const e of tree) add(e.path, e.type);
  for (const path of listed) add(path, PROTECTED_DIRECTORIES.includes(path) ? "tree" : "blob");
  const children = new Map<string | null, string[]>();
  for (const path of byPath.keys()) {
    const parent = parentOf(path);
    children.set(parent, [...(children.get(parent) ?? []), path]);
  }
  const rows: Row[] = [];
  const walk = (parent: string | null, depth: number) => {
    const kids = (children.get(parent) ?? []).sort((a, b) => {
      const dirs = Number(byPath.get(b) === "tree") - Number(byPath.get(a) === "tree");
      return dirs !== 0 ? dirs : a.localeCompare(b);
    });
    for (const path of kids) {
      rows.push({ path, type: byPath.get(path)!, depth, name: path.slice(parent === null ? 0 : parent.length + 1) });
      walk(path, depth + 1);
    }
  };
  walk(null, 0);
  return rows;
}

/**
 * A project's protected files (F-PROJ-01, F-PROJ-08, ADR-119 §9), picked
 * from the tree the students receive: a checkbox per file and per
 * directory, a ticked directory protecting its content (its entries drawn
 * ticked and held). The entries a grading mode forces (`forced`, the
 * `criteria` mode's workflows and criteria) are ticked and held. A
 * directory opens on demand; those holding a protected path start open.
 * Leaving `grading.yml` unprotected warns that the students could then
 * alter the grading. The new project's form draws it, and a project's
 * settings (M3-12).
 */
export function ProtectedFiles({
  tree,
  truncated = false,
  value,
  forced = [],
  onChange,
}: {
  /** The handed-out tree (`ProjectSourceDetail.tree`); empty while it cannot be read: the list alone is drawn. */
  tree: ProjectSourceDetail["tree"];
  truncated?: boolean;
  value: readonly string[];
  forced?: readonly string[];
  onChange: (files: string[]) => void;
}) {
  const t = useT();
  const listed = [...value, ...forced.filter((p) => !value.includes(p))];
  const rows = pickerRows(tree, listed);
  const [open, setOpen] = useState<ReadonlySet<string>>(
    () => new Set(rows.filter((r) => r.type === "tree" && listed.some((p) => p !== r.path && pathWithin(p, r.path))).map((r) => r.path)),
  );
  const shown = rows.filter((r) => {
    for (let p = parentOf(r.path); p !== null; p = parentOf(p)) if (!open.has(p)) return false;
    return true;
  });

  /** On: the path listed, the entries under it dropped (it covers them). Off: the path alone. */
  const toggle = (path: string, on: boolean) =>
    onChange(on ? [...value.filter((p) => !pathWithin(p, path)), path] : value.filter((p) => p !== path));
  const flip = (path: string) =>
    setOpen((prev) => {
      const next = new Set(prev);
      if (!next.delete(path)) next.add(path);
      return next;
    });
  const workflowExposed = rows.some((r) => r.path === GRADING_WORKFLOW) && !isProtected(GRADING_WORKFLOW, listed);

  return (
    <div className="space-y-2">
      <ul
        className="max-h-80 overflow-y-auto rounded-lg border border-line bg-surface py-1"
        aria-label={t("project.protected")}
        data-testid="protected-tree"
      >
        {shown.map((row) => {
          const isForced = forced.includes(row.path);
          // Ticked by a directory above it: held, the directory decides.
          const covered = listed.some((p) => p !== row.path && pathWithin(row.path, p));
          const dir = row.type === "tree";
          return (
            <li key={row.path} className="flex min-h-8 items-center gap-1 pr-3" style={{ paddingLeft: `${0.5 + row.depth * 1.25}rem` }}>
              {dir ? (
                <button
                  type="button"
                  className="inline-flex size-6 shrink-0 items-center justify-center rounded text-fg-muted hover:bg-surface-2 hover:text-fg"
                  aria-expanded={open.has(row.path)}
                  aria-label={t(open.has(row.path) ? "project.protected.collapse" : "project.protected.expand", { path: row.path })}
                  onClick={() => flip(row.path)}
                >
                  <ChevronRight className={cx("size-3.5 transition-transform", open.has(row.path) && "rotate-90")} />
                </button>
              ) : (
                <span className="size-6 shrink-0" aria-hidden />
              )}
              <Checkbox
                className="min-w-0"
                label={
                  <span className="truncate font-mono text-[13px]" title={row.path}>
                    {row.name}
                    {dir ? "/" : ""}
                  </span>
                }
                aria-label={row.path}
                checked={isForced || covered || listed.includes(row.path)}
                disabled={isForced || covered}
                onChange={(e) => toggle(row.path, e.target.checked)}
              />
              {isForced ? (
                <Badge tone="zinc" className="ml-auto shrink-0">
                  {t("project.protected.forced")}
                </Badge>
              ) : null}
            </li>
          );
        })}
      </ul>
      <p className="text-[13px] text-fg-muted">{t("project.protected.directory")}</p>
      {truncated ? <p className="text-[13px] text-fg-muted">{t("project.protected.truncated")}</p> : null}
      {forced.length > 0 ? <p className="text-[13px] text-fg-muted">{t("project.protected.forced.hint")}</p> : null}
      {workflowExposed ? <Alert tone="warning" icon={AlertTriangle} title={t("project.protected.gradingWarning")} /> : null}
    </div>
  );
}
