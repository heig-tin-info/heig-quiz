/**
 * The `categorize` editor (docs/04 §4.13).
 *
 * Controlled and offline: it reads `config`, emits a whole new config through
 * `onChange`, and never fetches — the host autosaves the draft and hands back
 * the validation `issues` (decision D16).
 *
 * The teacher writes the key the way the student will answer: on the same
 * board. Every card starts in the tray; dragging it into a column puts it in
 * that column's key, and a card left in the tray IS a distractor — there is
 * no "distractor" checkbox to disagree with where the card sits. The same
 * holds for a removed column: its cards fall back into the tray, in sight.
 */
import { useId, useState } from "react";

import type {
  ConfigIssue,
  EditorProps,
  RichTextComponent,
  StringOverrides,
} from "@quiz/core/client";
import { fmt, issuesAt, plural, resolveStrings, rootIssues } from "@quiz/core/client";
import {
  AsideSection,
  buttonClass,
  CheckboxField,
  cx,
  gripClass,
  GripIcon,
  hint,
  inputClass,
  inputSize,
  IssueList,
  label,
  markdown,
  PromptField,
  sectionClass,
  sectionTitle,
  Segmented,
  setting,
} from "@quiz/ui";

import { Board, OverlayCard, type CardSlot } from "./Board.js";
import { moveCard, trayOf } from "./placement.js";
import {
  CATEGORIZE_CARD_MAX,
  CATEGORIZE_LABEL_MAX,
  CATEGORIZE_MAX_CARDS,
  CATEGORIZE_MAX_COLUMNS,
  CATEGORIZE_MIN_COLUMNS,
  newId,
  type CategorizeConfig,
  type CategorizeQuestionPolicy,
} from "./schema.js";
import { categorizeEditorStrings, type CategorizeEditorStringKey } from "./strings.js";
import { CloseIcon, iconButtonClass, PlusIcon, Rank } from "./ui.js";

type CategorizeEditorProps = EditorProps<CategorizeConfig> & {
  strings?: StringOverrides<CategorizeEditorStringKey>;
};

/** The policies a question can carry, in the order of the segmented control. */
const POLICY_OPTIONS: {
  value: CategorizeQuestionPolicy;
  label: CategorizeEditorStringKey;
  desc: CategorizeEditorStringKey;
}[] = [
  { value: "inherit", label: "policyInherit", desc: "policyDescInherit" },
  { value: "per_item", label: "policyPerItem", desc: "policyDescPerItem" },
  { value: "all_or_nothing", label: "policyAllOrNothing", desc: "policyDescAllOrNothing" },
];

