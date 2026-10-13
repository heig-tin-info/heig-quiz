import type { CriteriaTableRow, ProjectGradingRepo, ProjectGradingScale } from "@quiz/contracts";
import { describe, gradeBand, gradeFromPoints, histogram, projectGrade, type Description, type GradeBand, type HistogramBucket } from "@quiz/domain";

/**
 * The pure rules of the Grading tab's matrix (ADR-106 §8 as amended
 * 2026-10-13): the criteria of the snapshot as a tree of its sections
 * (§2) — folded, a section is one column holding its sum —, the columns a
 * fold state leaves on screen, the header rows that draw them, a cell's
 * value and tone, and the statistics over the VALIDATED repositories.
 *
 * The tree comes from each row's `section` (the snapshot's dotted path),
 * never from cutting a criterion's id. Penalties (a negative maximum) and
 * bonuses are never summed into a section: they stand apart, in columns of
 * their own after the tree (`extras`), and their statistics are counts.
 */

/** What a criterion is to the sums: a normal one, a penalty (max < 0), or a bonus (`bonus` set). */
export type CriterionRole = "normal" | "penalty" | "bonus";

export interface MatrixLeaf {
  kind: "leaf";
  id: string;
  /** The last segment of its id, under its section (`modules` of `code.structure.modules`). */
  label: string;
  description: string;
  /** Its maximum; a bonus's are its `bonus` points. */
  max: number;
  role: CriterionRole;
}

export interface MatrixGroup {
  kind: "group";
  /** The section's dotted path (`code.structure`): the fold state's key. */
  key: string;
  /** Its last segment (`structure`). */
  label: string;
  /** The sum of the positive maxima of its normal leaves. */
  max: number;
  /** Its normal leaves, every level down. */
  leafIds: string[];
  children: MatrixNode[];
}

export type MatrixNode = MatrixLeaf | MatrixGroup;

export interface CriteriaTree {
  /** The normal criteria, by section, in the snapshot's order. */
  nodes: MatrixNode[];
  /** The penalties and bonuses, in the snapshot's order, never folded. */
  extras: MatrixLeaf[];
}

export const roleOf = (row: Pick<CriteriaTableRow, "max" | "bonus">): CriterionRole =>
  row.bonus !== undefined ? "bonus" : row.max < 0 ? "penalty" : "normal";

const leafOf = (row: CriteriaTableRow): MatrixLeaf => {
  const role = roleOf(row);
  return {
    kind: "leaf",
    id: row.criterionId,
    label: row.section && row.criterionId.startsWith(`${row.section}.`) ? row.criterionId.slice(row.section.length + 1) : row.criterionId,
    description: row.description,
    max: role === "bonus" ? (row.bonus ?? 0) : row.max,
    role,
  };
};

/** A section with one child is that child, its label prefixed with the section's (`rendu.tests`): nothing to fold. */
const collapse = (node: MatrixNode): MatrixNode => {
  if (node.kind === "leaf") return node;
  const children = node.children.map(collapse);
  if (children.length !== 1) return { ...node, children };
  const only = children[0]!;
  return { ...only, label: `${node.label}.${only.label}` };
};

const leavesOf = (node: MatrixNode): MatrixLeaf[] => (node.kind === "leaf" ? [node] : node.children.flatMap(leavesOf));

/**
 * The criteria of a repository's table (every repository's is the same
 * snapshot, in its order) as the tree of their sections. A leaf at the root
 * is a column of its own; a section with one child is drawn as that child.
 */
