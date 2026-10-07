/**
 * The diagram editor: the React port of `mockups/uml.html` (ADR-046).
 *
 * It is CONTROLLED. Every committed edit — an element placed, a drag let go
 * of, a link finished, a character typed in the inspector or the text pane,
 * an undo — calls `onChange` with a new scene. What is transient stays here:
 * the tool, the selection, the link being drawn, the view, and the scene of
 * a drag in progress, which is committed when the pointer is released (a
 * drag is one save and one undo step, not a hundred).
 *
 * The keyboard is scoped to the editor, never the window: several editors
 * may sit on one page, and the app has shortcuts of its own.
 *
 * This file is the pointer and keyboard dispatch. The view is
 * `useViewport`, the edits are the pure functions of `ops.ts`, the markup
 * is `Toolbar`, `Overlay` and `Inspector`.
 */
import { fmt, resolveStrings, type CanvasShortcut, type CanvasShortcutsListener } from "@quiz/core/client";
import { useCanvasShortcuts, useHistory } from "@quiz/ui";
import { useCallback, useId, useMemo, useRef, useState, type JSX, type KeyboardEvent, type PointerEvent } from "react";

import { BODIED, INK, KINDS, NAMELESS, RESIZABLE, kindIssues, typeOfTool, type DiagramKind, type PlaceTool } from "../kinds.js";
import { HEAD, bodyLineAt, drawOrder, rectOf, snap, type Bounds } from "../geometry.js";
import { bounds, layout, type LinkLike } from "../layout.js";
import { SceneSchema, type Point, type Scene } from "../scene.js";
import { Inspector, type FocusRequest } from "./Inspector.js";
import {
  addElement,
  addInk,
  addLink,
  carried,
  duplicateSelection,
  elementAt,
  hasRoom,
  hintFor,
  inBand,
  insertElbow,
  moveBy,
  moveElbow,
  newElement,
  removeElbow,
  removeSelection,
  resizeTo,
  reverseSelection,
  type Hit,
} from "./ops.js";
import { Handles, Overlay } from "./Overlay.js";
import { LinkShape, NodeShape } from "./shapes.js";
import { diagramStrings, type DiagramStrings } from "./strings.js";
import { cx, drawingArea, frame, gridMajor, gridMinor, inkNormal, inkSelected, statusLine } from "./styles.js";
import { TextPane } from "./TextPane.js";
import { Toolbar, type Mode } from "./Toolbar.js";
import { useMeasure } from "./useMeasure.js";
import { useViewport, type View } from "./useViewport.js";

export interface DiagramEditorProps {
  kind: DiagramKind;
  value: Scene;
  /** Every committed edit. */
  onChange: (next: Scene) => void;
  /** View, pan and zoom only. */
  readOnly?: boolean | undefined;
  /** The text tab, for the teacher (ADR-046 §4). */
  withText?: boolean | undefined;
  strings?: Partial<DiagramStrings> | undefined;
  /** The drawing area's height in px; absent, the editor fills its parent. */
  height?: number | undefined;
  id?: string | undefined;
  "aria-label"?: string | undefined;
  /** The host's shortcut zone (`EditorProps.onCanvasShortcuts`); never called when read-only. */
  onShortcuts?: CanvasShortcutsListener | undefined;
}

interface Draft {
  a: string;
  via: Point[];
  /** Started from a border in select mode: back to select when done. */
  back: boolean;
}

/** A pointer gesture in progress. It lives in a ref: it changes on every move and is read back on release. */
type Drag =
  | { kind: "pan"; x: number; y: number; start: View; moved: boolean; button: number }
  | { kind: "move"; x: number; y: number; base: Scene; ids: Set<string>; moved: boolean; collapse: string | null }
  | { kind: "band"; x: number; y: number; to: Point; base: Set<string> }
  | { kind: "via"; link: string; index: number; base: Scene; moved: boolean }
  | { kind: "resize"; id: string; base: Scene; moved: boolean }
  | { kind: "link"; x: number; y: number; moved: boolean }
  | { kind: "ink"; t: "stroke" | "line"; pts: Array<[number, number]> };

