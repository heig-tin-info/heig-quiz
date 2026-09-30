/**
 * The properties of the one element or link selected. Every field writes
 * the scene on each keystroke; one focus of a field is one undo step (the
 * `session` handed to `onEdit`). Every field is bounded like the schema.
 */
import { fmt } from "@quiz/core/client";
import { useEffect, useId, useRef, type JSX, type KeyboardEvent } from "react";

import { BODIED, KINDS, LINK_STYLE, type DiagramKind } from "../kinds.js";
import {
  BODY_LINES_MAX,
  BODY_LINE_MAX,
  CARDINALITIES,
  LABEL_MAX,
  NAME_MAX,
  type DiagramLink,
  type DiagramNode,
  type Scene,
} from "../scene.js";
import { BufferedText } from "./BufferedText.js";
import { patchItem, setInitial } from "./ops.js";
import { nextSession } from "./session.js";
import { CardinalityIcon, LinkIcon } from "./shapes.js";
import { labelKey, linkKey, type DiagramStrings } from "./strings.js";
import { checkRow, cx, field, iconButton, input, inspector, lineButton, textarea, tip } from "./styles.js";

/** A field to focus once the inspector shows: the name, or a line of the body. */
export type FocusRequest = { field: "name" } | { field: "body"; line: number } | null;

export interface InspectorProps {
  kind: DiagramKind;
  scene: Scene;
  item: DiagramNode | DiagramLink;
  /** `session` changes with every focus: the editor records one undo step per session. */
  onEdit: (next: Scene, session: number) => void;
  onReverse: () => void;
  focus: FocusRequest;
  onFocused: () => void;
  strings: DiagramStrings;
}

const isLink = (item: DiagramNode | DiagramLink): item is DiagramLink => "type" in item;

/** A body as lines: blank ones dropped, each line and their count bounded like the schema. */
const bodyLines = (text: string): string[] =>
  text
    .split("\n")
    .map((l) => l.trimEnd().slice(0, BODY_LINE_MAX))
    .filter((l) => l.trim())
    .slice(0, BODY_LINES_MAX);

const MULTIPLICITIES = ["1", "0..1", "*", "0..*", "1..*"];
const STEREOTYPES = ["interface", "enumeration", "entity", "service", "utility", "dataType"];

