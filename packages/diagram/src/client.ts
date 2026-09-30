/**
 * `@quiz/diagram/client`: the diagram editor and view (ADR-046 §1). The pure
 * engine is `@quiz/diagram/server`, which this entry does not repeat.
 */
export { DiagramEditor, type DiagramEditorProps } from "./editor/DiagramEditor.js";
export { DiagramView, type DiagramViewProps } from "./editor/DiagramView.js";
export { ToolIcon, LinkIcon } from "./editor/shapes.js";
export { diagramStrings, type DiagramStrings } from "./editor/strings.js";
