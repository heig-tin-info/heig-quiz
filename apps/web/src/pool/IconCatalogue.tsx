import { iconNames, type IconName } from "lucide-react/dynamic";
import { useMemo, useState } from "react";
import aliases from "virtual:lucide-aliases";

import type { PoolColor } from "@quiz/contracts";

import { fuzzyFilter } from "../fuzzy";
import { useT } from "../i18n";
import { SearchInput } from "../ui";
import { ICON_SEARCH_LIMIT } from "./poolIcons";
import { IconTile } from "./IconTile";

/**
 * The second step of the icon picker: the whole lucide catalogue, searched.
 *
 * Its own module, and loaded with `lazy()` by the picker, because importing
 * `iconNames` means importing `dynamicIconImports` — 1500 lazy imports, about
 * 62 kB gzipped. A teacher who takes an icon off the shelf never downloads
 * it; the one who goes looking pays for it once, at the moment they ask.
 * The alias map (`virtual:lucide-aliases`, built by `vite.config.ts`) rides
 * in the same chunk for the same reason.
 */

/** An alias (`bar-chart-3`) is listed under its canonical name (`chart-column`). */
const canonicalIcon = (name: IconName): IconName => aliases[name] ?? name;

/**
 * The whole catalogue filtered by the app's fuzzy matcher, capped, one name
 * per glyph. Aliases still match (a teacher typing `bar-chart` finds
 * `chart-column`), but each result is a canonical name, listed once.
 */
export function searchIcons(query: string, limit = ICON_SEARCH_LIMIT): IconName[] {
  const names = new Set<IconName>();
  for (const name of fuzzyFilter(query, [...iconNames], (n) => n)) {
    if (names.size === limit) break;
    names.add(canonicalIcon(name));
  }
  return [...names];
}

export default function IconCatalogue({
  value,
  color,
  onPick,
}: {
  value: string | null;
  color: PoolColor | null;
  onPick: (icon: string) => void;
}) {
  const t = useT();
  const [query, setQuery] = useState("");
  const results = useMemo(() => searchIcons(query), [query]);
  const selected = value && canonicalIcon(value as IconName);

  return (
    <div className="space-y-3">
      <SearchInput
        autoFocus
        className="w-full"
        aria-label={t("pools.icon.search")}
        placeholder={t("pools.icon.search")}
        value={query}
        onChange={(e) => setQuery(e.target.value)}
      />
      {results.length === 0 ? (
        <p className="py-8 text-center text-sm text-fg-muted">{t("pools.icon.noMatch")}</p>
      ) : (
        // Capped and scrolled rather than virtualized: 120 tiles is one screen
        // and a half, and each one costs a chunk of a few hundred bytes — a
        // window of rows would buy nothing but code.
        <div className="-mx-1 max-h-72 overflow-y-auto px-1">
          <div className="grid grid-cols-5 gap-2 sm:grid-cols-8">
            {results.map((name) => (
              <IconTile
                key={name}
                label={name}
                icon={name}
                color={color}
                selected={selected === name}
                onPick={() => onPick(name)}
              />
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
