/**
 * The `mcq` editor (mockup `mockups/01-editeur-qcm.html`, docs/04 §4.4).
 *
 * Controlled and offline: it reads `config`, emits a whole new config through
 * `onChange`, and never fetches anything — the host autosaves the draft and
 * hands back the validation `issues` (decision D16). An invalid draft is a
 * normal state here: a teacher must be able to leave a question half-written.
 *
 * Two things this screen refuses to ask the teacher:
 *
 *  - HOW MANY answers are correct. The mode is DERIVED from the key set after
 *    every toggle — one key is `single`, more than one is `multiple` — and the
 *    teacher is told in one sentence what the student will see. A radio group
 *    asking for the mode next to the checkboxes that already answer it is two
 *    controls for one fact, and they can disagree.
 *  - Where a choice goes, twice. The ↑ / ↓ buttons are gone: the row has a
 *    drag handle, and that handle is a BUTTON, so the keyboard reorders
 *    through the very same affordance (focus it, Space, arrows, Space).
 */
import { useEffect, useRef, useState, type ReactNode } from "react";
import {
  closestCenter,
  DndContext,
  KeyboardSensor,
  PointerSensor,
  useSensor,
  useSensors,
  type DragEndEvent,
} from "@dnd-kit/core";
import { restrictToVerticalAxis } from "@dnd-kit/modifiers";
import {
  SortableContext,
  sortableKeyboardCoordinates,
  useSortable,
  verticalListSortingStrategy,
} from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";

import type {
  ConfigIssue,
  EditorProps,
  MarkdownRenderer,
  RichTextComponent,
  StringOverrides,
} from "@quiz/core/client";
import { resolveStrings } from "@quiz/core/client";
import {
  MCQ_MAX_CHOICES,
  MCQ_MIN_CHOICES,
  type McqChoice,
  type McqConfig,
  type McqQuestionPolicy,
} from "./schema.js";
import { mcqEditorStrings, type McqEditorStringKey } from "./strings.js";
import {
  buttonClass,
  choiceLetter,
  cx,
  gripClass,
  GripIcon,
  helpClass,
  iconButtonClass,
  inputClass,
  IssueList,
  issuesAt,
  labelClass,
  rootIssues,
  sectionClass,
  selectClass,
  Tip,
  TrashIcon,
} from "./ui.js";

export type McqEditorProps = Omit<EditorProps<McqConfig>, "uploadAsset"> & {
  /** The rich editor uses it; the textarea fallback does not. */
  uploadAsset?: EditorProps<McqConfig>["uploadAsset"];
  /** What the last save reported, as zod paths (decision D16). */
  issues?: readonly ConfigIssue[];
  strings?: StringOverrides<McqEditorStringKey>;
  /** The host's sanitised markdown view; plain text when absent. */
  renderMarkdown?: MarkdownRenderer;
  /** The host's contextual help; without it the "?" beside a label is not drawn. */
  renderHelp?: EditorProps<McqConfig>["renderHelp"];
};

type Strings = Readonly<Record<McqEditorStringKey, string>>;

/** The DOM id of one choice's editing surface, so a sibling can focus it. */
const choiceId = (index: number) => `mcq-choice-${index}`;

/**
 * Focuses a choice, whether it is a rich surface or the plain input fallback.
 *
 * With RETRIES, because the rich editor is lazy twice over: the host loads its
 * chunk on demand, and Tiptap then builds its ProseMirror view in an effect of
 * its own. A choice added by Tab or by Enter therefore has no editing surface
 * at all on the frame the list grew — which is exactly what the teacher hit:
 * the row appeared and the caret stayed behind.
 *
 * And the retry does not stop at the first `focus()`: under React's strict
 * mode the editor is built, thrown away and built again, so the surface that
 * took the caret can be destroyed a frame later and the focus fall back to the
 * body. The loop therefore keeps asking until the SAME element still has the
 * focus one frame on. Twenty frames is a third of a second, after which the
 * surface is simply not coming.
 */
function focusChoice(
  index: number,
  framesLeft = 20,
  held = 0,
  origin: Element | null = document.activeElement,
) {
  const el = document.getElementById(choiceId(index));
  const active = document.activeElement;
  if (el !== null && active === el) {
    // Focused, and still focused a frame later: the surface is the final one.
    if (held >= 1) return;
    if (framesLeft > 0 && typeof requestAnimationFrame === "function") {
      requestAnimationFrame(() => focusChoice(index, framesLeft - 1, held + 1, origin));
    }
    return;
  }
  // Somebody else has the caret now — the teacher pressed a handle, a
  // checkbox, another row — so the row that was asked for has lost its claim.
  // Without this the loop would go on stealing the focus for a third of a
  // second after the teacher moved on.
  if (active !== null && active !== document.body && active !== origin) return;
  el?.focus();
  if (framesLeft <= 0 || typeof requestAnimationFrame !== "function") return;
  requestAnimationFrame(() => focusChoice(index, framesLeft - 1, 0, origin));
}

