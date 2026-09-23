import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { X } from "lucide-react";
import { useEffect, useId, useMemo, useRef, useState } from "react";

import type { PoolTag } from "@quiz/contracts";

import { api } from "../api";
import { useT } from "../i18n";
import { useErrorToast } from "../notify";
import { cx, inputClass, listboxIndex, Tip, Z } from "../ui";
import { poolTagsKey } from "../queryKeys";

/**
 * The tags of a question, written the way a teacher expects tags to be
 * written: one field, chips inside it, and the vocabulary of the pool
 * suggested as soon as the caret lands in it.
 *
 * The field is not a text input — it is a box carrying chips and an input.
 * The ARIA combobox pattern makes that legible to a screen reader: the input
 * owns `role="combobox"`, the suggestions are a listbox it points at, and the
 * highlighted option travels through `aria-activedescendant` (virtual focus),
 * so the caret never leaves the input and Backspace keeps meaning "delete".
 *
 * A tag that does not exist yet is offered as `Create "x"` rather than added
 * silently: inventing a synonym of an existing tag is the one mistake that
 * makes a pool unsearchable, so the vocabulary is shown first and the new
 * word is a deliberate click. Once created, the description is offered on the
 * spot — a tag documented at birth is a tag the next teacher understands.
 */

/** The one spelling a tag is stored under, mirrored from the API service. */
function normalize(tag: string): string {
  return tag.trim().replace(/^#/, "").toLowerCase();
}

export function TagInput({
  poolId,
  tags,
  disabled,
  onChange,
}: {
  poolId: string;
  tags: string[];
  disabled?: boolean;
  /** The new tag list; the caller saves it (`PATCH /questions/:id`). */
  onChange: (tags: string[]) => void;
}) {
  const t = useT();
  const qc = useQueryClient();
  const toastError = useErrorToast();
  const uid = useId();
  const listId = `${uid}-list`;
  const optionId = (i: number) => `${uid}-option-${i}`;

  const [query, setQuery] = useState("");
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  /** The tag whose description is being written, under the chips. */
  const [describing, setDescribing] = useState<string | null>(null);
  const [description, setDescription] = useState("");
  const input = useRef<HTMLInputElement>(null);
  const describeInput = useRef<HTMLInputElement>(null);

  const vocabulary = useQuery<PoolTag[]>({
    queryKey: poolTagsKey(poolId),
    queryFn: () => api(`/app/api/pools/${poolId}/tags`),
  });
  const known = vocabulary.data ?? [];
  const descriptionOf = (tag: string) => known.find((k) => k.tag === tag)?.description ?? "";

  const describe = useMutation({
    mutationFn: (body: { tag: string; description: string }) =>
      api<PoolTag>(`/app/api/pools/${poolId}/tags/${encodeURIComponent(body.tag)}`, {
        method: "PATCH",
        body: JSON.stringify({ description: body.description }),
      }),
    onSuccess: () => qc.invalidateQueries({ queryKey: poolTagsKey(poolId) }),
    onError: toastError("question.tag.describeFailed"),
  });

  const typed = normalize(query);
  const suggestions = useMemo(
    () =>
      known
        .filter((k) => !tags.includes(k.tag) && (typed === "" || k.tag.includes(typed)))
        .slice(0, 8),
    [known, tags, typed],
  );
  /** The last row of the list, when the typed word is nobody's tag yet. */
  const creatable = typed !== "" && !known.some((k) => k.tag === typed) && !tags.includes(typed);
  const rows = suggestions.length + (creatable ? 1 : 0);

  useEffect(() => setActive(0), [typed, open]);

  const add = (tag: string, isNew: boolean) => {
    const value = normalize(tag);
    setQuery("");
    if (!value || tags.includes(value)) return;
    onChange([...tags, value]);
    // A brand-new word is the one a colleague will not recognize: the
    // description is offered immediately, still in the flow of typing it.
    if (isNew) {
      setDescribing(value);
      setDescription("");
    }
  };

  const pick = (index: number) => {
    const suggestion = suggestions[index];
    if (suggestion) add(suggestion.tag, false);
    else if (creatable) add(typed, true);
  };

  const saveDescription = () => {
    const tag = describing;
    setDescribing(null);
    if (!tag) return;
    const value = description.trim();
    if (value === descriptionOf(tag)) return;
    describe.mutate({ tag, description: value });
  };

  // The one-line description input takes the focus when it appears, so a tag
  // created from the keyboard can be documented without reaching for a mouse.
  useEffect(() => {
    if (describing) describeInput.current?.focus();
  }, [describing]);

  const onKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    const next = listboxIndex(e.key, active, rows);
    if (next !== null) {
      e.preventDefault();
      setOpen(true);
      setActive(next);
    } else if (e.key === "Enter" || e.key === ",") {
      e.preventDefault();
      if (open && rows) pick(active);
      else if (typed) add(typed, !known.some((k) => k.tag === typed));
    } else if (e.key === "Escape") {
      if (open) {
        e.preventDefault();
        setOpen(false);
      }
    } else if (e.key === "Backspace" && query === "" && tags.length) {
      // The chip nearest the caret goes first: the field behaves like the
      // text it looks like.
      e.preventDefault();
      onChange(tags.slice(0, -1));
    }
  };

  const remove = (tag: string) => {
    onChange(tags.filter((x) => x !== tag));
    if (describing === tag) setDescribing(null);
  };

  const undocumented = describing === null && tags.some((tag) => descriptionOf(tag) === "");

  return (
    <div className="space-y-1.5">
      <label htmlFor={`${uid}-input`} className="block text-[13px] font-medium text-fg">
        {t("question.meta.tags")}
      </label>

      <div className="relative">
        {/* The whole box is the control: clicking anywhere in it puts the
            caret in the input, which is what a chip field promises. */}
        <div
          onMouseDown={(e) => {
            if (e.target === e.currentTarget) {
              e.preventDefault();
              input.current?.focus();
            }
          }}
          // The field chrome of `inputClass`, written out without its
          // padding and height: a chip box grows with its rows, and two
          // padding utilities on one element are settled by the stylesheet
          // order rather than by the intent (DESIGN.md, Field).
          className={cx(
            "flex min-h-8.5 w-full flex-wrap items-center gap-1.5 rounded-field border border-line-strong bg-surface px-2 py-1 text-sm text-fg transition-colors hover:border-fg-faint focus-within:border-accent focus-within:ring-3 focus-within:ring-accent/20",
            disabled && "opacity-50",
          )}
        >
          {tags.map((tag) => (
            <Tip key={tag} label={descriptionOf(tag) || null}>
              <span className="inline-flex h-6 items-center gap-1 rounded-full bg-surface-3 pl-2.5 pr-1 text-xs font-medium text-fg-muted">
                <button
                  type="button"
                  disabled={disabled}
                  aria-label={t("question.tag.describeOne", { name: tag })}
                  onClick={() => {
                    setDescribing(tag);
                    setDescription(descriptionOf(tag));
                  }}
                  className="rounded-full transition-colors hover:text-fg"
                >
                  #{tag}
                </button>
                <button
                  type="button"
                  disabled={disabled}
                  aria-label={t("question.meta.tagRemove", { name: tag })}
                  onClick={() => remove(tag)}
                  className="rounded-full p-0.5 text-fg-faint transition-colors hover:bg-line-strong hover:text-fg"
                >
                  <X className="size-3" />
                </button>
              </span>
            </Tip>
          ))}

          <input
            ref={input}
            id={`${uid}-input`}
            disabled={disabled}
            value={query}
            role="combobox"
            aria-expanded={open}
            aria-controls={listId}
            aria-activedescendant={open && rows ? optionId(active) : undefined}
            aria-autocomplete="list"
            autoComplete="off"
            spellCheck={false}
            // Always shown, chips or not: an empty input with no placeholder
            // beside a row of chips reads as a static list, and nothing tells
            // the teacher the box is the place to type.
            placeholder={t("question.tag.placeholder")}
            onChange={(e) => {
              setQuery(e.target.value);
              setOpen(true);
            }}
            onFocus={() => setOpen(true)}
            // A click on an option fires after the blur, so the list is kept
            // alive long enough for that click to land.
            onBlur={() => window.setTimeout(() => setOpen(false), 120)}
            onKeyDown={onKeyDown}
            className="h-6 min-w-24 flex-1 bg-transparent text-sm text-fg placeholder:text-fg-faint focus:outline-none"
          />
        </div>

        {open && !disabled ? (
          <div
            id={listId}
            role="listbox"
            aria-label={t("question.tag.suggestions")}
            className={`absolute left-0 right-0 top-full ${Z.popover} mt-1 max-h-64 overflow-y-auto rounded-menu border border-line bg-surface p-1 shadow-popover`}
          >
            {vocabulary.isPending ? (
              <p className="px-2.5 py-2 text-[13px] text-fg-faint">{t("common.loading")}</p>
            ) : vocabulary.isError ? (
              <p className="px-2.5 py-2 text-[13px] text-danger">{t("question.tag.loadFailed")}</p>
            ) : null}

            {suggestions.map((suggestion, index) => {
              const isActive = index === active;
              return (
                // The panel is as narrow as the properties column, so the
                // description sits UNDER the name rather than beside it: on
                // one line it was cut after three words, which is exactly the
                // information that stops a teacher inventing a synonym. The
                // tooltip carries the rest when it is longer than two lines.
                <Tip key={suggestion.tag} label={suggestion.description || null} className="block">
                  <div
                    id={optionId(index)}
                    role="option"
                    aria-selected={isActive}
                    onMouseMove={() => setActive(index)}
                    onMouseDown={(e) => e.preventDefault()}
                    onClick={() => pick(index)}
                    className={cx(
                      "cursor-pointer rounded-[10px] px-2.5 py-1.5 text-sm",
                      isActive
                        ? "bg-accent-soft font-semibold text-accent"
                        : "text-fg-muted hover:bg-surface-2 hover:text-fg",
                    )}
                  >
                    <div className="flex items-baseline gap-2">
                      <span className="min-w-0 flex-1 truncate">#{suggestion.tag}</span>
                      <span
                        className={cx(
                          "shrink-0 text-xs font-normal tabular-nums",
                          !isActive && "text-fg-faint",
                        )}
                      >
                        {t(
                          suggestion.count === 1
                            ? "question.tag.count.one"
                            : "question.tag.count",
                          { n: suggestion.count },
                        )}
                      </span>
                    </div>
                    {suggestion.description ? (
                      <p
                        className={cx(
                          "line-clamp-2 text-xs font-normal",
                          !isActive && "text-fg-faint",
                        )}
                      >
                        {suggestion.description}
                      </p>
                    ) : null}
                  </div>
                </Tip>
              );
            })}

            {creatable ? (
              <div
                id={optionId(suggestions.length)}
                role="option"
                aria-selected={active === suggestions.length}
                onMouseMove={() => setActive(suggestions.length)}
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => pick(suggestions.length)}
                className={cx(
                  "flex cursor-pointer items-center gap-2 rounded-[10px] px-2.5 py-1.5 text-sm",
                  active === suggestions.length
                    ? "bg-accent-soft font-semibold text-accent"
                    : "text-fg-muted hover:bg-surface-2 hover:text-fg",
                )}
              >
                {t("question.tag.create", { name: typed })}
              </div>
            ) : null}

            {!vocabulary.isPending && !vocabulary.isError && rows === 0 ? (
              <p className="px-2.5 py-2 text-[13px] text-fg-faint">
                {known.length === 0 ? t("question.tag.none") : t("question.tag.noMatch")}
              </p>
            ) : null}
          </div>
        ) : null}
      </div>

      {describing ? (
        <div className="flex items-center gap-2">
          <input
            ref={describeInput}
            value={description}
            aria-label={t("question.tag.describeInput", { name: describing })}
            placeholder={t("question.tag.describePlaceholder")}
            maxLength={200}
            onChange={(e) => setDescription(e.target.value)}
            onBlur={saveDescription}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                saveDescription();
              } else if (e.key === "Escape") {
                e.preventDefault();
                setDescribing(null);
              }
            }}
            className={cx(inputClass, "h-7 w-full text-[13px]")}
          />
        </div>
      ) : undocumented ? (
        <button
          type="button"
          disabled={disabled}
          onClick={() => {
            const tag = tags.find((x) => descriptionOf(x) === "")!;
            setDescribing(tag);
            setDescription("");
          }}
          className="text-xs text-fg-faint underline decoration-line-strong underline-offset-2 transition-colors hover:text-fg"
        >
          {t("question.tag.describe")}
        </button>
      ) : null}
    </div>
  );
}
