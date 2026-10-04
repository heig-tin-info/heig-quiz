/**
 * The brainstorm poll (issue #458, ADR-071): participants type short ideas,
 * the projection draws one bubble per IDEA, and a bubble grows with the
 * number of participants who proposed it.
 *
 * Pure (invariant 8). Three rules live here:
 *
 *   - {@link ideaKey}: when two texts are the same idea without anybody's
 *     help — case, accents, punctuation, spacing and a leading French or
 *     English article ("la respiration" and "Respiration !"). No edit
 *     distance: "vit" and "vie" are not one idea, and a false merge on the
 *     wall is worse than two bubbles the teacher merges by hand;
 *   - {@link brainstormBoard}: the teacher's board — every idea, grouped
 *     into clusters by the teacher's merges, with its moderation status;
 *   - {@link brainstormCloud}: what the ROOM may see of that board — only
 *     the ideas that are visible, the label of a cluster never taken from a
 *     hidden or unmoderated text.
 *
 * The teacher's choices are {@link IdeaMark}s keyed by the idea key, so they
 * survive a participant editing their answer: the marks follow the TEXT,
 * never an attempt.
 */

/** Longest idea a participant may type: a few words, not a sentence. */
export const BRAINSTORM_IDEA_MAX = 60;
/** Most ideas a single participant may hold at once. */
export const BRAINSTORM_MAX_IDEAS = 10;
/** How many bubbles a cloud carries at most: a projector shows no more. */
export const BRAINSTORM_CLOUD_CAP = 60;

/** Leading words that never make an idea different ("la respiration"). */
const ARTICLES = new Set([
  "le", "la", "les", "l", "un", "une", "des", "du", "de", "d",
  "the", "a", "an",
]);

/**
 * The identity of an idea: accents and case folded, punctuation dropped,
 * spacing collapsed, leading articles removed (unless nothing else is left).
 */
export function ideaKey(raw: string): string {
  const words = raw
    .normalize("NFKD")
    .replace(/\p{M}/gu, "")
    .toLocaleLowerCase("fr")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim()
    .split(" ")
    .filter((w) => w !== "");
  let start = 0;
  while (start < words.length - 1 && ARTICLES.has(words[start]!)) start += 1;
  return words.slice(start).join(" ");
}

/** The ideas of one stored answer payload, trimmed, empty ones dropped. */
export function ideasOf(payload: unknown): string[] {
  if (payload === null || typeof payload !== "object") return [];
  const ideas = (payload as { ideas?: unknown }).ideas;
  if (!Array.isArray(ideas)) return [];
  return ideas
    .filter((idea): idea is string => typeof idea === "string")
    .map((idea) => idea.replace(/\s+/g, " ").trim())
    .filter((idea) => idea !== "");
}

/** The teacher's decision on an idea; `null` status means "not moderated yet". */
export interface IdeaMark {
  key: string;
  status: "approved" | "hidden" | null;
  /** The idea key this one was merged into; null for an idea standing alone. */
  mergedInto: string | null;
  /** The teacher's name for the cluster this idea heads. */
  label: string | null;
}

export type IdeaStatus = "pending" | "approved" | "hidden";

export interface BrainstormVariant {
  key: string;
  /** The first spelling met, as the participant typed it. */
  text: string;
  /** Participants who wrote it. */
  count: number;
  status: IdeaStatus;
}

export interface BrainstormCluster {
  /** The idea key of the cluster's head: what the others were merged into. */
  key: string;
  /** The teacher's label, or the most frequent spelling of the cluster. */
  label: string;
  renamed: boolean;
  /** Participants with at least one VISIBLE idea in the cluster. */
  count: number;
  /** Participants with any idea in the cluster, visible or not. */
  total: number;
  variants: BrainstormVariant[];
}

export interface BrainstormBoard {
  /** Participants holding at least one idea. */
  answered: number;
  /** Ideas waiting for the teacher (moderation on). */
  pending: number;
  clusters: BrainstormCluster[];
}

export interface BrainstormBubble {
  /**
   * Stable within the poll, and never a text the room may not see: the
   * smallest key among the cluster's VISIBLE ideas — not the head's, which
   * may be hidden or unmoderated.
   */
  key: string;
  label: string;
  count: number;
}

/** The head of an idea's cluster: its `mergedInto` chain, followed to the end. */
export function clusterOf(key: string, marks: ReadonlyMap<string, IdeaMark>): string {
  let current = key;
  const seen = new Set<string>([key]);
  for (;;) {
    const next = marks.get(current)?.mergedInto ?? null;
    // A cycle cannot be written (`applyIdeaAction`), and is stopped if read.
    if (next === null || seen.has(next)) return current;
    seen.add(next);
    current = next;
  }
}

function statusOf(mark: IdeaMark | undefined): IdeaStatus {
  return mark?.status ?? "pending";
}

/** Shown to the room: approved, or not hidden when nobody moderates. */
export function isVisible(status: IdeaStatus, moderation: boolean): boolean {
  return status === "approved" || (status === "pending" && !moderation);
}

/**
 * THE board. `payloads` holds one stored answer per participant; a
 * participant who wrote the same idea twice counts once.
 */
