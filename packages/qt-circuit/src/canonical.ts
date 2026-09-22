/**
 * Canonical YAML mapping (docs/spec/04 §4.2).
 *
 * The canonical file is what a teacher reads and edits by hand, so it carries
 * the spec's field names and nothing the schema can rebuild: `configVersion`
 * is the storage's business, and a default is left out rather than written
 * down — a manual question with one sine stimulus should read as four lines,
 * not as forty.
 *
 * The two SCHEMATICS are the exception: the reference and every component in
 * it travel verbatim. They are coordinates, and rounding one would move a
 * pin off a wire.
 */
import { DEFAULT_PALETTE } from "./library.js";
import {
  CIRCUIT_CONFIG_VERSION,
  CircuitConfig,
  DEFAULT_ANALYSIS,
  type Analysis,
  type Grading,
  type Palette,
  type Stimulus,
  type Supplies,
} from "./schema.js";

const DEFAULT_MAX_COMPONENTS = 10;
const DEFAULT_SIMULATIONS_PER_MINUTE = 10;
const DEFAULT_TOLERANCE = 0.05;

const isDefaultPalette = (p: Palette): boolean =>
  p.maxComponents === DEFAULT_MAX_COMPONENTS &&
  p.kinds.length === DEFAULT_PALETTE.length &&
  p.kinds.every((k, i) => k === DEFAULT_PALETTE[i]);

const isDefaultSupplies = (s: Supplies): boolean => s.vcc === null && s.vee === null;

const isDefaultAnalysis = (a: Analysis): boolean =>
  a.stopMs === DEFAULT_ANALYSIS.stopMs &&
  a.skipMs === DEFAULT_ANALYSIS.skipMs &&
  a.points === DEFAULT_ANALYSIS.points;

const isDefaultGrading = (g: Grading): boolean =>
  g.mode === "manual" && g.tolerance === DEFAULT_TOLERANCE && g.rubric === "";

function stimulusToCanonical(stimulus: Stimulus): Record<string, unknown> {
  return {
    name: stimulus.name,
    source: { ...stimulus.source },
    ...(stimulus.sourceOhms === 0 ? {} : { sourceOhms: stimulus.sourceOhms }),
    load: { ...stimulus.load },
    ...(isDefaultAnalysis(stimulus.analysis) ? {} : { analysis: { ...stimulus.analysis } }),
    ...(stimulus.points === 1 ? {} : { points: stimulus.points }),
    ...(stimulus.visible ? {} : { visible: false }),
  };
}

/** Config → the plain object a canonical `question.yaml` holds under `config:`. */
export function toCanonical(config: CircuitConfig): Record<string, unknown> {
  const out: Record<string, unknown> = { prompt: config.prompt };
  if (!isDefaultPalette(config.palette)) {
    out["palette"] = { kinds: [...config.palette.kinds], maxComponents: config.palette.maxComponents };
  }
  if (!isDefaultSupplies(config.supplies)) out["supplies"] = { ...config.supplies };
  if (!config.commonGround) out["commonGround"] = false;
  if (config.stimuli.length > 0) out["stimuli"] = config.stimuli.map(stimulusToCanonical);
  if (config.reference !== null) {
    // Verbatim: a schematic is geometry, and the extractor reads it exactly.
    out["reference"] = {
      components: config.reference.components.map((c) => ({ ...c, m: [...c.m] })),
      wires: config.reference.wires.map((w) => ({
        ...w,
        via: w.via.map((v) => ({ ...v })),
        points: w.points.map((p) => [...p]),
      })),
    };
  }
  if (!isDefaultGrading(config.grading)) out["grading"] = { ...config.grading };
  if (config.showExpected) out["showExpected"] = true;
  if (config.simulationsPerMinute !== DEFAULT_SIMULATIONS_PER_MINUTE) {
    out["simulationsPerMinute"] = config.simulationsPerMinute;
  }
  return out;
}

/** The canonical object → a validated config. Throws a `ZodError` on a bad file. */
export function fromCanonical(raw: unknown): CircuitConfig {
  const source = typeof raw === "object" && raw !== null ? (raw as Record<string, unknown>) : {};
  return CircuitConfig.parse({ ...source, configVersion: CIRCUIT_CONFIG_VERSION });
}
