/**
 * The schematic editor: the React port of `mockups/circuit.html`.
 *
 * It is CONTROLLED. Every committed edit — a component placed, a drag let go
 * of, a wire finished, a deletion, a character typed in the inspector, an undo
 * — calls `onChange` with a NEW schematic whose wires carry freshly routed
 * `points`, because that polyline is what the server reads (`schema.ts`). What
 * is transient stays here: the selection, the wire being drawn, the drag, the
 * view box.
 *
 * The parts, the box and its ports come from a {@link SchematicLibrary}
 * (`library`): the editor itself knows no kind.
 *
 * Two differences from the mockup, both from the data model:
 * - the world IS the box (`0..box.width` × `0..box.height`). Components are
 *   clamped inside it and the router never leaves it, so nothing on the canvas
 *   can be a value the schema rejects;
 * - the ports on the border (`circuit`'s four) are wire ends like any pin.
 *
 * Keyboard is scoped to the editor, never to the window: several of these may
 * sit on one page, and the app has shortcuts of its own.
 *
 * This file is the composition. Each tool is a hook beside it — the view
 * (`useViewport`), the selection (`useSelection`), dragging
 * (`usePartDragging`), the wire tool (`useWireDrawing`), the pointer dispatch
 * (`usePointerTools`) — and the markup is in `EditorChrome.tsx`.
 *
 * Hook order, flattened as React sees it. Every hook is called
 * unconditionally; keep it that way, and keep this list true:
 *   useId · useRef rootRef, svgRef, canvasRef · useHistory · useState mode,
 *   placeKind, ghost · useViewport [useState view, canvasHeight · useCallback
 *   toWorld, slack · useEffect measure, wheel] · useState cursor, hover ·
 *   useCallback apply · useSelection [useState selection ·
 *   useCallback removeSelection, transformSelection, duplicate] · useCallback
 *   place · usePartDragging [useState drag · useRef dragRef, lastVia ·
 *   useState palDrag · useMemo displayed · useCallback componentUnder,
 *   viaUnder · useEffect palette drop] · useMemo routes, obstacles, connected,
 *   byId · useWireDrawing [useState draft · useCallback finishWire, wireClick,
 *   cancelStep, wireUnder · useMemo draftPoints] · useCallback undo, redo ·
 *   usePointerTools [useCallback onPointerDown, onPointerMove, onPointerUp] ·
 *   useCallback onKeyDown · useCanvasShortcuts [useRef inside, shown,
 *   listener · useEffect ×3] · useMemo selectedComponent · useState
 *   nameDraft · useRef editing · useCallback editComponent.
 */
import { useCallback, useId, useMemo, useRef, useState, type JSX, type KeyboardEvent as ReactKeyboardEvent } from "react";

import { resolveStrings, type CanvasShortcutsListener } from "@quiz/core/client";
import { CANVAS_STRINGS, type CanvasStrings } from "./canvasStrings.js";
import { canvasArea, cx, frame } from "./canvasStyles.js";
import { Drawing, Inspector, PaletteRail, StatusBar, Toolbar, Transient } from "./EditorChrome.js";
import { ORIENT_0, connectedPins, fitView, indexOf, newComponent, viewBoxAttr, type PinTarget } from "./geometry.js";
import { useCanvasShortcuts, useHistory } from "@quiz/ui";
import { blockedCells, computeRoutes, withRoutes } from "./router.js";
import {
  countedParts,
  type CanvasComponent,
  type CanvasSchematic,
  type SchematicLibrary,
} from "./schematicLibrary.js";
import type { FlaggedPin } from "./SchematicView.js";
import { usePartDragging, type Ghost } from "./usePartDragging.js";
import { usePointerTools, type Cursor } from "./usePointerTools.js";
import { editorKey, keyActions, SHORTCUT_LINES, useSelection, type Mode } from "./useSelection.js";
import { useViewport } from "./useViewport.js";
import { useWireDrawing } from "./useWireDrawing.js";

/** What the student may place: these kinds, and this many parts that are not terminals. */
export interface CanvasPalette {
  readonly kinds: readonly string[];
  readonly maxComponents: number;
}

export interface SchematicEditorProps<S extends CanvasSchematic = CanvasSchematic> {
  value: S;
  /**
   * Every committed edit, with a value of the host's own type (`Schematic.parse`
   * accepts it): the editor only places the palette's kinds, wires the
   * library's pins and ports, and keeps every point inside the box.
   */
  onChange: (next: S) => void;
  /** The parts, the box and the ports. */
  library: SchematicLibrary;
  /** Only these kinds are offered: the host has already filtered them (`offeredKinds` for `circuit`). */
  palette: CanvasPalette;
  /** View and select only: no palette, no transform, no edit. */
  readOnly?: boolean | undefined;
  /** Pins to mark as a problem — the host maps its netlist issues onto these. */
  highlightPins?: readonly FlaggedPin[] | undefined;
  highlightPorts?: readonly string[] | undefined;
  strings?: Partial<CanvasStrings> | undefined;
  /**
   * The TALLEST the drawing area gets, in px. It is normally shorter: the
   * area takes the shape of the fitted view for the width it was given.
   * `"fill"`: the editor takes the whole height of its parent instead (the
   * host's expand layer), and the drawing area whatever the bars leave.
   */
  height?: number | "fill" | undefined;
  id?: string | undefined;
  "aria-label"?: string | undefined;
  /** The host's shortcut zone (`EditorProps.onCanvasShortcuts`); never called when read-only. */
  onShortcuts?: CanvasShortcutsListener | undefined;
}