/**
 * What the host's shortcut zone shows for this keyboard (issue #549): the
 * `shortcuts` and `withModifier` records of the editor, grouped into four
 * lines, in the `CanvasShortcut` spelling (`Mod` is Ctrl or ⌘). `1–9` is one
 * line: the tools are the kind's. `DiagramEditor.test.tsx` holds it against
 * the handlers, both ways.
 */
export const SHORTCUT_LINES = [
  { keys: ["Mod+Z", "Mod+Y"], label: "shortcutUndoRedo" },
  { keys: ["I"], label: "swap" },
  { keys: ["1–9"], label: "shortcutTool" },
  { keys: ["Del"], label: "remove" },
] as const satisfies ReadonlyArray<{ keys: readonly string[]; label: keyof DiagramStrings }>;

/**
 * Bound but not shown: the aliases of a shown key (Backspace, Ctrl+Shift+Z)
 * and three the toolbar or the status line already teach (duplicate, select
 * all, Escape).
 */
export const UNLISTED_KEYS = ["Backspace", "Mod+Shift+Z", "Mod+D", "Mod+A", "Esc"] as const;

const shortcutLines = (s: DiagramStrings): CanvasShortcut[] =>
  SHORTCUT_LINES.map((line) => ({ keys: line.keys, label: s[line.label] }));

/** A key typed in the inspector or the text pane is the field's, not the editor's. */
const isTextField = (target: EventTarget | null): boolean =>
  target instanceof Element && target.matches("input, textarea, select");

/** Two presses this close in time and space are a double click. */
const DOUBLE_MS = 380;
const DOUBLE_PX = 6;