export function criteriaTree(table: readonly CriteriaTableRow[]): CriteriaTree {
  const root: MatrixGroup = { kind: "group", key: "", label: "", max: 0, leafIds: [], children: [] };
  const groups = new Map<string, MatrixGroup>([["", root]]);
  const groupAt = (key: string): MatrixGroup => {
    const held = groups.get(key);
    if (held) return held;
    const cut = key.lastIndexOf(".");
    const parent = groupAt(cut < 0 ? "" : key.slice(0, cut));
    const group: MatrixGroup = { kind: "group", key, label: key.slice(cut + 1), max: 0, leafIds: [], children: [] };
    parent.children.push(group);
    groups.set(key, group);
    return group;
  };
  const extras: MatrixLeaf[] = [];
  for (const row of table) {
    const leaf = leafOf(row);
    // Out of its section, a penalty or a bonus is named in full.
    if (leaf.role !== "normal") extras.push({ ...leaf, label: leaf.id });
    else groupAt(row.section).children.push(leaf);
  }
  const finish = (node: MatrixNode): MatrixNode => {
    if (node.kind === "leaf") return node;
    const children = node.children.map(finish);
    const leaves = children.flatMap(leavesOf);
    return { ...node, children, leafIds: leaves.map((l) => l.id), max: leaves.reduce((s, l) => s + Math.max(0, l.max), 0) };
  };
  // A section holding penalties or bonuses only is left with no child: it draws nothing.
  const prune = (node: MatrixNode): MatrixNode[] =>
    node.kind === "leaf" ? [node] : node.leafIds.length === 0 ? [] : [{ ...node, children: node.children.flatMap(prune) }];
  const nodes = (finish(root) as MatrixGroup).children.flatMap(prune).map(collapse);
  return { nodes, extras };
}

/** A column on screen: a leaf, or a folded section; `chain` the unfolded sections above it, outermost first. */
export type MatrixColumn = (MatrixLeaf | (MatrixGroup & { open: false })) & { chain: MatrixGroup[] };

/** The columns a fold state leaves on screen: every section folded unless `open` names it. Extras last. */
export function visibleColumns(tree: CriteriaTree, open: ReadonlySet<string>): MatrixColumn[] {
  const walk = (node: MatrixNode, chain: MatrixGroup[]): MatrixColumn[] => {
    if (node.kind === "leaf") return [{ ...node, chain }];
    if (!open.has(node.key)) return [{ ...node, open: false, chain }];
    return node.children.flatMap((child) => walk(child, [...chain, node]));
  };
  return [...tree.nodes.flatMap((n) => walk(n, [])), ...tree.extras.map((leaf) => ({ ...leaf, chain: [] }))];
}

export type HeaderCell =
  /** An unfolded section over its columns: the button that folds it back. */
  | { kind: "open"; group: MatrixGroup; colSpan: number }
  /** A column's own head, down to the last header row. */
  | { kind: "column"; column: MatrixColumn; rowSpan: number };

/**
 * The header rows of `columns`: as many as the deepest chain of unfolded
 * sections, plus one. An unfolded section spans its columns on the row of
 * its depth; a column's own head starts under its chain and reaches down to
 * the last row.
 */
export function headerRows(columns: readonly MatrixColumn[]): HeaderCell[][] {
  const height = Math.max(0, ...columns.map((c) => c.chain.length)) + 1;
  const rows: HeaderCell[][] = Array.from({ length: height }, () => []);
  columns.forEach((column, index) => {
    column.chain.forEach((group, depth) => {
      const before = columns[index - 1]?.chain[depth];
      const row = rows[depth]!;
      const last = row.at(-1);
      if (before === group && last?.kind === "open" && last.group === group) last.colSpan += 1;
      else row.push({ kind: "open", group, colSpan: 1 });
    });
    rows[column.chain.length]!.push({ kind: "column", column, rowSpan: height - column.chain.length });
  });
  return rows;
}

export type CellState = CriteriaTableRow["state"];

export interface CellValue {
  /** The points, or a section's sum of the points given; null when none was. */
  points: number | null;
  max: number;
  /** A section's: validated when all are, empty when none has a row, proposed otherwise. */
  state: CellState;
  role: CriterionRole;
}

/** A repository's rows by criterion. */
export const rowsById = (repo: Pick<ProjectGradingRepo, "table">): Map<string, CriteriaTableRow> =>
  new Map(repo.table.map((row) => [row.criterionId, row]));

