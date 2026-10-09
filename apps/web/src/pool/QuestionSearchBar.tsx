import { CircleAlert, SlidersHorizontal, X } from "lucide-react";
import { useMemo, useRef, useState, type ReactNode } from "react";

import type { ConceptRef } from "@quiz/contracts";

import { conceptName, refName } from "../concepts/sorting";
import { useConcepts } from "../concepts/useConcepts";
import { fuzzyFilter } from "../fuzzy";
import { formatSpan, useI18n, useT } from "../i18n";
import { typeIcon, typeLabel, QUESTION_TYPE_IDS } from "../questionTypes";
import {
  Badge,
  Button,
  ComboboxList,
  cx,
  ComboboxOption,
  SearchInput,
  Sheet,
  Switch,
  ToggleChip,
  useCombobox,
} from "../ui";
import {
  activeFilterCount,
  NO_FILTERS,
  resolveFilters,
  toggle,
  type QuestionFilters,
  type Vocabulary,
} from "./filters";
import {
  applyCompletion,
  completionAt,
  SEARCH_TYPE_IDS,
  withoutToken,
  type Completion,
} from "./searchSyntax";
import { StatsFilterFields, type StatsOffer } from "./StatsFilterFields";

/**
 * Search, then the filters behind one button, over the pool's table: one
 * field and one secondary button, and the four lists — type, concept, difficulty,
 * deleted — live in a sheet, because more than three controls in a row is a
 * control panel, not a toolbar.
 *
 * It is the pool screen's bar, and the poll launcher's "From pools" too
 * (issue #162): one component, so the two speak the same grammar and open the
 * same sheet. A caller narrows it to the question types it can use (`types`)
 * and may leave out the deleted switch (`deleted`); `children` sits between
 * the grammar line and the chips, where the pool screen puts its habits row.
 *
 * The FIELD is a second way into the same filters, for the teacher who types
 * faster than they click: `#pointeurs type:code difficulty:>3 version:>1`
 * (the grammar is in `searchSyntax.ts`, and one quiet line under the field
 * says so). What it parses MERGES with what the sheet ticked — the chips
 * below the bar show the union, and removing one takes the token out of the
 * text as well as the value out of the list, so a chip never comes straight
 * back. While the caret sits right after `#` (or `tag:`) or
 * `type:`, a small list of concepts — the scope's own first, then the rest of
 * the vocabulary — or of the types opens under the field: arrows move, Enter
 * inserts, Escape closes.
 *
 * A typed concept word is a chip of its own (`#pointeurs`), whatever number
 * of concepts it designates; one that designates none says so on its chip
 * and filters nothing (`resolveFilters`).
 *
 * Inside the sheet the three lists are rows of `ToggleChip`, not rows of
 * checkboxes. A checkbox is the shape of an independent setting; these are
 * SETS of values, and "Multiple choice" beside "Short answer" beside a box
 * each collide the moment the sheet is narrower than the labels. A pill
 * carries its own bounds and wraps.
 *
 * The pool screen alone passes `stats`: the sheet then ends on the
 * statistics bounds (`StatsFilterFields`, F-STAT-03), and each range set
 * there is one chip like the version bounds. The field has no token for
 * them — they are read off a panel, not typed from memory.
 */
const DIFFICULTIES = [1, 2, 3, 4, 5];

/** The chip wording of each range the bar can hold, as literal keys. */
const RANGE_KEYS = {
  version: { between: "pool.version.between", from: "pool.version.from", upTo: "pool.version.upTo" },
  rate: { between: "pool.filter.rate.between", from: "pool.filter.rate.from", upTo: "pool.filter.rate.upTo" },
  time: { between: "pool.filter.time.between", from: "pool.filter.time.from", upTo: "pool.filter.time.upTo" },
} as const;

/** How many concept chips the sheet shows before "Show all (N)". */
const CONCEPT_LIMIT = 20;

/** How many suggestions the `#` / `type:` popover offers at once. */
const COMPLETION_LIMIT = 8;

