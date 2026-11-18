import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { useState } from "react";

import type { TeacherCandidate, TeacherChoice } from "@quiz/contracts";

import { api } from "./api";
import { useT, type Dict } from "./i18n";
import { ComboboxList, ComboboxOption, cx, ErrorText, FieldLabel, Initials, useCombobox, TextInput } from "./ui";

/**
 * A person picked by name rather than spelled out as an address: a
 * colleague among the teachers a place does not seat yet — a pool's share
 * sheet (`GET /pools/:id/candidates`), a course's "Add a person" (`GET
 * /courses/:id/staff/candidates`) — or a student of the teacher's school a
 * roster does not hold yet (`GET /classrooms/:id/roster/candidates`,
 * ADR-133). One knows whom one wants, not always where their mail goes, and
 * a name picked from a list cannot be mistyped.
 *
 * The control is a combobox in the ARIA sense: the input owns
 * `role="combobox"`, the list is a listbox it points at, and the highlighted
 * row travels through `aria-activedescendant`, so the caret never leaves the
 * input. A pick puts the name in the field and the address on the label
 * line; typing again drops the pick, since the text no longer names it.
 *
 * The form keeps the text and the pick (`usePersonPick`), because both
 * matter to it: a pick is sent as what the route resolves, and a text
 * nobody was picked from may still be an address.
 */

/** Enough of an address to be worth sending: the API does the real check. */
const LOOKS_LIKE_EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** What each picker says: its placeholder, its list's name, a failed and an empty search. */
const WORDS = {
  teacherPicker: {
    placeholder: "teacherPicker.placeholder",
    list: "teacherPicker.list",
    failed: "teacherPicker.failed",
    none: "teacherPicker.none",
  },
  studentPicker: {
    placeholder: "studentPicker.placeholder",
    list: "studentPicker.list",
    failed: "studentPicker.failed",
    none: "studentPicker.none",
  },
} as const satisfies Record<string, Record<string, keyof Dict>>;

/** What a picker lists of a person: a name and an address. */
export interface Person {
  givenName: string;
  familyName: string;
  email: string;
}

/** How a candidate is called, in the field and in the list. */
export function nameOf(candidate: Person): string {
  return `${candidate.givenName} ${candidate.familyName}`.trim() || candidate.email;
}

/**
 * The state of a form that names one person: what is typed, what was
 * picked, and the address typed when nothing was (null while the text does
 * not look like one).
 */
export function usePersonPick<C extends Person>() {
  const [text, setText] = useState("");
  const [selected, setSelected] = useState<C | null>(null);
  const typed = text.trim();
  return {
    selected,
    typedEmail: !selected && LOOKS_LIKE_EMAIL.test(typed) ? typed.toLowerCase() : null,
    reset: () => {
      setText("");
      setSelected(null);
    },
    /** The props of `PersonPicker` that carry the state. */
    picker: {
      text,
      selected,
      onText: (value: string) => {
        setText(value);
        // The text no longer names the pick.
        setSelected(null);
      },
      onPick: (candidate: C) => {
        setSelected(candidate);
        setText(nameOf(candidate));
      },
    },
  };
}

/** {@link usePersonPick} for a colleague, and whom the form names (the contract's `TeacherChoice`). */
export function useTeacherPick() {
  const pick = usePersonPick<TeacherCandidate>();
  const choice: TeacherChoice | null = pick.selected
    ? { userId: pick.selected.userId }
    : pick.typedEmail !== null
      ? { email: pick.typedEmail }
      : null;
  return { ...pick, choice };
}

export function PersonPicker<C extends Person>({
  candidatesKey,
  candidatesUrl,
  label,
  idle,
  minLength = 0,
  words,
  text,
  selected,
  disabled,
  autoFocus,
  onText,
  onPick,
}: {
  /** The prefix of the search's query key; the typed text is appended to it. */
  candidatesKey: readonly unknown[];
  /**
   * The candidates route asked for `q`: built at the call site, where its
   * query is typed by the route's contract (`TeacherCandidateQuery`,
   * `RosterCandidateQuery`).
   */
  candidatesUrl: (q: string) => string;
  label: string;
  /**
   * What the empty list says while nothing is searched: everyone is seated
   * already (teachers, listed from an empty text), or how much to type
   * (`minLength`).
   */
  idle: string;
  /** The characters a search takes; under them nothing is asked. */
  minLength?: number;
  /** Whom it lists, which says its placeholder, list name, failure and empty search. */
  words: keyof typeof WORDS;
  /** What is typed; the name of the pick once one is made. */
  text: string;
  selected: C | null;
  disabled?: boolean;
  autoFocus?: boolean;
  onText: (text: string) => void;
  onPick: (candidate: C) => void;
}) {
  const t = useT();
  // Held here, not in the combobox: the query below needs it, and the
  // combobox needs the query's rows.
  const [open, setOpen] = useState(false);

  const q = text.trim();
  const searching = q.length >= minLength;
  const candidates = useQuery<C[]>({
    queryKey: [...candidatesKey, q],
    queryFn: () => api(candidatesUrl(q)),
    // Asked only while the list shows: the form opens on its fields, not on
    // the directory.
    enabled: open && searching,
    // The previous rows stay while the next letter is looked up, so the
    // list does not blink between two keystrokes.
    placeholderData: keepPreviousData,
  });
  const rows = searching ? (candidates.data ?? []) : [];

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
        <TextInput
          id={combo.inputId}
          disabled={disabled}
          autoFocus={autoFocus}
          value={text}
          {...combo.inputProps}
          autoComplete="off"
          spellCheck={false}
          placeholder={t(WORDS[words].placeholder)}
          onChange={(e) => {
            onText(e.target.value);
            setOpen(true);
          }}
          className="w-full"
        />

        {open && !disabled ? (
          <ComboboxList combobox={combo} label={t(WORDS[words].list)}>
            {!searching ? (
              <p className="px-2.5 py-2 text-[13px] text-fg-faint">{idle}</p>
            ) : candidates.isPending ? (
              <p className="px-2.5 py-2 text-[13px] text-fg-faint">{t("teacherPicker.loading")}</p>
            ) : candidates.isError ? (
              <ErrorText className="px-2.5 py-2">{t(WORDS[words].failed)}</ErrorText>
            ) : rows.length === 0 ? (
              <p className="px-2.5 py-2 text-[13px] text-fg-faint">
                {q === "" ? idle : t(WORDS[words].none, { q })}
              </p>
            ) : (
              rows.map((candidate, index) => {
                const isActive = index === combo.active;
                return (
                  <ComboboxOption
                    key={`${index}:${candidate.email}`}
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
