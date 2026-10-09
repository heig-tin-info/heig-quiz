import { Search } from "lucide-react";
import { useEffect, useId, useRef, useState } from "react";
import { createPortal } from "react-dom";

import {
  buildCommands,
  capClassrooms,
  filterCommands,
  groupCommands,
  type Command,
  type CommandContext,
} from "./commands";
import { useT } from "./i18n";
import { ComboboxOption, cx, Kbd, useCombobox, useLayer, useScrollLock, Z } from "./ui";

/** The palette's list is open for as long as the palette is. */
const ALWAYS_OPEN: [boolean, (open: boolean) => void] = [true, () => {}];

/*
 * Ctrl/⌘+K: one field that reaches every page, every classroom, the theme,
 * the language and every help topic. Four decisions, per DESIGN.md:
 *
 * - Type: the 16 px search row over the 14 px rows over the 11 px group
 *   labels — the reader's eye lands on what they are typing, then on the list.
 * - Color: the active row is the single accent use of the screen, the same
 *   `accent-soft` chip a selected sidebar item wears.
 * - Space: 2 px between rows inside a group (the sidebar's own `space-y-0.5`),
 *   12 px above each group label.
 * - Finish: hairlines between the three bands (search, list, footer); the
 *   panel floats, so it is the one thing here allowed a shadow.
 */

/**
 * Two shapes, one panel. The Shell hands over the whole `CommandContext` and
 * the palette builds the global list from it. The zen player hands over a
 * FIXED list instead: during an attempt there is no sidebar, no theme switch
 * and no other page to jump to, and the four things a student can do from
 * here are the four things the palette offers (W15). Either way the palette
 * translates through `useT()`, its own chrome and the global list alike.
 */
type CommandPaletteProps = { open: boolean; onClose: () => void } & (
  | ({ commands?: undefined } & Omit<CommandContext, "t">)
  | { commands: Command[] }
);