export function brainstormBoard(input: {
  payloads: readonly unknown[];
  marks: readonly IdeaMark[];
  moderation: boolean;
}): BrainstormBoard {
  const marks = new Map(input.marks.map((m) => [m.key, m]));
  const variants = new Map<string, BrainstormVariant & { rank: number }>();
  const clusters = new Map<string, { rank: number; all: Set<number>; visible: Set<number> }>();
  let answered = 0;

  input.payloads.forEach((payload, participant) => {
    const ideas = ideasOf(payload);
    if (ideas.length > 0) answered += 1;
    const mine = new Set<string>();
    for (const text of ideas) {
      const key = ideaKey(text);
      if (key === "" || mine.has(key)) continue;
      mine.add(key);
      const status = statusOf(marks.get(key));
      const variant = variants.get(key);
      if (variant) variant.count += 1;
      else variants.set(key, { key, text, count: 1, status, rank: variants.size });

      const head = clusterOf(key, marks);
      const cluster = clusters.get(head) ?? { rank: clusters.size, all: new Set(), visible: new Set() };
      clusters.set(head, cluster);
      cluster.all.add(participant);
      if (isVisible(status, input.moderation)) cluster.visible.add(participant);
    }
  });

  const members = new Map<string, (BrainstormVariant & { rank: number })[]>();
  for (const variant of variants.values()) {
    const head = clusterOf(variant.key, marks);
    members.set(head, [...(members.get(head) ?? []), variant]);
  }

  const byFrequency = <T extends { count: number; rank: number }>(a: T, b: T) =>
    b.count - a.count || a.rank - b.rank;

  const out = [...clusters.entries()]
    .map(([key, c]) => {
      const list = (members.get(key) ?? []).sort(byFrequency);
      const label = marks.get(key)?.label ?? null;
      return {
        rank: c.rank,
        cluster: {
          key,
          label: label ?? list[0]?.text ?? key,
          renamed: label !== null,
          count: c.visible.size,
          total: c.all.size,
          variants: list.map(({ rank: _rank, ...v }) => v),
        },
      };
    })
    .sort((a, b) => b.cluster.total - a.cluster.total || a.rank - b.rank)
    .map((entry) => entry.cluster);

  const pending = input.moderation ? [...variants.values()].filter((v) => v.status === "pending").length : 0;
  return { answered, pending, clusters: out };
}

/**
 * What the room may see of a board: a bubble per cluster holding a visible
 * idea, labelled by the teacher's name or by its most frequent VISIBLE
 * spelling — never by a text the teacher hid or has not seen yet.
 */
export function brainstormCloud(board: BrainstormBoard, moderation: boolean, cap = BRAINSTORM_CLOUD_CAP): BrainstormBubble[] {
  return board.clusters
    .filter((c) => c.count > 0)
    .map((c) => {
      const visible = c.variants.filter((v) => isVisible(v.status, moderation));
      // `count > 0` holds a visible idea; the guard keeps the rule total.
      const key = visible.map((v) => v.key).sort()[0] ?? "";
      return { key, label: c.renamed ? c.label : (visible[0]?.text ?? ""), count: c.count };
    })
    .filter((b) => b.key !== "")
    .sort((a, b) => b.count - a.count)
    .slice(0, cap);
}

/** One teacher action on the board (contract `PollIdeaAction`). */
export type IdeaAction =
  | { action: "approve" | "hide" | "reset"; keys: string[] }
  | { action: "merge"; keys: string[]; into: string }
  | { action: "detach"; keys: string[] }
  | { action: "rename"; key: string; label: string | null };

/**
 * The marks an action writes, whole (the caller upserts them). Merging into
 * an idea of the same cluster is a no-op, so no `mergedInto` chain can loop.
 */
export function applyIdeaAction(current: readonly IdeaMark[], change: IdeaAction): IdeaMark[] {
  // One mark per key, the last one written: the caller upserts them in one statement.
  return [...new Map(marksFor(current, change).map((m) => [m.key, m])).values()];
}

function marksFor(current: readonly IdeaMark[], change: IdeaAction): IdeaMark[] {
  const marks = new Map(current.map((m) => [m.key, m]));
  const markOf = (key: string): IdeaMark => marks.get(key) ?? { key, status: null, mergedInto: null, label: null };

  switch (change.action) {
    case "approve":
    case "hide":
    case "reset": {
      const status = change.action === "approve" ? "approved" : change.action === "hide" ? "hidden" : null;
      return change.keys.map((key) => ({ ...markOf(key), status }));
    }
    case "merge": {
      const into = clusterOf(change.into, marks);
      const out: IdeaMark[] = [];
      for (const key of change.keys) {
        const head = clusterOf(key, marks);
        if (head === into) continue;
        const merged = { ...markOf(head), mergedInto: into, label: null };
        marks.set(head, merged);
        out.push(merged);
      }
      return out;
    }
    case "detach":
      return change.keys
        .filter((key) => markOf(key).mergedInto !== null)
        .map((key) => ({ ...markOf(key), mergedInto: null }));
    case "rename": {
      const label = change.label?.trim() || null;
      return [{ ...markOf(clusterOf(change.key, marks)), label }];
    }
  }
}
