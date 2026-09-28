import { lazy, Suspense, useState } from "react";

import type { PoolColor } from "@quiz/contracts";

import { useT } from "../i18n";
import { Button, Modal, Spinner } from "../ui";
import { IconTile } from "./IconTile";
import { PoolColorSwatches } from "./PoolColorSwatches";
import { POOL_ICONS } from "./poolIcons";

/**
 * Picking the icon of a pool, in ONE dialog with two steps: the curated shelf
 * (`poolIcons.ts`), and the whole lucide catalogue behind a search box.
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
 * in it, and picking an icon takes both. So the dialog keeps its one intent,
 * "give this pool its look", and no second button appears: a teacher who only
 * wants a colour picks it, then the icon already outlined.
 */

/** 1500 names and their lazy imports: downloaded when, and if, they are asked for. */
const IconCatalogue = lazy(() => import("./IconCatalogue"));

export function PoolIconPicker({
  value,
  color: initialColor,
  onPick,
  onClose,
}: {
  /** The pool's current icon; null is the default. */
  value: string | null;
  /** The pool's current colour; null is grey, the default. */
  color: PoolColor | null;
  /** A tile was picked: the caller stores both and takes the dialog back. */
  onPick: (icon: string | null, color: PoolColor | null) => void;
  /** Escape, the X, or "Back": the dialog closes with the icon and colour unchanged. */
  onClose: () => void;
}) {
  const t = useT();
  const [all, setAll] = useState(false);
  const [color, setColor] = useState(initialColor);
  const pick = (icon: string | null) => onPick(icon, color);

  return (
    <Modal
      title={all ? t("pools.icon.all") : t("pools.icon.title")}
      subtitle={all ? t("pools.icon.allHint") : t("pools.icon.hint")}
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
          <IconCatalogue value={value} color={color} onPick={pick} />
        </Suspense>
      ) : (
        <div className="space-y-5">
          <PoolColorSwatches value={color} onChange={setColor} />
          <div className="grid grid-cols-5 gap-2 sm:grid-cols-8">
            <IconTile
              label={t("pools.icon.default")}
              icon={null}
              color={color}
              selected={value === null}
              onPick={() => pick(null)}
            />
            {POOL_ICONS.map((name) => (
              <IconTile
                key={name}
                label={name}
                icon={name}
                color={color}
                selected={value === name}
                onPick={() => pick(name)}
              />
            ))}
          </div>
        </div>
      )}
    </Modal>
  );
}
