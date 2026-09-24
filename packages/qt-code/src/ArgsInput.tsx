/**
 * The command line of a program, one argument per row (docs/spec/04 §4.7).
 *
 * It replaces a textarea that read "one argument per line": an argument may
 * hold a space, and a person who types `hello world` on one line means ONE
 * argument — the textarea left that to a hint nobody read. Here each row is
 * one `argv` entry by construction, and the preview under the rows shows the
 * line exactly as a shell would need it typed, quotes included.
 *
 * Keyboard, the way a list of lines is edited everywhere:
 *
 *  - Enter inserts an empty row below and moves into it;
 *  - Backspace in an EMPTY row removes it and moves to the previous one;
 *  - Tab is left alone: focus moves on, like in any form.
 *
 * `argv[0]` is shown, greyed and not editable, because it is what makes the
 * numbering read right: the first thing the student types is `argv[1]`.
 */
import { useEffect, useId, useRef, type KeyboardEvent, type ReactNode } from "react";

import { fmt } from "@quiz/core/client";
import { button, cx, inputSm, lockedBlock } from "@quiz/ui";

import { PlusIcon, TrashIcon } from "./icons.js";
import type { CodeLanguage } from "./schema.js";

/** The words of the argument list; both the editor's and the player's dictionaries carry them. */
export interface ArgsInputStrings {
  /** The accessible name of a row: "Argument {n}". */
  argument: string;
  addArgument: string;
  /** "Remove argument {n}". */
  removeArgument: string;
  commandLine: string;
}

/**
 * What `argv[0]` is called for a program in `language`: the binary for a
 * compiled one, the script for an interpreted one. It is what the preview
 * starts with, so the line reads as something one could type.
 */
export function programName(language: CodeLanguage): string {
  switch (language) {
    case "python":
      return "main.py";
    case "js":
      return "main.js";
    default:
      return "./prog";
  }
}

/** The characters a POSIX shell reads literally, outside any quotes. */
const SHELL_SAFE = /^[A-Za-z0-9_@%+=:,./-]+$/;

/**
 * One argument as a POSIX shell needs it typed: as is when every character
 * is literal, otherwise inside single quotes, where only `'` itself needs
 * the `'\''` dance. The empty argument is `''` — it still exists.
 */
export function shellQuote(arg: string): string {
  if (SHELL_SAFE.test(arg)) return arg;
  return `'${arg.replace(/'/g, `'\\''`)}'`;
}

/** The whole line: the program name, then each argument quoted when it must be. */
export function commandLine(program: string, args: readonly string[]): string {
  return [program, ...args.map(shellQuote)].join(" ");
}

export function ArgsInput({
  value,
  onChange,
  language,
  s,
  disabled,
  labelledBy,
}: {
  value: readonly string[];
  onChange: (next: string[]) => void;
  language: CodeLanguage;
  s: ArgsInputStrings;
  disabled?: boolean | undefined;
  /** The id of the element naming the list ("Arguments"). */
  labelledBy?: string | undefined;
}): ReactNode {
  const id = useId();
  const inputs = useRef<(HTMLInputElement | null)[]>([]);
  const addButton = useRef<HTMLButtonElement | null>(null);
  /** The row to focus once the list the last edit produced is rendered; -1 is the add button. */
  const focusNext = useRef<number | null>(null);

  useEffect(() => {
    const target = focusNext.current;
    if (target === null) return;
    focusNext.current = null;
    if (target < 0) addButton.current?.focus();
    else inputs.current[target]?.focus();
  });

  const program = programName(language);

  const insertAfter = (index: number) => {
    const next = [...value];
    next.splice(index + 1, 0, "");
    focusNext.current = index + 1;
    onChange(next);
  };

  const remove = (index: number) => {
    const next = value.filter((_, i) => i !== index);
    // The previous row, else the one that slid into this place, else "add".
    focusNext.current = next.length === 0 ? -1 : Math.max(0, index - 1);
    onChange(next);
  };

  const onKeyDown = (index: number) => (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Enter" && !e.nativeEvent.isComposing) {
      e.preventDefault();
      insertAfter(index);
    } else if (e.key === "Backspace" && value[index] === "") {
      e.preventDefault();
      remove(index);
    }
  };

  return (
    <div className="flex flex-col gap-1.5">
      <ol
        className="flex flex-col gap-1"
        {...(labelledBy === undefined ? {} : { "aria-labelledby": labelledBy })}
      >
        <li className="flex items-center gap-2">
          <span className="w-16 shrink-0 font-mono text-xs text-fg-faint">argv[0]</span>
          <span
            className="flex h-7 min-w-0 flex-1 items-center rounded-field border border-line bg-surface-2 px-3 font-mono text-[13px] text-fg-faint"
            aria-readonly="true"
          >
            {program}
          </span>
          {/* The width of a trash button, so the fields line up. */}
          <span className="w-7 shrink-0" aria-hidden="true" />
        </li>
        {value.map((arg, i) => (
          <li key={i} className="flex items-center gap-2">
            <label
              htmlFor={`${id}-${i}`}
              className="w-16 shrink-0 font-mono text-xs text-fg-muted"
            >
              argv[{i + 1}]
            </label>
            <input
              id={`${id}-${i}`}
              ref={(el) => {
                inputs.current[i] = el;
              }}
              className={cx(inputSm, "min-w-0 flex-1 font-mono")}
              aria-label={fmt(s.argument, { n: i + 1 })}
              spellCheck={false}
              autoComplete="off"
              disabled={disabled}
              value={arg}
              onChange={(e) => onChange(value.map((a, j) => (j === i ? e.target.value : a)))}
              onKeyDown={onKeyDown(i)}
            />
            <button
              type="button"
              // `px-0!`: the sm size sets `px-3`, which would leave the icon 4 px wide.
              className={button("ghost", "sm", "w-7 px-0!")}
              aria-label={fmt(s.removeArgument, { n: i + 1 })}
              title={fmt(s.removeArgument, { n: i + 1 })}
              disabled={disabled}
              onClick={() => remove(i)}
            >
              <TrashIcon />
            </button>
          </li>
        ))}
      </ol>
      {value.length === 0 ? (
        <div>
          <button
            ref={addButton}
            type="button"
            className={button("ghost", "sm")}
            disabled={disabled}
            onClick={() => insertAfter(-1)}
          >
            <PlusIcon />
            {s.addArgument}
          </button>
        </div>
      ) : null}
      {/* With no argument the preview would only repeat argv[0]. */}
      {value.length === 0 ? null : (
        <pre className={cx(lockedBlock, "py-1.5")} aria-label={s.commandLine} title={s.commandLine}>
          <code>
            <span className="select-none text-fg-faint" aria-hidden="true">
              ${" "}
            </span>
            {commandLine(program, value)}
          </code>
        </pre>
      )}
    </div>
  );
}
