/**
 * The `categorize` player (in the zen player, `apps/web/src/student/Player.tsx`).
 *
 * Controlled: it draws exactly what `toStudent` sent — the columns and the
 * cards already in the student's display order — plus the stored answer, and
 * reports every move through `onChange` as a whole new `{ columns }`. The ids
 * it writes are the canonical ones; the display order is never sent back.
 * A card in no column is simply absent from the answer: that is the tray.
 */
import type { PlayerProps, StringOverrides } from "@quiz/core/client";
import { plural, resolveStrings } from "@quiz/core/client";
import { buttonClass, caption, cx, GripIcon, isLocked, markdown } from "@quiz/ui";

import { Board, OverlayCard } from "./Board.js";
import { moveCard, normalizePlacement, trayOf } from "./placement.js";
import type { CategorizeAnswer, CategorizeStudent } from "./schema.js";
import { categorizePlayerStrings, type CategorizePlayerStringKey } from "./strings.js";
import { cardClass, cardTone, Rank } from "./ui.js";

type CategorizePlayerProps = PlayerProps<CategorizeStudent, CategorizeAnswer> & {
  /** Alias of `readOnly`, for hosts that speak in disabled controls. */
  disabled?: boolean;
  strings?: StringOverrides<CategorizePlayerStringKey>;
};

export function CategorizePlayer({
  student,
  answer,
  onChange,
  readOnly,
  disabled,
  strings,
  renderMarkdown,
}: CategorizePlayerProps) {
  const s = resolveStrings(categorizePlayerStrings, strings);
  const locked = isLocked(readOnly, disabled);
  const placement = normalizePlacement(student.columns, student.cards, answer?.columns);
  const tray = trayOf(student.cards, placement);
  const text = new Map(student.cards.map((card) => [card.id, card.text]));
  const placedAny = tray.length < student.cards.length;

  /** The answer written back: only the columns that hold a card. */
  const write = (next: Record<string, string[]>) =>
    onChange({ columns: Object.fromEntries(Object.entries(next).filter(([, ids]) => ids.length > 0)) });

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-col gap-1">
        <div className="text-lg leading-relaxed text-fg">{markdown(renderMarkdown, student.prompt)}</div>
        <p className={caption}>
          {student.ordered ? s.instructionOrdered : s.instruction} {s.noColumn}
        </p>
      </div>
      {/* Negative marking (ADR-026): said where the decision to guess is taken, as `mcq` does. */}
      {student.negativeMarking ? (
        <p className="rounded-lg bg-warning-soft px-3 py-1.5 text-[13px] font-medium text-warning" role="note">
          {s.negativeMarking}
        </p>
      ) : null}

      <Board
        columns={student.columns}
        placement={placement}
        tray={tray}
        ordered={student.ordered}
        locked={locked}
        onMove={(card, target, index) => write(moveCard(placement, card, target, index))}
        trayHead={
          <div className="flex items-baseline justify-between gap-2">
            <h3 className="text-[13px] font-semibold text-fg">{s.tray}</h3>
            <span className={caption}>{plural(s, "remaining", tray.length)}</span>
          </div>
        }
        columnHead={(column, count) => (
          <>
            <span className="min-w-0 flex-1 text-sm font-semibold text-fg">{column.label}</span>
            <span className="text-xs tabular-nums text-fg-faint">{count}</span>
          </>
        )}
        renderCard={({ id, rank, selected, toggle, handle }) => {
          const { ref, ...rest } = handle;
          return (
            <button
              type="button"
              ref={ref}
              {...rest}
              aria-pressed={selected}
              disabled={locked}
              onClick={toggle}
              className={cx(
                cardClass,
                "w-full text-left transition-colors",
                locked ? "cursor-default opacity-80" : "cursor-grab active:cursor-grabbing",
                !locked && !selected && "hover:border-fg-faint",
                selected ? cardTone.selected : cardTone.neutral,
              )}
            >
              {locked ? null : <GripIcon className="size-3.5 text-fg-faint" />}
              {rank === null ? null : <Rank n={rank} />}
              <span className="min-w-0 flex-1 [overflow-wrap:anywhere]">{markdown(renderMarkdown, text.get(id) ?? "")}</span>
            </button>
          );
        }}
        renderOverlay={(id) => (
          <OverlayCard>
            <GripIcon className="size-3.5 text-fg-faint" />
            <span className="min-w-0 flex-1">{markdown(renderMarkdown, text.get(id) ?? "")}</span>
          </OverlayCard>
        )}
        emptyColumn={s.dropHere}
        emptyTray={s.allSorted}
        dropHere={s.dropHere}
        dropInto={s.dropInto}
        dropIntoTray={s.dropIntoTray}
      />

      {placedAny && !locked ? (
        <div>
          <button type="button" className={buttonClass("ghost", "sm")} onClick={() => onChange({ columns: {} })}>
            {s.reset}
          </button>
        </div>
      ) : null}
    </div>
  );
}
