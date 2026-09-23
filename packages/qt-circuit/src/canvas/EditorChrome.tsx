/**
 * The pieces of the schematic editor that are drawn, not decided: the
 * toolbar, the palette, the stored layers of the drawing, the transient
 * overlay, the inspector and the status bar.
 *
 * Every piece is a pure function of its props. The state and the rules stay
 * in `SchematicEditor` and its hooks; nothing here holds a hook of its own,
 * so splitting the markup out did not change the editor's hook order.
 */
import type { Dispatch, JSX, RefObject, SetStateAction } from "react";

import { LIBRARY, formatValue, valueIssue, type ComponentKind, type PortId } from "../library.js";
import type { Orientation, Schematic, SchematicComponent, Wire } from "../schema.js";

import { fmt, plural } from "@quiz/core/client";
import type { CanvasStrings } from "./canvasStrings.js";
import {
  cx,
  draftLine,
  fieldError,
  fieldInput,
  fieldInputInvalid,
  fieldLabel,
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
import { MIRROR_X, MIRROR_Y, ROTATE, type PinTarget } from "./geometry.js";
import { pathOf } from "./router.js";
import {
  ComponentGlyph,
  GridDefs,
  Junctions,
  Paper,
  Ports,
  SymbolPreview,
  WireGlyph,
  type FlaggedPin,
} from "./SchematicView.js";
import { TOOL_ICONS } from "./symbols.js";
import type { Drag, Ghost } from "./usePartDragging.js";
import type { Cursor } from "./usePointerTools.js";
import { isTerminal, type Mode } from "./useSelection.js";
import type { Draft } from "./useWireDrawing.js";

type Routes = ReadonlyMap<string, Array<[number, number]>>;

/** A component name the schema takes: a letter, then up to eleven of letters, digits, `_+-`. */
const NAME = /^[A-Za-z][A-Za-z0-9_+-]{0,11}$/;

export function Toolbar({
  strings: s,
  readOnly,
  mode,
  selection,
  canUndo,
  canRedo,
  zoom,
  setMode,
  setPlaceKind,
  setDraft,
  transform,
  duplicate,
  remove,
  undo,
  redo,
  fit,
}: {
  strings: CanvasStrings;
  readOnly: boolean;
  mode: Mode;
  selection: ReadonlySet<string>;
  canUndo: boolean;
  canRedo: boolean;
  zoom: number;
  setMode: Dispatch<SetStateAction<Mode>>;
  setPlaceKind: Dispatch<SetStateAction<ComponentKind | null>>;
  setDraft: Dispatch<SetStateAction<Draft | null>>;
  transform: (t: Orientation) => void;
  duplicate: () => void;
  remove: () => void;
  undo: () => void;
  redo: () => void;
  fit: () => void;
}): JSX.Element {
  /* A transform turns the selection, or the piece in hand while placing. */
  const nothingToTurn = selection.size === 0 && mode !== "place";
  return (
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
            <IconButton label={s.rotate} name="rotate" onClick={() => transform(ROTATE)} disabled={nothingToTurn} />
            <IconButton label={s.mirrorHorizontal} name="mirrorH" onClick={() => transform(MIRROR_X)} disabled={nothingToTurn} />
            <IconButton label={s.mirrorVertical} name="mirrorV" onClick={() => transform(MIRROR_Y)} disabled={nothingToTurn} />
            <IconButton label={s.duplicate} name="duplicate" onClick={duplicate} disabled={![...selection].some((x) => x.startsWith("c"))} />
            <IconButton label={s.remove} name="remove" onClick={remove} disabled={selection.size === 0} />
          </div>
          <span className={separator} aria-hidden="true" />
          <div className={toolbarGroup}>
            <IconButton label={s.undo} name="undo" onClick={undo} disabled={!canUndo} />
            <IconButton label={s.redo} name="redo" onClick={redo} disabled={!canRedo} />
          </div>
        </>
      )}
      <div className="ml-auto flex items-center gap-1">
        <span className={cx(statusCursor, "text-[11px] text-fg-faint")}>{zoom} %</span>
        <IconButton label={s.fit} name="fit" onClick={fit} />
      </div>
    </div>
  );
}

