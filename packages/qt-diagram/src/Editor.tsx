/**
 * The `diagram` editor (docs/spec/04 §4.14): the statement, the KIND, the
 * reference diagram with its text tab, the optional starter, the rubric.
 *
 * Controlled and offline, like every editor: it reads `config`, emits a whole
 * new config through `onChange` and never fetches. An invalid draft is a
 * normal state (decision D16): a draft without a reference is stored, and the
 * publication refuses it (`diagram.reference_missing`).
 *
 * THE KIND is chosen on a draft only (ADR-046 addendum, decision 4): a grid of
 * cards, and changing it empties the reference and the starter — they hold
 * elements the new kind does not have — after an inline confirmation. Once
 * the question has a published version (`EditorProps.published`) the kind is
 * shown, locked: the answers already given are diagrams of that kind.
 *
 * The reference and the starter each have an Expand button when the host
 * lends a layer (`EditorProps.Expand`): the same canvas, text tab included,
 * over the page under the host's bar ("Close").
 */
import { useId, useState } from "react";

import type { ConfigIssue, EditorProps, MarkdownRenderer, StringOverrides } from "@quiz/core/client";
import { issuesAt, resolveStrings, rootIssues } from "@quiz/core/client";
import { DiagramEditor, ToolIcon, type DiagramStrings } from "@quiz/diagram/client";
import { DIAGRAM_KINDS, emptyScene, freshCopy, isEmptyScene, type DiagramKind, type PlaceTool, type Scene } from "@quiz/diagram/server";
import { AsideSection, buttonClass, cx, ExpandableCanvas, hint, IssueList, label, PromptField, sectionClass } from "@quiz/ui";

import type { DiagramConfig } from "./schema.js";
import { diagramEditorStrings, kindHintKey, kindKey, type DiagramEditorStringKey } from "./strings.js";

type DiagramEditorProps = Omit<EditorProps<DiagramConfig>, "uploadAsset"> & {
  uploadAsset?: EditorProps<DiagramConfig>["uploadAsset"];
  issues?: readonly ConfigIssue[];
  strings?: StringOverrides<DiagramEditorStringKey>;
  /** The engine's dictionary: tools, inspector, text pane (`qt.diagram.c.*` in the host). */
  canvasStrings?: Partial<DiagramStrings>;
  renderMarkdown?: MarkdownRenderer;
};

/** The canvas height of the reference and the starter: room for a dozen elements. */
const CANVAS_HEIGHT = 420;

/** The tool whose icon stands for a kind on its card. */
const KIND_ICON: Readonly<Record<DiagramKind, PlaceTool>> = {
  class: "class",
  usecase: "actor",
  state: "state",
  er: "entity",
  flow: "decision",
  automaton: "accept",
  graph: "vertex",
  free: "stroke",
};