export function CommandPalette(props: CommandPaletteProps) {
  const { open, onClose } = props;
  const t = useT();
  const [query, setQuery] = useState("");
  const panel = useRef<HTMLDivElement>(null);
  const uid = useId();

  // Escape, the Tab trap and the focus restore, from the shared contract.
  useLayer(panel, onClose, { enabled: open });
  // The panel is anchored at 12 dvh of a viewport that must not move under
  // it. Unconditional: the component is mounted only while open, and the hook
  // has to run before the `if (!open)` below to keep the hook order stable.
  useScrollLock();

  // Rebuilt on every render rather than memoized: a few dozen objects, each
  // closing over the current context, against a dependency array that would
  // have to list every field of that context to stay honest. `buildCommands`
  // folds in whatever the screen under the palette declared while it was
  // mounted: "Publish this question" exists in the editor and nowhere else.
  const all =
    props.commands ??
    // The union above guarantees the context is there when `commands` is not;
    // TypeScript cannot narrow a rest-free union by an absent property.
    buildCommands({ ...(props as unknown as Omit<CommandContext, "t">), t });
  const groups = groupCommands(capClassrooms(filterCommands(query, all), query));
  // The list the arrows walk is the one the eye walks: the groups in their
  // fixed order, not the score order the filter returned.
  const flat = groups.flatMap((g) => g.commands);
  const position = new Map(flat.map((c, i) => [c.id, i]));

  const run = (command: Command) => {
    command.run();
    onClose();
  };
  // The shared combobox (virtual focus, wrapping arrows), with Home/End to
  // the ends of the list. Escape never reaches it: `useLayer` takes it first,
  // in the capture phase, and closes the palette. A new query starts the
  // highlight over on the best match rather than on a row that now means
  // something else.
  const combobox = useCombobox({
    count: flat.length,
    onPick: (index) => run(flat[index]!),
    query,
    ends: true,
    state: ALWAYS_OPEN,
  });
  const { active } = combobox;

  // Most screen readers ignore an `aria-live` region that arrives with its
  // text already in it, and the whole region is inserted in the same commit as
  // its first count. Mounting it empty and filling it one paint later makes
  // that first count a change the reader is told about.
  const [announced, setAnnounced] = useState("");
  const count = t(flat.length === 1 ? "palette.result" : "palette.results", { n: flat.length });
  useEffect(() => setAnnounced(count), [count]);

  // Keeps the active row in view when the arrows leave the visible slice.
  // `scrollIntoView` is not implemented under jsdom, hence the optional call.
  const activeId = combobox.optionProps(active).id;
  useEffect(() => {
    document.getElementById(activeId)?.scrollIntoView?.({ block: "nearest" });
  }, [activeId]);

  if (!open) return null;

  return createPortal(
    <div
      // A navigation layer, not a form layer: it holds nothing the user wrote
      // beyond a query they can retype in a second, so insisting on Escape
      // here would be friction for nothing.
      onClick={onClose}
      className={`layer-backdrop fixed inset-0 ${Z.modal} flex items-start justify-center bg-fg/30 p-4 pt-[12vh] backdrop-blur-[2px]`}
    >
      <div
        ref={panel}
        role="dialog"
        aria-modal="true"
        aria-label={t("palette.title")}
        tabIndex={-1}
        onClick={(e) => e.stopPropagation()}
        className="dialog-panel w-full max-w-155 rounded-sheet border border-line bg-surface shadow-overlay focus:outline-none"
      >
        <div className="flex h-13 items-center gap-2.5 border-b border-line px-4">
          <Search className="size-4 shrink-0 text-fg-faint" />
          <input
            autoFocus
            {...combobox.inputProps}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder={t("palette.placeholder")}
            aria-label={t("palette.title")}
            autoComplete="off"
            spellCheck={false}
            // No field chrome: the whole top band IS the field, and a second
            // border inside a bordered panel is noise. The focus ring goes
            // with it — the panel is the focus indicator here, and the caret
            // is in this input from the moment the palette opens until it
            // closes (the rows never take the focus).
            className="min-w-0 flex-1 bg-transparent text-base text-fg placeholder:text-fg-faint focus:outline-none"
          />
        </div>

        {/* `dvh` and not `vh`: a soft keyboard shrinks the dynamic viewport, and
            a cap read from the static one would put the last rows under it. */}
        <div className="max-h-[60dvh] overflow-y-auto p-2">
          <div {...combobox.listProps} aria-label={t("palette.title")}>
            {groups.map((group) => {
              const headingId = `${uid}-group-${group.group}`;
              return (
                <div key={group.group} role="group" aria-labelledby={headingId}>
                  {/* Exactly the sidebar's section label: the palette lists
                      the same things and must not invent a second voice. */}
                  <p
                    id={headingId}
                    className="px-2.5 pb-1 pt-3 text-[11px] font-semibold uppercase tracking-wider text-fg-faint"
                  >
                    {t(`palette.group.${group.group}`)}
                  </p>
                  <div className="space-y-0.5">
                    {group.commands.map((command) => {
                      const index = position.get(command.id) ?? 0;
                      const isActive = index === active;
                      const Icon = command.icon;
                      return (
                        // Virtual focus: the rows are not in the Tab order,
                        // `aria-activedescendant` on the input carries the
                        // selection instead.
                        <ComboboxOption
                          key={command.id}
                          combobox={combobox}
                          index={index}
                          className="flex items-center gap-2.5"
                        >
                          <Icon className="size-4 shrink-0" />
                          <span className="min-w-0 flex-1 truncate">{command.label}</span>
                          {command.hint ? (
                            // The hint inherits the accent on the active row,
                            // so the row reads as one object and not as a
                            // label with a leftover caption. Hidden on a
                            // phone: the identity of the row must never lose
                            // width to its caption, and the org login is a
                            // desktop refinement.
                            <span
                              className={cx(
                                "hidden shrink-0 text-xs sm:inline",
                                !isActive && "text-fg-faint",
                              )}
                            >
                              {command.hint}
                            </span>
                          ) : null}
                        </ComboboxOption>
                      );
                    })}
                  </div>
                </div>
              );
            })}
          </div>
          {flat.length === 0 ? (
            // Deliberately not an <EmptyState>: its circle, title and action
            // are a page-sized apparatus, and there is no action to offer —
            // the way out is one backspace away.
            <p className="py-8 text-center text-[13px] text-fg-muted">
              {t("palette.noResult", { query })}
            </p>
          ) : null}
        </div>

        <div className="flex items-center gap-3 border-t border-line px-3 py-2 text-[11px] text-fg-faint">
          <span className="flex items-center gap-1">
            <Kbd>↑</Kbd>
            <Kbd>↓</Kbd>
            {t("palette.hint.move")}
          </span>
          <span className="flex items-center gap-1">
            <Kbd>↵</Kbd>
            {t("palette.hint.run")}
          </span>
          <span className="flex items-center gap-1">
            <Kbd>Esc</Kbd>
            {t("palette.hint.close")}
          </span>
        </div>

        {/* The count is the only feedback a screen reader gets while typing:
            the rows come and go without any of them being focused. */}
        <div aria-live="polite" className="sr-only">
          {announced}
        </div>
      </div>
    </div>,
    document.body,
  );
}
