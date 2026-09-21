import { lazy, Suspense, useState } from "react";

import { useT } from "../i18n";
import { Button, Modal, Spinner } from "../ui";
import { IconTile } from "./IconTile";
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
 */

/** 1500 names and their lazy imports: downloaded when, and if, they are asked for. */
const IconCatalogue = lazy(() => import("./IconCatalogue"));

export function PoolIconPicker({
  value,
  onPick,
  onClose,
}: {
  /** The pool's current icon; null is the default. */
  value: string | null;
  /** A tile was picked: the caller stores it and takes the dialog back. */
  onPick: (icon: string | null) => void;
  /** Escape, the X, or "Back": the dialog closes with the icon unchanged. */
  onClose: () => void;
}) {
  const t = useT();
  const [all, setAll] = useState(false);

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
          <IconCatalogue value={value} onPick={onPick} />
        </Suspense>
      ) : (
        <div className="grid grid-cols-5 gap-2 sm:grid-cols-8">
          <IconTile
            label={t("pools.icon.default")}
            icon={null}
            selected={value === null}
            onPick={() => onPick(null)}
          />
          {POOL_ICONS.map((name) => (
            <IconTile
              key={name}
              label={name}
              icon={name}
              selected={value === name}
              onPick={() => onPick(name)}
            />
          ))}
        </div>
      )}
    </Modal>
  );
}