export function CategorizeEditor({
  config,
  onChange,
  disabled,
  issues = [],
  strings,
  RichText,
  uploadAsset,
  aside,
  renderMarkdown,
}: CategorizeEditorProps) {
  const s = resolveStrings(categorizeEditorStrings, strings);
  const id = useId();
  const locked = disabled === true;
  const [draft, setDraft] = useState("");

  const patch = (next: Partial<CategorizeConfig>) => onChange({ ...config, ...next });
  const placement = Object.fromEntries(config.columns.map((column) => [column.id, column.cards]));
  const tray = trayOf(config.cards, placement);
  const text = new Map(config.cards.map((card) => [card.id, card.text]));
  /** 1-based numbers, for the accessible names ("Column name 2", "Move card 7"). */
  const cardNumber = new Map(config.cards.map((card, index) => [card.id, index + 1]));
  const columnNumber = new Map(config.columns.map((column, index) => [column.id, index + 1]));
  const labelOf = new Map(config.columns.map((column) => [column.id, column.label]));

  /** The key after a move, written back into the columns it lives in. */
  const move = (card: string, target: string | null, index?: number) => {
    const next = moveCard(placement, card, target, index);
    patch({ columns: config.columns.map((column) => ({ ...column, cards: next[column.id] ?? [] })) });
  };

  const addCard = () => {
    const value = draft.trim();
    if (value === "" || config.cards.length >= CATEGORIZE_MAX_CARDS) return;
    patch({ cards: [...config.cards, { id: newId(), text: value }] });
    setDraft("");
  };

  const removeCard = (card: string) =>
    patch({
      cards: config.cards.filter((c) => c.id !== card),
      columns: config.columns.map((column) => ({ ...column, cards: column.cards.filter((c) => c !== card) })),
    });

  const setCardText = (card: string, value: string) =>
    patch({ cards: config.cards.map((c) => (c.id === card ? { ...c, text: value } : c)) });

  /**
   * Under the board: its own issues, then those of one column or one card,
   * each prefixed with the field's accessible name ("Column name 2"), since
   * the numbers are nowhere else on screen. The field itself turns red.
   */
  const located = (field: string) => (issue: ConfigIssue): ConfigIssue =>
    issue.path.length < 2
      ? issue
      : { ...issue, message: fmt(s.issueAt, { field, n: Number(issue.path[1]) + 1, message: issue.message }) };
  const columnIssues = issuesAt(issues, "columns");
  const cardIssues = issuesAt(issues, "cards");
  const boardIssues = [...columnIssues.map(located(s.columnLabel)), ...cardIssues.map(located(s.cardText))];
  /** The indexes of the columns and cards the last save refused, as the wire spells them. */
  const refused = (list: readonly ConfigIssue[]) => new Set(list.flatMap((i) => (i.path.length < 2 ? [] : [String(i.path[1])])));
  const badColumns = refused(columnIssues);
  const badCards = refused(cardIssues);

  const policy = POLICY_OPTIONS.find((o) => o.value === config.policy) ?? POLICY_OPTIONS[0]!;

  const options = (
    <AsideSection aside={aside}>
      <h3 className={aside ? sectionTitle : label}>{s.options}</h3>
      {(
        [
          ["ordered", s.ordered, s.orderedHint],
          ["shuffleCards", s.shuffleCards, s.shuffleCardsHint],
          ["shuffleColumns", s.shuffleColumns, s.shuffleColumnsHint],
        ] as const
      ).map(([key, word, why]) => (
        <div key={key} className="flex flex-col gap-1">
          <CheckboxField
            className={setting}
            label={word}
            checked={config[key]}
            disabled={locked}
            onChange={(checked) => patch({ [key]: checked })}
          />
          <p className={cx(hint, "pl-6")}>{why}</p>
        </div>
      ))}

      <div className="flex flex-col gap-1.5">
        <span className={label} id={`${id}-policy`}>
          {s.policy}
        </span>
        <Segmented
          wrap
          labelledBy={`${id}-policy`}
          name={`${id}-policy`}
          value={config.policy}
          disabled={locked}
          options={POLICY_OPTIONS.map((o) => ({ value: o.value, label: s[o.label] }))}
          onChange={(value) => patch({ policy: value })}
        />
        <p className={hint}>{s[policy.desc]}</p>
      </div>
    </AsideSection>
  );

  return (
    <div className="flex flex-col gap-6">
      <IssueList issues={rootIssues(issues)} />

      <section className={sectionClass}>
        <PromptField
          id={`${id}-prompt`}
          label={s.prompt}
          value={config.prompt}
          onChange={(prompt) => patch({ prompt })}
          disabled={disabled}
          RichText={RichText}
          uploadImage={uploadAsset}
        />
        <IssueList issues={issuesAt(issues, "prompt")} />
      </section>

      <section className={sectionClass}>
        <div className="flex flex-col gap-1">
          <h3 className={label}>{s.expected}</h3>
          <p className={hint}>{s.expectedHint}</p>
        </div>

        <Board
          columns={config.columns.map((column, index) => ({
            id: column.id,
            label: column.label === "" ? String(index + 1) : column.label,
          }))}
          placement={placement}
          tray={tray}
          ordered={config.ordered}
          locked={locked}
          onMove={move}
          trayHead={
            <div className="flex items-baseline justify-between gap-2">
              <h4 className="text-[13px] font-semibold text-fg">{s.tray}</h4>
              {tray.length === 0 ? null : (
                <span className="text-xs text-fg-faint">{plural(s, "distractors", tray.length)}</span>
              )}
            </div>
          }
          trayFoot={
            <form
              className="flex gap-2"
              onSubmit={(e) => {
                e.preventDefault();
                addCard();
              }}
            >
              <input
                className={cx(inputClass, inputSize.md, "min-w-0 flex-1")}
                placeholder={s.newCard}
                aria-label={s.newCard}
                value={draft}
                maxLength={CATEGORIZE_CARD_MAX}
                disabled={locked || config.cards.length >= CATEGORIZE_MAX_CARDS}
                onChange={(e) => setDraft(e.target.value)}
              />
              <button
                type="submit"
                className={buttonClass("secondary", "md")}
                disabled={locked || draft.trim() === ""}
              >
                {s.addCard}
              </button>
            </form>
          }
          columnHead={(column, count) => (
            <ColumnHeader
              number={columnNumber.get(column.id) ?? 0}
              invalid={badColumns.has(String(config.columns.findIndex((c) => c.id === column.id)))}
              label={labelOf.get(column.id) ?? ""}
              count={count}
              s={s}
              locked={locked}
              removable={config.columns.length > CATEGORIZE_MIN_COLUMNS}
              onRename={(label) =>
                patch({ columns: config.columns.map((c) => (c.id === column.id ? { ...c, label } : c)) })
              }
              onRemove={() => patch({ columns: config.columns.filter((c) => c.id !== column.id) })}
            />
          )}
          renderCard={(slot) => (
            <CardField
              slot={slot}
              number={cardNumber.get(slot.id) ?? 0}
              invalid={badCards.has(String(config.cards.findIndex((c) => c.id === slot.id)))}
              value={text.get(slot.id) ?? ""}
              s={s}
              locked={locked}
              RichText={RichText}
              onText={(value) => setCardText(slot.id, value)}
              onRemove={() => removeCard(slot.id)}
            />
          )}
          renderOverlay={(card) => (
            <OverlayCard>
              <GripIcon className="size-3.5 text-fg-faint" />
              <span className="min-w-0 flex-1">{markdown(renderMarkdown, text.get(card) ?? "")}</span>
            </OverlayCard>
          )}
          emptyColumn={s.dropHere}
          dropHere={s.moveHere}
          dropInto={s.dropInto}
          dropIntoTray={s.dropIntoTray}
        />
        {locked || config.columns.length >= CATEGORIZE_MAX_COLUMNS ? null : (
          <button
            type="button"
            className={cx(
              "flex h-10 items-center justify-center gap-1.5 rounded-card border border-dashed border-line-strong",
              "text-sm font-medium text-fg-muted transition-colors hover:border-fg-faint hover:bg-surface-2 hover:text-fg",
              "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent",
            )}
            onClick={() => patch({ columns: [...config.columns, { id: newId(), label: "", cards: [] }] })}
          >
            <PlusIcon />
            {s.addColumn}
          </button>
        )}
        <IssueList issues={boardIssues} />
      </section>

      {options}
    </div>
  );
}

