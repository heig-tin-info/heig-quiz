/**
 * The teacher's editor for a `codeimage` question (docs/spec/04 §4.9).
 *
 * The program half — statement, language, runtime, starting code, reference
 * solution, advanced settings — is `code`'s own (`../ProgramEditor.tsx`).
 * What this editor adds is the picture: its size and palette, the target the
 * student must draw, and the one way a target is made — try the reference
 * solution, look at the image it draws, and press "Use as target".
 *
 * The target is stored in the config, in the compact encoding of
 * `./pixels.ts`; publication refuses a question without one (decision D16).
 */
import { useId, useMemo, useState, type ReactNode } from "react";

import { fmt, issuesAt, resolveStrings, rootIssues } from "@quiz/core/client";
import type { ConfigIssue, EditorProps, MarkdownRenderer } from "@quiz/core/client";
import type { RunnerOutcome } from "@quiz/core/server";
import {
  AdvancedDisclosure,
  button,
  EditorSection,
  hint,
  IssueList,
  NumberField,
  Segmented,
  TryPanel,
  type TryStatus,
} from "@quiz/ui";

import {
  PROGRAM_ADVANCED_PATHS,
  ProgramAdvancedFields,
  ProgramPromptSection,
  ReferenceSection,
  TemplateSection,
} from "../ProgramEditor.js";
import { referenceRegions } from "../reference.js";
import { PixelGrid } from "./PixelGrid.js";
import {
  countCorrect,
  decodeImage,
  encodeImage,
  imageStringIssue,
  INVALID,
  parseImageOutput,
} from "./pixels.js";
import {
  DEFAULT_IMAGE_LIMITS,
  IMAGE_MAX_SIDE,
  IMAGE_MIN_SIDE,
  PALETTES,
  type CodeImageConfig,
  type CodeImageDetails,
  type ImageSpec,
  type Palette,
} from "./schema.js";
import { CODEIMAGE_EDITOR_DEFAULTS, type CodeImageEditorStrings } from "./strings.js";

/**
 * What the reference run came back with. A raw {@link RunnerOutcome} when the
 * browser ran it, the server's grading `details` when `POST /questions/:id/try`
 * did — its `image` is the picture, already parsed by the grader's own rule —
 * and `"unavailable"` when no runner could.
 */
export type CodeImageTryOutcome = RunnerOutcome | { details: CodeImageDetails } | "unavailable";

export interface CodeImageEditorProps extends EditorProps<CodeImageConfig> {
  onTry?: ((config: CodeImageConfig) => Promise<CodeImageTryOutcome>) | undefined;
  issues?: readonly ConfigIssue[] | undefined;
  strings?: Partial<CodeImageEditorStrings> | undefined;
  renderMarkdown?: MarkdownRenderer | undefined;
  monaco?: boolean | undefined;
}

type TryState =
  | { status: "idle" }
  | { status: "running" }
  | { status: "unavailable" }
  | { status: "failed"; reason: "compile" | "regions" }
  /** `spec` is the size and palette the image was read with: a later change makes it stale. */
  | { status: "done"; pixels: Int16Array; spec: ImageSpec };

const sameSpec = (a: ImageSpec, b: ImageSpec): boolean =>
  a.width === b.width && a.height === b.height && a.palette === b.palette;

/** The advanced settings of a picture question: the program's, with no action to pick. */
const ADVANCED_PATHS = PROGRAM_ADVANCED_PATHS;

/** The reference run, as the pixels it drew, whichever runner answered. */
async function tryReference(
  config: CodeImageConfig,
  onTry: (config: CodeImageConfig) => Promise<CodeImageTryOutcome>,
): Promise<TryState> {
  const spec = { ...config.image };
  const outcome = await onTry(config);
  if (outcome === "unavailable") return { status: "unavailable" };
  if ("details" in outcome) {
    const details = outcome.details;
    if (details.runner !== "ok") return { status: "unavailable" };
    if (details.compile !== null && !details.compile.ok) {
      return { status: "failed", reason: "compile" };
    }
    const count = spec.width * spec.height;
    return {
      status: "done",
      spec,
      pixels:
        details.image === null
          ? new Int16Array(count).fill(INVALID)
          : decodeImage(details.image, spec.palette, count),
    };
  }
  if (!outcome.compile.ok) return { status: "failed", reason: "compile" };
  return {
    status: "done",
    spec,
    pixels: parseImageOutput(outcome.cases[0]?.stdout ?? "", spec).pixels,
  };
}

