import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { useState } from "react";

import type { TeacherCandidate, TeacherCandidateQuery, TeacherCandidates, TeacherChoice } from "@quiz/contracts";

import { api } from "./api";
import { useT } from "./i18n";
import {
  ComboboxList,
  ComboboxOption,
  cx,
  ErrorText,
  FieldLabel,
  Initials,
  inputClass,
  inputSize,
  useCombobox,
} from "./ui";

/**
 * A colleague picked by name among the teachers a place does not seat yet
 * — a pool's share sheet (`GET /pools/:id/candidates`), a course's "Add a
 * person" (`GET /courses/:id/staff/candidates`) — rather than spelled out
 * as an address: a teacher knows whom they want to work with, not always
 * where that person's mail goes, and a name picked from a list cannot be
 * mistyped.
 *
 * The control is a combobox in the ARIA sense: the input owns
 * `role="combobox"`, the list is a listbox it points at, and the highlighted
 * row travels through `aria-activedescendant`, so the caret never leaves the
 * input. A pick puts the name in the field and the address on the label
 * line; typing again drops the pick, since the text no longer names it.
 *
 * The form keeps the text and the pick (`useTeacherPick`), because both
 * matter to it: a pick is sent as an account id, and a text nobody was
 * picked from may still be an address the route knows how to resolve.
 */

/** Enough of an address to be worth sending: the API does the real check. */
const LOOKS_LIKE_EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** How a candidate is called, in the field and in the list. */
export function nameOf(candidate: TeacherCandidate): string {
  return `${candidate.givenName} ${candidate.familyName}`.trim() || candidate.email;
}

/**
 * The state of a form that names one colleague: what is typed, what was
 * picked, and what the request carries (`choice`, null while neither a pick
 * nor something that looks like an address).
 */
export function useTeacherPick() {
  const [text, setText] = useState("");
  const [selected, setSelected] = useState<TeacherCandidate | null>(null);
  const typed = text.trim();
  // Whom the form names (the contract's `TeacherChoice`), or nobody yet.
  const choice: TeacherChoice | null = selected
    ? { userId: selected.userId }
    : LOOKS_LIKE_EMAIL.test(typed)
      ? { email: typed.toLowerCase() }
      : null;
  return {
    choice,
    reset: () => {
      setText("");
      setSelected(null);
    },
    /** The props of `TeacherPicker` that carry the state. */
    picker: {
      text,
      selected,
      onText: (value: string) => {
        setText(value);
        // The text no longer names the pick.
        setSelected(null);
      },
      onPick: (candidate: TeacherCandidate) => {
        setSelected(candidate);
        setText(nameOf(candidate));
      },
    },
  };
}

export function TeacherPicker({
  candidatesKey,
  candidatesUrl,
  label,
  everyoneSeated,
  text,
  selected,
  disabled,
  autoFocus,
  onText,
  onPick,
}: {
  /** The prefix of the search's query key; the typed text is appended to it. */
  candidatesKey: readonly unknown[];
  /** The candidates route, without its `?q=`. */
  candidatesUrl: string;
  label: string;
  /** What the empty list says when nothing is typed: everyone is seated already. */
  everyoneSeated: string;
  /** What is typed; the name of the pick once one is made. */
  text: string;
  selected: TeacherCandidate | null;
  disabled?: boolean;
  autoFocus?: boolean;
  onText: (text: string) => void;
  onPick: (candidate: TeacherCandidate) => void;
}) {
  const t = useT();
  // Held here, not in the combobox: the query below needs it, and the
  // combobox needs the query's rows.
  const [open, setOpen] = useState(false);

  const q = text.trim();
  const candidates = useQuery<TeacherCandidates>({
    queryKey: [...candidatesKey, q],
    queryFn: () => api(`${candidatesUrl}?${new URLSearchParams({ q } satisfies TeacherCandidateQuery)}`),
    // Asked only while the list shows: the form opens on its fields, not on
    // the directory.
    enabled: open,
    // The previous rows stay while the next letter is looked up, so the
    // list does not blink between two keystrokes.
    placeholderData: keepPreviousData,
  });
  const rows = candidates.data ?? [];

  // With a row under the highlight, Enter picks it; otherwise the form has
  // it, and submits what is typed.
  const combo = useCombobox({
    count: rows.length,
    onPick: (index) => {
      onPick(rows[index]!);
      setOpen(false);
    },
    query: q,
    state: [open, setOpen],
  });

  return (
    <div className="flex min-w-0 flex-1 basis-56 flex-col gap-1.5">
      <FieldLabel htmlFor={combo.inputId} hint={selected?.email}>
        {label}
      </FieldLabel>
      <div className="relative">
        <input
          id={combo.inputId}
          disabled={disabled}
          autoFocus={autoFocus}
          value={text}
          {...combo.inputProps}
          autoComplete="off"
          spellCheck={false}
          placeholder={t("teacherPicker.placeholder")}
          onChange={(e) => {
            onText(e.target.value);
            setOpen(true);
          }}
          className={cx(inputClass, inputSize.md, "w-full")}
        />

        {open && !disabled ? (
          <ComboboxList combobox={combo} label={t("teacherPicker.list")}>
            {candidates.isPending ? (
              <p className="px-2.5 py-2 text-[13px] text-fg-faint">{t("teacherPicker.loading")}</p>
            ) : candidates.isError ? (
              <ErrorText className="px-2.5 py-2">{t("teacherPicker.failed")}</ErrorText>
            ) : rows.length === 0 ? (
              <p className="px-2.5 py-2 text-[13px] text-fg-faint">
                {q ? t("teacherPicker.none", { q }) : everyoneSeated}
              </p>
            ) : (
              rows.map((candidate, index) => {
                const isActive = index === combo.active;
                return (
                  <ComboboxOption
                    key={candidate.userId}
                    combobox={combo}
                    index={index}
                    className="flex items-center gap-2.5"
                  >
                    <Initials
                      name={[candidate.givenName, candidate.familyName]}
                      className="size-7 text-[11px]"
                    />
                    <span className="min-w-0 flex-1">
                      <span className="block truncate">{nameOf(candidate)}</span>
                      <span
                        className={cx(
                          "block truncate text-xs font-normal",
                          !isActive && "text-fg-faint",
                        )}
                      >
                        {candidate.email}
                      </span>
                    </span>
                  </ComboboxOption>
                );
              })
            )}
          </ComboboxList>
        ) : null}
      </div>
    </div>
  );
}