function Chip({ label, warning, onRemove }: { label: string; warning?: string; onRemove: () => void }) {
  const t = useT();
  return (
    <span
      title={warning}
      className={cx(
        "inline-flex h-6 items-center gap-1 rounded-full pl-2.5 pr-1 text-xs font-medium",
        warning ? "border border-dashed border-fg-faint bg-surface text-fg-muted" : "bg-surface-3 text-fg-muted",
      )}
    >
      {warning ? <CircleAlert className="size-3 shrink-0 text-warning" aria-hidden /> : null}
      {label}
      {warning ? <span className="font-normal text-fg-faint">· {warning}</span> : null}
      <button
        type="button"
        aria-label={`${t("pool.filter.clear")} — ${label}`}
        onClick={onRemove}
        className="rounded-full p-0.5 text-fg-faint transition-colors hover:bg-line-strong hover:text-fg"
      >
        <X className="size-3" />
      </button>
    </span>
  );
}

/**
 * The concepts of the scope as chips, with a search above them.
 *
 * A pool of a few hundred questions uses more concepts than a sheet can
 * hold, so the list is capped at twenty and the field searches ALL of them,
 * fuzzily. The selected ones are always in the list, and first — a filter
 * you cannot see in the panel that sets it is a filter you cannot take off.
 */
function ConceptChips({
  concepts,
  selected,
  onToggle,
}: {
  concepts: readonly ConceptRef[];
  selected: string[];
  onToggle: (id: string) => void;
}) {
  const t = useT();
  const [query, setQuery] = useState("");
  const [showAll, setShowAll] = useState(false);
  const ordered = useMemo(() => {
    const matches = fuzzyFilter(query, [...concepts], refName);
    const picked = matches.filter((c) => selected.includes(c.id));
    return [...picked, ...matches.filter((c) => !selected.includes(c.id))];
  }, [query, concepts, selected]);
  const shown = showAll ? ordered : ordered.slice(0, CONCEPT_LIMIT);
  const hidden = ordered.length - shown.length;

  return (
    <div className="space-y-2.5">
      <SearchInput
        className="w-full"
        aria-label={t("pool.filter.conceptSearch")}
        placeholder={t("pool.filter.conceptSearch")}
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        onKeyDown={(e) => {
          // Enter takes the first match: the fastest way through a long list
          // is to type it, and a search that answers nothing to Enter makes
          // the reader reach for the mouse anyway.
          if (e.key !== "Enter") return;
          e.preventDefault();
          const first = ordered[0];
          if (first !== undefined) onToggle(first.id);
        }}
      />
      {ordered.length === 0 ? (
        <p className="text-sm text-fg-muted">{t("pool.filter.noConcept")}</p>
      ) : (
        <div className="flex flex-wrap gap-2">
          {shown.map((c) => (
            <ToggleChip
              key={c.id}
              label={refName(c)}
              pressed={selected.includes(c.id)}
              onToggle={() => onToggle(c.id)}
            />
          ))}
          {hidden > 0 ? (
            <ToggleChip
              label={t("common.showAll", { n: ordered.length })}
              onToggle={() => setShowAll(true)}
            />
          ) : null}
        </div>
      )}
    </div>
  );
}

interface Suggestion {
  value: string;
  label: string;
}

/**
 * The search field, plus the completion list that opens on `#` / `type:`.
 *
 * The list is virtually focused, like the command palette: the focus never
 * leaves the input (typing must keep working), the rows are out of the Tab
 * order and `aria-activedescendant` carries the selection. It is a floating
 * layer, so it is the one thing here allowed a shadow.
 */