type Strings = Readonly<Record<CategorizeEditorStringKey, string>>;

/** A column's header: its name as an in-place field, its count, its bin. */
function ColumnHeader({
  number,
  invalid,
  label: value,
  count,
  s,
  locked,
  removable,
  onRename,
  onRemove,
}: {
  number: number;
  /** The last save refused this column (its name, in practice). */
  invalid: boolean;
  label: string;
  count: number;
  s: Strings;
  locked: boolean;
  /** Two columns at least: the last two cannot go. */
  removable: boolean;
  onRename: (label: string) => void;
  onRemove: () => void;
}) {
  return (
    <>
      <input
        className={cx(
          "-ml-1.5 min-w-0 flex-1 rounded-field border bg-transparent px-1.5 py-0.5 text-sm font-semibold text-fg",
          "placeholder:font-normal placeholder:text-fg-faint focus:bg-surface focus:outline-none",
          invalid ? "border-danger" : "border-transparent hover:border-line focus:border-line-strong",
        )}
        aria-invalid={invalid || undefined}
        aria-label={`${s.columnLabel} ${number}`}
        placeholder={s.columnLabel}
        value={value}
        maxLength={CATEGORIZE_LABEL_MAX}
        disabled={locked}
        onChange={(e) => onRename(e.target.value)}
      />
      <span className="text-xs tabular-nums text-fg-faint">{count}</span>
      <button
        type="button"
        className={cx(iconButtonClass, "hover:bg-danger-soft hover:text-danger")}
        aria-label={`${s.removeColumn} ${number}`}
        title={s.removeColumn}
        disabled={locked || !removable}
        onClick={onRemove}
      >
        <CloseIcon />
      </button>
    </>
  );
}

/**
 * One card of the key, as a field. No card chrome of its own: the text field
 * IS the card here, and a bordered field inside a bordered tile was a box in
 * a box. The grip is the handle of both moves — Enter selects the card for
 * the click-then-click move, Space picks it up for the arrows.
 */
function CardField({
  slot,
  number,
  invalid,
  value,
  s,
  locked,
  RichText,
  onText,
  onRemove,
}: {
  slot: CardSlot;
  number: number;
  /** The last save refused this card (an empty text, in practice). */
  invalid: boolean;
  value: string;
  s: Strings;
  locked: boolean;
  RichText: RichTextComponent | undefined;
  onText: (value: string) => void;
  onRemove: () => void;
}) {
  const { ref, ...handle } = slot.handle;
  return (
    <div
      className={cx(
        "group/grip flex w-full min-w-0 items-center gap-1 rounded-field p-0.5 transition-colors",
        slot.selected ? "bg-info-soft ring-2 ring-info" : invalid && "ring-1 ring-danger",
      )}
    >
      <button
        type="button"
        ref={ref}
        {...handle}
        aria-pressed={slot.selected}
        aria-label={`${s.moveCard} ${number}`}
        disabled={locked}
        onClick={slot.toggle}
        className={gripClass}
      >
        <GripIcon />
      </button>
      {slot.rank === null ? null : <Rank n={slot.rank} />}
      {RichText ? (
        <RichText
          inline
          toolbar="focus"
          aria-label={`${s.cardText} ${number}`}
          aria-invalid={invalid || undefined}
          value={value}
          onChange={onText}
          disabled={locked}
          className="min-w-0 flex-1"
        />
      ) : (
        <input
          className={cx(inputClass, inputSize.sm, "min-w-24 flex-1 text-[13px]")}
          aria-label={`${s.cardText} ${number}`}
          aria-invalid={invalid || undefined}
          value={value}
          maxLength={CATEGORIZE_CARD_MAX}
          disabled={locked}
          onChange={(e) => onText(e.target.value)}
        />
      )}
      <button
        type="button"
        className={cx(iconButtonClass, "hover:bg-danger-soft hover:text-danger")}
        aria-label={`${s.removeCard} ${number}`}
        title={s.removeCard}
        disabled={locked}
        onClick={onRemove}
      >
        <CloseIcon />
      </button>
    </div>
  );
}
