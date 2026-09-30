/**
 * The SCENE: what a diagram stores (docs/spec/04 §4.14, ADR-046 §2).
 *
 * A scene is elements and links. An element has a position on the grid and
 * its content; a link joins two elements and may pass through elbows. The
 * routed polyline of a link is NOT stored: it is recomputed on display, so a
 * change to the router moves no grade. The text form of a diagram (PlantUML,
 * Mermaid, DOT) is derived from the scene and never stored either.
 *
 * One flat element shape serves every kind; which fields an element carries
 * depends on its type (`t`), and which types a scene may hold depends on the
 * diagram's kind (`kindIssues` in `kinds.ts`). The schema bounds everything,
 * because the autosave sends the whole answer every 300 ms.
 *
 * Every id is OPAQUE, minted by the editor ({@link newId}): a starter scene
 * reaches the student with its ids, so an id must say nothing (the rule of
 * `categorize`, ADR-036).
 */
import { z } from "zod";

/** Coordinates stay within ±20 000 canvas units; a freehand point, within 20 000 of its element's corner. */
export const COORD_LIMIT = 20_000;
/** Elements of one scene: 80 in every kind but `free`, which allows 200 shapes. */
export const MAX_NODES = 200;
export const MAX_NODES_STRUCTURED = 80;
export const MAX_LINKS = 160;
export const MAX_VIA = 16;
export const NAME_MAX = 120;
export const LABEL_MAX = 40;
export const BODY_LINES_MAX = 40;
export const BODY_LINE_MAX = 200;
/** Freehand points of a whole `free` scene. */
export const MAX_INK_POINTS = 4_000;
/**
 * The characters of every text of a scene together — names, bodies, labels.
 * The autosave sends the whole answer every 300 ms, so a scene is bounded
 * like an essay (`rich`, 50 000).
 */
export const MAX_TEXT = 50_000;

/** Element types, across every kind. */
export const NODE_TYPES = [
  "class",
  "actor",
  "usecase",
  "system",
  "initial",
  "state",
  "final",
  "entity",
  "terminal",
  "action",
  "decision",
  "astate",
  "vertex",
  "stroke",
  "line",
  "rect",
  "square",
  "circle",
  "ellipse",
  "triangle",
] as const;
export type NodeType = (typeof NODE_TYPES)[number];

/** Link types, across every kind. */
export const LINK_TYPES = [
  "assoc",
  "nav",
  "inh",
  "impl",
  "dep",
  "agg",
  "comp",
  "incl",
  "ext",
  "strans",
  "erel",
  "flow",
  "trans",
  "edge",
  "arc",
] as const;
export type LinkType = (typeof LINK_TYPES)[number];

/** A crow's-foot cardinality, at one end of an entity-relationship link. */
export const CARDINALITIES = ["1", "0..1", "1..*", "0..*"] as const;
export type Cardinality = (typeof CARDINALITIES)[number];

/**
 * An id minted by the editor: lowercase letters and digits, bounded. The
 * charset keeps a crafted id from carrying anything but an identity.
 */
const IdSchema = z.string().regex(/^[a-z0-9]{4,40}$/);
const Coord = z.number().int().min(-COORD_LIMIT).max(COORD_LIMIT);
const Size = z.number().int().min(1).max(COORD_LIMIT);
/**
 * A text on one line, without control or format characters: the text form
 * is derived from these fields, and a new line in a name — or a line
 * separator, or a bidi override that reorders what is shown — would let an
 * answer forge the structure of the text the teacher (and later a grader)
 * reads.
 */
const Text = (max: number) => z.string().max(max).regex(/^[^\p{Cc}\p{Cf}\p{Zl}\p{Zp}]*$/u);
/** A freehand point, relative to its element's corner: never left of it or above it. */
const Offset = z.number().int().min(0).max(COORD_LIMIT);

export const PointSchema = z.strictObject({ x: Coord, y: Coord });
export type Point = z.infer<typeof PointSchema>;

export const NodeSchema = z.strictObject({
  id: IdSchema,
  t: z.enum(NODE_TYPES),
  /** Top left corner, on the grid for every type but the freehand ones. */
  x: Coord,
  y: Coord,
  name: Text(NAME_MAX).optional(),
  /** A class's stereotype, without its guillemets. */
  stereo: Text(NAME_MAX).optional(),
  abstract: z.boolean().optional(),
  /** A class's members (`---` cuts a compartment), an entity's attributes, a state's activities. */
  body: z.array(Text(BODY_LINE_MAX)).max(BODY_LINES_MAX).optional(),
  /** The size of what the student sizes: a system boundary, a shape, a stroke's box. */
  w: Size.optional(),
  h: Size.optional(),
  /** An automaton state's flags. */
  initial: z.boolean().optional(),
  accept: z.boolean().optional(),
  /** A stroke's or a line's points, relative to `x`, `y`. */
  pts: z.array(z.tuple([Offset, Offset])).min(2).max(MAX_INK_POINTS).optional(),
});
export type DiagramNode = z.infer<typeof NodeSchema>;