export function DiagramEditor(props: DiagramEditorProps): JSX.Element {
  const { kind, value, onChange, readOnly = false, withText = false, height } = props;
  const s = useMemo(() => resolveStrings<DiagramStrings>(diagramStrings, props.strings), [props.strings]);
  const spec = KINDS[kind];
  const gridId = useId();
  const rootRef = useRef<HTMLDivElement>(null);
  const svgRef = useRef<SVGSVGElement>(null);
  const history = useHistory<Scene>();
  const measure = useMeasure(svgRef);

  const [pane, setPane] = useState<"draw" | "text">("draw");
  const [mode, setMode] = useState<Mode>({ kind: "select" });
  const [selection, setSelection] = useState<Set<string>>(new Set());
  const [draft, setDraft] = useState<Draft | null>(null);
  const [live, setLive] = useState<Scene | null>(null);
  const [hover, setHover] = useState<Hit | null>(null);
  const [cursor, setCursor] = useState<Point & { inside: boolean }>({ x: 0, y: 0, inside: false });
  const [focus, setFocus] = useState<FocusRequest>(null);
  const [, redraw] = useState(0);
  const drag = useRef<Drag | null>(null);
  const lastDown = useRef<{ t: number; x: number; y: number } | null>(null);
  const lastSession = useRef(0);

  const scene = live ?? value;
  const draftLink: LinkLike | undefined = useMemo(() => {
    if (!draft || mode.kind !== "link" || (hover?.id === draft.a && draft.via.length === 0)) return undefined;
    return { id: "__draft", type: mode.type, a: draft.a, b: hover ? hover.id : { x: cursor.x, y: cursor.y }, via: draft.via };
  }, [draft, mode, hover, cursor]);
  const lay = useMemo(() => layout(scene, kind, measure, draftLink), [scene, kind, measure, draftLink]);
  const { rects, routes } = lay;
  const { view, toWorld, panFrom } = useViewport(svgRef, useMemo(() => bounds(lay), [lay]));
  const band = Math.max(4, 6 / view.k);

  /**
   * A committed edit: one undo step, unless it continues the same field's
   * session. An edit that would make a valid scene invalid is dropped: the
   * answer schema would refuse it at the next save, out of the student's sight.
   */
  const commit = useCallback(
    (next: Scene, previous: Scene = value, session = 0) => {
      if (next === previous || (!fits(next, kind) && fits(previous, kind))) return;
      if (session === 0 || session !== lastSession.current) history.push(previous);
      lastSession.current = session;
      onChange(next);
    },
    [history, onChange, value, kind],
  );
  const select = (ids: Iterable<string>): void => setSelection(new Set(ids));
  const changeMode = (m: Mode): void => {
    setDraft(null);
    setMode(m);
  };

  const placeAt = (tool: PlaceTool, at: Point): boolean => {
    if (!hasRoom(value, kind)) return false;
    const n = newElement(value, tool, at, measure, s);
    commit(addElement(value, kind, n));
    select([n.id]);
    return true;
  };
  const finishLink = (b: string): void => {
    if (!draft || mode.kind !== "link") return;
    const added = addLink(value, mode.type, draft.a, b, draft.via);
    if (added) {
      commit(added.scene);
      select([added.id]);
    }
    if (draft.back) setMode({ kind: "select" });
    setDraft(null);
  };
  const cancelDraft = (): void => {
    if (draft?.back) setMode({ kind: "select" });
    setDraft(null);
  };
  const restore = (to: Scene | undefined): void => {
    if (!to) return;
    onChange(to);
    setSelection(new Set());
  };
  const undo = (): void => restore(history.undo(value));
  const redo = (): void => restore(history.redo(value));
  const remove = (): void => {
    if (selection.size === 0) return;
    commit(removeSelection(value, selection));
    setSelection(new Set());
  };
  const duplicate = (): void => {
    const copy = duplicateSelection(value, kind, selection);
    if (!copy) return;
    commit(copy.scene);
    setSelection(copy.ids);
  };
  const reverse = (): void => commit(reverseSelection(value, selection));
  /**
   * Cancels what is in progress, innermost first: the link being drawn, the
   * tool, the selection. `false` when there was nothing to cancel, so the key
   * is left to whoever holds the editor — the student's expand layer closes
   * on it (ADR-046 addendum).
   */
  const escape = (): boolean => {
    if (draft) cancelDraft();
    else if (mode.kind !== "select") setMode({ kind: "select" });
    else if (selection.size > 0) setSelection(new Set());
    else return false;
    return true;
  };

  const doubleClick = (target: Element, w: Point): void => {
    const onLink = target.closest("[data-link]");
    if (onLink) {
      const id = onLink.getAttribute("data-link") ?? "";
      const route = routes.get(id);
      if (route) commit(insertElbow(value, id, route, { x: snap(w.x), y: snap(w.y) }));
      select([id]);
      return;
    }
    const hit = elementAt(value, rects, w.x, w.y, band);
    const n = hit && value.nodes.find((x) => x.id === hit.id);
    if (n) {
      if (NAMELESS.has(n.t)) return;
      select([n.id]);
      const ly = w.y - n.y;
      setFocus(BODIED.has(n.t) && ly >= HEAD ? { field: "body", line: bodyLineAt(n, ly) } : { field: "name" });
      return;
    }
    if (spec.dbl && placeAt(spec.dbl, w)) setFocus({ field: "name" });
  };

  const onPointerDown = (e: PointerEvent<SVGSVGElement>): void => {
    const w = toWorld(e);
    setCursor({ x: snap(w.x), y: snap(w.y), inside: w.inside });
    rootRef.current?.focus({ preventScroll: true });
    try {
      e.currentTarget.setPointerCapture(e.pointerId);
    } catch {
      /* jsdom has no pointer capture */
    }
    if (e.button === 1 || e.button === 2 || readOnly) {
      e.preventDefault();
      drag.current = { kind: "pan", x: e.clientX, y: e.clientY, start: view, moved: false, button: e.button };
      return;
    }
    if (e.button !== 0) return;
    const target = e.target as Element;
    const now = performance.now();
    const last = lastDown.current;
    const dbl = last !== null && now - last.t < DOUBLE_MS && Math.hypot(e.clientX - last.x, e.clientY - last.y) < DOUBLE_PX;
    lastDown.current = dbl ? null : { t: now, x: e.clientX, y: e.clientY };

    if (mode.kind === "place") {
      const t = typeOfTool(mode.tool);
      if (t === "stroke" || t === "line") {
        const p: [number, number] = t === "line" ? [snap(w.x), snap(w.y)] : [w.x, w.y];
        drag.current = { kind: "ink", t, pts: [p, [p[0], p[1]]] };
      } else placeAt(mode.tool, w);
      return;
    }
    const resize = target.closest("[data-resize]");
    if (resize) {
      drag.current = { kind: "resize", id: resize.getAttribute("data-resize") ?? "", base: value, moved: false };
      return;
    }
    const via = target.closest("[data-via]");
    if (via) {
      const link = via.getAttribute("data-via-link") ?? "";
      const index = Number(via.getAttribute("data-via"));
      if (dbl) commit(removeElbow(value, link, index));
      else drag.current = { kind: "via", link, index, base: value, moved: false };
      return;
    }
    if (dbl && mode.kind === "select" && !e.shiftKey) {
      doubleClick(target, w);
      return;
    }
    if (mode.kind === "link") {
      linkClick(elementAt(value, rects, w.x, w.y, band, false), w);
      return;
    }
    const hit = elementAt(value, rects, w.x, w.y, band);
    const onLink = target.closest("[data-link]");
    const first = spec.links[0];
    if (hit?.edge && !onLink && !e.shiftKey && first) {
      /* a press on a border starts a link of the kind's first type */
      setMode({ kind: "link", type: first });
      setDraft({ a: hit.id, via: [], back: true });
      drag.current = { kind: "link", x: w.x, y: w.y, moved: false };
      return;
    }
    const id = onLink ? onLink.getAttribute("data-link") : (hit?.id ?? null);
    if (id) {
      const was = selection.has(id);
      const next = new Set(e.shiftKey || was ? selection : []);
      if (e.shiftKey && was) next.delete(id);
      else next.add(id);
      setSelection(next);
      if (next.has(id)) drag.current = { kind: "move", x: w.x, y: w.y, base: value, ids: carried(value, next, measure), moved: false, collapse: !e.shiftKey && was ? id : null };
      return;
    }
    const base = e.shiftKey ? new Set(selection) : new Set<string>();
    if (!e.shiftKey) setSelection(new Set());
    drag.current = { kind: "band", x: w.x, y: w.y, to: w, base };
  };

  const linkClick = (hit: Hit | null, w: Point): void => {
    if (!draft) {
      if (hit) {
        setDraft({ a: hit.id, via: [], back: false });
        drag.current = { kind: "link", x: w.x, y: w.y, moved: false };
      }
      return;
    }
    if (hit) {
      if (hit.id !== draft.a || draft.via.length > 0) finishLink(hit.id);
      return;
    }
    const p = { x: snap(w.x), y: snap(w.y) };
    const lv = draft.via[draft.via.length - 1];
    if (!lv || lv.x !== p.x || lv.y !== p.y) setDraft({ ...draft, via: [...draft.via, p] });
  };

  const onPointerMove = (e: PointerEvent<SVGSVGElement>): void => {
    const w = toWorld(e);
    const c = { x: snap(w.x), y: snap(w.y) };
    setCursor({ ...c, inside: w.inside });
    const d = drag.current;
    if (!d || d.kind === "link") {
      const linking = mode.kind === "link" || d?.kind === "link";
      setHover(w.inside && mode.kind !== "place" ? elementAt(value, rects, w.x, w.y, band, !linking) : null);
    }
    if (!d) return;
    switch (d.kind) {
      case "pan":
        d.moved ||= Math.abs(e.clientX - d.x) + Math.abs(e.clientY - d.y) > 3;
        panFrom(d.start, e.clientX - d.x, e.clientY - d.y);
        return;
      case "move": {
        const dx = snap(w.x - d.x);
        const dy = snap(w.y - d.y);
        d.moved ||= dx !== 0 || dy !== 0;
        setLive(moveBy(d.base, d.ids, selection, dx, dy));
        return;
      }
      case "band":
        d.to = w;
        setSelection(new Set([...d.base, ...inBand(value, rects, routes, boundsOf(d, w))]));
        return;
      case "via":
        d.moved = true;
        setLive(moveElbow(d.base, d.link, d.index, c));
        return;
      case "resize":
        d.moved = true;
        setLive(resizeTo(d.base, d.id, c));
        return;
      case "link":
        d.moved ||= Math.hypot(w.x - d.x, w.y - d.y) > 8;
        return;
      case "ink": {
        const lastPt = d.pts[d.pts.length - 1] ?? [w.x, w.y];
        if (d.t === "line") d.pts[1] = [c.x, c.y];
        else if (Math.hypot(w.x - lastPt[0], w.y - lastPt[1]) > 3) d.pts.push([w.x, w.y]);
        redraw((n) => n + 1);
        return;
      }
    }
  };

  const onPointerUp = (e: PointerEvent<SVGSVGElement>): void => {
    const d = drag.current;
    drag.current = null;
    redraw((n) => n + 1);
    if (!d) return;
    switch (d.kind) {
      case "pan":
        /* a right click that did not pan steps back */
        if (!d.moved && d.button === 2) {
          if (draft && draft.via.length > 0) setDraft({ ...draft, via: draft.via.slice(0, -1) });
          else escape();
        }
        return;
      case "move":
      case "via":
      case "resize":
        if (d.moved && live) commit(live, d.base);
        else if (d.kind === "move" && d.collapse && !e.shiftKey) setSelection(new Set([d.collapse]));
        setLive(null);
        return;
      case "link":
        /* a drag from an element: released on another one links them, on the grid drops the drawing */
        if (d.moved && draft) {
          if (hover && hover.id !== draft.a) finishLink(hover.id);
          else if (!hover) cancelDraft();
        }
        return;
      case "ink":
        commit(addInk(value, kind, d.t, d.t === "stroke" ? d.pts.slice(1) : d.pts));
        return;
      case "band":
        return;
    }
  };

  const tools = [...spec.tools.map((tool): Mode => ({ kind: "place", tool })), ...spec.links.map((type): Mode => ({ kind: "link", type }))];
  /** A shortcut returns `false` when it did nothing: the key is then not consumed. */
  const shortcuts: Readonly<Record<string, () => void | boolean>> = {
    Delete: remove,
    Backspace: remove,
    Escape: escape,
    i: reverse,
    I: reverse,
  };
  const withModifier: Readonly<Record<string, (shift: boolean) => void>> = {
    z: (shift) => (shift ? redo() : undo()),
    y: redo,
    d: duplicate,
    a: () => select([...value.nodes, ...value.links].map((x) => x.id)),
  };
  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>): void => {
    if (isTextField(e.target) || readOnly || pane !== "draw") return;
    const run = e.ctrlKey || e.metaKey ? withModifier[e.key.toLowerCase()]?.bind(null, e.shiftKey) : shortcuts[e.key];
    const tool = !e.ctrlKey && !e.metaKey && /^[1-9]$/.test(e.key) ? tools[Number(e.key) - 1] : undefined;
    if (run) {
      if (run() === false) return;
    } else if (tool) changeMode(tool);
    else return;
    e.preventDefault();
  };

  /* what the inspector shows: exactly one element with a name, or one link */
  const only = selection.size === 1 ? [...selection][0] : undefined;
  const item = only ? (value.nodes.find((n) => n.id === only) ?? value.links.find((l) => l.id === only)) : undefined;
  const inspected = item && !("t" in item && NAMELESS.has(item.t)) ? item : undefined;
  const sized = item && "t" in item && RESIZABLE.has(item.t) ? scene.nodes.find((n) => n.id === item.id) : undefined;

  const d = drag.current;
  const edgeHover = mode.kind === "select" && hover?.edge === true && !d && spec.links.length > 0;
  const highlight = new Set<string>();
  if (hover && (mode.kind === "link" || draft || edgeHover)) highlight.add(hover.id);
  if (draft) highlight.add(draft.a);
  const ghost = mode.kind === "place" && cursor.inside && !INK.has(typeOfTool(mode.tool)) ? newElement(value, mode.tool, cursor, measure, s) : null;
  const shortcutFocus = useCanvasShortcuts({
    publish: props.onShortcuts,
    list: shortcutLines(s),
    enabled: !readOnly && pane === "draw",
    isTextField,
  });
  const hint = s[
    hintFor({ mode: mode.kind, tool: mode.kind === "place" ? mode.tool : null, drawing: draft !== null, selected: selection.size, kind })
  ];

  return (
    <div
      ref={rootRef}
      id={props.id}
      className={cx(frame, "relative flex flex-col outline-none", height === undefined && "h-full")}
      tabIndex={-1}
      onKeyDown={onKeyDown}
      {...shortcutFocus}
      aria-label={props["aria-label"] ?? s.canvas}
      role="group"
    >
      {!readOnly && (
        <Toolbar
          kind={kind}
          mode={mode}
          onMode={changeMode}
          pane={pane}
          onPane={
            withText
              ? (p) => {
                  setPane(p);
                  changeMode({ kind: "select" });
                }
              : null
          }
          canUndo={history.canUndo}
          canRedo={history.canRedo}
          canDuplicate={value.nodes.some((n) => selection.has(n.id))}
          canRemove={selection.size > 0}
          onUndo={undo}
          onRedo={redo}
          onDuplicate={duplicate}
          onRemove={remove}
          strings={s}
        />
      )}

      {pane === "text" ? (
        <TextPane kind={kind} scene={value} measure={measure} onEdit={(next, session) => commit(next, value, session)} strings={s} height={height} />
      ) : (
        <div className={cx("relative", height === undefined && "min-h-0 flex-1")} style={height === undefined ? undefined : { height }}>
          <svg
            ref={svgRef}
            className={cx(drawingArea, "h-full", mode.kind === "link" || edgeHover ? "cursor-crosshair" : mode.kind === "place" && "cursor-copy")}
            onPointerDown={onPointerDown}
            onPointerMove={onPointerMove}
            onPointerUp={onPointerUp}
            onPointerLeave={() => setCursor((c) => ({ ...c, inside: false }))}
            onContextMenu={(e) => e.preventDefault()}
            role="img"
            aria-label={props["aria-label"] ?? s.canvas}
          >
            <defs>
              <pattern id={`${gridId}-minor`} width={20} height={20} patternUnits="userSpaceOnUse">
                <path className={gridMinor} d="M20 0H0V20" />
              </pattern>
              <pattern id={`${gridId}-major`} width={100} height={100} patternUnits="userSpaceOnUse">
                <rect width={100} height={100} fill={`url(#${gridId}-minor)`} />
                <path className={gridMajor} d="M100 0H0V100" />
              </pattern>
            </defs>
            <g transform={`translate(${view.x} ${view.y}) scale(${view.k})`}>
              <rect x={-20000} y={-20000} width={40000} height={40000} fill={`url(#${gridId}-major)`} />
              {drawOrder(scene.nodes).map((n) => (
                <g key={n.id} className={selection.has(n.id) ? inkSelected : inkNormal}>
                  <NodeShape node={n} measure={measure} selected={selection.has(n.id)} />
                </g>
              ))}
              {scene.links.map((l) => {
                const route = routes.get(l.id);
                return route ? (
                  <g key={l.id} className={selection.has(l.id) ? inkSelected : inkNormal}>
                    <LinkShape link={l} route={route} selected={selection.has(l.id)} id={l.id} />
                  </g>
                ) : null;
              })}
              <Overlay
                highlight={highlight}
                rects={rects}
                draft={draftLink ? { type: draftLink.type, route: routes.get("__draft"), via: draftLink.via } : null}
                ghost={ghost}
                measure={measure}
                ink={d?.kind === "ink" ? d : null}
                band={d?.kind === "band" ? boundsOf(d, d.to) : null}
              />
              {!readOnly && (
                <Handles
                  elbows={scene.links.filter((l) => selection.has(l.id) && l.via).map((l) => ({ link: l.id, via: l.via ?? [] }))}
                  corner={sized ? { id: sized.id, r: rectOf(sized, measure) } : null}
                />
              )}
            </g>
          </svg>
          {!readOnly && inspected && (
            <Inspector
              kind={kind}
              scene={value}
              item={inspected}
              onEdit={(next, session) => commit(next, value, session)}
              onReverse={reverse}
              focus={focus}
              onFocused={() => setFocus(null)}
              strings={s}
            />
          )}
        </div>
      )}
      {!readOnly && pane === "draw" && (
        <p className={statusLine} aria-live="polite">
          <span className="min-w-0 flex-1 truncate">{hint}</span>
          <span className="font-mono tabular-nums">{fmt("{k} %", { k: Math.round(view.k * 100) })}</span>
        </p>
      )}
    </div>
  );
}

const fits = (scene: Scene, kind: DiagramKind): boolean => SceneSchema.safeParse(scene).success && kindIssues(scene, kind).length === 0;

/** The rubber band from where the press began to a point. */
const boundsOf = (from: Point, to: Point): Bounds => ({
  x0: Math.min(from.x, to.x),
  y0: Math.min(from.y, to.y),
  x1: Math.max(from.x, to.x),
  y1: Math.max(from.y, to.y),
});