export function PaletteRail({
  strings: s,
  kinds,
  used,
  max,
  full,
  mode,
  placeKind,
  maxHeight,
  onGrab,
}: {
  strings: CanvasStrings;
  kinds: readonly ComponentKind[];
  used: number;
  max: number;
  full: boolean;
  mode: Mode;
  placeKind: ComponentKind | null;
  maxHeight: number;
  /** A tile pressed with the main button; `rearm` when it was already the armed one. */
  onGrab: (kind: ComponentKind, clientX: number, clientY: number, rearm: boolean) => void;
}): JSX.Element {
  return (
    <div className={paletteColumn} style={{ maxHeight }}>
      <div className={paletteHead}>
        <span className={paletteTitle}>{s.components}</span>
        <span className={paletteCount}>{fmt(s.componentCount, { used, max })}</span>
      </div>
      <div className={paletteGrid}>
        {kinds.map((kind) => {
          const disabled = full && !isTerminal(kind);
          const armed = mode === "place" && placeKind === kind;
          return (
            <button
              key={kind}
              type="button"
              className={paletteTile(armed)}
              aria-pressed={armed}
              aria-label={s.kind(kind)}
              title={s.kind(kind)}
              disabled={disabled}
              onPointerDown={(e) => {
                if (e.button !== 0 || disabled) return;
                onGrab(kind, e.clientX, e.clientY, armed);
              }}
            >
              <SymbolPreview kind={kind} width={48} height={22} />
              <span className={paletteTileLabel}>{kind}</span>
            </button>
          );
        })}
      </div>
      {full ? <p className="px-0.5 text-[11px] text-fg-faint">{fmt(s.paletteFull, { max })}</p> : null}
    </div>
  );
}