export function CodeImageEditor({
  config,
  onChange,
  disabled,
  issues = [],
  onTry,
  strings,
  RichText,
  uploadAsset,
  monaco,
}: CodeImageEditorProps) {
  const s = resolveStrings(CODEIMAGE_EDITOR_DEFAULTS, strings);
  const ids = useId();
  const [tryState, setTryState] = useState<TryState>({ status: "idle" });

  const patch = (next: Partial<CodeImageConfig>) => onChange({ ...config, ...next });
  const patchImage = (next: Partial<ImageSpec>) => patch({ image: { ...config.image, ...next } });

  const spec = config.image;
  const specOk = sideOk(spec.width) && sideOk(spec.height);
  const count = spec.width * spec.height;
  const targetValid =
    specOk && config.target !== "" && imageStringIssue(config.target, spec) === null;
  const target = useMemo(
    () => (targetValid ? decodeImage(config.target, spec.palette, count) : null),
    [targetValid, config.target, spec.palette, count],
  );

  async function runReference() {
    if (onTry === undefined || !specOk) return;
    if (referenceRegions(config) === null) {
      setTryState({ status: "failed", reason: "regions" });
      return;
    }
    setTryState({ status: "running" });
    try {
      setTryState(await tryReference(config, onTry));
    } catch {
      setTryState({ status: "failed", reason: "compile" });
    }
  }

  const advancedIssues = ADVANCED_PATHS.flatMap((key) => issuesAt(issues, key));

  return (
    <div className="flex flex-col gap-6">
      <IssueList issues={rootIssues(issues)} />

      <ProgramPromptSection
        ids={ids}
        config={config}
        patch={patch}
        s={s}
        disabled={disabled}
        issues={issues}
        RichText={RichText}
        uploadAsset={uploadAsset}
      />

      <EditorSection title={s.imageSection} hint={s.imageHint}>
        <div className="flex flex-wrap items-end gap-4">
          <NumberField
            id={`${ids}-width`}
            label={s.width}
            value={spec.width}
            min={IMAGE_MIN_SIDE}
            max={IMAGE_MAX_SIDE}
            width="w-24"
            disabled={disabled}
            onChange={(width) => patchImage({ width: Math.round(width) })}
          />
          <NumberField
            id={`${ids}-height`}
            label={s.height}
            value={spec.height}
            min={IMAGE_MIN_SIDE}
            max={IMAGE_MAX_SIDE}
            width="w-24"
            disabled={disabled}
            onChange={(height) => patchImage({ height: Math.round(height) })}
          />
          <div className="flex flex-col gap-1.5">
            <span id={`${ids}-palette`} className="text-[13px] font-medium text-fg">
              {s.palette}
            </span>
            <Segmented<Palette>
              name={`${ids}-palette-radio`}
              labelledBy={`${ids}-palette`}
              value={spec.palette}
              disabled={disabled}
              options={PALETTES.map((p) => ({ value: p, label: paletteLabel(p, s) }))}
              onChange={(palette) => patchImage({ palette })}
            />
          </div>
        </div>
        <p className={specOk ? hint : "text-[13px] text-danger"}>
          {fmt(s.sizeHint, { min: IMAGE_MIN_SIDE, max: IMAGE_MAX_SIDE })}
        </p>
        <IssueList issues={issuesAt(issues, "image")} />

        <h4 className="mt-2 text-[13px] font-medium text-fg">{s.target}</h4>
        <p className={hint}>
          {targetValid ? s.targetHint : config.target === "" ? s.targetEmpty : s.targetInvalid}
        </p>
        {specOk ? (
          <div className="max-w-80">
            <PixelGrid
              width={spec.width}
              height={spec.height}
              palette={spec.palette}
              pixels={target}
              label={s.target}
              emptyLabel={config.target === "" ? s.targetEmpty : s.targetInvalid}
            />
          </div>
        ) : null}
        <IssueList issues={issuesAt(issues, "target")} />
      </EditorSection>

      <TemplateSection
        config={config}
        patch={patch}
        s={s}
        disabled={disabled}
        issues={issues}
        monaco={monaco}
      />

      <ReferenceSection
        config={config}
        patch={patch}
        s={s}
        disabled={disabled}
        issues={issues}
        monaco={monaco}
      >
        {onTry === undefined ? null : (
          <>
            <TryPanel
              label={s.tryReference}
              runningLabel={s.trying}
              running={tryState.status === "running"}
              disabled={disabled || !specOk}
              onTry={() => void runReference()}
              status={tryStatusOf(tryState, s)}
            />
            {tryState.status === "done" ? (
              <ReferenceImage
                state={tryState}
                config={config}
                target={target}
                s={s}
                disabled={disabled}
                onUse={(encoded) => patch({ target: encoded })}
              />
            ) : null}
          </>
        )}
      </ReferenceSection>

      <IssueList issues={advancedIssues} />
      <AdvancedDisclosure summary={s.advanced} className="grid gap-4 sm:grid-cols-2">
        <ProgramAdvancedFields
          ids={ids}
          config={config}
          s={s}
          disabled={disabled}
          patch={patch}
          defaultLimits={DEFAULT_IMAGE_LIMITS}
          showAction={false}
        />
      </AdvancedDisclosure>
    </div>
  );
}

