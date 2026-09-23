import { useT } from "../i18n";
import { cx, IconButton, Menu, type MenuItem } from "./layers";

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
      className={cx("inline-flex items-center", size === "sm" ? "gap-0" : "gap-0.5")}
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
