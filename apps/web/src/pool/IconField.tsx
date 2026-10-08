import type { ReactNode } from "react";

import { useT } from "../i18n";
import { Tip } from "../ui";

/**
 * The icon beside a name, in the forms of a pool and of a course: a labelled
 * tile that IS the trigger — the icon the thing will wear, one click from the
 * picker it comes off — and the name field after it, on one row.
 */
export function IconField({
  onPick,
  icon,
  children,
}: {
  /** Opens the picker. */
  onPick: () => void;
  /** The icon as it will be worn. */
  icon: ReactNode;
  /** The name field. */
  children: ReactNode;
}) {
  const t = useT();
  return (
    <div className="flex items-end gap-3">
      <div className="flex flex-col gap-1.5">
        <span className="text-[13px] font-medium text-fg">{t("pools.icon")}</span>
        <Tip label={t("pools.icon.change")}>
          <button
            type="button"
            onClick={onPick}
            aria-label={t("pools.icon.change")}
            className="inline-flex size-8.5 items-center justify-center rounded-field border border-line-strong bg-surface text-fg-muted transition-colors hover:border-fg-faint hover:text-fg"
          >
            {icon}
          </button>
        </Tip>
      </div>
      {children}
    </div>
  );
}
