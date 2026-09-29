/**
 * The text form of the diagram, the teacher's (ADR-041 §4): edited, parsed
 * on every keystroke and applied when it reads. A line in error is named and
 * the diagram is left as it was.
 */
import { fmt } from "@quiz/core/client";
import { useState, type JSX } from "react";

import { applyParsed } from "../apply.js";
import { parseText, toText } from "../codecs/index.js";
import type { Measure } from "../geometry.js";
import type { DiagramKind } from "../kinds.js";
import type { Scene } from "../scene.js";
import { BufferedText } from "./Inspector.js";
import { errorKey, type DiagramStrings } from "./strings.js";
import { codeArea, cx, statusBad, statusLine } from "./styles.js";
import { nextSession } from "./useHistory.js";

export interface TextPaneProps {
  kind: DiagramKind;
  scene: Scene;
  measure: Measure;
  /** A parsed text, applied: one call per keystroke that reads. */
  onEdit: (next: Scene, session: number) => void;
  strings: DiagramStrings;
  height: number | undefined;
}


export function TextPane({ kind, scene, measure, onEdit, strings: s, height }: TextPaneProps): JSX.Element {
  const [status, setStatus] = useState<{ bad: boolean; text: string }>({ bad: false, text: s.codeLive });
  const [session, setSession] = useState(0);
  return (
    <div className="flex flex-col" style={height === undefined ? { height: "100%" } : { height }}>
      <BufferedText
        className={codeArea}
        aria-label={s.code}
        aria-invalid={status.bad}
        tabIndents
        value={toText(scene, kind, measure) ?? ""}
        onFocus={() => setSession(nextSession())}
        onValue={(text) => {
          const parsed = parseText(text, kind);
          const first = parsed.errors[0];
          if (first) {
            setStatus({ bad: true, text: fmt(s.codeError, { line: first.line, message: fmt(s[errorKey(first.code)], { text: first.text }) }) });
            return;
          }
          setStatus({ bad: false, text: s.codeApplied });
          onEdit(applyParsed(scene, parsed, kind, measure), session);
        }}
      />
      <p className={cx(statusLine, status.bad && statusBad)} role="status">
        {status.text}
      </p>
    </div>
  );
}
