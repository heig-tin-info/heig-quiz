/**
 * The diagram editor: the React port of `mockups/uml.html` (ADR-041).
 *
 * It is CONTROLLED. Every committed edit — an element placed, a drag let go
 * of, a link finished, a character typed in the inspector or the text pane,
 * an undo — calls `onChange` with a new scene. What is transient stays here:
 * the tool, the selection, the link being drawn, the view, and the scene of
 * a drag in progress, which is committed when the pointer is released (so a
 * drag is one save and one undo step, not a hundred).
 *
 * The keyboard is scoped to the editor, never the window: several editors
 * may sit on one page, and the app has shortcuts of its own.
 */
import { fmt, resolveStrings } from "@quiz/core/client";
import {
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type JSX,
  type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent as ReactPointerEvent,
} from "react";

import { BODIED, INK, KINDS, NAMELESS, RESIZABLE, typeOfTool, type DiagramKind, type PlaceTool } from "../kinds.js";
import { HEAD, PAD, ROW, bodyCompartments, rectOf, snap, type Measure, type Rect } from "../geometry.js";
import { layout, type LinkLike } from "../layout.js";
import type { DiagramNode, LinkType, Point, Scene } from "../scene.js";
import { Inspector, type FocusRequest } from "./Inspector.js";
import { canvasMeasure } from "./measure.js";
import {
  addLink,
  carried,
  duplicateSelection,
  elementAt,
  inBand,
  inkElement,
  insertElbow,
  moveBy,
  newElement,
  patchItem,
  removeElbow,
  removeSelection,
  reverseSelection,
  type Hit,
  type NewNames,
} from "./ops.js";
import { LinkIcon, LinkShape, NodeShape, ToolIcon, inkPath } from "./shapes.js";
import { diagramStrings, linkKey, toolKey, type DiagramStrings } from "./strings.js";
import {
  cx,
  draftLine,
  drawingArea,
  frame,
  gridMajor,
  gridMinor,
  handle,
  hoverFrame,
  iconButton,
  inkNormal,
  inkSelected,
  lineButton,
  marquee,
  separator,
  statusLine,
  toolbar,
} from "./styles.js";
import { TextPane } from "./TextPane.js";
import { useHistory } from "./useHistory.js";

export interface DiagramEditorProps {
  kind: DiagramKind;
  value: Scene;
  /** Every committed edit. */
  onChange: (next: Scene) => void;
  /** View, pan and zoom only. */
  readOnly?: boolean | undefined;
  /** The text tab, for the teacher (ADR-041 §4). */
  withText?: boolean | undefined;
  strings?: Partial<DiagramStrings> | undefined;
  /** The drawing area's height in px; absent, the editor fills its parent. */
  height?: number | undefined;
  id?: string | undefined;
  "aria-label"?: string | undefined;
}

type Mode = { kind: "select" } | { kind: "place"; tool: PlaceTool } | { kind: "link"; type: LinkType };

interface Draft {
  a: string;
  via: Point[];
  /** Started from a border in select mode: back to select when done. */
  back: boolean;
}

type Drag =
  | { kind: "pan"; cx: number; cy: number; vx: number; vy: number; moved: boolean; button: number }
  | { kind: "move"; sx: number; sy: number; base: Scene; ids: Set<string>; moved: boolean; collapse: string | null }
  | { kind: "box"; x0: number; y0: number; x1: number; y1: number; base: Set<string> }
  | { kind: "via"; link: string; index: number; base: Scene; moved: boolean }
  | { kind: "resize"; id: string; base: Scene; moved: boolean }
  | { kind: "link"; cx: number; cy: number; moved: boolean }
  | { kind: "ink"; t: "stroke" | "line"; pts: Array<[number, number]> };

interface View {
  x: number;
  y: number;
  k: number;
}

const DEFAULT_HEIGHT = 460;

