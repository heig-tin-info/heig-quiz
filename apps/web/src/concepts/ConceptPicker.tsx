import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Info, Plus, X } from "lucide-react";
import { useMemo, useRef, useState } from "react";

import { ConceptCreate, ConceptExists, type Concept, type ConceptList } from "@quiz/contracts";
import { CONCEPT_LABEL_MAX, CONCEPT_QUALIFIER_MAX, splitQualifiedLabel } from "@quiz/domain";

import { api, ApiError, wordedRefusal } from "../api";
import { useI18n, useT, type Locale } from "../i18n";
import { conceptsKey } from "../queryKeys";
import { Button, ComboboxList, ComboboxOption, cx, ErrorText, Field, Tip, useCombobox } from "../ui";
import { namesAConcept, rankConcepts } from "./ranking";
import { conceptSide } from "./sorting";
import { useConcepts } from "./useConcepts";

/**
 * The concepts of a question (ADR-081 §5, third addendum §5), written the
 * way the tag field taught teachers to write tags: one box, chips inside it,
 * the vocabulary suggested under it — but the vocabulary is the instance's,
 * and what is stored is a concept id, never the typed string.
 *
 * The same ARIA combobox as the tag field (virtual focus, `useCombobox`), so
 * Backspace keeps meaning "delete the last chip". The concepts the pool
 * already uses come first; each suggestion shows its qualifier (what tells
 * homonyms apart) and its description, which is what stops a teacher from
 * proposing a synonym. When nothing matches exactly, the last row offers to
 * CREATE a `proposed` concept, in the interface language, through a small
 * form that names the label and an optional qualifier: a deliberate step,
 * never a side effect of Enter.
 */

/** The refusal of a creation this field words itself; any other reads as the server says. */
const REFUSALS = { concept_dropped: "concepts.picker.dropped" } as const;

/** No pool, no concept to put first. */
const NO_POOL: readonly string[] = [];

/** How many suggestions show at once: eight rows, the combobox's cap (DESIGN.md › Combobox). */
const MAX_SUGGESTIONS = 8;

/** The label, then the qualifier in a quieter ink: `Adresse (mémoire)`. */
function ConceptName({ concept, locale, quiet }: { concept: Concept; locale: Locale; quiet?: boolean }) {
  const side = conceptSide(concept, locale);
  return (
    <span lang={side.lang === locale ? undefined : side.lang} className="min-w-0 truncate">
      {side.label}
      {side.qualifier ? (
        <span className={cx("font-normal", !quiet && "text-fg-faint")}> ({side.qualifier})</span>
      ) : null}
    </span>
  );
}

type Draft = { label: string; qualifier: string };

