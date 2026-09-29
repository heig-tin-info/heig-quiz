/**
 * Where the cards are, and how one moves: the pure half of the board the
 * editor and the player share. The editor writes it into the key
 * (`config.columns[].cards`), the player into the answer (`answer.columns`);
 * both read the same shape, a column id → the card ids it holds, in order.
 * A card in no column is in the tray.
 */

export type Placement = Readonly<Record<string, readonly string[]>>;

/**
 * A placement a board can draw: only the columns and cards it knows, each
 * card once — at its FIRST place, walking the columns in display order. The
 * server refuses anything else on write (`answerMisfit`); this is the
 * client's own defence against a stored payload it did not write.
 */
export function normalizePlacement(
  columns: readonly { id: string }[],
  cards: readonly { id: string }[],
  raw: Placement | undefined,
): Record<string, string[]> {
  const known = new Set(cards.map((card) => card.id));
  const seen = new Set<string>();
  const out: Record<string, string[]> = {};
  for (const column of columns) {
    const ids = raw !== undefined && Object.hasOwn(raw, column.id) ? raw[column.id] : undefined;
    out[column.id] = (ids ?? []).filter((id) => {
      if (!known.has(id) || seen.has(id)) return false;
      seen.add(id);
      return true;
    });
  }
  return out;
}

/** The cards in no column, in the order of `cards` (the display order). */
export function trayOf(cards: readonly { id: string }[], placement: Placement): string[] {
  const placed = new Set(Object.values(placement).flat());
  return cards.map((card) => card.id).filter((id) => !placed.has(id));
}

/**
 * `card` taken out of wherever it is and put in `target` (`null`: the tray)
 * at `index` — the end when absent. Within one column this is `arrayMove`:
 * the index is the card's place in the column AFTER the move.
 */
export function moveCard(
  placement: Placement,
  card: string,
  target: string | null,
  index?: number,
): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  for (const [column, ids] of Object.entries(placement)) out[column] = ids.filter((id) => id !== card);
  if (target !== null) {
    const ids = out[target] ?? [];
    const at = index === undefined ? ids.length : Math.max(0, Math.min(index, ids.length));
    ids.splice(at, 0, card);
    out[target] = ids;
  }
  return out;
}