export function DiagramQuestionEditor({
  config,
  onChange,
  disabled,
  published = false,
  issues = [],
  strings,
  canvasStrings,
  RichText,
  uploadAsset,
  aside,
  Expand,
  onCanvasShortcuts,
}: DiagramEditorProps) {
  const s = resolveStrings(diagramEditorStrings, strings);
  const id = useId();
  /** The kind the teacher picked while something is drawn: waiting for the confirmation. */
  const [pending, setPending] = useState<DiagramKind | null>(null);
  const patch = (next: Partial<DiagramConfig>) => onChange({ ...config, ...next });

  const setKind = (kind: DiagramKind) => {
    const { starter: _dropped, ...rest } = config;
    onChange({ ...rest, kind, reference: emptyScene() });
    setPending(null);
  };
  const pick = (kind: DiagramKind) => {
    if (kind === config.kind) return setPending(null);
    if (isEmptyScene(config.reference) && config.starter === undefined) return setKind(kind);
    setPending(kind);
  };
  const setStarter = (starter: Scene | undefined) => {
    const { starter: _old, ...rest } = config;
    onChange(starter === undefined ? rest : { ...rest, starter });
  };

  /** Inline at its height, or filling the host's expand layer (`EditorProps.Expand`). */
  const canvas = (value: Scene, name: string, change: (next: Scene) => void, fieldId: string) => (expanded: boolean) => (
    <DiagramEditor
      id={fieldId}
      kind={config.kind}
      value={value}
      onChange={change}
      readOnly={disabled}
      withText
      {...(expanded ? {} : { height: CANVAS_HEIGHT })}
      strings={canvasStrings}
      aria-label={name}
      onShortcuts={onCanvasShortcuts}
    />
  );

  return (
    <div className="flex flex-col gap-6">
      <IssueList issues={rootIssues(issues)} />

      <section className={sectionClass}>
        <PromptField
          id={`${id}-prompt`}
          label={s.prompt}
          value={config.prompt}
          onChange={(prompt) => patch({ prompt })}
          disabled={disabled}
          RichText={RichText}
          uploadImage={uploadAsset}
        />
        <IssueList issues={issuesAt(issues, "prompt")} />
      </section>

      <section className={sectionClass}>
        {published ? (
          <>
            <span className={label}>{s.kind}</span>
            <KindCard kind={config.kind} s={s} />
            <p className={hint}>{s.kindLocked}</p>
          </>
        ) : (
          <fieldset className="flex flex-col gap-2" disabled={disabled}>
            <legend className={cx(label, "mb-2")}>{s.kind}</legend>
            <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
              {DIAGRAM_KINDS.map((kind) => (
                <label
                  key={kind}
                  className={cx(
                    "flex cursor-pointer flex-col gap-1 rounded-field border p-3 transition-colors",
                    "has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-offset-2 has-[:focus-visible]:outline-accent",
                    (pending ?? config.kind) === kind
                      ? "border-accent bg-accent-soft"
                      : "border-line bg-surface hover:border-line-strong",
                  )}
                >
                  <input
                    type="radio"
                    className="sr-only"
                    name={`${id}-kind`}
                    value={kind}
                    checked={(pending ?? config.kind) === kind}
                    onChange={() => pick(kind)}
                  />
                  <span className="text-fg-muted">
                    <ToolIcon tool={KIND_ICON[kind]} />
                  </span>
                  <span className="text-[13px] font-medium text-fg">{s[kindKey(kind)]}</span>
                  <span className="text-xs leading-snug text-fg-muted">{s[kindHintKey(kind)]}</span>
                </label>
              ))}
            </div>
            <p className={hint}>{s.kindHint}</p>
          </fieldset>
        )}
        {pending === null ? null : (
          <div role="alert" className="flex flex-col gap-2 rounded-field border border-line bg-warning-soft p-3">
            <p className="text-[13px] font-medium text-fg">{s.kindChange}</p>
            <p className={hint}>{s.kindChangeBody}</p>
            <div className="flex flex-wrap gap-2">
              <button type="button" className={buttonClass("danger", "sm")} onClick={() => setKind(pending)}>
                {s.kindChangeConfirm}
              </button>
              <button type="button" className={buttonClass("secondary", "sm")} onClick={() => setPending(null)}>
                {s.kindChangeCancel}
              </button>
            </div>
          </div>
        )}
        <IssueList issues={issuesAt(issues, "kind")} />
      </section>

      <section className={sectionClass}>
        <ExpandableCanvas
          Expand={Expand}
          title={s.reference}
          hint={<p className={hint}>{s.referenceHint}</p>}
          strings={s}
        >
          {canvas(config.reference, s.reference, (reference) => patch({ reference }), `${id}-reference`)}
        </ExpandableCanvas>
        <IssueList issues={issuesAt(issues, "reference")} />
      </section>

      <section className={sectionClass}>
        {/* Without a starter there is nothing to expand: the row offers the copy instead. */}
        <ExpandableCanvas
          Expand={config.starter === undefined ? undefined : Expand}
          title={s.starter}
          hint={<p className={hint}>{s.starterHint}</p>}
          strings={s}
          actions={
            config.starter === undefined || disabled ? undefined : (
              <button type="button" className={buttonClass("ghost", "sm")} onClick={() => setStarter(undefined)}>
                {s.starterRemove}
              </button>
            )
          }
        >
          {config.starter === undefined
            ? () => (
                <div className="flex flex-wrap items-center gap-2">
                  <button
                    type="button"
                    className={buttonClass("secondary", "sm")}
                    disabled={disabled || isEmptyScene(config.reference)}
                    // Fresh ids: the starter reaches the student, and must share none with the reference (ADR-046 §2).
                    onClick={() => setStarter(freshCopy(config.reference))}
                  >
                    {s.starterCopy}
                  </button>
                  <span className={hint}>{s.starterCopyHint}</span>
                </div>
              )
            : canvas(config.starter, s.starter, (starter) => setStarter(starter), `${id}-starter`)}
        </ExpandableCanvas>
        <IssueList issues={issuesAt(issues, "starter")} />
      </section>

      <section className={sectionClass}>
        <PromptField
          id={`${id}-rubric`}
          label={s.rubric}
          value={config.rubric ?? ""}
          onChange={(rubric) => patch({ rubric })}
          disabled={disabled}
          RichText={RichText}
        />
        <p className={hint}>{s.rubricHint}</p>
        <IssueList issues={issuesAt(issues, "rubric")} />
      </section>

      <AsideSection aside={aside}>
        <p className={hint}>{s.manualGrading}</p>
      </AsideSection>
    </div>
  );
}

/** The chosen kind, locked: the card of the grid without its radio. */
function KindCard({ kind, s }: { kind: DiagramKind; s: Readonly<Record<DiagramEditorStringKey, string>> }) {
  return (
    <div className="flex max-w-xs items-start gap-3 rounded-field border border-line bg-surface-2 p-3">
      <span className="text-fg-muted">
        <ToolIcon tool={KIND_ICON[kind]} />
      </span>
      <span className="flex flex-col gap-0.5">
        <span className="text-[13px] font-medium text-fg">{s[kindKey(kind)]}</span>
        <span className="text-xs leading-snug text-fg-muted">{s[kindHintKey(kind)]}</span>
      </span>
    </div>
  );
}