export function ConceptPicker({
  value,
  onChange,
  poolConceptIds = NO_POOL,
  disabled,
}: {
  /** The ids of the question's concepts, in order. */
  value: readonly string[];
  /** The new list of ids; the caller saves it. */
  onChange: (ids: string[]) => void;
  /** The concepts the pool's questions already use: offered first (ADR-081 §5). */
  poolConceptIds?: readonly string[];
  disabled?: boolean;
}) {
  const t = useT();
  const { locale } = useI18n();
  const qc = useQueryClient();
  const concepts = useConcepts();
  const all = useMemo(() => concepts.data?.concepts ?? [], [concepts.data]);
  const byId = useMemo(() => new Map(all.map((c) => [c.id, c])), [all]);

  const [query, setQuery] = useState("");
  /** The new concept being named, under the field; null when none is. */
  const [draft, setDraft] = useState<Draft | null>(null);
  const [createError, setCreateError] = useState<string | null>(null);
  /** What a refused creation turned into: the existing concept, picked instead. */
  const [notice, setNotice] = useState<string | null>(null);
  const input = useRef<HTMLInputElement>(null);
  // The mutation's callbacks run after the answer, from the render that
  // started it: reading `value` there would drop a chip removed meanwhile.
  const latest = useRef(value);
  latest.current = value;

  const typed = query.trim();
  const first = useMemo(() => new Set(poolConceptIds), [poolConceptIds]);
  const suggestions = useMemo(
    () =>
      rankConcepts(
        typed,
        all.filter((c) => !value.includes(c.id)),
        locale,
        first,
      ).slice(0, MAX_SUGGESTIONS),
    [all, value, typed, locale, first],
  );
  /** The last row, when the typed words are nobody's name yet. */
  const creatable = typed !== "" && concepts.isSuccess && !namesAConcept(typed, all);
  const rows = suggestions.length + (creatable ? 1 : 0);

  const add = (id: string) => {
    setQuery("");
    if (!latest.current.includes(id)) onChange([...latest.current, id]);
  };

  /** A concept the server just named, in the shared list before the refetch confirms it. */
  const remember = (c: Concept) => {
    qc.setQueryData<ConceptList>(conceptsKey, (old) =>
      old && !old.concepts.some((o) => o.id === c.id) ? { concepts: [...old.concepts, c] } : old,
    );
    void qc.invalidateQueries({ queryKey: conceptsKey });
  };

  const create = useMutation({
    mutationFn: (body: ConceptCreate) =>
      api<Concept>("/app/api/concepts", {
        method: "POST",
        body: JSON.stringify(body),
      }),
    onSuccess: (c) => {
      remember(c);
      add(c.id);
      setDraft(null);
      input.current?.focus();
    },
    onError: (error) => {
      // Someone named it first (or a spelling of it): the existing concept is
      // what the teacher meant, so it is picked, and the notice says so.
      const existing = error instanceof ApiError ? ConceptExists.safeParse(error.body) : null;
      if (existing?.success) {
        const { concept } = existing.data;
        remember(concept);
        add(concept.id);
        setDraft(null);
        setNotice(
          t("concepts.picker.existed", {
            name: conceptSide(concept, locale).label,
          }),
        );
        input.current?.focus();
      } else {
        setCreateError(wordedRefusal(error, REFUSALS, t));
      }
    },
  });

  const openDraft = () => {
    const split = splitQualifiedLabel(typed);
    setDraft(split ?? { label: typed, qualifier: "" });
    setCreateError(null);
    setNotice(null);
    combo.setOpen(false);
  };

  const pick = (index: number) => {
    const suggestion = suggestions[index];
    if (suggestion) add(suggestion.id);
    else if (creatable) openDraft();
  };

  // The list stays open after a pick: a question rarely has only one concept.
  const combo = useCombobox({ count: rows, onPick: pick, query: typed });
  const { open, active } = combo;

  const onKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Enter") {
      // Enter picks a row; it never submits the editor around the field.
      e.preventDefault();
      if (open && rows) pick(active);
      else combo.setOpen(true);
    } else if (e.key === "Backspace" && query === "" && value.length) {
      e.preventDefault();
      onChange(value.slice(0, -1));
    } else {
      combo.inputProps.onKeyDown(e);
    }
  };

  const body = draft
    ? ConceptCreate.safeParse({
        lang: locale,
        label: draft.label,
        qualifier: draft.qualifier,
      })
    : null;
  /** A label typed that cannot be one (no letter, no digit): said before Create is tried. */
  const invalid = draft !== null && draft.label.trim() !== "" && !body?.success;
  const submit = () => {
    if (body?.success && !create.isPending) create.mutate(body.data);
  };
  const cancel = () => {
    setDraft(null);
    input.current?.focus();
  };
  const draftKeys = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Enter") {
      e.preventDefault();
      submit();
    } else if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      cancel();
    }
  };
  const editDraft = (field: keyof Draft) => (e: { target: { value: string } }) => {
    setDraft((d) => (d ? { ...d, [field]: e.target.value } : d));
    setCreateError(null);
  };

  return (
    <div className="space-y-1.5">
      <label htmlFor={combo.inputId} className="block text-[13px] font-medium text-fg">
        {t("concepts.picker.label")}
      </label>

      <div className="relative">
        {/* The whole box is the control: a click anywhere in it puts the caret in the input. */}
        <div
          onMouseDown={(e) => {
            if (e.target === e.currentTarget) {
              e.preventDefault();
              input.current?.focus();
            }
          }}
          // The tag field's chip box (DESIGN.md › Field): the field chrome
          // without its padding and height, growing with its rows.
          className={cx(
            "flex min-h-8.5 w-full flex-wrap items-center gap-1.5 rounded-field border border-line-strong bg-surface px-2 py-1 text-sm text-fg transition-colors hover:border-fg-faint focus-within:border-accent focus-within:ring-3 focus-within:ring-accent/20",
            disabled && "opacity-50",
          )}
        >
          {value.map((id) => {
            const concept = byId.get(id);
            const proposed = concept?.status === "proposed";
            const name = concept ? conceptSide(concept, locale).label : t("concepts.picker.unknown");
            return (
              <Tip
                key={id}
                label={
                  proposed
                    ? t("concepts.picker.proposedHint")
                    : concept
                      ? conceptSide(concept, locale).description || null
                      : null
                }
              >
                <span
                  data-status={concept?.status ?? "unknown"}
                  className={cx(
                    "inline-flex h-6 max-w-full items-center gap-1 rounded-full pl-2.5 pr-1 text-xs font-medium text-fg-muted",
                    // A proposed concept is not the vocabulary's yet: its edge is dashed until the admin validates it.
                    proposed ? "border border-dashed border-fg-faint bg-surface" : "bg-surface-3",
                  )}
                >
                  {concept ? (
                    <>
                      <ConceptName concept={concept} locale={locale} />
                      {proposed ? <span className="sr-only">, {t("concepts.picker.proposed")}</span> : null}
                    </>
                  ) : (
                    <span className="text-fg-faint">{concepts.isPending ? "…" : name}</span>
                  )}
                  <button
                    type="button"
                    disabled={disabled}
                    aria-label={t("concepts.picker.remove", { name })}
                    onClick={() => onChange(value.filter((x) => x !== id))}
                    className="shrink-0 rounded-full p-0.5 text-fg-faint transition-colors hover:bg-line-strong hover:text-fg"
                  >
                    <X className="size-3" />
                  </button>
                </span>
              </Tip>
            );
          })}

          <input
            ref={input}
            id={combo.inputId}
            disabled={disabled}
            value={query}
            {...combo.inputProps}
            autoComplete="off"
            spellCheck={false}
            placeholder={t("concepts.picker.placeholder")}
            onChange={(e) => {
              setQuery(e.target.value);
              setNotice(null);
              combo.setOpen(true);
            }}
            onKeyDown={onKeyDown}
            className="h-6 min-w-24 flex-1 bg-transparent text-sm text-fg placeholder:text-fg-faint focus:outline-none"
          />
        </div>

        {open && !disabled ? (
          <ComboboxList combobox={combo} label={t("concepts.picker.suggestions")}>
            {concepts.isPending ? (
              <p className="px-2.5 py-2 text-[13px] text-fg-faint">{t("common.loading")}</p>
            ) : concepts.isError ? (
              <ErrorText className="px-2.5 py-2">{t("concepts.picker.loadFailed")}</ErrorText>
            ) : null}

            {suggestions.map((c, index) => {
              const isActive = index === active;
              const description = conceptSide(c, locale).description;
              const marks = [
                first.has(c.id) ? t("concepts.picker.inPool") : null,
                c.status === "proposed" ? t("concepts.picker.proposed") : null,
              ].filter((m): m is string => m !== null);
              return (
                <Tip key={c.id} label={description || null} className="block">
                  <ComboboxOption combobox={combo} index={index}>
                    <div className="flex items-baseline gap-2">
                      <span className="flex min-w-0 flex-1">
                        <ConceptName concept={c} locale={locale} quiet={isActive} />
                      </span>
                      {marks.length ? (
                        <span className={cx("shrink-0 text-xs font-normal", !isActive && "text-fg-faint")}>
                          {marks.join(" · ")}
                        </span>
                      ) : null}
                    </div>
                    {description ? (
                      <p className={cx("line-clamp-2 text-xs font-normal", !isActive && "text-fg-faint")}>
                        {description}
                      </p>
                    ) : null}
                  </ComboboxOption>
                </Tip>
              );
            })}

            {creatable ? (
              <ComboboxOption combobox={combo} index={suggestions.length} className="flex items-center gap-2">
                <Plus className="size-3.5 shrink-0" aria-hidden />
                <span className="min-w-0 truncate">{t("concepts.picker.create", { name: typed })}</span>
              </ComboboxOption>
            ) : null}

            {concepts.isSuccess && rows === 0 ? (
              <p className="px-2.5 py-2 text-[13px] text-fg-faint">
                {all.length === 0
                  ? t("concepts.picker.none")
                  : // `pointeurs` names `Pointeur`, already on the question: say so, not "no match".
                    typed &&
                      namesAConcept(
                        typed,
                        all.filter((c) => value.includes(c.id)),
                      )
                    ? t("concepts.picker.already")
                    : t("concepts.picker.noMatch")}
              </p>
            ) : null}
          </ComboboxList>
        ) : null}
      </div>

      {/* Always present, so a screen reader hears the notice when it appears. */}
      <p role="status" className="flex items-center gap-1.5 text-xs text-fg-muted empty:sr-only">
        {notice ? (
          <>
            <Info className="size-3.5 shrink-0" aria-hidden />
            {notice}
          </>
        ) : null}
      </p>

      {draft ? (
        <div
          role="group"
          aria-labelledby={`${combo.inputId}-new`}
          className="space-y-2.5 rounded-field border border-line bg-surface-2 p-3"
        >
          <p id={`${combo.inputId}-new`} className="text-[13px] font-semibold text-fg">
            {t("concepts.picker.new.title")}
          </p>
          <div className="flex flex-wrap gap-2">
            <Field
              label={t("concepts.picker.new.label")}
              size="sm"
              width="min-w-40 flex-1"
              lang={locale}
              autoFocus
              maxLength={CONCEPT_LABEL_MAX}
              value={draft.label}
              onChange={editDraft("label")}
              onKeyDown={draftKeys}
            />
            <Field
              label={t("concepts.picker.new.qualifier")}
              hint={t("concepts.picker.new.optional")}
              size="sm"
              width="w-36"
              lang={locale}
              maxLength={CONCEPT_QUALIFIER_MAX}
              value={draft.qualifier}
              onChange={editDraft("qualifier")}
              onKeyDown={draftKeys}
            />
          </div>
          <p className="text-xs text-fg-muted">{t("concepts.picker.new.hint")}</p>
          {createError ? (
            <ErrorText role="alert">{createError}</ErrorText>
          ) : invalid ? (
            <ErrorText>{t("concepts.picker.invalid")}</ErrorText>
          ) : null}
          <div className="flex justify-end gap-2">
            <Button variant="ghost" size="sm" onClick={cancel}>
              {t("common.cancel")}
            </Button>
            <Button variant="secondary" size="sm" disabled={!body?.success || create.isPending} onClick={submit}>
              {t("concepts.picker.new.submit")}
            </Button>
          </div>
        </div>
      ) : null}
    </div>
  );
}
