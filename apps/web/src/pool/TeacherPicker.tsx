import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { useRef, useState } from "react";

import type { PoolCandidate, PoolCandidates } from "@quiz/contracts";

import { api } from "../api";
import { useT } from "../i18n";
import {
  ComboboxList,
  ComboboxOption,
  cx,
  FieldLabel,
  Initials,
  inputClass,
  inputSize,
  useCombobox,
} from "../ui";
import { poolCandidatesKey } from "../queryKeys";

/**
 * The teacher to invite, picked by name among the colleagues the pool does
 * not seat yet (`GET /pools/:id/candidates`) rather than spelled out as an
 * address: a teacher knows whom they want to work with, not always where
 * that person's mail goes.
 *
 * The control is a combobox in the ARIA sense: the input owns
 * `role="combobox"`, the list is a listbox it points at, and the highlighted
 * row travels through `aria-activedescendant`, so the caret never leaves the
 * input. A pick puts the name in the field and the address on the label
 * line; typing again drops the pick, since the text no longer names it.
 *
 * The parent keeps the text and the pick, because both matter to it: a pick
 * is sent as an account id, and a text nobody was picked from may still be
 * an address the invitation route knows how to resolve.
 */

/** How a candidate is called, in the field and in the list. */
export function nameOf(candidate: PoolCandidate): string {
  return `${candidate.givenName} ${candidate.familyName}`.trim() || candidate.email;
}

export function TeacherPicker({
  poolId,
  text,
  selected,
  disabled,
  onText,
  onPick,
}: {
  poolId: string;
  /** What is typed; the name of the pick once one is made. */
  text: string;
  selected: PoolCandidate | null;
  disabled?: boolean;
  onText: (text: string) => void;
  onPick: (candidate: PoolCandidate) => void;
}) {
  const t = useT();
  // Held here, not in the combobox: the query below needs it, and the
  // combobox needs the query's rows.
  const [open, setOpen] = useState(false);
  const input = useRef<HTMLInputElement>(null);

  const q = text.trim();
  const candidates = useQuery<PoolCandidates>({
    queryKey: poolCandidatesKey(poolId, q),
    queryFn: () => api(`/app/api/pools/${poolId}/candidates?q=${encodeURIComponent(q)}`),
    // Asked only while the list shows: the sheet opens on the members, not
    // on the directory.
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
        {t("share.teacher")}
      </FieldLabel>
      <div className="relative">
        <input
          ref={input}
          id={combo.inputId}
          disabled={disabled}
          value={text}
          {...combo.inputProps}
          autoComplete="off"
          spellCheck={false}
          placeholder={t("share.teacherPlaceholder")}
          onChange={(e) => {
            onText(e.target.value);
            setOpen(true);
          }}
          className={cx(inputClass, inputSize.md, "w-full")}
        />

        {open && !disabled ? (
          <ComboboxList combobox={combo} label={t("share.candidates")}>
            {candidates.isPending ? (
              <p className="px-2.5 py-2 text-[13px] text-fg-faint">
                {t("share.candidatesLoading")}
              </p>
            ) : candidates.isError ? (
              <p className="px-2.5 py-2 text-[13px] text-danger">{t("share.candidatesFailed")}</p>
            ) : rows.length === 0 ? (
              <p className="px-2.5 py-2 text-[13px] text-fg-faint">
                {q ? t("share.noCandidate", { q }) : t("share.everyoneSeated")}
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
