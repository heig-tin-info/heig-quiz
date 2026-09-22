import { Copy, Pencil, Trash2 } from "lucide-react";
import type { DragEvent } from "react";

import type { QuestionRow } from "@quiz/contracts";

import { useT } from "../i18n";
import { Badge, Card, Checkbox, cx, IconButton, pressable, RelativeTime, Skeleton } from "../ui";
import { DifficultyDots, TypeGlyph, VersionCell } from "./QuestionTable";
import type { QuestionGroup } from "./QuestionGroups";

/**
 * The same questions as cards.
 *
 * A table answers "which of these is the oldest, and how hard is it" in one
 * scan; a card answers "what is this question" — the name gets a line of its
 * own instead of a column that must not wrap, and the tags sit under it
 * rather than inside a 224 px cell. A teacher browsing a pool they did not
 * write reads cards; one triaging their own reads the table. Which one is a
 * habit, so the choice is remembered (`PoolView`), not a state of the data.
 *
 * Everything on it comes from the row the table shows, in the same order the
 * row reads left to right: the type glyph and the name, the difficulty dots,
 * the tags, the version, the last change. The three actions are the row's
 * three actions, on a hairline of their own at the bottom edge — always
 * drawn, not revealed on hover: a card is also what a touch screen shows,
 * and an action that needs a pointer to exist does not exist there.
 */

function QuestionCard({
  row,
  checked,
  onToggleCheck,
  onEdit,
  onDuplicate,
  onDelete,
  onDragStart,
  readOnly,
}: {
  row: QuestionRow;
  checked: boolean;
  onToggleCheck: () => void;
  onEdit: () => void;
  onDuplicate: () => void;
  onDelete: () => void;
  onDragStart?: (event: DragEvent) => void;
  readOnly: boolean;
}) {
  const t = useT();
  return (
    <Card
      onClick={onEdit}
      {...pressable(onEdit)}
      draggable={onDragStart !== undefined}
      onDragStart={onDragStart}
      className={cx(
        "group flex min-w-0 cursor-pointer flex-col gap-3 p-4 transition-colors hover:bg-surface-2/70",
        checked && "border-accent",
      )}
    >
      <div className="flex min-w-0 items-start gap-2">
        <TypeGlyph type={row.type} />
        <span className="min-w-0 flex-1 break-words font-mono text-[13px] font-bold">
          {row.internalName}
        </span>
        {row.deletedAt ? <Badge tone="zinc">{t("pool.deleted")}</Badge> : null}
        {readOnly ? null : (
          <span onClick={(e) => e.stopPropagation()}>
            <Checkbox
              label={<span className="sr-only">{t("pool.select", { name: row.internalName })}</span>}
              checked={checked}
              onChange={onToggleCheck}
            />
          </span>
        )}
      </div>

      {row.tags.length === 0 ? null : (
        <div className="flex flex-wrap gap-1">
          {row.tags.map((tag) => (
            <span key={tag} className="text-xs text-fg-muted">
              #{tag}
            </span>
          ))}
        </div>
      )}

      <div className="mt-auto flex flex-wrap items-center gap-x-3 gap-y-1.5 text-xs text-fg-muted">
        <DifficultyDots value={row.difficulty} />
        <VersionCell row={row} />
        {/* The wrapper carries the push, not the `<time>`: `RelativeTime`
            hands its className to the element INSIDE the tooltip span, and
            the span is what this flex row lays out. */}
        <span className="ml-auto">
          <RelativeTime iso={row.updatedAt} />
        </span>
      </div>

      {readOnly ? null : (
        <div
          className="-mb-1 flex justify-end gap-0.5 border-t border-line pt-2"
          onClick={(e) => e.stopPropagation()}
        >
          <IconButton size="sm" label={t("pool.editRow", { name: row.internalName })} onClick={onEdit}>
            <Pencil />
          </IconButton>
          <IconButton
            size="sm"
            label={t("pool.duplicateRow", { name: row.internalName })}
            onClick={onDuplicate}
          >
            <Copy />
          </IconButton>
          <IconButton
            size="sm"
            danger
            label={t("pool.deleteRow", { name: row.internalName })}
            onClick={onDelete}
          >
            <Trash2 />
          </IconButton>
        </div>
      )}
    </Card>
  );
}

export function QuestionCardsSkeleton({ cards = 6 }: { cards?: number }) {
  return (
    <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
      {Array.from({ length: cards }, (_, i) => (
        <Skeleton key={i} className="h-36 w-full" />
      ))}
    </div>
  );
}

export function QuestionCards({
  groups,
  checked,
  onToggleCheck,
  onEdit,
  onDuplicate,
  onDelete,
  onDragStart,
  readOnly = false,
}: {
  groups: QuestionGroup[];
  checked: ReadonlySet<string>;
  onToggleCheck: (id: string) => void;
  onEdit: (row: QuestionRow) => void;
  onDuplicate: (row: QuestionRow) => void;
  onDelete: (row: QuestionRow) => void;
  /** Dragging a card onto a sidebar pool moves the question there (ADR-017). */
  onDragStart?: (event: DragEvent, row: QuestionRow) => void;
  readOnly?: boolean;
}) {
  return (
    <div className="space-y-6">
      {groups.map((group) => (
        <section key={group.key} className="space-y-2.5">
          {group.label === null ? null : (
            <h2 className="flex items-baseline gap-2 text-xs font-medium uppercase tracking-wide text-fg-muted">
              {group.label}
              <span className="tabular-nums text-fg-faint">{group.rows.length}</span>
            </h2>
          )}
          <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
            {group.rows.map((row) => (
              <QuestionCard
                key={`${group.key}:${row.id}`}
                row={row}
                checked={checked.has(row.id)}
                onToggleCheck={() => onToggleCheck(row.id)}
                onEdit={() => onEdit(row)}
                onDuplicate={() => onDuplicate(row)}
                onDelete={() => onDelete(row)}
                onDragStart={onDragStart ? (event) => onDragStart(event, row) : undefined}
                readOnly={readOnly}
              />
            ))}
          </div>
        </section>
      ))}
    </div>
  );
}
