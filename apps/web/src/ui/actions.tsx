import { useT } from "../i18n";
import { Button } from "./controls";
import { cx, IconButton } from "./layers";
import { Menu, type MenuItem } from "./menu";

/**
 * The actions of one record — a course, a pool, a row — as the shape they
 * deserve: a row of icon buttons while there are one or two of them, the
 * overflow `Menu` from three on.
 *
 * It exists so that the rule of `.claude/skills/quiz-ui/SKILL.md` ("a row of
 * three or more icon buttons is a menu") holds BY CONSTRUCTION rather than by
 * review. The call site does not choose: it hands over what the record can
 * do, and the same list drawn on a card and in a table row cannot end up as
 * two different shapes. `menu` forces the panel for the one case the count
 * alone cannot settle — a list whose length varies with the state, which
 * would otherwise flicker between two shapes under the reader's pointer.
 *
 * An item that cannot be a button falls back to the menu as well: without an
 * icon there is nothing to draw, and an `href` or a `description` is a row of
 * text, not a 28 px disc.
 */

/** From this many items on, the row becomes a menu. */
const MENU_FROM = 3;

export function Actions({
  items,
  label,
  menu,
  size = "md",
}: {
  items: MenuItem[];
  /** Accessible name of the group / of the menu trigger. */
  label?: string;
  /** Always a menu, whatever the count. */
  menu?: boolean;
  size?: "sm" | "md";
}) {
  const t = useT();
  if (items.length === 0) return null;
  const asMenu =
    menu === true ||
    items.length >= MENU_FROM ||
    items.some((it) => !it.icon || it.href || it.description);
  if (asMenu) return <Menu items={items} label={label} />;
  return (
    <span
      role="group"
      aria-label={label ?? t("common.actions")}
      className={cx("touch-group inline-flex items-center", size === "sm" ? "gap-0" : "gap-0.5")}
    >
      {items.map((it, i) => {
        const Icon = it.icon!;
        return (
          <IconButton
            key={i}
            size={size}
            label={it.label}
            danger={it.danger}
            disabled={it.disabled}
            // Like the `Menu` trigger: these buttons sit inside cards and rows
            // that are themselves clickable, and acting on a record must not
            // also open it.
            onClick={(e) => {
              e.stopPropagation();
              it.onSelect?.();
            }}
          >
            <Icon />
          </IconButton>
        );
      })}
    </span>
  );
}

/**
 * The actions of a table row that turns into a ROW CARD (`T.stack`,
 * DESIGN.md › Tables › Row cards): on the row they are drawn as they always
 * were, on the card they are ONE "…" holding every item, even a single one.
 * A card's first line has room for the identity and one trigger: nothing
 * leaves the phone, it folds into the menu.
 *
 * The switch is the card's own: the same 28 rem container query as
 * `T.stack` (`@md`), so the card and its menu cannot disagree. Both forms
 * are in the DOM and the stylesheet shows one; like `T.stack`, it needs the
 * `T.container` of the table's scroller around it.
 *
 * `worded`: the row keeps its words (a task's "Run now", an account's
 * "Anonymize…"), each item a small labelled button, quiet red when it is
 * `danger`, in a group named by `label`. The button carries the item's
 * `name` (its accessible name with the row's: "Run Health checks now") and
 * its spinner while `pending`; the menu, gone once an item is picked, needs
 * neither.
 */
export type RowItem = MenuItem & {
  /** The worded button's accessible name, naming the row. */
  name?: string;
  /** The worded button's spinner: the action runs. */
  pending?: boolean;
};

export function RowActions({
  items,
  label,
  size,
  worded = false,
}: {
  items: RowItem[];
  /** Accessible name of the group and of the menu's trigger: the row's. */
  label?: string;
  size?: "sm" | "md";
  worded?: boolean;
}) {
  if (items.length === 0) return null;
  const row = worded ? (
    <span role="group" aria-label={label} className="touch-group inline-flex items-center gap-1">
      {items.map((it, i) => {
        const Icon = it.icon;
        return (
          <Button
            key={i}
            size="sm"
            variant={it.danger ? "danger-quiet" : "secondary"}
            disabled={it.disabled}
            loading={it.pending ?? false}
            aria-label={it.name}
            onClick={(e) => {
              e.stopPropagation();
              it.onSelect?.();
            }}
          >
            {Icon && !it.pending ? <Icon /> : null} {it.label}
          </Button>
        );
      })}
    </span>
  ) : (
    <Actions items={items} label={label} size={size} />
  );
  return (
    <>
      <span data-row-actions="row" className="@max-md:hidden">
        {row}
      </span>
      <span data-row-actions="card" className="@md:hidden">
        <Actions menu items={items} label={label} />
      </span>
    </>
  );
}