export const LinkSchema = z.strictObject({
  id: IdSchema,
  type: z.enum(LINK_TYPES),
  a: IdSchema,
  b: IdSchema,
  /** Elbows the line must pass through, in order from `a`. */
  via: z.array(PointSchema).max(MAX_VIA).optional(),
  /** A name, a label, a verb, a weight or the symbols of a transition. */
  name: Text(NAME_MAX).optional(),
  /** Multiplicities (class) or cardinalities (entity-relationship) at `a` and at `b`. */
  ma: Text(LABEL_MAX).optional(),
  mb: Text(LABEL_MAX).optional(),
});
export type DiagramLink = z.infer<typeof LinkSchema>;

export const SceneSchema = z
  .strictObject({
    nodes: z.array(NodeSchema).max(MAX_NODES),
    links: z.array(LinkSchema).max(MAX_LINKS),
  })
  .superRefine((scene, ctx) => {
    const ids = new Set<string>();
    for (const item of [...scene.nodes, ...scene.links]) {
      if (ids.has(item.id)) ctx.addIssue({ code: "custom", message: "diagram.duplicate_id" });
      ids.add(item.id);
    }
    const nodes = new Set(scene.nodes.map((n) => n.id));
    for (const l of scene.links) {
      if (!nodes.has(l.a) || !nodes.has(l.b)) ctx.addIssue({ code: "custom", message: "diagram.dangling_link" });
    }
    const ink = scene.nodes.reduce((n, node) => n + (node.pts?.length ?? 0), 0);
    if (ink > MAX_INK_POINTS) ctx.addIssue({ code: "custom", message: "diagram.too_much_ink" });
    if (textLength(scene) > MAX_TEXT) ctx.addIssue({ code: "custom", message: "diagram.too_much_text" });
    for (const n of scene.nodes) if (!fieldsFit(n)) ctx.addIssue({ code: "custom", message: "diagram.field_type" });
  });

/** Every character of every text of a scene. */
export function textLength(scene: { nodes: readonly DiagramNode[]; links: readonly DiagramLink[] }): number {
  let n = 0;
  for (const node of scene.nodes) n += (node.name?.length ?? 0) + (node.stereo?.length ?? 0) + (node.body ?? []).reduce((k, l) => k + l.length, 0);
  for (const l of scene.links) n += (l.name?.length ?? 0) + (l.ma?.length ?? 0) + (l.mb?.length ?? 0);
  return n;
}

/** A field only on the types that use it: a stereotype on a class, points on a stroke, a flag on an automaton state. */
function fieldsFit(n: DiagramNode): boolean {
  const is = (...types: NodeType[]): boolean => types.includes(n.t);
  return (
    (n.stereo === undefined && n.abstract === undefined ? true : is("class")) &&
    (n.body === undefined || is("class", "entity", "state")) &&
    (n.pts === undefined ? !is("stroke", "line") : is("stroke", "line")) &&
    (n.initial === undefined && n.accept === undefined ? true : is("astate"))
  );
}
export type Scene = z.infer<typeof SceneSchema>;

export const emptyScene = (): Scene => ({ nodes: [], links: [] });

/**
 * A fresh opaque id: eight base-36 characters. `crypto.getRandomValues`
 * exists in every browser and in Node since 19.
 */
export function newId(): string {
  const bytes = new Uint8Array(8);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => (b % 36).toString(36)).join("");
}

/**
 * Whether two scenes say the same thing, element for element and link for
 * link, in the same order: an untouched starter is no answer.
 */
export function sameScene(a: Scene, b: Scene): boolean {
  return JSON.stringify(canonical(a)) === JSON.stringify(canonical(b));
}

/** A scene with its keys in one order and its absent fields dropped. */
function canonical(scene: Scene): unknown {
  const sorted = (o: object): Record<string, unknown> =>
    Object.fromEntries(
      Object.entries(o)
        .filter(([, v]) => v !== undefined)
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)),
    );
  return { nodes: scene.nodes.map(sorted), links: scene.links.map(sorted) };
}