export function Inspector({ kind, scene, item, onEdit, onReverse, focus, onFocused, strings: s }: InspectorProps): JSX.Element {
  const listId = useId();
  const session = useRef(0);
  const nameRef = useRef<HTMLInputElement>(null);
  const bodyRef = useRef<HTMLTextAreaElement>(null);
  const begin = (): void => {
    session.current = nextSession();
  };
  const edit = (patch: Partial<DiagramNode> & Partial<DiagramLink>): void => onEdit(patchItem(scene, item.id, patch), session.current);
  /* a click on a choice is a session of its own */
  const choose = (patch: Partial<DiagramNode> & Partial<DiagramLink>): void => {
    begin();
    edit(patch);
  };

  useEffect(() => {
    if (!focus) return;
    if (focus.field === "name") {
      nameRef.current?.focus();
      nameRef.current?.select();
    } else if (bodyRef.current) {
      const el = bodyRef.current;
      el.focus();
      const at = el.value.split("\n").slice(0, focus.line + 1).join("\n").length;
      el.setSelectionRange(at, at);
    }
    onFocused();
  }, [focus, onFocused]);

  const text = {
    onFocus: begin,
    spellCheck: false,
    onKeyDown: (e: KeyboardEvent<HTMLInputElement>) => (e.key === "Enter" || e.key === "Escape") && e.currentTarget.blur(),
  };

  if (isLink(item)) {
    const endName = (end: "ma" | "mb"): string => scene.nodes.find((n) => n.id === (end === "ma" ? item.a : item.b))?.name ?? "";
    const spec = KINDS[kind];
    return (
      <div className={inspector} aria-label={s[linkKey(item.type)]} role="group">
        {spec.links.length > 1 && (
          <div className="flex flex-wrap gap-1" role="radiogroup">
            {spec.links.map((t) => (
              <button
                key={t}
                type="button"
                role="radio"
                aria-checked={item.type === t}
                aria-label={s[linkKey(t)]}
                title={s[linkKey(t)]}
                className={lineButton(item.type === t)}
                onClick={() => choose({ type: t })}
              >
                <LinkIcon type={t} />
              </button>
            ))}
          </div>
        )}
        {spec.ends === "cardinality" &&
          (["ma", "mb"] as const).map((end) => (
            <div key={end} className={field}>
              <span className="truncate">{endName(end)}</span>
              <div className="flex gap-1" role="radiogroup" aria-label={fmt(s.cardinality, { name: endName(end) })}>
                {CARDINALITIES.map((c) => (
                  <button
                    key={c}
                    type="button"
                    role="radio"
                    aria-checked={item[end] === c}
                    aria-label={c}
                    title={c}
                    className={iconButton(item[end] === c)}
                    onClick={() => choose({ [end]: c })}
                  >
                    <CardinalityIcon card={c} />
                  </button>
                ))}
              </div>
            </div>
          ))}
        {!LINK_STYLE[item.type].label && (
          <label className={field}>
            <span>{s[labelKey(kind)]}</span>
            <input className={input} value={item.name ?? ""} maxLength={NAME_MAX} {...text} onChange={(e) => edit({ name: e.target.value })} />
          </label>
        )}
        {spec.ends === "multiplicity" &&
          (["ma", "mb"] as const).map((end) => (
            <label key={end} className={field}>
              <span className="truncate" title={endName(end)}>
                {endName(end)}
              </span>
              <input
                className={input}
                value={item[end] ?? ""}
                list={`${listId}-m`}
                maxLength={LABEL_MAX}
                aria-label={fmt(s.multiplicity, { name: endName(end) })}
                {...text}
                onChange={(e) => edit({ [end]: e.target.value.trim() })}
              />
            </label>
          ))}
        {spec.ends === "multiplicity" && (
          <datalist id={`${listId}-m`}>
            {MULTIPLICITIES.map((m) => (
              <option key={m} value={m} />
            ))}
          </datalist>
        )}
        <button type="button" className={cx(iconButton(), "w-auto justify-start px-2 text-[12.5px]")} onClick={onReverse}>
          {s.swap}
        </button>
      </div>
    );
  }

  return (
    <div className={inspector} role="group" aria-label={item.name ?? ""}>
      <label className={field}>
        <span>{s.name}</span>
        <input ref={nameRef} className={input} value={item.name ?? ""} maxLength={NAME_MAX} {...text} onChange={(e) => edit({ name: e.target.value })} />
      </label>
      {item.t === "class" && (
        <>
          <label className={field}>
            <span>{s.stereotype}</span>
            <input
              className={input}
              value={item.stereo ?? ""}
              placeholder={s.stereotypeNone}
              list={`${listId}-s`}
              maxLength={NAME_MAX}
              {...text}
              onChange={(e) => edit({ stereo: e.target.value.replace(/[«»<>]/g, "").trim() })}
            />
          </label>
          <datalist id={`${listId}-s`}>
            {STEREOTYPES.map((v) => (
              <option key={v} value={v} />
            ))}
          </datalist>
          <label className={checkRow}>
            <input type="checkbox" className="accent-accent" checked={item.abstract === true} onChange={(e) => choose({ abstract: e.target.checked })} />
            {s.abstract}
          </label>
        </>
      )}
      {item.t === "astate" && (
        <div className="flex gap-4">
          <label className={checkRow}>
            <input
              type="checkbox"
              className="accent-accent"
              checked={item.initial === true}
              onChange={(e) => {
                begin();
                onEdit(setInitial(scene, item.id, e.target.checked), session.current);
              }}
            />
            {s.initial}
          </label>
          <label className={checkRow}>
            <input type="checkbox" className="accent-accent" checked={item.accept === true} onChange={(e) => choose({ accept: e.target.checked })} />
            {s.accepting}
          </label>
        </div>
      )}
      {BODIED.has(item.t) && (
        <label className="flex flex-col gap-1 text-fg-muted">
          <span>{s[`body.${item.t as "class" | "entity" | "state"}`]}</span>
          <BufferedText
            textRef={bodyRef}
            className={textarea}
            rows={7}
            value={(item.body ?? []).join("\n")}
            onFocus={begin}
            onValue={(value) => edit({ body: bodyLines(value) })}
          />
        </label>
      )}
      {item.t === "class" && <p className={tip}>{s.bodyHintClass}</p>}
      {item.t === "entity" && <p className={tip}>{s.bodyHintEntity}</p>}
    </div>
  );
}
