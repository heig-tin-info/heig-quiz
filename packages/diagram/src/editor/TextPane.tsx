/**
 * The text form of the diagram, the teacher's (ADR-046 §4): edited, parsed
 * on every keystroke and applied when it reads and fits. A line in error is
 * named, and a text that says a diagram larger than the schema allows is
 * refused: in both cases the diagram is left as it was.
 */
import { fmt } from "@quiz/core/client";
import { useState, type JSX } from "react";

import { applyParsed } from "../apply.js";
import { CODECS } from "../codecs/index.js";
import { MAX_SOURCE } from "../codecs/parsed.js";
import type { Measure } from "../geometry.js";
import { kindIssues, type DiagramKind } from "../kinds.js";
import { SceneSchema, type Scene } from "../scene.js";
import { BufferedText } from "./BufferedText.js";
import { nextSession } from "./session.js";
import { errorKey, type DiagramStrings } from "./strings.js";
import { codeArea, cx, statusBad, statusLine } from "./styles.js";

export interface TextPaneProps {
  kind: DiagramKind;
  scene: Scene;
  measure: Measure;
  /** A parsed text, applied: one call per keystroke that reads. */
  onEdit: (next: Scene, session: number) => void;
  strings: DiagramStrings;
  height: number | undefined;
}

export function TextPane({ kind, scene, measure, onEdit, strings: s, height }: TextPaneProps): JSX.Element | null {
  const [status, setStatus] = useState<{ bad: boolean; text: string }>({ bad: false, text: s.codeLive });
  const [session, setSession] = useState(0);
  const codec = CODECS[kind];
  if (!codec) return null;
  return (
    <div className="flex flex-col" style={height === undefined ? { height: "100%" } : { height }}>
      <BufferedText
        className={codeArea}
        aria-label={s.code}
        aria-invalid={status.bad}
        tabIndents
        value={codec.write(scene, measure)}
        onFocus={() => setSession(nextSession())}
        onValue={(text) => {
          if (text.length > MAX_SOURCE) {
            setStatus({ bad: true, text: s.codeTooLarge });
            return;
          }
          const parsed = codec.read(text);
          const first = parsed.errors[0];
          if (first) {
            setStatus({ bad: true, text: fmt(s.codeError, { line: first.line, message: fmt(s[errorKey(first.code)], { text: first.text }) }) });
            return;
          }
          const next = applyParsed(scene, parsed, kind, measure);
          if (!SceneSchema.safeParse(next).success || kindIssues(next, kind).length > 0) {
            setStatus({ bad: true, text: s.codeTooLarge });
            return;
          }
          setStatus({ bad: false, text: s.codeApplied });
          onEdit(next, session);
        }}
      />
      <p className={cx(statusLine, status.bad && statusBad)} role="status">
        {status.text}
      </p>
    </div>
  );
}