/** What is stored, as drawn: the paper, the wires, the junctions, the parts and the ports. */
export function Drawing({
  strings: s,
  patternId,
  schematic,
  routes,
  selection,
  connected,
  hover,
  highlightPins,
  highlightPorts,
}: {
  strings: CanvasStrings;
  patternId: string;
  schematic: Schematic;
  routes: Routes;
  selection: ReadonlySet<string>;
  connected: ReadonlySet<string>;
  hover: PinTarget | null;
  highlightPins: readonly FlaggedPin[] | undefined;
  highlightPorts: readonly PortId[] | undefined;
}): JSX.Element {
  const hoveredPinOf = (componentId: string): number | null =>
    hover !== null && hover.kind === "pin" && hover.c === componentId ? hover.p : null;
  return (
    <>
      <GridDefs id={patternId} />
      <Paper id={patternId} />
      <g>
        {schematic.wires.map((w) => {
          const points = routes.get(w.id);
          return points === undefined ? null : (
            <WireGlyph key={w.id} wire={w} points={points} selected={selection.has(w.id)} />
          );
        })}
      </g>
      <Junctions schematic={schematic} routes={routes} />
      <g>
        {schematic.components.map((c) => (
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
    </>
  );
}

/** Everything drawn over the schematic that is never stored. */
export function Transient({
  draftPoints,
  draft,
  wires,
  selection,
  mode,
  ghost,
  placeKind,
  cursor,
  hover,
  drag,
}: {
  draftPoints: Array<[number, number]> | null;
  draft: Draft | null;
  wires: readonly Wire[];
  selection: ReadonlySet<string>;
  mode: Mode;
  ghost: Ghost;
  placeKind: ComponentKind | null;
  cursor: Cursor;
  hover: PinTarget | null;
  drag: Drag | null;
}): JSX.Element {
  return (
    <g className="pointer-events-none">
      {draftPoints !== null ? (
        <>
          <path className={draftLine} d={pathOf(draftPoints)} />
          {draft?.via.map((v, i) => (
            <circle key={i} className="fill-accent" cx={v.x} cy={v.y} r={3} />
          ))}
        </>
      ) : null}
      {selection.size > 0 ? <WaypointHandles wires={wires} selection={selection} /> : null}
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
  );
}

/** A square handle on every waypoint of a selected wire. */
function WaypointHandles({ wires, selection }: { wires: readonly Wire[]; selection: ReadonlySet<string> }): JSX.Element {
  return (
    <>
      {wires
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
        )}
    </>
  );
}

/**
 * The one selected component's name and value. A run of keystrokes in one
 * field is ONE undo step: `editing` is reset when a field takes the focus.
 */
export function Inspector({
  strings: s,
  component,
  readOnly,
  nameDraft,
  setNameDraft,
  editing,
  edit,
}: {
  strings: CanvasStrings;
  component: SchematicComponent;
  readOnly: boolean;
  /** The name as typed, which may not be valid yet; `null` shows the stored one. */
  nameDraft: { id: string; text: string } | null;
  setNameDraft: Dispatch<SetStateAction<{ id: string; text: string } | null>>;
  editing: RefObject<boolean>;
  edit: (patch: Partial<SchematicComponent>) => void;
}): JSX.Element {
  const nameText = nameDraft !== null && nameDraft.id === component.id ? nameDraft.text : component.name;
  const nameOk = NAME.test(nameText);
  const startEditing = (): void => {
    editing.current = false;
  };
  return (
    <div className={inspector}>
      <span className={inspectorTitle}>{s.kind(component.kind)}</span>
      {readOnly ? (
        <>
          <span className={readOnlyValue}>{component.name}</span>
          {component.value !== "" ? <span className={readOnlyValue}>{component.value}</span> : null}
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
              onFocus={startEditing}
              onChange={(e) => {
                const text = e.target.value;
                setNameDraft({ id: component.id, text });
                if (NAME.test(text)) edit({ name: text });
              }}
              onBlur={() => setNameDraft(null)}
              onKeyDown={blurOnEnterOrEscape}
            />
          </label>
          {nameOk ? null : <span className={fieldError}>{s.nameInvalid}</span>}
          <ValueField component={component} strings={s} onEdit={(v) => edit({ value: v })} onFocus={startEditing} />
        </>
      )}
    </div>
  );
}

const blurOnEnterOrEscape = (e: { key: string; currentTarget: HTMLInputElement }): void => {
  if (e.key === "Enter" || e.key === "Escape") e.currentTarget.blur();
};

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
          onKeyDown={blurOnEnterOrEscape}
        />
      </label>
      {message === null ? null : <span className={fieldError}>{message}</span>}
    </>
  );
}

export function StatusBar({
  strings: s,
  mode,
  placeKind,
  drafting,
  selected,
  cursor,
}: {
  strings: CanvasStrings;
  mode: Mode;
  placeKind: ComponentKind | null;
  /** A wire is being drawn. */
  drafting: boolean;
  /** How many things are selected. */
  selected: number;
  cursor: Cursor;
}): JSX.Element {
  const hint =
    mode === "place" && placeKind !== null
      ? fmt(s.hintPlace, { kind: s.kind(placeKind) })
      : mode === "wire"
        ? drafting
          ? s.hintWireDrawing
          : s.hintWire
        : selected > 0
          ? plural(s, "hintSelection", selected)
          : s.hintSelect;
  const modeName = mode === "place" ? s.modePlace : mode === "wire" ? s.modeWire : s.modeSelect;
  return (
    <div className={statusBar}>
      <span className={statusMode}>{modeName}</span>
      <span className={statusHint}>{hint}</span>
      <span className={statusCursor}>{fmt(s.cursor, { x: cursor.x, y: cursor.y })}</span>
    </div>
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