function SearchBox({
  value,
  onChange,
  concepts,
  types,
  coach,
  onFocusChange,
}: {
  value: string;
  onChange: (next: string) => void;
  concepts: readonly ConceptRef[];
  types: readonly string[];
  coach: string | undefined;
  onFocusChange: (focused: boolean) => void;
}) {
  const t = useT();
  const { locale } = useI18n();
  const input = useRef<HTMLInputElement>(null);
  const [caret, setCaret] = useState(0);
  const listId = "pool-search-completions";

  const at: Completion | null = completionAt(value, caret);
  // The rest of the vocabulary, once a concept is being typed: after the scope's own.
  const vocabulary = useConcepts(at?.kind === "concept").data?.concepts;
  const options = useMemo<Suggestion[]>(() => {
    if (!at) return [];
    if (at.kind === "type") {
      const all = SEARCH_TYPE_IDS.filter((id) => types.includes(id)).map((id) => ({
        value: id,
        label: typeLabel(t, id),
      }));
      return fuzzyFilter(at.prefix, all, (s) => `${s.value} ${s.label}`).slice(0, COMPLETION_LIMIT);
    }
    const own = concepts.map((c) => refName(c));
    const others = (vocabulary ?? [])
      .filter((c) => !concepts.some((o) => o.id === c.id))
      .map((c) => conceptName(c, locale));
    const pick = (names: string[]) => fuzzyFilter(at.prefix, names, (n) => n);
    return [...new Set([...pick(own), ...pick(others)])]
      .slice(0, COMPLETION_LIMIT)
      .map((name) => ({ value: name, label: `#${name}` }));
  }, [at, concepts, vocabulary, types, t, locale]);

  const sync = (el: HTMLInputElement) => setCaret(el.selectionStart ?? el.value.length);

  const pick = (suggestion: Suggestion) => {
    if (!at) return;
    const next = applyCompletion(value, at, suggestion.value);
    onChange(next.text);
    combo.setOpen(false);
    // The caret belongs after the value the pick inserted, not at the end of
    // a field the teacher may still be writing the middle of.
    requestAnimationFrame(() => {
      const el = input.current;
      if (!el) return;
      el.focus();
      el.setSelectionRange(next.caret, next.caret);
      setCaret(next.caret);
    });
  };

  const combo = useCombobox({
    count: options.length,
    onPick: (index) => pick(options[index]!),
    query: value,
    completion: true,
    listId,
    optionId: (index) => `${listId}-${index}`,
  });

  return (
    <div className="relative min-w-0 flex-1">
      <SearchInput
        ref={input}
        className="w-full"
        aria-label={t("pool.search")}
        placeholder={t("pool.search")}
        {...(coach === undefined ? {} : { "data-coach": coach })}
        {...combo.inputProps}
        value={value}
        onChange={(e) => {
          combo.setOpen(true);
          onChange(e.target.value);
          sync(e.target);
        }}
        onClick={(e) => sync(e.currentTarget)}
        onFocus={() => {
          onFocusChange(true);
          combo.inputProps.onFocus?.();
        }}
        onBlur={() => {
          onFocusChange(false);
          combo.inputProps.onBlur();
        }}
        onKeyUp={(e) => sync(e.currentTarget)}
      />
      {combo.open ? (
        <ComboboxList
          combobox={combo}
          label={t(at?.kind === "type" ? "pool.filter.type" : "pool.filter.concept")}
          place="left-0 w-72 max-w-full"
        >
          {options.map((option, i) => (
            <ComboboxOption key={option.value} combobox={combo} index={i} className="truncate">
              {option.label}
            </ComboboxOption>
          ))}
        </ComboboxList>
      ) : null}
    </div>
  );
}