/** What a repository holds under `column`. */
export function cellValue(column: MatrixColumn, rows: ReadonlyMap<string, CriteriaTableRow>): CellValue {
  if (column.kind === "leaf") {
    const row = rows.get(column.id);
    return { points: row?.points ?? null, max: column.max, state: row?.state ?? "empty", role: column.role };
  }
  const lines = column.leafIds.map((id) => rows.get(id));
  const given = lines.filter((l): l is CriteriaTableRow => l !== undefined && l.points !== null);
  const state: CellState =
    given.length === 0 ? "empty" : lines.every((l) => l?.state === "validated") ? "validated" : "proposed";
  return { points: given.length === 0 ? null : given.reduce((s, l) => s + l.points!, 0), max: column.max, state, role: "normal" };
}

/**
 * The heat of a cell: a normal criterion's or a section's share of its
 * maximum, read as the grade band it would be (`gradeBand`, the Histogram's
 * tones); a penalty applied is a fail; a bonus, an empty cell or a
 * maximum of 0 has none.
 */
export function cellHeat(cell: CellValue): GradeBand | null {
  if (cell.points === null) return null;
  if (cell.role === "bonus") return null;
  if (cell.role === "penalty") return cell.points < 0 ? "fail" : null;
  if (!(cell.max > 0)) return null;
  return gradeBand(gradeFromPoints(cell.points, cell.max, {}));
}

/** The repositories the statistics count: validated (every criterion), with their total. */
export const validatedRepos = (repos: readonly ProjectGradingRepo[]): ProjectGradingRepo[] =>
  repos.filter((r) => r.validation.validated && r.total !== null);

/** A validated repository's mark, by the project's scale, from its (clamped) total; null without one. */
export const repoMark = (repo: Pick<ProjectGradingRepo, "total">, scale: ProjectGradingScale): number | null =>
  repo.total === null ? null : projectGrade(repo.total.points, repo.total.max, scale).grade;

export interface MarkStats {
  description: Description;
  histogram: HistogramBucket[];
  /** At or above the pass mark. */
  passing: number;
}

/** The marks of the validated repositories: their description and their histogram. */
export function markStats(repos: readonly ProjectGradingRepo[], scale: ProjectGradingScale): MarkStats {
  const marks = validatedRepos(repos).map((r) => repoMark(r, scale)!);
  return { description: describe(marks), histogram: histogram(marks), passing: marks.filter((m) => gradeBand(m) !== "fail").length };
}

export interface CriterionStat {
  column: MatrixColumn;
  /** The mean share of its maximum over the validated repositories, 0 … 1. */
  ratio: number;
}

export interface ExtraStat {
  column: MatrixColumn;
  /** The validated repositories where the penalty applied, or the bonus was given. */
  count: number;
}

export interface CriteriaStats {
  /** The normal columns (leaves and folded sections), the worst first. */
  criteria: CriterionStat[];
  penalties: ExtraStat[];
  bonuses: ExtraStat[];
}

/** Per column of the same fold, over the validated repositories: the mean share, and the extras' counts. */
export function criteriaStats(columns: readonly MatrixColumn[], repos: readonly ProjectGradingRepo[]): CriteriaStats {
  const tables = validatedRepos(repos).map(rowsById);
  const cells = (column: MatrixColumn) => tables.map((rows) => cellValue(column, rows));
  const criteria: CriterionStat[] = [];
  const penalties: ExtraStat[] = [];
  const bonuses: ExtraStat[] = [];
  for (const column of columns) {
    const values = cells(column);
    const role = column.kind === "leaf" ? column.role : "normal";
    if (role === "penalty") penalties.push({ column, count: values.filter((v) => (v.points ?? 0) < 0).length });
    else if (role === "bonus") bonuses.push({ column, count: values.filter((v) => (v.points ?? 0) > 0).length });
    else if (column.max > 0 && values.length > 0) {
      const ratio = values.reduce((s, v) => s + (v.points ?? 0) / column.max, 0) / values.length;
      criteria.push({ column, ratio });
    }
  }
  criteria.sort((a, b) => a.ratio - b.ratio);
  return { criteria, penalties, bonuses };
}
