/**
 * The properties of the one element or link selected. Every field writes
 * the scene on each keystroke; one focus of a field is one undo step (the
 * `session` handed to `onEdit`).
 */
import { fmt } from "@quiz/core/client";
import { useEffect, useRef, useState, type JSX, type RefObject } from "react";

import { BODIED, CIRCLES, KINDS, type DiagramKind } from "../kinds.js";
import { CARDINALITIES, type DiagramLink, type DiagramNode, type Scene } from "../scene.js";
import { patchItem, setInitial } from "./ops.js";
import { CardinalityIcon, LinkIcon } from "./shapes.js";
import { labelKey, linkKey, type DiagramStrings } from "./strings.js";
import { nextSession } from "./useHistory.js";
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
const lines = (text: string): string[] => text.split("\n").map((s) => s.trimEnd()).filter((s) => s.trim());


export function Inspector({ kind, scene, item, onEdit, onReverse, focus, onFocused, strings: s }: InspectorProps): JSX.Element {
  const session = useRef(0);
  const nameRef = useRef<HTMLInputElement>(null);
  const bodyRef = useRef<HTMLTextAreaElement>(null);
  const begin = (): void => {
    session.current = nextSession();
  };
  const edit = (patch: Partial<DiagramNode> & Partial<DiagramLink>): void => onEdit(patchItem(scene, item.id, patch), session.current);

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

  const keys = { onFocus: begin, onKeyDown: (e: React.KeyboardEvent<HTMLInputElement>) => (e.key === "Enter" || e.key === "Escape") && e.currentTarget.blur() };

  if (isLink(item)) {
    const a = scene.nodes.find((n) => n.id === item.a)?.name ?? "";
    const b = scene.nodes.find((n) => n.id === item.b)?.name ?? "";
    const types = KINDS[kind].links;
    const named = kind !== "usecase" || item.type === "assoc";
    return (
      <div className={inspector} aria-label={s[linkKey(item.type)]} role="group">
        {types.length > 1 && (
          <div className="flex flex-wrap gap-1" role="radiogroup">
            {types.map((t) => (
              <button
                key={t}
                type="button"
                role="radio"
                aria-checked={item.type === t}
                aria-label={s[linkKey(t)]}
                title={s[linkKey(t)]}
                className={lineButton(item.type === t)}
                onClick={() => {
                  begin();
                  edit({ type: t });
                }}
              >
                <LinkIcon type={t} />
              </button>
            ))}
          </div>
        )}
        {kind === "er" &&
          (["ma", "mb"] as const).map((end) => (
            <div key={end} className={field}>
              <span className="truncate">{end === "ma" ? a : b}</span>
              <div className="flex gap-1" role="radiogroup" aria-label={fmt(s.cardinality, { name: end === "ma" ? a : b })}>
                {CARDINALITIES.map((c) => (
                  <button
                    key={c}
                    type="button"
                    role="radio"
                    aria-checked={item[end] === c}
                    aria-label={c}
                    title={c}
                    className={iconButton(item[end] === c)}
                    onClick={() => {
                      begin();
                      edit({ [end]: c });
                    }}
                  >
                    <CardinalityIcon card={c} />
                  </button>
                ))}
              </div>
            </div>
          ))}
        {named && (
          <label className={field}>
            <span>{s[labelKey(kind)]}</span>
            <input className={input} value={item.name ?? ""} spellCheck={false} {...keys} onChange={(e) => edit({ name: e.target.value })} />
          </label>
        )}
        {kind === "class" &&
          (["ma", "mb"] as const).map((end) => (
            <label key={end} className={field}>
              <span className="truncate" title={end === "ma" ? a : b}>
                {end === "ma" ? a : b}
              </span>
              <input
                className={input}
                value={item[end] ?? ""}
                list="diagram-multiplicities"
                spellCheck={false}
                aria-label={fmt(s.multiplicity, { name: end === "ma" ? a : b })}
                {...keys}
                onChange={(e) => edit({ [end]: e.target.value.trim() })}
              />
            </label>
          ))}
        <datalist id="diagram-multiplicities">
          {["1", "0..1", "*", "0..*", "1..*"].map((m) => (
            <option key={m} value={m} />
          ))}
        </datalist>
        <button type="button" className={cx(iconButton(), "w-auto justify-start px-2 text-[12.5px]")} onClick={onReverse}>
          {s.swap}
        </button>
      </div>
    );
  }

  const bodied = BODIED.has(item.t);
  return (
    <div className={inspector} role="group" aria-label={item.name ?? ""}>
      <label className={field}>
        <span>{s.name}</span>
        <input ref={nameRef} className={input} value={item.name ?? ""} spellCheck={false} {...keys} onChange={(e) => edit({ name: e.target.value })} />
      </label>
      {item.t === "class" && (
        <>
          <label className={field}>
            <span>{s.stereotype}</span>
            <input
              className={input}
              value={item.stereo ?? ""}
              placeholder={s.stereotypeNone}
              list="diagram-stereotypes"
              spellCheck={false}
              {...keys}
              onChange={(e) => edit({ stereo: e.target.value.replace(/[«»<>]/g, "").trim() })}
            />
          </label>
          <datalist id="diagram-stereotypes">
            {["interface", "enumeration", "entity", "service", "utility", "dataType"].map((v) => (
              <option key={v} value={v} />
            ))}
          </datalist>
          <label className={checkRow}>
            <input
              type="checkbox"
              className="accent-accent"
              checked={item.abstract === true}
              onChange={(e) => {
                begin();
                edit({ abstract: e.target.checked });
              }}
            />
            {s.abstract}
          </label>
        </>
      )}
      {CIRCLES.has(item.t) && kind === "automaton" && (
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
            <input
              type="checkbox"
              className="accent-accent"
              checked={item.accept === true}
              onChange={(e) => {
                begin();
                edit({ accept: e.target.checked });
              }}
            />
            {s.accepting}
          </label>
        </div>
      )}
      {bodied && (
        <label className="flex flex-col gap-1 text-fg-muted">
          <span>{s[`body.${item.t as "class" | "entity" | "state"}`]}</span>
          <BufferedText
            textRef={bodyRef}
            className={textarea}
            rows={7}
            value={(item.body ?? []).join("\n")}
            onFocus={begin}
            onValue={(text) => edit({ body: lines(text) })}
          />
        </label>
      )}
      {item.t === "class" && <p className={tip}>{s.bodyHintClass}</p>}
      {item.t === "entity" && <p className={tip}>{s.bodyHintEntity}</p>}
    </div>
  );
}

