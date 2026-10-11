/**
 * The teacher's editor of a `blocks` question (docs/spec/04 §4.17): the
 * statement, the toolbox, the starter program, the reference with its
 * "Check the reference", the warehouses with their grids, and the scoring —
 * cards, as the code and circuit editors, because the sections are long.
 *
 * "Check the reference" runs the reference on EVERY warehouse in the browser,
 * hidden ones included — the teacher's own key, never a student's — through
 * the interpreter publication runs (`publicationIssues`), so what it lists is
 * what publication will say.
 */
import { useEffect, useState, type ReactNode } from "react";

import type { ConfigIssue, EditorProps, StringOverrides } from "@quiz/core/client";
import { fmt, issuesAt, plural, resolveStrings } from "@quiz/core/client";
import { BLOCK_KINDS, type BlockKind, type Stmt } from "@quiz/domain/blocks";
import {
  AsideSection,
  Button,
  CheckboxField,
  EditorSection,
  hint,
  IssueList,
  NumberField,
  patchAt,
  PromptSection,
  removeAt,
  RowHead,
  RowList,
  RowListHeader,
  sectionTitle,
  setting,
  Verdict,
  verdictTone,
} from "@quiz/ui";

import { BlocklyHost } from "./BlocklyHost.js";
import { reasonWord } from "./CaseTable.js";
import { referenceRuns } from "./grade.js";
import { MapEditor } from "./MapEditor.js";
import { CASES_MAX, emptyCase, totalCasePoints, type BlocksConfig } from "./schema.js";
import {
  blocksCanvasStrings,
  blocksEditorStrings,
  type BlocksCanvasStringKey,
  type BlocksCanvasStrings,
  type BlocksEditorStringKey,
  type BlocksEditorStrings,
} from "./strings.js";

export type BlocksEditorProps = EditorProps<BlocksConfig> & {
  strings?: StringOverrides<BlocksEditorStringKey>;
  canvasStrings?: StringOverrides<BlocksCanvasStringKey>;
  blockly?: boolean | undefined;
};

const KIND_WORD = {
  forward: "kindForward",
  turn: "kindTurn",
  repeat: "kindRepeat",
  repeat_until_dock: "kindRepeatUntilDock",
  if_sensor: "kindIfSensor",
} as const satisfies Record<BlockKind, BlocksCanvasStringKey>;

/** The issues of exactly this path, not of what lies under it. */
const issuesHere = (issues: readonly ConfigIssue[], ...path: (string | number)[]) =>
  issuesAt(issues, ...path).filter((issue) => issue.path.length === path.length);