export function DiagramEditor(props: DiagramEditorProps): JSX.Element {
  const { kind, value, onChange, readOnly = false, withText = false, height } = props;
  const s = useMemo(() => resolveStrings<DiagramStrings>(diagramStrings, props.strings), [props.strings]);
  const words: NewNames = useMemo(
    () => ({
      class: s["new.class"],
      actor: s["new.actor"],
      usecase: s["new.usecase"],
      system: s["new.system"],
      state: s["new.state"],
      entity: s["new.entity"],
      start: s["new.start"],
      end: s["new.end"],
      action: s["new.action"],
      decision: s["new.decision"],
    }),
    [s],
  );
  const spec = KINDS[kind];
  const gridId = useId();
  const rootRef = useRef<HTMLDivElement>(null);
  const svgRef = useRef<SVGSVGElement>(null);
  const history = useHistory<Scene>();

  const [measure, setMeasure] = useState<Measure>(() => canvasMeasure(null));
  useLayoutEffect(() => setMeasure(() => canvasMeasure(svgRef.current)), []);

  const [pane, setPane] = useState<"draw" | "text">("draw");
  const [view, setView] = useState<View>({ x: 40, y: 40, k: 1 });
  const [mode, setMode] = useState<Mode>({ kind: "select" });
  const [selection, setSelection] = useState<Set<string>>(new Set());
  const [draft, setDraft] = useState<Draft | null>(null);
  const [drag, setDrag] = useState<Drag | null>(null);
  const [live, setLive] = useState<Scene | null>(null);
  const [hover, setHover] = useState<Hit | null>(null);
  const [cursor, setCursor] = useState<Point & { inside: boolean }>({ x: 0, y: 0, inside: false });
  const [focus, setFocus] = useState<FocusRequest>(null);
  const lastDown = useRef<{ t: number; x: number; y: number } | null>(null);
  const lastSession = useRef(0);

  const scene = live ?? value;

  /* the drawn line of a link in progress, to a target or to the pointer */
  const draftLink: LinkLike | undefined = useMemo(() => {
    if (!draft || mode.kind !== "link") return undefined;
    if (hover && hover.id === draft.a && draft.via.length === 0) return undefined;
    return { id: "__draft", type: mode.type, a: draft.a, b: hover ? hover.id : { x: cursor.x, y: cursor.y }, via: draft.via };
  }, [draft, mode, hover, cursor]);
  const { rects, routes } = useMemo(() => layout(scene, kind, measure, draftLink), [scene, kind, measure, draftLink]);

  /* first view: the content fitted, at most at 100 % */
  const fitted = useRef(false);
  useLayoutEffect(() => {
    if (fitted.current || !svgRef.current) return;
    const box = svgRef.current.getBoundingClientRect();
    if (box.width === 0) return;
    fitted.current = true;
    const all = [...rects.values()];
    if (all.length === 0) return;
    const x0 = Math.min(...all.map((r) => r.x0)) - 40;
    const y0 = Math.min(...all.map((r) => r.y0)) - 40;
    const x1 = Math.max(...all.map((r) => r.x1)) + 40;
    const y1 = Math.max(...all.map((r) => r.y1)) + 40;
    const k = Math.min(1, box.width / (x1 - x0), box.height / (y1 - y0));
    setView({ k, x: (box.width - (x1 - x0) * k) / 2 - x0 * k, y: (box.height - (y1 - y0) * k) / 2 - y0 * k });
  }, [rects]);

  const band = Math.max(4, 6 / view.k);
  const toWorld = useCallback(
    (e: { clientX: number; clientY: number }): Point & { inside: boolean } => {
      const r = svgRef.current?.getBoundingClientRect();
      if (!r) return { x: 0, y: 0, inside: false };
      return {
        x: (e.clientX - r.left - view.x) / view.k,
        y: (e.clientY - r.top - view.y) / view.k,
        inside: e.clientX >= r.left && e.clientX <= r.right && e.clientY >= r.top && e.clientY <= r.bottom,
      };
    },
    [view],
  );

  /** A committed edit: one undo step, unless it continues the same field's session. */
  const commit = useCallback(
    (next: Scene, previous: Scene = value, session = 0) => {
      if (session === 0 || session !== lastSession.current) history.push(previous);
      lastSession.current = session;
      onChange(next);
    },
    [history, onChange, value],
  );

  const select = (ids: Iterable<string>): void => setSelection(new Set(ids));

  const placeAt = (tool: PlaceTool, at: Point): DiagramNode => {
    const n = newElement(value, tool, at, measure, words);
    commit({ ...value, nodes: [...value.nodes, n] });
    select([n.id]);
    return n;
  };

  const finishLink = (b: string): void => {
    if (!draft || mode.kind !== "link") return;
    const { scene: next, id } = addLink(value, mode.type, draft.a, b, draft.via);
    commit(next);
    select([id]);
    if (draft.back) setMode({ kind: "select" });
    setDraft(null);
  };
  const cancelDraft = (): void => {
    if (draft?.back) setMode({ kind: "select" });
    setDraft(null);
  };

  const undo = (): void => {
    const previous = history.undo(value);
    if (previous) {
      onChange(previous);
      setSelection(new Set());
    }
  };
  const redo = (): void => {
    const next = history.redo(value);
    if (next) {
      onChange(next);
      setSelection(new Set());
    }
  };
  const remove = (): void => {
    if (selection.size === 0) return;
    commit(removeSelection(value, selection));
    setSelection(new Set());
  };
  const duplicate = (): void => {
    if (![...selection].some((id) => value.nodes.some((n) => n.id === id))) return;
    const { scene: next, ids } = duplicateSelection(value, selection);
    commit(next);
    setSelection(ids);
  };
  const reverse = (): void => {
    if (![...selection].some((id) => value.links.some((l) => l.id === id))) return;
    commit(reverseSelection(value, selection));
  };

  /* the wheel zooms around the pointer; React's wheel listener is passive */
  useEffect(() => {
    const el = svgRef.current;
    if (!el) return undefined;
    const onWheel = (e: WheelEvent): void => {
      e.preventDefault();
      const r = el.getBoundingClientRect();
      const sx = e.clientX - r.left;
      const sy = e.clientY - r.top;
      setView((v) => {
        const k = Math.min(4, Math.max(0.25, v.k * Math.exp(-e.deltaY * 0.0015)));
        return { k, x: sx - ((sx - v.x) * k) / v.k, y: sy - ((sy - v.y) * k) / v.k };
      });
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  }, []);

  const doubleClick = (target: Element, w: Point): void => {
    const onLink = target.closest("[data-link]");
    if (onLink && !target.closest("[data-via]")) {
      const id = onLink.getAttribute("data-link") ?? "";
      const route = routes.get(id);
      if (route) {
        commit(insertElbow(value, id, route, { x: snap(w.x), y: snap(w.y) }));
        select([id]);
      }
      return;
    }
    const hit = elementAt(value, rects, w.x, w.y, band);
    if (hit) {
      const n = value.nodes.find((x) => x.id === hit.id);
      if (!n || NAMELESS.has(n.t) || INK.has(n.t)) return;
      select([n.id]);
      const ly = w.y - n.y;
      if (!BODIED.has(n.t) || ly < HEAD) {
        setFocus({ field: "name" });
        return;
      }
      /* the body line under the pointer: walk the compartments, counting the `---` between them */
      let y = HEAD;
      let start = 0;
      let line = Math.max(0, (n.body ?? []).length - 1);
      for (const c of bodyCompartments(n)) {
        const end = y + c.length * ROW + PAD;
        if (ly < end) {
          line = start + Math.max(0, Math.min(c.length - 1, Math.floor((ly - y - PAD / 2) / ROW)));
          break;
        }
        y = end;
        start += c.length + 1;
      }
      setFocus({ field: "body", line });
      return;
    }
    if (target.closest("[data-via]") || !spec.dbl) return;
    placeAt(spec.dbl, w);
    setFocus({ field: "name" });
  };

  const onPointerDown = (e: ReactPointerEvent<SVGSVGElement>): void => {
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
      setDrag({ kind: "pan", cx: e.clientX, cy: e.clientY, vx: view.x, vy: view.y, moved: false, button: e.button });
      return;
    }
    if (e.button !== 0) return;
    const target = e.target as Element;
    const now = performance.now();
    const last = lastDown.current;
    const dbl = last !== null && now - last.t < 380 && Math.hypot(e.clientX - last.x, e.clientY - last.y) < 6;
    lastDown.current = dbl ? null : { t: now, x: e.clientX, y: e.clientY };

    if (mode.kind === "place") {
      const t = typeOfTool(mode.tool);
      if (t === "stroke" || t === "line") {
        const p: [number, number] = t === "line" ? [snap(w.x), snap(w.y)] : [w.x, w.y];
        setDrag({ kind: "ink", t, pts: [p, [p[0], p[1]]] });
      } else placeAt(mode.tool, w);
      return;
    }
    const resize = target.closest("[data-resize]");
    if (resize) {
      setDrag({ kind: "resize", id: resize.getAttribute("data-resize") ?? "", base: value, moved: false });
      return;
    }
    const via = target.closest("[data-via]");
    if (via && mode.kind === "select") {
      const link = via.getAttribute("data-via-link") ?? "";
      const index = Number(via.getAttribute("data-via"));
      if (dbl) {
        commit(removeElbow(value, link, index));
        return;
      }
      setDrag({ kind: "via", link, index, base: value, moved: false });
      return;
    }
    if (dbl && mode.kind === "select" && !e.shiftKey) {
      doubleClick(target, w);
      return;
    }
    if (mode.kind === "link") {
      const hit = elementAt(value, rects, w.x, w.y, band, false);
      if (!draft) {
        if (hit) {
          setDraft({ a: hit.id, via: [], back: false });
          setDrag({ kind: "link", cx: w.x, cy: w.y, moved: false });
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
      return;
    }
    const hit = elementAt(value, rects, w.x, w.y, band);
    const onLink = target.closest("[data-link]");
    const first = spec.links[0];
    if (hit?.edge && !onLink && !e.shiftKey && first) {
      setMode({ kind: "link", type: first });
      setDraft({ a: hit.id, via: [], back: true });
      setDrag({ kind: "link", cx: w.x, cy: w.y, moved: false });
      return;
    }
    const id = onLink ? onLink.getAttribute("data-link") : hit ? hit.id : null;
    if (id) {
      const was = selection.has(id);
      const next = new Set(selection);
      if (e.shiftKey) {
        if (was) next.delete(id);
        else next.add(id);
      } else if (!was) {
        next.clear();
        next.add(id);
      }
      setSelection(next);
      if (next.has(id))
        setDrag({ kind: "move", sx: w.x, sy: w.y, base: value, ids: carried(value, next, measure), moved: false, collapse: !e.shiftKey && was ? id : null });
      return;
    }
    const base = e.shiftKey ? new Set(selection) : new Set<string>();
    if (!e.shiftKey) setSelection(new Set());
    setDrag({ kind: "box", x0: w.x, y0: w.y, x1: w.x, y1: w.y, base });
  };

  const onPointerMove = (e: ReactPointerEvent<SVGSVGElement>): void => {
    const w = toWorld(e);
    const c = { x: snap(w.x), y: snap(w.y), inside: w.inside };
    setCursor(c);
    if (!drag || drag.kind === "link") {
      const linking = mode.kind === "link" || drag?.kind === "link";
      setHover(w.inside && mode.kind !== "place" ? elementAt(value, rects, w.x, w.y, band, !linking) : null);
    }
    if (!drag) return;
    switch (drag.kind) {
      case "pan": {
        const dx = e.clientX - drag.cx;
        const dy = e.clientY - drag.cy;
        if (Math.abs(dx) + Math.abs(dy) > 3) drag.moved = true;
        setView((v) => ({ ...v, x: drag.vx + dx, y: drag.vy + dy }));
        return;
      }
      case "move": {
        const dx = snap(w.x - drag.sx);
        const dy = snap(w.y - drag.sy);
        if (dx !== 0 || dy !== 0) drag.moved = true;
        setLive(moveBy(drag.base, drag.ids, selection, dx, dy));
        return;
      }
      case "box": {
        const next = { ...drag, x1: w.x, y1: w.y };
        setDrag(next);
        const r: Rect = {
          x0: Math.min(next.x0, next.x1),
          y0: Math.min(next.y0, next.y1),
          x1: Math.max(next.x0, next.x1),
          y1: Math.max(next.y0, next.y1),
          w: 0,
          h: 0,
        };
        setSelection(new Set([...next.base, ...inBand(value, rects, routes, r)]));
        return;
      }
      case "via": {
        drag.moved = true;
        setLive(
          patchItem(drag.base, drag.link, {
            via: (drag.base.links.find((l) => l.id === drag.link)?.via ?? []).map((v, i) => (i === drag.index ? { x: c.x, y: c.y } : v)),
          }),
        );
        return;
      }
      case "resize": {
        const n = drag.base.nodes.find((x) => x.id === drag.id);
        if (!n) return;
        const min = n.t === "system" ? [160, 120] : [20, 20];
        let nw = Math.max(min[0] ?? 20, c.x - n.x);
        let nh = Math.max(min[1] ?? 20, c.y - n.y);
        if (n.t === "square" || n.t === "circle") nw = nh = Math.max(nw, nh);
        drag.moved = true;
        setLive(patchItem(drag.base, drag.id, { w: nw, h: nh }));
        return;
      }
      case "link":
        if (Math.hypot(w.x - drag.cx, w.y - drag.cy) > 8) drag.moved = true;
        return;
      case "ink": {
        const pts = drag.pts;
        if (drag.t === "line") pts[1] = [c.x, c.y];
        else {
          const lastPt = pts[pts.length - 1] ?? [w.x, w.y];
          if (Math.hypot(w.x - lastPt[0], w.y - lastPt[1]) > 3) pts.push([w.x, w.y]);
        }
        setDrag({ ...drag });
        return;
      }
    }
  };

  const onPointerUp = (e: ReactPointerEvent<SVGSVGElement>): void => {
    const d = drag;
    setDrag(null);
    if (!d) return;
    switch (d.kind) {
      case "pan":
        if (!d.moved && d.button === 2) {
          if (draft && draft.via.length > 0) setDraft({ ...draft, via: draft.via.slice(0, -1) });
          else if (draft) cancelDraft();
          else if (mode.kind !== "select") setMode({ kind: "select" });
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
        if (d.moved && draft) {
          /* a drag from an element: released on another one links them, on the grid drops the drawing */
          if (hover && hover.id !== draft.a) finishLink(hover.id);
          else if (!hover) cancelDraft();
        }
        return;
      case "ink": {
        const pts = d.t === "stroke" ? d.pts.slice(1) : d.pts;
        const a = pts[0];
        const b = pts[pts.length - 1];
        if (a && b && (Math.hypot(b[0] - a[0], b[1] - a[1]) > 4 || pts.length > 3)) commit({ ...value, nodes: [...value.nodes, inkElement(d.t, pts)] });
        return;
      }
      case "box":
        return;
    }
  };

  const tools: Array<{ place: PlaceTool } | { link: LinkType }> = [...spec.tools.map((t) => ({ place: t })), ...spec.links.map((l) => ({ link: l }))];

  const onKeyDown = (e: ReactKeyboardEvent<HTMLDivElement>): void => {
    const target = e.target as HTMLElement;
    if (target.matches("input, textarea, select") || readOnly || pane !== "draw") return;
    const k = e.key;
    const mod = e.ctrlKey || e.metaKey;
    if (mod) {
      const lk = k.toLowerCase();
      if (lk === "z") e.shiftKey ? redo() : undo();
      else if (lk === "y") redo();
      else if (lk === "d") duplicate();
      else if (lk === "a") select([...value.nodes, ...value.links].map((x) => x.id));
      else return;
      e.preventDefault();
      return;
    }
    if (k === "Delete" || k === "Backspace") remove();
    else if (k === "Escape") {
      if (draft) cancelDraft();
      else if (mode.kind !== "select") setMode({ kind: "select" });
      else setSelection(new Set());
    } else if (k.toLowerCase() === "i") reverse();
    else if (/^[1-9]$/.test(k)) {
      const tool = tools[Number(k) - 1];
      if (!tool) return;
      setDraft(null);
      setMode("place" in tool ? { kind: "place", tool: tool.place } : { kind: "link", type: tool.link });
    } else return;
    e.preventDefault();
  };

  /* what the inspector shows: exactly one element with a name, or one link */
  const only = selection.size === 1 ? [...selection][0] : undefined;
  const item = only ? (value.nodes.find((n) => n.id === only) ?? value.links.find((l) => l.id === only)) : undefined;
  const inspected = item && !("t" in item && NAMELESS.has(item.t)) ? item : undefined;

  const edgeHover = mode.kind === "select" && hover?.edge === true && !drag && spec.links.length > 0;
  const highlight = new Set<string>();
  if (hover && (mode.kind === "link" || draft || edgeHover)) highlight.add(hover.id);
  if (draft) highlight.add(draft.a);

  const ghost =
    mode.kind === "place" && cursor.inside && !INK.has(typeOfTool(mode.tool)) ? newElement(value, mode.tool, cursor, measure, words) : null;

  const hint =
    mode.kind === "place"
      ? INK.has(typeOfTool(mode.tool))
        ? s.hintInk
        : s.hintPlace
      : draft
        ? s.hintDrawing
        : mode.kind === "link"
          ? s.hintLink
          : selection.size > 0
            ? s.hintSelected
            : spec.dbl
              ? s.hintSelect
              : s.hintSelectFree;

  const areaStyle = height === undefined ? undefined : { height };
  const selectedOne = only ? value.nodes.find((n) => n.id === only) : undefined;

  return (
    <div
      ref={rootRef}
      id={props.id}
      className={cx(frame, "relative flex flex-col outline-none", height === undefined && "h-full")}
      tabIndex={-1}
      onKeyDown={onKeyDown}
      aria-label={props["aria-label"] ?? s.canvas}
      role="group"
    >
      {!readOnly && (
        <div className={toolbar} role="toolbar" aria-label={s.toolbox}>
          {pane === "draw" && (
            <>
              <button
                type="button"
                className={iconButton(mode.kind === "select")}
                aria-label={s.select}
                aria-pressed={mode.kind === "select"}
                onClick={() => {
                  setDraft(null);
                  setMode({ kind: "select" });
                }}
              >
                <svg viewBox="0 0 16 16" className="size-4" aria-hidden="true">
                  <path className="fill-none stroke-current stroke-[1.5] [stroke-linejoin:round]" d="M3 2l9 5.2-4 1-2 4.3z" />
                </svg>
              </button>
              <span className={separator} />
              {spec.tools.map((tool) => {
                const on = mode.kind === "place" && mode.tool === tool;
                return (
                  <button
                    key={tool}
                    type="button"
                    className={iconButton(on)}
                    aria-label={s[toolKey(tool)]}
                    aria-pressed={on}
                    onClick={() => {
                      setDraft(null);
                      setMode(on ? { kind: "select" } : { kind: "place", tool });
                    }}
                  >
                    <ToolIcon tool={tool} />
                  </button>
                );
              })}
              {spec.links.length > 0 && <span className={separator} />}
              {spec.links.map((type) => {
                const on = mode.kind === "link" && mode.type === type;
                return (
                  <button
                    key={type}
                    type="button"
                    className={lineButton(on)}
                    aria-label={s[linkKey(type)]}
                    aria-pressed={on}
                    onClick={() => {
                      if (!draft) setMode(on ? { kind: "select" } : { kind: "link", type });
                      else setMode({ kind: "link", type });
                    }}
                  >
                    <LinkIcon type={type} />
                  </button>
                );
              })}
              <span className={separator} />
              <button type="button" className={iconButton()} aria-label={s.undo} title={s.undo} disabled={!history.canUndo} onClick={undo}>
                <ActionIcon d="M7 4L3 8l4 4M3 8h9a4.5 4.5 0 0 1 0 9H9" />
              </button>
              <button type="button" className={iconButton()} aria-label={s.redo} title={s.redo} disabled={!history.canRedo} onClick={redo}>
                <ActionIcon d="M13 4l4 4-4 4M17 8H8a4.5 4.5 0 0 0 0 9h3" />
              </button>
              <button
                type="button"
                className={iconButton()}
                aria-label={s.duplicate}
                title={s.duplicate}
                disabled={!value.nodes.some((n) => selection.has(n.id))}
                onClick={duplicate}
              >
                <ActionIcon d="M3 3h10v10H3zM7 16.5h8.5a1.5 1.5 0 0 0 1.5-1.5V7" />
              </button>
              <button type="button" className={iconButton()} aria-label={s.remove} title={s.remove} disabled={selection.size === 0} onClick={remove}>
                <ActionIcon d="M3.5 5.5h13M8 5.5V3.5h4v2M5.5 5.5l.8 11h7.4l.8-11M8.5 8.5v5.5M11.5 8.5v5.5" />
              </button>
            </>
          )}
          {withText && spec.text && (
            <div className="ml-auto flex gap-0.5" role="tablist">
              {(["draw", "text"] as const).map((p) => (
                <button
                  key={p}
                  type="button"
                  role="tab"
                  aria-selected={pane === p}
                  className={cx(iconButton(pane === p), "w-auto px-2.5 text-[12.5px] font-medium")}
                  onClick={() => {
                    setPane(p);
                    setDraft(null);
                    setMode({ kind: "select" });
                  }}
                >
                  {p === "draw" ? s.draw : s.code}
                </button>
              ))}
            </div>
          )}
        </div>
      )}

      {pane === "text" ? (
        <TextPane kind={kind} scene={value} measure={measure} onEdit={(next, session) => commit(next, value, session)} strings={s} height={height} />
      ) : (
        <div className={cx("relative", height === undefined && "min-h-0 flex-1")} style={areaStyle}>
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
              {[...scene.nodes.filter((n) => n.t === "system"), ...scene.nodes.filter((n) => n.t !== "system")].map((n) => (
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
              <g className="pointer-events-none">
                {[...highlight].map((id) => {
                  const r = rects.get(id);
                  return r ? <rect key={id} className={hoverFrame} x={r.x0 - 3} y={r.y0 - 3} width={r.w + 6} height={r.h + 6} rx={3} /> : null;
                })}
                {draftLink && routes.get("__draft") && (
                  <LinkShape link={{ type: draftLink.type }} route={routes.get("__draft") ?? { pts: [], a: { x: 0, y: 0, d: -1 }, b: { x: 0, y: 0, d: -1 } }} draft />
                )}
                {draft?.via.map((v, i) => <circle key={i} className="fill-accent" cx={v.x} cy={v.y} r={3} />)}
                {ghost && (
                  <g className={inkNormal}>
                    <NodeShape node={ghost} measure={measure} ghost />
                  </g>
                )}
                {drag?.kind === "ink" && <path className={draftLine} d={drag.t === "stroke" ? inkPath(drag.pts.slice(1)) : `M${drag.pts.map((q) => q.join(" ")).join("L")}`} />}
                {drag?.kind === "box" && (
                  <rect
                    className={marquee}
                    x={Math.min(drag.x0, drag.x1)}
                    y={Math.min(drag.y0, drag.y1)}
                    width={Math.abs(drag.x1 - drag.x0)}
                    height={Math.abs(drag.y1 - drag.y0)}
                  />
                )}
              </g>
              {!readOnly &&
                scene.links
                  .filter((l) => selection.has(l.id))
                  .flatMap((l) =>
                    (l.via ?? []).map((v, i) => (
                      <rect key={`${l.id}-${i}`} className={handle} data-via={i} data-via-link={l.id} x={v.x - 4.5} y={v.y - 4.5} width={9} height={9} rx={1.5} />
                    )),
                  )}
              {!readOnly &&
                selectedOne &&
                RESIZABLE.has(selectedOne.t) &&
                (() => {
                  const r = rectOf(scene.nodes.find((n) => n.id === selectedOne.id) ?? selectedOne, measure);
                  return <rect className={cx(handle, "cursor-nwse-resize")} data-resize={selectedOne.id} x={r.x1 - 5} y={r.y1 - 5} width={10} height={10} rx={1.5} />;
                })()}
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

function ActionIcon({ d }: { d: string }): JSX.Element {
  return (
    <svg viewBox="0 0 20 20" className="size-[18px]" aria-hidden="true">
      <path className="fill-none stroke-current stroke-[1.6] [stroke-linecap:round] [stroke-linejoin:round]" d={d} />
    </svg>
  );
}