/**
 * A textarea that keeps what is typed while it has the focus: the value it
 * writes back is normalised (blank lines dropped), and re-reading it at once
 * would eat the new line an Enter just made.
 */
export function BufferedText({
  value,
  onValue,
  onFocus,
  textRef,
  tabIndents = false,
  ...rest
}: {
  value: string;
  onValue: (text: string) => void;
  onFocus?: () => void;
  /** Tab indents by two spaces instead of leaving the field: the text pane. */
  tabIndents?: boolean;
  textRef?: RefObject<HTMLTextAreaElement | null>;
  className?: string;
  rows?: number;
  "aria-label"?: string;
  "aria-invalid"?: boolean;
}): JSX.Element {
  const [local, setLocal] = useState<string | null>(null);
  return (
    <textarea
      ref={textRef}
      spellCheck={false}
      {...rest}
      value={local ?? value}
      onFocus={() => {
        setLocal(value);
        onFocus?.();
      }}
      onBlur={() => setLocal(null)}
      onKeyDown={(e) => {
        if (e.key === "Escape") e.currentTarget.blur();
        if (tabIndents && e.key === "Tab" && !e.shiftKey) {
          e.preventDefault();
          const el = e.currentTarget;
          el.setRangeText("  ", el.selectionStart, el.selectionEnd, "end");
          setLocal(el.value);
          onValue(el.value);
        }
      }}
      onChange={(e) => {
        setLocal(e.target.value);
        onValue(e.target.value);
      }}
    />
  );
}
