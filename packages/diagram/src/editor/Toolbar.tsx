/**
 * The editor's toolbar: select, the kind's tools and links as icons, the
 * history and the edits, and the teacher's Diagram / Text tabs.
 */
import { useId, type JSX } from "react";

import { Segmented } from "@quiz/ui";

import { KINDS, type DiagramKind, type PlaceTool } from "../kinds.js";
import type { LinkType } from "../scene.js";
import { CODECS } from "../codecs/index.js";
import { LinkIcon, ToolIcon } from "./shapes.js";
import { linkKey, toolKey, type DiagramStrings } from "./strings.js";
import { iconButton, lineButton, separator, toolbar } from "./styles.js";

export type Mode = { kind: "select" } | { kind: "place"; tool: PlaceTool } | { kind: "link"; type: LinkType };

export interface ToolbarProps {
  kind: DiagramKind;
  mode: Mode;
  onMode: (mode: Mode) => void;
  pane: "draw" | "text";
  /** The tabs, when the text form is offered. */
  onPane: ((pane: "draw" | "text") => void) | null;
  canUndo: boolean;
  canRedo: boolean;
  canDuplicate: boolean;
  canRemove: boolean;
  onUndo: () => void;
  onRedo: () => void;
  onDuplicate: () => void;
  onRemove: () => void;
  strings: DiagramStrings;
}

/** The digit that arms the tool at `index` from the keyboard: the order of the editor's `tools`, tools then links. */
const digit = (index: number): string | undefined => (index < 9 ? String(index + 1) : undefined);

export function Toolbar(p: ToolbarProps): JSX.Element {
  const { mode, strings: s } = p;
  const paneName = useId();
  const spec = KINDS[p.kind];
  return (
    <div className={toolbar} role="toolbar" aria-label={s.toolbox}>
      {p.pane === "draw" && (
        <>
          <button type="button" className={iconButton(mode.kind === "select")} aria-label={s.select} aria-pressed={mode.kind === "select"} onClick={() => p.onMode({ kind: "select" })}>
            <svg viewBox="0 0 16 16" className="size-4" aria-hidden="true">
              <path className="fill-none stroke-current stroke-[1.5] [stroke-linejoin:round]" d="M3 2l9 5.2-4 1-2 4.3z" />
            </svg>
          </button>
          <span className={separator} />
          {spec.tools.map((tool, i) => {
            const on = mode.kind === "place" && mode.tool === tool;
            return (
              <button key={tool} type="button" className={iconButton(on)} aria-label={s[toolKey(tool)]} aria-keyshortcuts={digit(i)} aria-pressed={on} onClick={() => p.onMode(on ? { kind: "select" } : { kind: "place", tool })}>
                <ToolIcon tool={tool} />
              </button>
            );
          })}
          {spec.links.length > 0 && <span className={separator} />}
          {spec.links.map((type, i) => {
            const on = mode.kind === "link" && mode.type === type;
            return (
              <button key={type} type="button" className={lineButton(on)} aria-label={s[linkKey(type)]} aria-keyshortcuts={digit(spec.tools.length + i)} aria-pressed={on} onClick={() => p.onMode(on ? { kind: "select" } : { kind: "link", type })}>
                <LinkIcon type={type} />
              </button>
            );
          })}
          <span className={separator} />
          <Action label={s.undo} disabled={!p.canUndo} onClick={p.onUndo} d="M7 4L3 8l4 4M3 8h9a4.5 4.5 0 0 1 0 9H9" />
          <Action label={s.redo} disabled={!p.canRedo} onClick={p.onRedo} d="M13 4l4 4-4 4M17 8H8a4.5 4.5 0 0 0 0 9h3" />
          <Action label={s.duplicate} disabled={!p.canDuplicate} onClick={p.onDuplicate} d="M3 3h10v10H3zM7 16.5h8.5a1.5 1.5 0 0 0 1.5-1.5V7" />
          <Action label={s.remove} disabled={!p.canRemove} onClick={p.onRemove} d="M3.5 5.5h13M8 5.5V3.5h4v2M5.5 5.5l.8 11h7.4l.8-11M8.5 8.5v5.5M11.5 8.5v5.5" />
        </>
      )}
      {p.onPane && CODECS[p.kind] && (
        // Two views of one value, not two panels: a segmented choice, which
        // the arrows move along (it was a tab list without tab panels).
        <div className="ml-auto">
          <Segmented
            name={paneName}
            size="sm"
            value={p.pane}
            options={[
              { value: "draw", label: s.draw },
              { value: "text", label: s.code },
            ]}
            onChange={p.onPane}
          />
        </div>
      )}
    </div>
  );
}

function Action({ label, disabled, onClick, d }: { label: string; disabled: boolean; onClick: () => void; d: string }): JSX.Element {
  return (
    <button type="button" className={iconButton()} aria-label={label} title={label} disabled={disabled} onClick={onClick}>
      <svg viewBox="0 0 20 20" className="size-[18px]" aria-hidden="true">
        <path className="fill-none stroke-current stroke-[1.6] [stroke-linecap:round] [stroke-linejoin:round]" d={d} />
      </svg>
    </button>
  );
}
