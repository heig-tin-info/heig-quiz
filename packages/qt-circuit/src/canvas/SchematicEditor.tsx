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
 * Two differences from the mockup, both from the data model:
 * - the world IS the box (`0..BOX.width` × `0..BOX.height`). Components are
 *   clamped inside it and the router never leaves it, so nothing on the canvas
 *   can be a value the schema rejects;
 * - the four ports on the border are wire ends like any pin.
 *
 * Keyboard is scoped to the editor, never to the window: several of these may
 * sit on one page, and the app has shortcuts of its own.
 *
 * Hook order, as React sees it (flattened, top to bottom). It is recorded
 * here because the editor is being split into hooks, and a split must keep
 * the same hooks, unconditionally, in a stated order:
 *   1 useId                       18 useRef lastVia            35 useCallback toWorld
 *   2 useRef rootRef              19 useMemo kinds             36 useCallback slack
 *   3 useRef svgRef               20 useCallback apply         37 useCallback wireUnder
 *   4 useRef canvasRef            21 useMemo displayed         38 useCallback componentUnder
 *   5 useHistory (2 refs,         22 useMemo routes            39 useCallback viaUnder
 *     1 state, 4 callbacks)       23 useMemo obstacles         40 useCallback onPointerDown
 *   6 useState mode               24 useMemo connected         41 useCallback onPointerMove
 *   7 useState placeKind          25 useMemo byId              42 useCallback onPointerUp
 *   8 useState ghost              26 useCallback place         43 useEffect measure
 *   9 useState selection          27 useCallback removeSel.    44 useEffect wheel
 *  10 useState draft              28 useCallback transformSel. 45 useEffect palette drag
 *  11 useState drag               29 useCallback duplicate     46 useCallback onKeyDown
 *  12 useState view               30 useCallback undo          47 useMemo selectedComponent
 *  13 useState cursor             31 useCallback redo          48 useState nameDraft
 *  14 useState hover              32 useCallback finishWire    49 useRef editing
 *  15 useState palDrag            33 useCallback wireClick     50 useCallback editComponent
 *  16 useState canvasHeight       34 useCallback cancelStep    51 useMemo draftPoints
 *  17 useRef dragRef
 */
import {
  useCallback,
  useId,
  useMemo,
  useRef,
  useState,
  type JSX,
  type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent as ReactPointerEvent,
} from "react";

import {
  LIBRARY,
  formatValue,
  valueIssue,
  type ComponentKind,
  type PortId,
} from "../library.js";
import {
  Schematic,
  countedComponents,
  type Palette,
  type SchematicComponent,
  type Supplies,
} from "../schema.js";

import { fmt, plural, resolveStrings } from "@quiz/core/client";
import { CANVAS_STRINGS, type CanvasStrings } from "./canvasStrings.js";
import {
  canvasArea,
  cx,
  draftLine,
  fieldError,
  fieldInput,
  fieldInputInvalid,
  fieldLabel,
  frame,
  iconButton,
  inspector,
  inspectorTitle,
  marquee,
  paletteColumn,
  paletteCount,
  paletteGrid,
  paletteHead,
  paletteTile,
  paletteTileLabel,
  paletteTitle,
  readOnlyValue,
  separator,
  statusBar,
  statusCursor,
  statusHint,
  statusMode,
  toolButton,
  toolbar,
  toolbarGroup,
  crosshair,
} from "./canvasStyles.js";
import {
  MIRROR_X,
  MIRROR_Y,
  ORIENT_0,
  ROTATE,
  indexOf,
  newComponent,
  pinAt,
  snap,
  viewBoxAttr,
  type PinTarget,
} from "./geometry.js";
import { useHistory } from "./history.js";
import { blockedCells, computeRoutes, pathOf, withRoutes } from "./router.js";
import {
  ComponentGlyph,
  GridDefs,
  Junctions,
  Paper,
  Ports,
  SymbolPreview,
  WireGlyph,
  connectedPins,
  type FlaggedPin,
} from "./SchematicView.js";
import { TOOL_ICONS } from "./symbols.js";
import {
  boxSelection,
  boxStart,
  editorKey,
  isTerminal,
  pressed,
  useSelection,
} from "./useSelection.js";
import {
  ghostAt,
  moveStart,
  moveStep,
  movedBy,
  secondPress,
  usePartDragging,
  viaMoved,
  viaStart,
  withoutVia,
  type Ghost,
} from "./usePartDragging.js";
import { useWireDrawing } from "./useWireDrawing.js";
import { panStart, panned, useViewport } from "./useViewport.js";