/**
 * Whether a side can be drawn. The field keeps what the teacher is typing —
 * clamping "1" on the way to "16" would fight every keystroke — so a side
 * out of range is simply not drawn, and the schema names it at publication.
 */
function sideOk(value: number): boolean {
  return Number.isInteger(value) && value >= IMAGE_MIN_SIDE && value <= IMAGE_MAX_SIDE;
}

function paletteLabel(palette: Palette, s: CodeImageEditorStrings): string {
  switch (palette) {
    case "bw":
      return s.paletteBw;
    case "color16":
      return s.paletteColor16;
    case "gray256":
      return s.paletteGray256;
  }
}

function tryStatusOf(tryState: TryState, s: CodeImageEditorStrings): TryStatus | null {
  switch (tryState.status) {
    case "unavailable":
      return { tone: "hint", text: s.tryUnavailable };
    case "failed":
      return {
        tone: "danger",
        text: tryState.reason === "regions" ? s.tryRegionsMismatch : s.tryCompileFailed,
      };
    case "done":
      return { tone: "hint", text: s.tryDrawn };
    default:
      return null;
  }
}

/**
 * The picture the reference drew, how it compares with the current target,
 * and the button that makes it the target. The button is refused for an
 * image that is incomplete (a target must be a valid picture) and for one
 * read under a size or palette the teacher has since changed.
 */
function ReferenceImage({
  state,
  config,
  target,
  s,
  disabled,
  onUse,
}: {
  state: Extract<TryState, { status: "done" }>;
  config: CodeImageConfig;
  target: Int16Array | null;
  s: CodeImageEditorStrings;
  disabled: boolean | undefined;
  onUse: (encoded: string) => void;
}): ReactNode {
  const stale = !sameSpec(state.spec, config.image);
  const complete = !state.pixels.includes(INVALID);
  const encoded = complete ? encodeImage(state.pixels, state.spec.palette) : null;
  const isTarget = encoded !== null && encoded === config.target;
  const total = state.spec.width * state.spec.height;
  const note = stale
    ? s.tryStale
    : !complete
      ? s.tryIncomplete
      : isTarget
        ? s.targetSet
        : target !== null
          ? fmt(s.tryMatch, { matching: countCorrect(state.pixels, target), total })
          : null;

  return (
    <div className="flex flex-col gap-2">
      <h4 className="text-[13px] font-medium text-fg">{s.referenceImage}</h4>
      <div className="max-w-80">
        <PixelGrid
          width={state.spec.width}
          height={state.spec.height}
          palette={state.spec.palette}
          pixels={state.pixels}
          label={s.referenceImage}
        />
      </div>
      <div className="flex flex-wrap items-center gap-3">
        <button
          type="button"
          className={button("secondary", "sm")}
          disabled={disabled || stale || encoded === null || isTarget}
          onClick={() => {
            if (encoded !== null) onUse(encoded);
          }}
        >
          {s.useAsTarget}
        </button>
        {note === null ? null : (
          <p role="status" className={stale || !complete ? "text-[13px] text-danger" : hint}>
            {note}
          </p>
        )}
      </div>
    </div>
  );
}

export default CodeImageEditor;