export function SchematicEditor<S extends CanvasSchematic>({
  value,
  onChange,
  library,
  palette,
  readOnly = false,
  highlightPins,
  highlightPorts,
  strings,
  height = 420,
  id,
  "aria-label": ariaLabel,
  onShortcuts,
}: SchematicEditorProps<S>): JSX.Element {
  const s = resolveStrings(CANVAS_STRINGS, strings);
  const reactId = useId();
  const patternId = (id ?? reactId).replace(/[^A-Za-z0-9_-]/g, "_");
  const label = ariaLabel ?? s.editorLabel;

  const rootRef = useRef<HTMLDivElement | null>(null);
  const svgRef = useRef<SVGSVGElement | null>(null);
  const canvasRef = useRef<HTMLDivElement | null>(null);

  const history = useHistory<S>();
  const [mode, setMode] = useState<Mode>("select");
  const [placeKind, setPlaceKind] = useState<string | null>(null);
  const [ghost, setGhost] = useState<Ghost>({ x: 200, y: 200, m: ORIENT_0, show: false });
  const fill = height === "fill";
  const { view, setView, canvasHeight, toWorld, slack, fit, zoom } = useViewport(
    svgRef,
    canvasRef,
    fill ? null : height,
    fitView(library.box),
  );
  const [cursor, setCursor] = useState<Cursor>({ x: 0, y: 0, inside: false });
  const [hover, setHover] = useState<PinTarget | null>(null);

  // --- what the palette offers ------------------------------------------
  const kinds = palette.kinds;
  const used = countedParts(value.components, library);
  const full = used >= palette.maxComponents;

  // --- committing --------------------------------------------------------
  const apply = useCallback(
    (next: CanvasSchematic, continuing = false) => {
      if (!continuing) history.push(value);
      /* The one widening back to the host's type: see `onChange`. */
      onChange(withRoutes(next, library) as S);
    },
    [history, library, onChange, value],
  );

  const { selection, setSelection, removeSelection, transformSelection, duplicate, canRemove, canDuplicate } = useSelection({
    library, value, apply, readOnly, placing: mode === "place", setGhost, used, maxComponents: palette.maxComponents,
  });

  const place = useCallback(
    (x: number, y: number) => {
      if (placeKind === null || readOnly) return;
      if (!library.part(placeKind).terminal && full) return;
      const c = newComponent(placeKind, x, y, ghost.m, value.components, library);
      apply({ components: [...value.components, c], wires: value.wires });
      setSelection(new Set([c.id]));
    },
    [apply, full, ghost.m, library, placeKind, readOnly, value],
  );

  // --- what is drawn right now ------------------------------------------
  const { drag, setDrag, dragRef, lastVia, setPalDrag, displayed, componentUnder, viaUnder } = usePartDragging({
    library, value, selection, slack, toWorld, place, setGhost, setMode, setPlaceKind,
  });

  const routes = useMemo(() => computeRoutes(displayed, library), [displayed, library]);
  const obstacles = useMemo(
    () => ({ blocked: blockedCells(displayed.components, library), used: new Map<string, number>() }),
    [displayed, library],
  );
  const connected = useMemo(() => connectedPins(displayed), [displayed]);
  const byId = useMemo(() => indexOf(displayed.components), [displayed]);

  const { draft, setDraft, wireClick, cancelStep, wireUnder, draftPoints } = useWireDrawing({
    library, value, apply, byId, obstacles, routes, slack, mode, setMode, setPlaceKind, setHover, cursor, hover,
  });

  /* Undo and redo hand the host a value it already had; nothing is re-routed. */
  const restore = (to: S | undefined): void => {
    if (to === undefined) return;
    setSelection(new Set());
    setDraft(null);
    onChange(to);
  };
  const undo = useCallback(() => restore(history.undo(value)), [history, onChange, value]);
  const redo = useCallback(() => restore(history.redo(value)), [history, onChange, value]);

  // --- the pointer -------------------------------------------------------
  const pointer = usePointerTools({
    library, rootRef, svgRef, value, apply, readOnly, mode, setMode, placeKind, place,
    view, setView, toWorld, slack, selection, setSelection,
    dragRef, setDrag, lastVia, displayed, routes, componentUnder, viaUnder,
    wireUnder, wireClick, cancelStep, setCursor, setGhost, setHover,
  });

  // --- the keyboard, scoped to this editor -------------------------------
  const onKeyDown = useCallback(
    (e: ReactKeyboardEvent<HTMLDivElement>) => {
      const actions = keyActions({
        undo, redo, duplicate, remove: removeSelection, transform: transformSelection, value, setSelection,
        hasSelection: selection.size > 0, kinds, mode, setMode, setPlaceKind, drafting: draft !== null, setDraft,
      });
      editorKey(e, actions, readOnly);
    },
    [draft, duplicate, kinds, mode, readOnly, redo, removeSelection, selection.size, setSelection, transformSelection, undo, value],
  );
  const shortcutFocus = useCanvasShortcuts({ publish: onShortcuts, lines: SHORTCUT_LINES, strings: s, enabled: !readOnly });

  // --- the inspector -----------------------------------------------------
  const selectedComponent = useMemo(() => {
    const ids = [...selection];
    if (ids.length !== 1) return null;
    return value.components.find((c) => c.id === ids[0]) ?? null;
  }, [selection, value.components]);

  const [nameDraft, setNameDraft] = useState<{ id: string; text: string } | null>(null);
  const editing = useRef(false);

  const editComponent = useCallback(
    (patch: Partial<CanvasComponent>) => {
      if (selectedComponent === null) return;
      const continuing = editing.current;
      editing.current = true;
      apply(
        {
          components: value.components.map((c) => (c.id === selectedComponent.id ? { ...c, ...patch } : c)),
          wires: value.wires,
        },
        continuing,
      );
    },
    [apply, selectedComponent, value],
  );

  // --- render ------------------------------------------------------------
  const grabTile = (kind: string, x: number, y: number, rearm: boolean): void => {
    setMode("place");
    setPlaceKind(kind);
    setDraft(null);
    setGhost((g) => ({ ...g, m: ORIENT_0 }));
    setPalDrag({ kind, x, y, moved: false, rearm });
  };

  return (
    <div
      ref={rootRef}
      id={id}
      className={cx(frame, "focus-visible:outline-none", fill && "flex h-full min-h-0 flex-1 flex-col")}
      tabIndex={0}
      role="group"
      aria-label={label}
      onKeyDown={onKeyDown}
      {...shortcutFocus}
    >
      <Toolbar
        strings={s} readOnly={readOnly} mode={mode} selection={selection} zoom={zoom}
        canRemove={canRemove} canDuplicate={canDuplicate}
        canUndo={history.canUndo} canRedo={history.canRedo}
        setMode={setMode} setPlaceKind={setPlaceKind} setDraft={setDraft}
        transform={transformSelection} duplicate={duplicate} remove={removeSelection} undo={undo} redo={redo} fit={fit}
      />
      <div className={cx("flex flex-col sm:flex-row", fill && "min-h-0 flex-1")}>
        {readOnly ? null : (
          <PaletteRail
            strings={s} library={library} kinds={kinds} used={used} max={palette.maxComponents} full={full}
            mode={mode} placeKind={placeKind} maxHeight={canvasHeight} onGrab={grabTile}
          />
        )}
        <div ref={canvasRef} className={canvasArea} style={fill ? undefined : { height: canvasHeight }}>
          <svg
            ref={svgRef}
            data-testid="schematic-canvas"
            role="application"
            aria-label={label}
            viewBox={viewBoxAttr(view)}
            preserveAspectRatio="xMidYMid meet"
            width="100%"
            height="100%"
            className={cx("block touch-none select-none", mode === "wire" && "cursor-crosshair", mode === "place" && "cursor-copy")}
            onPointerDown={pointer.onPointerDown}
            onPointerMove={pointer.onPointerMove}
            onPointerUp={pointer.onPointerUp}
            onPointerLeave={() => {
              setCursor((c) => ({ ...c, inside: false }));
              setGhost((g) => ({ ...g, show: false }));
              setHover(null);
            }}
            onDoubleClick={(e) => {
              /* A double click on empty paper, with no wire in hand, fits the view. */
              const w = toWorld(e.clientX, e.clientY);
              if (componentUnder(w.x, w.y) === null && wireUnder(w.x, w.y) === null && draft === null) fit();
            }}
            onContextMenu={(e) => e.preventDefault()}
          >
            <Drawing
              strings={s} library={library} patternId={patternId} schematic={displayed} routes={routes} selection={selection}
              connected={connected} hover={hover} highlightPins={highlightPins} highlightPorts={highlightPorts}
            />
            <Transient
              library={library} draftPoints={draftPoints} draft={draft} wires={displayed.wires} selection={selection} mode={mode}
              ghost={ghost} placeKind={placeKind} cursor={cursor} hover={hover} drag={drag}
            />
          </svg>
          {selectedComponent !== null ? (
            <Inspector
              strings={s} library={library} component={selectedComponent} readOnly={readOnly}
              nameDraft={nameDraft} setNameDraft={setNameDraft} editing={editing} edit={editComponent}
            />
          ) : null}
        </div>
      </div>
      <StatusBar strings={s} mode={mode} placeKind={placeKind} drafting={draft !== null} selected={selection.size} cursor={cursor} />
    </div>
  );
}
