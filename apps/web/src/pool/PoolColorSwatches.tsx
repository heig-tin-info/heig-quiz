import { POOL_COLORS, type PoolColor } from "@quiz/contracts";

import { useT } from "../i18n";
import { cx, Tip } from "../ui";

/**
 * The colour row of the icon picker (#213): grey, the default (`null`), then
 * the fifteen `PoolColor` names, as one row of round swatches.
 *
 * Native radios under the swatches, like `Segmented`: one value out of a set,
 * so the arrow keys walk the row and Tab leaves it in one step — sixteen tab
 * stops before the icons would be a wall. The swatch is a fill and nothing
 * else, so every radio carries its colour's NAME as its accessible name, and
 * the tooltip says the same thing to the pointer.
 *
 * The chosen swatch is ringed in ink (`fg`), and so is the focused one, never
 * in the accent: once icons are coloured, a red ring would read as the red
 * swatch.
 */
export function PoolColorSwatches({
  value,
  onChange,
}: {
  value: PoolColor | null;
  onChange: (color: PoolColor | null) => void;
}) {
  const t = useT();
  // Grey is the call sites' own ink, `fg-muted`; the others are their token.
  const swatches: { color: PoolColor | null; fill: string; label: string }[] = [
    { color: null, fill: "var(--fg-muted)", label: t("pools.color.gray") },
    ...POOL_COLORS.map((color) => ({
      color,
      fill: `var(--pool-${color})`,
      label: t(`pools.color.${color}`),
    })),
  ];

  return (
    <fieldset className="min-w-0">
      <legend className="mb-2 text-[13px] font-medium text-fg">{t("pools.color")}</legend>
      {/* One row across the dialog's width; two rows of eight where a phone
          cannot hold sixteen. */}
      <div className="grid grid-cols-8 justify-items-center gap-y-2 sm:flex sm:justify-between">
        {swatches.map((s) => {
          const checked = s.color === value;
          return (
            <Tip key={s.color ?? "gray"} label={s.label}>
              <label
                className={cx(
                  "inline-flex size-6 cursor-pointer items-center justify-center rounded-full transition-shadow duration-150",
                  "has-focus-visible:outline-2 has-focus-visible:outline-offset-2 has-focus-visible:outline-fg",
                  checked
                    ? "ring-2 ring-fg ring-offset-2 ring-offset-surface"
                    : "hover:ring-2 hover:ring-line-strong hover:ring-offset-2 hover:ring-offset-surface",
                )}
              >
                <input
                  type="radio"
                  name="pool-color"
                  className="sr-only"
                  aria-label={s.label}
                  checked={checked}
                  onChange={() => onChange(s.color)}
                />
                <span
                  aria-hidden="true"
                  className="size-5 rounded-full"
                  style={{ backgroundColor: s.fill }}
                />
              </label>
            </Tip>
          );
        })}
      </div>
    </fieldset>
  );
}