export function QuestionSearchBar({
  filters,
  onChange,
  concepts,
  vocabulary,
  types = QUESTION_TYPE_IDS,
  deleted = true,
  stats,
  coach,
  children,
}: {
  filters: QuestionFilters;
  onChange: (next: QuestionFilters) => void;
  /** Every concept of the scope searched, as the API reports them. */
  concepts: readonly ConceptRef[];
  /** The vocabulary the typed concept words resolved against (`useFilterVocabulary`). */
  vocabulary: Vocabulary;
  /** The question types the sheet and the `type:` completion offer. */
  types?: readonly string[];
  /** Whether the sheet offers the soft-deleted questions (F-QST-11). */
  deleted?: boolean;
  /** The statistics the sheet may filter on (the pool screen); absent, no such block. */
  stats?: StatsOffer;
  /** The coach-mark anchor of the field, when the screen has a tour. */
  coach?: string;
  /** Between the grammar line and the chips: the caller's own row. */
  children?: ReactNode;
}) {
  const t = useT();
  const { locale } = useI18n();
  const [open, setOpen] = useState(false);
  const count = activeFilterCount(filters);
  const resolved = resolveFilters(filters, vocabulary);
  /** The word still being typed (the focused field's last, no space after it): not judged yet. */
  const [focused, setFocused] = useState(false);
  const typing =
    focused && completionAt(filters.q, filters.q.length)?.kind === "concept" ? resolved.words.at(-1)?.word : undefined;
  /** A ticked concept's name: the scope's, else the vocabulary's; it may have left both. */
  const nameOf = (id: string) => {
    const own = concepts.find((c) => c.id === id);
    if (own) return refName(own);
    const known = vocabulary?.find((c) => c.id === id);
    return known ? conceptName(known, locale) : t("concepts.picker.unknown");
  };
  const set = (patch: Partial<QuestionFilters>) => onChange({ ...filters, ...patch });

  /**
   * Removing a chip takes the value off the list AND out of the search text:
   * the chip stands for the union of the two, so taking it off one side only
   * would put it straight back.
   */
  const dropType = (id: string) =>
    set({ types: filters.types.filter((x) => x !== id), q: withoutToken(filters.q, "type", id) });
  const dropWord = (word: string) => set({ q: withoutToken(filters.q, "concept", word) });
  /**
   * A concept off, in the sheet: off the ticked list, and every typed word
   * that designates it out of the text, or it would stay pressed.
   */
  const dropConcept = (id: string) =>
    set({
      concepts: filters.concepts.filter((x) => x !== id),
      q: resolved.words
        .filter((w) => w.ids.includes(id))
        .reduce((q, w) => withoutToken(q, "concept", w.word), filters.q),
    });
  const dropDifficulty = (d: number) =>
    set({
      difficulties: filters.difficulties.filter((x) => x !== d),
      q: withoutToken(filters.q, "difficulty", String(d)),
    });
  const dropVersion = () =>
    set({ versionMin: null, versionMax: null, q: withoutToken(filters.q, "version") });

  /**
   * One chip per range — "Versions 2 to 4", "Success 20% to 60%", "Median
   * time 1 min 30 and up" — from `RANGE_KEYS`. A version range
   * closed on one number reads "Version 3".
   */
  const rangeLabel = (
    kind: keyof typeof RANGE_KEYS,
    min: number | null,
    max: number | null,
    show: (v: number) => string = String,
  ) => {
    const keys = RANGE_KEYS[kind];
    if (kind === "version" && min !== null && min === max) {
      return t("pool.version.is", { n: min });
    }
    if (min !== null && max !== null) {
      return t(keys.between, { min: show(min), max: show(max) });
    }
    return min !== null ? t(keys.from, { n: show(min) }) : t(keys.upTo, { n: show(max!) });
  };

  return (
    <div className="space-y-2.5">
      <div className="flex flex-wrap items-center gap-2">
        <SearchBox
          value={filters.q}
          onChange={(q) => set({ q })}
          concepts={concepts}
          types={types}
          coach={coach}
          onFocusChange={setFocused}
        />
        {/* Default size (md, 34 px) on purpose: `SearchInput` is `inputSize.md`
            and a 28 px button beside it sat on a different baseline. */}
        <Button variant="secondary" onClick={() => setOpen(true)}>
          <SlidersHorizontal /> {t("pool.filters")}
          {count > 0 ? (
            <Badge tone="accent" className="ml-0.5">
              {count}
            </Badge>
          ) : null}
        </Button>
      </div>

      <p className="text-[11px] leading-relaxed text-fg-faint">{t("search.syntax")}</p>

      {children}

      {count > 0 ? (
        <div className="flex flex-wrap items-center gap-1.5">
          {resolved.types.map((type) => (
            <Chip key={`type-${type}`} label={typeLabel(t, type)} onRemove={() => dropType(type)} />
          ))}
          {filters.concepts.map((id) => (
            <Chip key={`concept-${id}`} label={nameOf(id)} onRemove={() => dropConcept(id)} />
          ))}
          {resolved.words.map(({ word, ids }) => (
            <Chip
              key={`word-${word}`}
              label={`#${word}`}
              warning={
                !resolved.pending && ids.length === 0 && word !== typing ? t("pool.filter.noConceptMatch") : undefined
              }
              onRemove={() => dropWord(word)}
            />
          ))}
          {resolved.difficulties.map((d) => (
            <Chip
              key={`diff-${d}`}
              label={t("pool.difficultyOf", { n: d })}
              onRemove={() => dropDifficulty(d)}
            />
          ))}
          {resolved.versionMin !== null || resolved.versionMax !== null ? (
            <Chip
              label={rangeLabel("version", resolved.versionMin, resolved.versionMax)}
              onRemove={dropVersion}
            />
          ) : null}
          {filters.rateMin !== null || filters.rateMax !== null ? (
            <Chip
              label={rangeLabel("rate", filters.rateMin, filters.rateMax)}
              onRemove={() => set({ rateMin: null, rateMax: null })}
            />
          ) : null}
          {filters.timeMin !== null || filters.timeMax !== null ? (
            <Chip
              label={rangeLabel("time", filters.timeMin, filters.timeMax, (s) =>
                formatSpan(s, t),
              )}
              onRemove={() => set({ timeMin: null, timeMax: null })}
            />
          ) : null}
          {resolved.includeDeleted ? (
            <Chip label={t("pool.filter.deleted")} onRemove={() => set({ includeDeleted: false })} />
          ) : null}
          <button
            type="button"
            onClick={() => onChange({ ...filters, ...NO_FILTERS, q: "" })}
            className="rounded-field px-1.5 py-0.5 text-xs text-fg-muted transition-colors hover:bg-surface-2 hover:text-fg"
          >
            {t("pool.filter.clear")}
          </button>
        </div>
      ) : null}

      {open ? (
        <Sheet
          title={t("pool.filters")}
          onClose={() => setOpen(false)}
          footer={
            <>
              <Button
                variant="ghost"
                onClick={() =>
                  onChange({
                    ...filters,
                    ...NO_FILTERS,
                    q: withoutToken(
                      withoutToken(withoutToken(withoutToken(filters.q, "concept"), "type"), "difficulty"),
                      "version",
                    ),
                  })
                }
              >
                {t("pool.filter.clear")}
              </Button>
              <Button onClick={() => setOpen(false)}>{t("common.done")}</Button>
            </>
          }
        >
          <div className="space-y-6">
            <fieldset>
              <legend className="mb-2 text-[13px] font-medium">{t("pool.filter.type")}</legend>
              <div className="flex flex-wrap gap-2">
                {types.map((id) => (
                  <ToggleChip
                    key={id}
                    icon={typeIcon(id)}
                    label={typeLabel(t, id)}
                    pressed={resolved.types.includes(id)}
                    onToggle={() =>
                      resolved.types.includes(id) ? dropType(id) : set({ types: toggle(filters.types, id) })
                    }
                  />
                ))}
              </div>
            </fieldset>

            <fieldset>
              <legend className="mb-2 text-[13px] font-medium">
                {t("pool.filter.difficulty")}
              </legend>
              <div className="flex flex-wrap gap-2">
                {DIFFICULTIES.map((d) => (
                  <ToggleChip
                    key={d}
                    label={d}
                    // A bare digit is not a name: the reader hears the scale.
                    aria-label={t("pool.difficultyOf", { n: d })}
                    pressed={resolved.difficulties.includes(d)}
                    onToggle={() =>
                      resolved.difficulties.includes(d)
                        ? dropDifficulty(d)
                        : set({ difficulties: toggle(filters.difficulties, d) })
                    }
                  />
                ))}
              </div>
            </fieldset>

            <fieldset>
              <legend className="mb-2 text-[13px] font-medium">{t("pool.filter.concept")}</legend>
              {concepts.length === 0 ? (
                <p className="text-sm text-fg-muted">—</p>
              ) : (
                <ConceptChips
                  concepts={concepts}
                  selected={resolved.concepts}
                  onToggle={(id) =>
                    resolved.concepts.includes(id)
                      ? dropConcept(id)
                      : set({ concepts: toggle(filters.concepts, id) })
                  }
                />
              )}
            </fieldset>

            {stats ? <StatsFilterFields offer={stats} filters={filters} onChange={set} /> : null}

            {deleted ? (
              <div className="flex items-center justify-between gap-4 border-t border-line pt-4">
                <span className="text-sm font-medium">{t("pool.filter.deleted")}</span>
                <Switch
                  label={t("pool.filter.deleted")}
                  checked={filters.includeDeleted}
                  onChange={(v) => set({ includeDeleted: v })}
                />
              </div>
            ) : null}
          </div>
        </Sheet>
      ) : null}
    </div>
  );
}
