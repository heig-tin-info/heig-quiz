import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { useEffect, useId, useRef, useState } from "react";

import type { PoolCandidate, PoolCandidates } from "@quiz/contracts";

import { api } from "../api";
import { useT } from "../i18n";
import { FieldLabel, Initials, Z, cx, inputClass, inputSize } from "../ui";

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
  const uid = useId();
  const inputId = `${uid}-input`;
  const listId = `${uid}-list`;
  const optionId = (i: number) => `${uid}-option-${i}`;
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const input = useRef<HTMLInputElement>(null);

  const q = text.trim();
  const candidates = useQuery<PoolCandidates>({
    queryKey: ["pool-candidates", poolId, q],
    queryFn: () => api(`/app/api/pools/${poolId}/candidates?q=${encodeURIComponent(q)}`),
    // Asked only while the list shows: the sheet opens on the members, not
    // on the directory.
    enabled: open,
    // The previous rows stay while the next letter is looked up, so the
    // list does not blink between two keystrokes.
    placeholderData: keepPreviousData,
  });
  const rows = candidates.data ?? [];

  useEffect(() => setActive(0), [q, open]);

  const pick = (candidate: PoolCandidate) => {
    onPick(candidate);
    setOpen(false);
  };

  const onKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setOpen(true);
      if (rows.length) setActive((i) => (i + 1) % rows.length);
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setOpen(true);
      if (rows.length) setActive((i) => (i - 1 + rows.length) % rows.length);
    } else if (e.key === "Enter") {
      // With a row under the highlight, Enter picks it; otherwise the form
      // has it, and submits what is typed.
      const candidate = open ? rows[active] : undefined;
      if (candidate) {
        e.preventDefault();
        pick(candidate);
      }
    } else if (e.key === "Escape" && open) {
      e.preventDefault();
      setOpen(false);
    }
  };

  return (
    <div className="flex min-w-0 flex-1 basis-56 flex-col gap-1.5">
      <FieldLabel htmlFor={inputId} hint={selected?.email}>
        {t("share.teacher")}
      </FieldLabel>
      <div className="relative">
        <input
          ref={input}
          id={inputId}
          disabled={disabled}
          value={text}
          role="combobox"
          aria-expanded={open}
          aria-controls={listId}
          aria-activedescendant={open && rows[active] ? optionId(active) : undefined}
          aria-autocomplete="list"
          autoComplete="off"
          spellCheck={false}
          placeholder={t("share.teacherPlaceholder")}
          onChange={(e) => {
            onText(e.target.value);
            setOpen(true);
          }}
          onFocus={() => setOpen(true)}
          // A click on an option fires after the blur, so the list is kept
          // alive long enough for that click to land.
          onBlur={() => window.setTimeout(() => setOpen(false), 120)}
          onKeyDown={onKeyDown}
          className={cx(inputClass, inputSize.md, "w-full")}
        />

        {open && !disabled ? (
          <div
            id={listId}
            role="listbox"
            aria-label={t("share.candidates")}
            className={`absolute left-0 right-0 top-full ${Z.popover} mt-1 max-h-64 overflow-y-auto rounded-menu border border-line bg-surface p-1 shadow-popover`}
          >
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
                const isActive = index === active;
                return (
                  <div
                    key={candidate.userId}
                    id={optionId(index)}
                    role="option"
                    aria-selected={isActive}
                    onMouseMove={() => setActive(index)}
                    onMouseDown={(e) => e.preventDefault()}
                    onClick={() => pick(candidate)}
                    className={cx(
                      "flex cursor-pointer items-center gap-2.5 rounded-[10px] px-2.5 py-1.5 text-sm",
                      isActive
                        ? "bg-accent-soft font-semibold text-accent"
                        : "text-fg-muted hover:bg-surface-2 hover:text-fg",
                    )}
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
                  </div>
                );
              })
            )}
          </div>
        ) : null}
      </div>
    </div>
  );
}