/** The policies a question can carry, in the order the select offers them. */
const POLICY_OPTIONS: {
  value: McqQuestionPolicy;
  label: McqEditorStringKey;
  desc: McqEditorStringKey;
}[] = [
  { value: "inherit", label: "policyInherit", desc: "policyDescInherit" },
  { value: "all_or_nothing", label: "policyAllOrNothing", desc: "policyDescAllOrNothing" },
  { value: "true_false", label: "policyTrueFalse", desc: "policyDescTrueFalse" },
  { value: "discordance", label: "policyDiscordance", desc: "policyDescDiscordance" },
  { value: "symmetric", label: "policySymmetric", desc: "policyDescSymmetric" },
  { value: "ripkey", label: "policyRipkey", desc: "policyDescRipkey" },
];

export function McqEditor({
  config,
  onChange,
  disabled,
  issues = [],
  strings,
  renderMarkdown,
  renderHelp,
  RichText,
  uploadAsset,
}: McqEditorProps) {
  const s = resolveStrings(mcqEditorStrings, strings);
  const multiple = config.mode === "multiple";

  /**
   * The row to put the caret in once React has drawn it. A choice added by
   * Tab or Enter is useless if the teacher then has to reach for the mouse.
   */
  const [focusAfterRender, setFocusAfterRender] = useState<number | null>(null);
  useEffect(() => {
    if (focusAfterRender === null) return;
    focusChoice(focusAfterRender);
    setFocusAfterRender(null);
  }, [focusAfterRender]);

  const patch = (next: Partial<McqConfig>) => onChange({ ...config, ...next });

  /**
   * Writes a new choice list AND the mode it implies.
   *
   * `single` means exactly one key scored all or nothing (the two refinements
   * of the schema), so the normalisation happens here rather than producing a
   * draft the teacher cannot publish and was never told about. Zero keys is
   * left alone: the previous mode stands and the validation issue says what
   * is missing, which is better than silently flipping a setting because the
   * teacher un-ticked a box on the way to ticking another.
   */
  const setChoices = (choices: McqChoice[]) => {
    const keys = choices.filter((c) => c.correct).length;
    const next: McqConfig = { ...config, choices };
    if (keys === 1) {
      next.mode = "single";
      next.policy = "all_or_nothing";
      delete next.maxSelections;
    } else if (keys > 1) {
      next.mode = "multiple";
    }
    onChange(next);
  };

  const addChoice = (): number | null => {
    if (config.choices.length >= MCQ_MAX_CHOICES) return null;
    setChoices([...config.choices, { text: "", correct: false }]);
    return config.choices.length;
  };

  const sensors = useSensors(
    useSensor(PointerSensor, {
      // A few pixels of slop, so a click inside a choice's text is a click and
      // not the start of a drag.
      activationConstraint: { distance: 4 },
    }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );

  function onDragEnd(event: DragEndEvent) {
    const { active, over } = event;
    if (!over || active.id === over.id) return;
    const from = Number(active.id);
    const to = Number(over.id);
    if (Number.isNaN(from) || Number.isNaN(to)) return;
    const choices = config.choices.slice();
    const [moved] = choices.splice(from, 1);
    if (moved === undefined) return;
    choices.splice(to, 0, moved);
    setChoices(choices);
  }

  const promptField = RichText ? (
    <RichText
      id="mcq-prompt"
      aria-label={s.prompt}
      value={config.prompt}
      onChange={(prompt) => patch({ prompt })}
      {...(disabled === undefined ? {} : { disabled })}
      {...(uploadAsset === undefined ? {} : { uploadImage: uploadAsset })}
    />
  ) : (
    <textarea
      id="mcq-prompt"
      rows={4}
      className={cx(inputClass, "w-full resize-y font-mono text-[13px]")}
      aria-label={s.prompt}
      value={config.prompt}
      disabled={disabled}
      onChange={(e) => patch({ prompt: e.target.value })}
    />
  );

  return (
    <div className="flex flex-col gap-6">
      <IssueList issues={rootIssues(issues)} />

      <section className={sectionClass}>
        <label className={labelClass} htmlFor="mcq-prompt">
          {s.prompt}
        </label>
        {promptField}
        <p className={helpClass}>{s.promptHint}</p>
        <IssueList issues={issuesAt(issues, "prompt")} />
        {/*
         * No preview block under the statement any more. With `RichText` the
         * field IS the preview; without it, the textarea shows the source and
         * a second rendering of the same string is noise. `renderMarkdown` is
         * still accepted — the player and the review need it — and is used
         * for nothing here.
         */}
      </section>

      <section className={sectionClass}>
        <h3 className={labelClass}>{s.choices}</h3>
        <p className={helpClass}>{s.choicesHint}</p>

        <DndContext
          sensors={sensors}
          collisionDetection={closestCenter}
          modifiers={[restrictToVerticalAxis]}
          onDragEnd={onDragEnd}
        >
          <SortableContext
            items={config.choices.map((_, i) => i)}
            strategy={verticalListSortingStrategy}
          >
            <ul className="flex flex-col gap-2">
              {config.choices.map((choice, index) => (
                <ChoiceRow
                  key={index}
                  index={index}
                  choice={choice}
                  s={s}
                  disabled={disabled === true}
                  removable={config.choices.length > MCQ_MIN_CHOICES}
                  {...(RichText === undefined ? {} : { RichText })}
                  {...(uploadAsset === undefined ? {} : { uploadAsset })}
                  onText={(text) =>
                    setChoices(config.choices.map((c, i) => (i === index ? { ...c, text } : c)))
                  }
                  onCorrect={(correct) =>
                    setChoices(config.choices.map((c, i) => (i === index ? { ...c, correct } : c)))
                  }
                  onRemove={() => setChoices(config.choices.filter((_, i) => i !== index))}
                  onEnter={() => {
                    // Enter walks to the next choice, and makes one when there
                    // is none: writing four answers is four lines and four
                    // Enters, never a trip to "Add a choice".
                    const last = index === config.choices.length - 1;
                    if (!last) {
                      focusChoice(index + 1);
                      return;
                    }
                    const added = addChoice();
                    if (added !== null) setFocusAfterRender(added);
                  }}
                  onTab={(shift) => {
                    // Tab at the END of the last choice grows the list.
                    // Anywhere else — and Shift+Tab always — it is the normal
                    // Tab, which must keep leaving the field.
                    if (shift || index !== config.choices.length - 1) return false;
                    const added = addChoice();
                    if (added === null) return false;
                    setFocusAfterRender(added);
                    return true;
                  }}
                />
              ))}
            </ul>
          </SortableContext>
        </DndContext>

        <IssueList issues={issuesAt(issues, "choices")} />
        <div>
          <button
            type="button"
            className={buttonClass}
            disabled={disabled || config.choices.length >= MCQ_MAX_CHOICES}
            onClick={() => {
              const added = addChoice();
              if (added !== null) setFocusAfterRender(added);
            }}
          >
            {s.addChoice}
          </button>
        </div>
      </section>

      <section className={sectionClass}>
        <h3 className={labelClass}>{s.scoring}</h3>

        {/*
         * The policy, and only in `multiple` mode: with one key there is
         * nothing to be partial about, the schema refines it to all or
         * nothing, and a control that can hold exactly one value is a sentence
         * pretending to be a question. A <select> and no longer a segmented
         * control — six options is a paragraph of chips, and five of them are
         * formulas a teacher reads once and picks from a list.
         */}
        {multiple ? (
          <div className="flex flex-col gap-1.5">
            <div className="flex flex-wrap items-center gap-1.5">
              <label className={labelClass} htmlFor="mcq-policy">
                {s.policy}
              </label>
              {renderHelp ? renderHelp("mcq-policies") : null}
            </div>
            <select
              id="mcq-policy"
              className={cx(selectClass, "w-full max-w-80")}
              value={config.policy}
              disabled={disabled}
              onChange={(e) => patch({ policy: e.target.value as McqQuestionPolicy })}
            >
              {POLICY_OPTIONS.map((o) => (
                <option key={o.value} value={o.value}>
                  {s[o.label]}
                </option>
              ))}
            </select>
            {/* What the one chosen policy does, in one line: a legend of six
                lines is a table nobody reads, and the help "?" holds the long
                form. */}
            <p className={helpClass} data-testid="mcq-policy-desc">
              {s[(POLICY_OPTIONS.find((o) => o.value === config.policy) ?? POLICY_OPTIONS[0]!).desc]}
            </p>
          </div>
        ) : null}

        {multiple ? (
          <>
            <label className={labelClass} htmlFor="mcq-max">
              {s.maxSelections}
            </label>
            <input
              id="mcq-max"
              type="number"
              min={1}
              max={MCQ_MAX_CHOICES}
              className={cx(inputClass, "w-28 tabular-nums")}
              value={config.maxSelections ?? ""}
              disabled={disabled}
              onChange={(e) => {
                const next = { ...config };
                if (e.target.value === "") delete next.maxSelections;
                else next.maxSelections = Number(e.target.value);
                onChange(next);
              }}
            />
            <p className={helpClass}>{s.maxSelectionsHint}</p>
            {/* A cap below the number of correct choices makes the full mark
                unreachable; the schema refuses it and says so here. */}
            <IssueList issues={issuesAt(issues, "maxSelections")} />
          </>
        ) : null}

        <label className="inline-flex items-center gap-1.5 text-sm text-fg-muted">
          <input
            type="checkbox"
            className="size-4 accent-accent"
            checked={config.shuffleChoices}
            disabled={disabled}
            onChange={(e) => patch({ shuffleChoices: e.target.checked })}
          />
          {s.shuffleChoices}
        </label>
      </section>
    </div>
  );
}

/**
 * One row: handle, letter, "correct", the text, the bin.
 *
 * The checkbox is ALWAYS a checkbox, never a radio, even when exactly one
 * answer is correct. A radio cannot be un-ticked, so a teacher who ticked the
 * wrong line would have no way back to "no key yet", and the mode is derived
 * from what is ticked — a control that cannot express zero cannot drive it.
 */
function ChoiceRow({
  index,
  choice,
  s,
  disabled,
  removable,
  RichText,
  uploadAsset,
  onText,
  onCorrect,
  onRemove,
  onEnter,
  onTab,
}: {
  index: number;
  choice: McqChoice;
  s: Strings;
  disabled: boolean;
  removable: boolean;
  RichText?: RichTextComponent;
  /** A choice holds a figure as often as a statement does (a circuit, a plot). */
  uploadAsset?: EditorProps<McqConfig>["uploadAsset"];
  onText: (text: string) => void;
  onCorrect: (correct: boolean) => void;
  onRemove: () => void;
  onEnter: () => void;
  onTab: (shift: boolean) => boolean;
}) {
  const letter = choiceLetter(index);
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id: index,
    disabled,
  });
  const style = { transform: CSS.Translate.toString(transform), transition };

  return (
    <li
      ref={setNodeRef}
      style={style}
      className={cx(
        "group/choice flex items-start gap-2 rounded-field",
        isDragging && "relative z-10 bg-surface ring-1 ring-line-strong",
      )}
    >
      {/*
       * The handle IS the letter cell: the grip and the "B" are one target, so
       * a pointer aiming at the letter of the row it wants to move grabs it
       * instead of missing by four pixels. The tooltip names the gesture; the
       * accessible name is what the keyboard sensor announces.
       */}
      <Tip label={`${s.reorderChoice} ${letter}`}>
        <button
          type="button"
          className={cx(gripClass, "mt-0.75 w-auto gap-0.5 pl-0.5 pr-1")}
          aria-label={`${s.reorderChoice} ${letter}`}
          disabled={disabled}
          {...attributes}
          {...listeners}
        >
          <GripIcon />
          <span aria-hidden className="w-4 text-center text-[13px] font-medium">
            {letter}
          </span>
        </button>
      </Tip>

      <label className="mt-1.5 inline-flex shrink-0 items-center gap-1.5 text-[13px] text-fg-muted">
        <input
          type="checkbox"
          className="size-4 accent-accent"
          aria-label={`${s.correct} ${letter}`}
          checked={choice.correct}
          disabled={disabled}
          onChange={(e) => onCorrect(e.target.checked)}
        />
        <span aria-hidden>{s.correct}</span>
      </label>

      {RichText ? (
        <RichText
          inline
          // The toolbar of a choice appears INSIDE the field while it has the
          // caret: six rows each carrying a permanent one is a wall of icons,
          // and a row with no affordance at all is what the teacher met.
          toolbar="focus"
          id={choiceId(index)}
          aria-label={`${s.choiceText} ${letter}`}
          value={choice.text}
          onChange={onText}
          disabled={disabled}
          onEnter={onEnter}
          onTab={onTab}
          {...(uploadAsset === undefined ? {} : { uploadImage: uploadAsset })}
          // What the app's shortcut strip shows while the caret is in a
          // choice, on top of the formatting keys the field registers itself.
          shortcuts={[
            { keys: "Tab", label: s.addChoice },
            { keys: "Enter", label: s.nextChoice },
          ]}
          className="min-w-0 flex-1"
        />
      ) : (
        <input
          type="text"
          id={choiceId(index)}
          className={cx(inputClass, "min-w-0 flex-1")}
          aria-label={`${s.choiceText} ${letter}`}
          value={choice.text}
          disabled={disabled}
          onChange={(e) => onText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              onEnter();
            } else if (e.key === "Tab" && onTab(e.shiftKey)) {
              e.preventDefault();
            }
          }}
        />
      )}

      <button
        type="button"
        className={cx(iconButtonClass, "mt-0.75 hover:bg-danger-soft hover:text-danger")}
        aria-label={`${s.removeChoice} ${letter}`}
        disabled={disabled || !removable}
        onClick={onRemove}
      >
        <TrashIcon />
      </button>
    </li>
  );
}
