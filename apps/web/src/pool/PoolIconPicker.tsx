import { lazy, Suspense, useState } from "react";

import type { PoolColor } from "@quiz/contracts";

import { useT } from "../i18n";
import { Button, Modal, Spinner } from "../ui";
import { IconTile } from "./IconTile";
import { PoolColorSwatches } from "./PoolColorSwatches";
import { POOL_ICON_GROUPS } from "./poolIcons";

/**
 * Picking the icon of a pool, in ONE dialog with two steps: the curated shelf
 * (`poolIcons.ts`), one headed group per domain under the default tile, and
 * the whole lucide catalogue behind a search box. The body scrolls under the
 * title and the footer: a hundred tiles are taller than a laptop screen.
 *
 * Two steps and not two windows: the second step replaces the body of the
 * same dialog, because "more" is the same decision seen wider, not a new one.
 * The first tile of the shelf is the DEFAULT — it is a choice like the
 * others (`icon: null`), and hiding it in the footer would have made "no icon
 * in particular" the one thing you cannot point at.
 *
 * Picking is the action, so the dialog has no primary button at all: the
 * footer only carries the step change.
 *
 * The COLOUR (#213) is chosen on the way: the swatch row sits above the
 * shelf, every tile — on the shelf and in the catalogue — previews its icon
 * in it. The colour belongs to the CALLER's form, like the icon: a swatch
 * sets it there at once, so a teacher who only wants a colour picks it and
 * leaves, and the dialog keeps its one intent, "give this pool its look",
 * with no second button.
 *
 * A course picks its look in the same dialog: only the hint and the default
 * tile change.
 */

/** 1500 names and their lazy imports: downloaded when, and if, they are asked for. */
const IconCatalogue = lazy(() => import("./IconCatalogue"));

export function PoolIconPicker({
  value,
  color,
  onColor,
  onPick,
  onClose,
  hint,
  fallback,
}: {
  /** The pool's current icon; null is the default. */
  value: string | null;
  /** The colour being chosen; null is grey, the default. */
  color: PoolColor | null;
  /** A swatch was picked: the caller stores it, the dialog stays. */
  onColor: (color: PoolColor | null) => void;
  /** A tile was picked: the caller stores it and takes the dialog back. */
  onPick: (icon: string | null) => void;
  /** Escape, the X, or "Back": the dialog closes with the icon unchanged. */
  onClose: () => void;
  /** The first step's subtitle; a pool's by default. */
  hint?: string;
  /** The default icon the first tile draws (`PoolIcon`'s `fallback`). */
  fallback?: string;
}) {
  const t = useT();
  const [all, setAll] = useState(false);

  return (
    <Modal
      title={all ? t("pools.icon.all") : t("pools.icon.title")}
      subtitle={all ? t("pools.icon.allHint") : (hint ?? t("pools.icon.hint"))}
      scroll
      onClose={onClose}
      footer={
        all ? (
          <Button variant="secondary" onClick={() => setAll(false)}>
            {t("pools.icon.back")}
          </Button>
        ) : (
          <Button variant="secondary" onClick={() => setAll(true)}>
            {t("pools.icon.more")}
          </Button>
        )
      }
    >
      {all ? (
        <Suspense fallback={<Spinner className="py-16" label={t("common.loading")} />}>
          <IconCatalogue value={value} color={color} onPick={onPick} />
        </Suspense>
      ) : (
        <div className="space-y-5">
          <PoolColorSwatches value={color} onChange={onColor} />
          <IconTile
            label={t("pools.icon.default")}
            icon={null}
            color={color}
            fallback={fallback}
            selected={value === null}
            onPick={() => onPick(null)}
          />
          {POOL_ICON_GROUPS.map((group) => (
            <section
              key={group.id}
              aria-labelledby={`pool-icons-${group.id}`}
              className="space-y-2"
            >
              <h3
                id={`pool-icons-${group.id}`}
                className="text-xs font-semibold uppercase tracking-wide text-fg-faint"
              >
                {t(`pools.icon.group.${group.id}`)}
              </h3>
              <div className="grid grid-cols-5 gap-2 sm:grid-cols-8">
                {group.icons.map((name) => (
                  <IconTile
                    key={name}
                    label={name}
                    icon={name}
                    color={color}
                    selected={value === name}
                    onPick={() => onPick(name)}
                  />
                ))}
              </div>
            </section>
          ))}
        </div>
      )}
    </Modal>
  );
}