function ReferenceCheck({
  reference,
  cases,
  s,
  c,
}: {
  reference: Stmt[];
  cases: BlocksConfig["cases"];
  s: BlocksEditorStrings;
  c: BlocksCanvasStrings;
}): ReactNode {
  const [checks, setChecks] = useState<ReturnType<typeof referenceRuns> | null>(null);
  const key = JSON.stringify([reference, cases]);
  // A changed reference or warehouse is one nobody checked yet.
  useEffect(() => setChecks(null), [key]);
  const run = () => setChecks(referenceRuns(reference, cases));
  const missed = checks?.filter((check) => !check?.ok).length ?? 0;
  return (
    <div className="flex flex-col gap-2">
      <div className="flex flex-wrap items-center gap-3">
        <Button size="sm" disabled={reference.length === 0} onClick={run}>
          {s.checkReference}
        </Button>
        {reference.length === 0 ? <span className={hint}>{s.referenceEmpty}</span> : null}
        {checks === null ? null : (
          <span role="status" className={missed === 0 ? "text-[13px] text-success" : "text-[13px] text-danger"}>
            {missed === 0 ? s.referenceAllPass : plural(s, "referenceFails", missed)}
          </span>
        )}
      </div>
      {checks === null ? null : (
        <ul className="flex flex-col gap-1">
          {checks.map((check, i) => (
            <li key={i} className="flex items-center gap-2 text-[13px] text-fg">
              <Verdict tone={verdictTone(check?.ok)}>{check === null ? "—" : reasonWord(c, check.reason)}</Verdict>
              <span className="min-w-0 break-words">{cases[i]?.name || fmt(s.case, { n: i + 1 })}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

export function BlocksEditor({
  config,
  onChange,
  disabled,
  issues = [],
  RichText,
  uploadAsset,
  aside,
  strings,
  canvasStrings,
  blockly,
}: BlocksEditorProps) {
  const s = resolveStrings(blocksEditorStrings, strings);
  const c = resolveStrings(blocksCanvasStrings, canvasStrings);
  const patch = (next: Partial<BlocksConfig>) => onChange({ ...config, ...next });
  const editable = (fn: (program: Stmt[]) => void) => (disabled ? undefined : fn);
  const total = totalCasePoints(config.cases);
  const toggleKind = (kind: BlockKind, on: boolean) =>
    patch({ toolbox: BLOCK_KINDS.filter((k) => (k === kind ? on : config.toolbox.includes(k))) });

  return (
    <div className="flex flex-col gap-4">
      <PromptSection
        title={s.questionSection}
        id="blocks-prompt"
        label={s.prompt}
        value={config.prompt}
        onChange={(prompt) => patch({ prompt })}
        disabled={disabled}
        RichText={RichText}
        uploadImage={uploadAsset}
        rows={5}
        issues={issuesAt(issues, "prompt")}
      />

      <EditorSection title={s.toolbox} hint={s.toolboxHint}>
        <div className="flex flex-wrap gap-x-5 gap-y-1">
          {BLOCK_KINDS.map((kind) => (
            <CheckboxField
              key={kind}
              className={setting}
              label={c[KIND_WORD[kind]]}
              checked={config.toolbox.includes(kind)}
              disabled={disabled}
              onChange={(on) => toggleKind(kind, on)}
            />
          ))}
        </div>
        <IssueList issues={issuesAt(issues, "toolbox")} />
      </EditorSection>

      <EditorSection title={s.starter} hint={s.starterHint}>
        <BlocklyHost
          program={config.starter}
          onChange={editable((starter) => patch({ starter }))}
          toolbox={config.toolbox}
          words={c}
          label={s.starter}
          height={280}
          blockly={blockly}
        />
        <IssueList issues={issuesAt(issues, "starter")} />
      </EditorSection>

      <EditorSection title={c.reference} hint={s.referenceHint}>
        <BlocklyHost
          program={config.referenceSolution ?? []}
          onChange={editable((reference) => patch({ referenceSolution: reference.length > 0 ? reference : null }))}
          toolbox={config.toolbox}
          words={c}
          label={c.reference}
          height={320}
          blockly={blockly}
        />
        <IssueList issues={issuesAt(issues, "referenceSolution")} />
        <ReferenceCheck reference={config.referenceSolution ?? []} cases={config.cases} s={s} c={c} />
      </EditorSection>

      <EditorSection>
        <RowListHeader
          title={c.cases}
          count={plural(s, "totalPoints", total)}
          addLabel={s.addCase}
          addDisabled={disabled || config.cases.length >= CASES_MAX}
          onAdd={() => patch({ cases: [...config.cases, emptyCase()] })}
        />
        <p className={hint}>{s.casesHint}</p>
        <p className={hint}>{s.toolHint}</p>
        <IssueList issues={issuesHere(issues, "cases")} />
        <RowList items={config.cases}>
          {(kase, i) => (
            <div className="flex flex-col gap-3">
              <RowHead
                disabled={disabled}
                nameId={`blocks-case-${i}-name`}
                nameLabel={fmt(s.case, { n: i + 1 })}
                nameAriaLabel={fmt(s.caseNameAria, { n: i + 1 })}
                name={kase.name}
                onNameChange={(name) => patch({ cases: patchAt(config.cases, i, { name }) })}
                pointsId={`blocks-case-${i}-points`}
                pointsLabel={s.points}
                pointsAriaLabel={fmt(s.pointsAria, { n: i + 1 })}
                points={kase.points}
                onPointsChange={(points) => patch({ cases: patchAt(config.cases, i, { points }) })}
                hiddenLabel={c.hidden}
                hiddenAriaLabel={fmt(s.hiddenAria, { n: i + 1 })}
                visible={kase.visible}
                onVisibleChange={(visible) => patch({ cases: patchAt(config.cases, i, { visible }) })}
                removeLabel={fmt(s.removeCase, { name: kase.name || fmt(s.case, { n: i + 1 }) })}
                removeDisabled={disabled || config.cases.length <= 1}
                onRemove={() => patch({ cases: removeAt(config.cases, i) })}
              >
                <NumberField
                  id={`blocks-case-${i}-battery`}
                  label={c.battery}
                  aria-label={fmt(s.batteryAria, { n: i + 1 })}
                  value={kase.battery}
                  min={1}
                  step={1}
                  width="w-20"
                  disabled={disabled}
                  onChange={(battery) => patch({ cases: patchAt(config.cases, i, { battery }) })}
                />
              </RowHead>
              <MapEditor
                id={`blocks-case-${i}`}
                rows={kase.map}
                disabled={disabled}
                s={s}
                onChange={(map) => patch({ cases: patchAt(config.cases, i, { map }) })}
              />
              <IssueList issues={issuesAt(issues, "cases", i)} />
            </div>
          )}
        </RowList>
      </EditorSection>

      <AsideSection aside={aside}>
        <h3 className={sectionTitle}>{s.scoring}</h3>
        <CheckboxField
          className={setting}
          label={c.allOrNothing}
          checked={config.allOrNothing}
          disabled={disabled}
          onChange={(allOrNothing) => patch({ allOrNothing })}
        />
        <p className={hint}>{s.allOrNothingHint}</p>
      </AsideSection>
    </div>
  );
}