export interface SchematicEditorProps {
  value: Schematic;
  /** Every committed edit, with a value that satisfies `Schematic.parse`. */
  onChange: (next: Schematic) => void;
  /** Only these kinds are offered; VCC and VEE also need their supply. */
  palette: Palette;
  supplies: Supplies;
  /** View and select only: no palette, no transform, no edit. */
  readOnly?: boolean | undefined;
  /** Pins to mark as a problem — the host maps its netlist issues onto these. */
  highlightPins?: readonly FlaggedPin[] | undefined;
  highlightPorts?: readonly PortId[] | undefined;
  strings?: Partial<CanvasStrings> | undefined;
  /**
   * The TALLEST the drawing area gets, in px. It is normally shorter: the
   * area takes the shape of the fitted view for the width it was given.
   */
  height?: number | undefined;
  id?: string | undefined;
  "aria-label"?: string | undefined;
}

type Mode = "select" | "wire" | "place";

export function SchematicEditor({
  value,
  onChange,
  palette,
  supplies,
  readOnly = false,
  highlightPins,
  highlightPorts,
  strings,
  height = 420,
  id,
  "aria-label": ariaLabel,
}: SchematicEditorProps): JSX.Element {
  const s = resolveStrings(CANVAS_STRINGS, strings);
  const reactId = useId();
  const patternId = (id ?? reactId).replace(/[^A-Za-z0-9_-]/g, "_");

  const rootRef = useRef<HTMLDivElement | null>(null);
  const svgRef = useRef<SVGSVGElement | null>(null);
  const canvasRef = useRef<HTMLDivElement | null>(null);

  const history = useHistory<Schematic>();
  const [mode, setMode] = useState<Mode>("select");
  const [placeKind, setPlaceKind] = useState<ComponentKind | null>(null);
  const [ghost, setGhost] = useState<Ghost>({
    x: 200,
    y: 200,
    m: ORIENT_0,
    show: false,
  });
  const { view, setView, canvasHeight, toWorld, slack, fit, zoom } = useViewport(svgRef, canvasRef, height);
  const [cursor, setCursor] = useState<{ x: number; y: number; inside: boolean }>({
    x: 0,
    y: 0,
    inside: false,
  });
  const [hover, setHover] = useState<PinTarget | null>(null);
  // --- what the palette offers ------------------------------------------
  const kinds = useMemo(
    () =>
      palette.kinds.filter(
        (k) => (k !== "VCC" || supplies.vcc !== null) && (k !== "VEE" || supplies.vee !== null),
      ),
    [palette.kinds, supplies.vcc, supplies.vee],
  );
  const used = countedComponents(value, isTerminal);
  const full = used >= palette.maxComponents;

  // --- committing --------------------------------------------------------
  const apply = useCallback(
    (next: Schematic, continuing = false) => {
      if (!continuing) history.push(value);
      onChange(withRoutes(next));
    },
    [history, onChange, value],
  );

  const { selection, setSelection, removeSelection, transformSelection, duplicate } = useSelection({
    value,
    apply,
    readOnly,
    placing: mode === "place",
    setGhost,
    used,
    maxComponents: palette.maxComponents,
  });

  // --- operations --------------------------------------------------------

  const place = useCallback(
    (x: number, y: number) => {
      if (placeKind === null || readOnly) return;
      if (!isTerminal(placeKind) && full) return;
      const c = newComponent(placeKind, x, y, ghost.m, value.components);
      apply({ components: [...value.components, c], wires: value.wires });
      setSelection(new Set([c.id]));
    },
    [apply, full, ghost.m, placeKind, readOnly, value],
  );

  // --- what is drawn right now ------------------------------------------
  const { drag, setDrag, dragRef, lastVia, setPalDrag, displayed, componentUnder, viaUnder } = usePartDragging({
    value,
    selection,
    slack,
    toWorld,
    place,
    setGhost,
    setMode,
    setPlaceKind,
  });

  const routes = useMemo(() => computeRoutes(displayed), [displayed]);
  const obstacles = useMemo(
    () => ({ blocked: blockedCells(displayed.components), used: new Map<string, number>() }),
    [displayed],
  );
  const connected = useMemo(() => connectedPins(displayed), [displayed]);
  const byId = useMemo(() => indexOf(displayed.components), [displayed]);

  const { draft, setDraft, wireClick, cancelStep, wireUnder, draftPoints } = useWireDrawing({
    value,
    apply,
    byId,
    obstacles,
    routes,
    slack,
    mode,
    setMode,
    setPlaceKind,
    setHover,
    cursor,
    hover,
  });

  const undo = useCallback(() => {
    const previous = history.undo(value);
    if (previous === undefined) return;
    setSelection(new Set());
    setDraft(null);
    onChange(previous);
  }, [history, onChange, value]);

  const redo = useCallback(() => {
    const next = history.redo(value);
    if (next === undefined) return;
    setSelection(new Set());
    setDraft(null);
    onChange(next);
  }, [history, onChange, value]);

  // --- the pointer -------------------------------------------------------

  const onPointerDown = useCallback(
    (e: ReactPointerEvent<SVGSVGElement>) => {
      rootRef.current?.focus({ preventScroll: true });
      const w = toWorld(e.clientX, e.clientY);
      setCursor({ x: snap(w.x), y: snap(w.y), inside: true });
      try {
        svgRef.current?.setPointerCapture(e.pointerId);
      } catch {
        /* jsdom, and any browser that lost the pointer: the window listeners cover it. */
      }
      if (e.button === 1 || e.button === 2) {
        e.preventDefault();
        setDrag(panStart(e, view));
        return;
      }
      if (e.button !== 0) return;

      if (mode === "place" && !readOnly) {
        place(snap(w.x), snap(w.y));
        return;
      }

      const target = pinAt(displayed.components, w.x, w.y, slack());
      const onWire = wireUnder(w.x, w.y);

      if (!readOnly) {
        const via = viaUnder(w.x, w.y);
        if (via !== null && mode === "select") {
          if (secondPress(lastVia, via, Date.now())) apply(withoutVia(value, via));
          else setDrag(viaStart(via));
          return;
        }
        if (mode === "wire" || (target !== null && !e.shiftKey)) {
          if (mode !== "wire") setMode("wire");
          wireClick(target, onWire, w);
          return;
        }
      }

      const hitId = componentUnder(w.x, w.y) ?? onWire;
      if (hitId !== null) {
        const was = selection.has(hitId);
        const next = pressed(selection, hitId, e.shiftKey);
        setSelection(next);
        if (next.has(hitId) && !readOnly) {
          setDrag(moveStart(w, !e.shiftKey && was ? hitId : null));
        }
        return;
      }
      setDrag(boxStart(w, e.shiftKey, selection));
      if (!e.shiftKey) setSelection(new Set());
    },
    [
      apply,
      componentUnder,
      displayed.components,
      mode,
      place,
      readOnly,
      selection,
      slack,
      toWorld,
      value,
      view,
      viaUnder,
      wireClick,
      wireUnder,
    ],
  );

  const onPointerMove = useCallback(
    (e: ReactPointerEvent<SVGSVGElement>) => {
      const w = toWorld(e.clientX, e.clientY);
      const at = { x: snap(w.x), y: snap(w.y) };
      setCursor({ ...at, inside: w.inside });
      if (mode === "place" && placeKind !== null) {
        setGhost(ghostAt(placeKind, at.x, at.y, w.inside));
      }

      const d = dragRef.current;
      if (d === null) {
        setHover(
          (mode === "wire" || mode === "select") && w.inside && !readOnly
            ? pinAt(displayed.components, w.x, w.y, slack())
            : null,
        );
        return;
      }
      if (d.kind === "pan") {
        setView(panned(d, svgRef.current, e.clientX, e.clientY));
      } else if (d.kind === "move") {
        const next = moveStep(d, w);
        if (next !== null) setDrag(next);
      } else if (d.kind === "box") {
        setDrag({ ...d, x1: w.x, y1: w.y });
      } else if (d.kind === "via") {
        const next = viaMoved(value, d, at);
        if (next !== null) {
          if (!d.moved) history.push(value);
          setDrag({ ...d, moved: true });
          onChange(withRoutes(next));
        }
      }
    },
    [displayed.components, history, mode, onChange, placeKind, readOnly, slack, toWorld, value],
  );

  const onPointerUp = useCallback(
    (e: ReactPointerEvent<SVGSVGElement>) => {
      const d = dragRef.current;
      setDrag(null);
      if (d === null) return;
      if (d.kind === "pan") {
        if (!d.moved && d.button === 2) cancelStep();
        return;
      }
      if (d.kind === "move") {
        if (d.moved) apply(movedBy(value, selection, d.dx, d.dy));
        else if (d.collapse !== null && !e.shiftKey) setSelection(new Set([d.collapse]));
        return;
      }
      if (d.kind === "box") setSelection(boxSelection(d, displayed.components, routes));
    },
    [apply, displayed.components, routes, selection, value],
  );

  // --- the keyboard, scoped to this editor -------------------------------

  const onKeyDown = useCallback(
    (e: ReactKeyboardEvent<HTMLDivElement>) =>
      editorKey(
        e,
        {
          undo,
          redo,
          duplicate,
          selectAll: () => setSelection(new Set([...value.components.map((c) => c.id), ...value.wires.map((w) => w.id)])),
          transform: transformSelection,
          toggleWire: () => {
            setMode(mode === "wire" ? "select" : "wire");
            setPlaceKind(null);
            setDraft(null);
          },
          remove: removeSelection,
          escape: () => {
            if (draft !== null) setDraft(null);
            else if (mode !== "select") {
              setMode("select");
              setPlaceKind(null);
            } else setSelection(new Set());
          },
          arm: (index) => {
            const kind = kinds[index];
            if (kind === undefined) return;
            setMode("place");
            setPlaceKind(kind);
            setDraft(null);
          },
        },
        readOnly,
      ),
    [draft, duplicate, kinds, mode, readOnly, redo, removeSelection, setSelection, transformSelection, undo, value],
  );

  // --- the inspector -----------------------------------------------------

  const selectedComponent = useMemo(() => {
    const ids = [...selection];
    if (ids.length !== 1) return null;
    return value.components.find((c) => c.id === ids[0]) ?? null;
  }, [selection, value.components]);

  const [nameDraft, setNameDraft] = useState<{ id: string; text: string } | null>(null);
  const editing = useRef(false);

  const nameText = nameDraft !== null && nameDraft.id === selectedComponent?.id ? nameDraft.text : (selectedComponent?.name ?? "");
  const nameOk = /^[A-Za-z][A-Za-z0-9_+-]{0,11}$/.test(nameText);

  const editComponent = useCallback(
    (patch: Partial<SchematicComponent>) => {
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

  const hint =
    mode === "place" && placeKind !== null
      ? fmt(s.hintPlace, { kind: s.kind(placeKind) })
      : mode === "wire"
        ? draft !== null
          ? s.hintWireDrawing
          : s.hintWire
        : selection.size > 0
          ? plural(s, "hintSelection", selection.size)
          : s.hintSelect;
  const modeName = mode === "place" ? s.modePlace : mode === "wire" ? s.modeWire : s.modeSelect;

  const hoveredPinOf = (componentId: string): number | null =>
    hover !== null && hover.kind === "pin" && hover.c === componentId ? hover.p : null;

  return (
    <div
      ref={rootRef}
      id={id}
      className={cx(frame, "focus-visible:outline-none")}
      tabIndex={0}
      role="group"
      aria-label={ariaLabel ?? s.editorLabel}
      onKeyDown={onKeyDown}
    >
      <div className={toolbar}>
        {readOnly ? null : (
          <>
            <div className={toolbarGroup}>
              <button
                type="button"
                className={toolButton(mode === "select")}
                aria-pressed={mode === "select"}
                onClick={() => {
                  setMode("select");
                  setPlaceKind(null);
                  setDraft(null);
                }}
              >
                <Icon name="select" />
                {s.toolSelect}
              </button>
              <button
                type="button"
                className={toolButton(mode === "wire")}
                aria-pressed={mode === "wire"}
                onClick={() => {
                  setMode("wire");
                  setPlaceKind(null);
                }}
              >
                <Icon name="wire" />
                {s.toolWire}
              </button>
            </div>
            <span className={separator} aria-hidden="true" />
            <div className={toolbarGroup}>
              <IconButton label={s.rotate} name="rotate" onClick={() => transformSelection(ROTATE)} disabled={selection.size === 0 && mode !== "place"} />
              <IconButton label={s.mirrorHorizontal} name="mirrorH" onClick={() => transformSelection(MIRROR_X)} disabled={selection.size === 0 && mode !== "place"} />
              <IconButton label={s.mirrorVertical} name="mirrorV" onClick={() => transformSelection(MIRROR_Y)} disabled={selection.size === 0 && mode !== "place"} />
              <IconButton label={s.duplicate} name="duplicate" onClick={duplicate} disabled={![...selection].some((x) => x.startsWith("c"))} />
              <IconButton label={s.remove} name="remove" onClick={removeSelection} disabled={selection.size === 0} />
            </div>
            <span className={separator} aria-hidden="true" />
            <div className={toolbarGroup}>
              <IconButton label={s.undo} name="undo" onClick={undo} disabled={!history.canUndo} />
              <IconButton label={s.redo} name="redo" onClick={redo} disabled={!history.canRedo} />
            </div>
          </>
        )}
        <div className="ml-auto flex items-center gap-1">
          <span className={cx(statusCursor, "text-[11px] text-fg-faint")}>{zoom} %</span>
          <IconButton label={s.fit} name="fit" onClick={fit} />
        </div>
      </div>

      <div className="flex flex-col sm:flex-row">
        {readOnly ? null : (
          <div className={paletteColumn} style={{ maxHeight: canvasHeight }}>
            <div className={paletteHead}>
              <span className={paletteTitle}>{s.components}</span>
              <span className={paletteCount}>{fmt(s.componentCount, { used, max: palette.maxComponents })}</span>
            </div>
            <div className={paletteGrid}>
              {kinds.map((kind) => {
                const disabled = full && !isTerminal(kind);
                return (
                  <button
                    key={kind}
                    type="button"
                    className={paletteTile(mode === "place" && placeKind === kind)}
                    aria-pressed={mode === "place" && placeKind === kind}
                    aria-label={s.kind(kind)}
                    title={s.kind(kind)}
                    disabled={disabled}
                    onPointerDown={(e) => {
                      if (e.button !== 0 || disabled) return;
                      const rearm = mode === "place" && placeKind === kind;
                      setMode("place");
                      setPlaceKind(kind);
                      setDraft(null);
                      setGhost((g) => ({ ...g, m: ORIENT_0 }));
                      setPalDrag({ kind, x: e.clientX, y: e.clientY, moved: false, rearm });
                    }}
                  >
                    <SymbolPreview kind={kind} width={48} height={22} />
                    <span className={paletteTileLabel}>{kind}</span>
                  </button>
                );
              })}
            </div>
            {full ? <p className="px-0.5 text-[11px] text-fg-faint">{fmt(s.paletteFull, { max: palette.maxComponents })}</p> : null}
          </div>
        )}

        <div ref={canvasRef} className={canvasArea} style={{ height: canvasHeight }}>
          <svg
            ref={svgRef}
            data-testid="schematic-canvas"
            role="application"
            aria-label={ariaLabel ?? s.editorLabel}
            viewBox={viewBoxAttr(view)}
            preserveAspectRatio="xMidYMid meet"
            width="100%"
            height="100%"
            className={cx("block touch-none select-none", mode === "wire" && "cursor-crosshair", mode === "place" && "cursor-copy")}
            onPointerDown={onPointerDown}
            onPointerMove={onPointerMove}
            onPointerUp={onPointerUp}
            onPointerLeave={() => {
              setCursor((c) => ({ ...c, inside: false }));
              setGhost((g) => ({ ...g, show: false }));
              setHover(null);
            }}
            onDoubleClick={(e) => {
              const w = toWorld(e.clientX, e.clientY);
              if (componentUnder(w.x, w.y) === null && wireUnder(w.x, w.y) === null && draft === null) {
                fit();
              }
            }}
            onContextMenu={(e) => e.preventDefault()}
          >
            <GridDefs id={patternId} />
            <Paper id={patternId} />
            <g>
              {displayed.wires.map((w) => {
                const points = routes.get(w.id);
                return points === undefined ? null : (
                  <WireGlyph key={w.id} wire={w} points={points} selected={selection.has(w.id)} />
                );
              })}
            </g>
            <Junctions schematic={displayed} routes={routes} />
            <g>
              {displayed.components.map((c) => (
                <ComponentGlyph
                  key={c.id}
                  component={c}
                  selected={selection.has(c.id)}
                  connected={connected}
                  hoveredPin={hoveredPinOf(c.id)}
                  {...(highlightPins === undefined ? {} : { flaggedPins: highlightPins })}
                />
              ))}
            </g>
            <Ports
              strings={s}
              {...(highlightPorts === undefined ? {} : { flagged: highlightPorts })}
              hovered={hover?.kind === "port" ? hover.port : null}
            />

            {/* Everything below is transient: it is never stored. */}
            <g className="pointer-events-none">
              {draftPoints !== null ? (
                <>
                  <path className={draftLine} d={pathOf(draftPoints)} />
                  {draft?.via.map((v, i) => (
                    <circle key={i} className="fill-accent" cx={v.x} cy={v.y} r={3} />
                  ))}
                </>
              ) : null}
              {selection.size > 0
                ? displayed.wires
                    .filter((w) => selection.has(w.id))
                    .flatMap((w) =>
                      w.via.map((v, i) => (
                        <rect
                          key={`${w.id}-${i}`}
                          className="fill-surface stroke-accent stroke-[1.6]"
                          x={v.x - 4.5}
                          y={v.y - 4.5}
                          width={9}
                          height={9}
                          rx={1.5}
                        />
                      )),
                    )
                : null}
              {mode === "place" && ghost.show && placeKind !== null ? (
                <ComponentGlyph
                  ghost
                  component={{ id: "ghost", kind: placeKind, x: ghost.x, y: ghost.y, m: ghost.m, name: "", value: "" }}
                />
              ) : null}
              {mode === "wire" && cursor.inside && hover === null ? (
                <path className={crosshair} d={`M${cursor.x - 6} ${cursor.y}h12M${cursor.x} ${cursor.y - 6}v12`} />
              ) : null}
              {drag?.kind === "box" ? (
                <rect
                  className={marquee}
                  x={Math.min(drag.x0, drag.x1)}
                  y={Math.min(drag.y0, drag.y1)}
                  width={Math.abs(drag.x1 - drag.x0)}
                  height={Math.abs(drag.y1 - drag.y0)}
                />
              ) : null}
            </g>
          </svg>

          {selectedComponent !== null ? (
            <div className={inspector}>
              <span className={inspectorTitle}>{s.kind(selectedComponent.kind)}</span>
              {readOnly ? (
                <>
                  <span className={readOnlyValue}>{selectedComponent.name}</span>
                  {selectedComponent.value !== "" ? (
                    <span className={readOnlyValue}>{selectedComponent.value}</span>
                  ) : null}
                </>
              ) : (
                <>
                  <label className="flex flex-col gap-1">
                    <span className={fieldLabel}>{s.fieldName}</span>
                    <input
                      className={nameOk ? fieldInput : fieldInputInvalid}
                      value={nameText}
                      spellCheck={false}
                      autoComplete="off"
                      aria-invalid={!nameOk}
                      onFocus={() => {
                        editing.current = false;
                      }}
                      onChange={(e) => {
                        const text = e.target.value;
                        setNameDraft({ id: selectedComponent.id, text });
                        if (/^[A-Za-z][A-Za-z0-9_+-]{0,11}$/.test(text)) editComponent({ name: text });
                      }}
                      onBlur={() => setNameDraft(null)}
                      onKeyDown={(e) => {
                        if (e.key === "Enter" || e.key === "Escape") e.currentTarget.blur();
                      }}
                    />
                  </label>
                  {nameOk ? null : <span className={fieldError}>{s.nameInvalid}</span>}
                  <ValueField
                    component={selectedComponent}
                    strings={s}
                    onEdit={(v) => editComponent({ value: v })}
                    onFocus={() => {
                      editing.current = false;
                    }}
                  />
                </>
              )}
            </div>
          ) : null}

        </div>
      </div>

      <div className={statusBar}>
        <span className={statusMode}>{modeName}</span>
        <span className={statusHint}>{hint}</span>
        <span className={statusCursor}>{fmt(s.cursor, { x: cursor.x, y: cursor.y })}</span>
      </div>
    </div>
  );
}

/** The value box, with the unit the library declares and a live verdict. */
function ValueField({
  component,
  strings,
  onEdit,
  onFocus,
}: {
  component: SchematicComponent;
  strings: CanvasStrings;
  onEdit: (value: string) => void;
  onFocus: () => void;
}): JSX.Element | null {
  const role = LIBRARY[component.kind].value;
  if (role.kind === "none") return null;
  const issue = valueIssue(component.kind, component.value);
  const message =
    issue === "missing"
      ? strings.valueMissing
      : issue === "invalid"
        ? strings.valueInvalid
        : issue === "range"
          ? `${strings.valueRange} ${formatValue(role.min)}…${formatValue(role.max)}${role.unit}`
          : null;
  return (
    <>
      <label className="flex flex-col gap-1">
        <span className={fieldLabel}>
          {strings.fieldValue} <span className="font-mono">({role.unit})</span>
        </span>
        <input
          className={issue === null ? fieldInput : fieldInputInvalid}
          value={component.value}
          spellCheck={false}
          autoComplete="off"
          aria-invalid={issue !== null}
          maxLength={24}
          onFocus={onFocus}
          onChange={(e) => onEdit(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" || e.key === "Escape") e.currentTarget.blur();
          }}
        />
      </label>
      {message === null ? null : <span className={fieldError}>{message}</span>}
    </>
  );
}

function Icon({ name }: { name: keyof typeof TOOL_ICONS }): JSX.Element {
  const paths = TOOL_ICONS[name] ?? [];
  return (
    <svg
      viewBox="0 0 16 16"
      className="size-4 shrink-0"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.6}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      {paths.map((d, i) => (
        <path key={i} d={d} />
      ))}
    </svg>
  );
}

function IconButton({
  label,
  name,
  onClick,
  disabled = false,
}: {
  label: string;
  name: keyof typeof TOOL_ICONS;
  onClick: () => void;
  disabled?: boolean;
}): JSX.Element {
  return (
    <button type="button" className={iconButton()} aria-label={label} title={label} onClick={onClick} disabled={disabled}>
      <Icon name={name} />
    </button>
  );
}
