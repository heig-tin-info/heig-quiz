/**
 * The `diagram` player (docs/spec/04 §4.14, ADR-046 §6): the statement, the
 * canvas inline under it, and an Expand button that opens the same canvas in
 * the host's layer (`PlayerProps.Expand`) — the page covered with a margin of
 * 16 px, the host's thin bar above: the server's clock, the save state, and
 * "Back to the questions". Never the browser's full screen.
 *
 * Both views edit ONE answer, the one the host holds: the canvas is
 * controlled, and every committed edit goes out through `onChange` as a whole
 * scene, which the autosave sends as usual. Nothing is written before the
 * first edit — the starter shows, but an untouched question has no answer.
 *
 * On a screen under 1024 px the inline canvas is a preview and the layer is
 * where one draws; without a host layer (the grading panel) there is no
 * Expand button, and the inline canvas edits at every width. The heading,
 * the button, the preview and the one-line note while the layer is open are
 * `ExpandableCanvas` of `@quiz/ui`, which the `circuit` player shares.
 *
 * ESCAPE in the layer: the canvas cancels what it has in progress first (the
 * link being drawn, the tool, the selection) and consumes the key only then;
 * a key it leaves alone closes the layer, which is the host's to decide.
 */
import type { MarkdownRenderer, PlayerProps, StringOverrides } from "@quiz/core/client";
import { resolveStrings } from "@quiz/core/client";
import { DiagramEditor, DiagramView, type DiagramStrings } from "@quiz/diagram/client";
import type { Scene } from "@quiz/diagram/server";
import { ExpandableCanvas, isLocked, markdown } from "@quiz/ui";

import { startingScene, type DiagramAnswer, type DiagramStudent } from "./schema.js";
import { diagramPlayerStrings, type DiagramPlayerStringKey } from "./strings.js";

type DiagramPlayerProps = PlayerProps<DiagramStudent, DiagramAnswer> & {
  /** Alias of `readOnly`, for hosts that speak in disabled controls. */
  disabled?: boolean;
  strings?: StringOverrides<DiagramPlayerStringKey>;
  /** The engine's dictionary: the tools' accessible names, the inspector. */
  canvasStrings?: Partial<DiagramStrings>;
  renderMarkdown?: MarkdownRenderer;
};

/** The inline canvas: tall enough to draw a dozen elements, short enough to keep the prompt in sight. */
const INLINE_HEIGHT = 440;

export function DiagramPlayer({
  student,
  answer,
  onChange,
  readOnly,
  disabled,
  strings,
  canvasStrings,
  renderMarkdown,
  Expand,
  onCanvasShortcuts,
}: DiagramPlayerProps) {
  const s = resolveStrings(diagramPlayerStrings, strings);
  const locked = isLocked(readOnly, disabled);
  const scene = answer?.scene ?? startingScene(student.starter);
  const change = (next: Scene) => onChange({ scene: next });

  return (
    <div className="flex flex-col gap-4">
      <div className="text-lg leading-relaxed text-fg">{markdown(renderMarkdown, student.prompt)}</div>
      <ExpandableCanvas
        Expand={Expand}
        title={s.label}
        strings={s}
        locked={locked}
        preview={<DiagramView kind={student.kind} value={scene} maxHeight={280} strings={canvasStrings} />}
      >
        {(expanded) => (
          <DiagramEditor
            kind={student.kind}
            value={scene}
            onChange={change}
            readOnly={locked}
            strings={canvasStrings}
            aria-label={s.label}
            onShortcuts={onCanvasShortcuts}
            {...(expanded ? {} : { height: INLINE_HEIGHT })}
          />
        )}
      </ExpandableCanvas>
    </div>
  );
}
