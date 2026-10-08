/**
 * The teacher assistant rewrites the teacher's own texts in the question
 * editor (ADR-080, P3 amendment, decisions 1–2 and 6): a PROPOSAL the server
 * checks here and the browser shows as a per-field diff, merged into the
 * open draft only when the teacher applies it. Pure rules, no I/O.
 *
 * What may change is the type's declared free text (`assistText` of the
 * type, `AssistTextSpec` of `@quiz/core`): the statement, the choices' texts,
 * the explanation… Never an id, a setting, the key, the scoring nor the
 * variables: the proposed config is the base config with ONLY those strings
 * replaced, so everything else is the base's by construction. Inside a text,
 * what the platform reads — a `[[…]]` expression (ADR-056), a `{{…}}` blank
 * of a cloze (its key), an `asset:` reference — is kept verbatim: the same
 * tokens, as many times, or the proposal is refused.
 */
import type { AssistTextSpec } from "@quiz/core/server";

/** The statement only: what a type that declares no `assistText` lends the assistant. */
export const DEFAULT_ASSIST_TEXT: AssistTextSpec = { fields: ["prompt"] };

/** The longest text the assistant may write in one field (the types' own statement limit). */
export const ASSIST_MAX_FIELD_CHARS = 20_000;
/** The most fields one proposal may change, appended items included. */
export const ASSIST_MAX_EDITS = 40;
/** The pseudo-path of the explanation in a diff: it is beside the config, not in it. */
export const EXPLANATION_FIELD = "explanation";

/** The draft the proposal is computed against: the editor's own, as it was sent with the question. */
export interface AssistDraftTexts {
  config: unknown;
  explanation: string;
}

/** One field of the diff the panel shows: `before` null for an appended item. */
export interface AssistFieldChange {
  path: string;
  before: string | null;
  after: string;
}

/** An editor proposal, as the browser receives it (an `AssistAction`). */
export interface AssistEditQuestion {
  kind: "edit_question";
  questionId: string;
  /** The draft it was computed against: applied only while the editor still holds exactly this. */
  base: AssistDraftTexts;
  config: unknown;
  explanation: string;
  fields: AssistFieldChange[];
}

/** What the model asks for (`propose_question_edit`). */
export interface AssistEditInput {
  edits?: { path: string; text: string }[] | undefined;
  add?: string[] | undefined;
  explanation?: string | undefined;
}

/** What the platform reads inside a text, kept verbatim by a rewrite. */
const PRESERVED = /\[\[[\s\S]*?\]\]|\{\{[\s\S]*?\}\}|asset:[A-Za-z0-9._-]+/g;

/** The preserved tokens of a text, sorted: two texts keep the same ones when these are equal. */
export function preservedTokens(text: string): string[] {
  return (text.match(PRESERVED) ?? []).sort();
}

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

/** The concrete paths a pattern names in `config` (`choices.*.text` → `choices.0.text`, …), with their values. */
function expand(config: unknown, pattern: string): { path: string; value: unknown }[] {
  let found: { path: string[]; value: unknown }[] = [{ path: [], value: config }];
  for (const part of pattern.split(".")) {
    found = found.flatMap(({ path, value }) => {
      if (part === "*") return Array.isArray(value) ? value.map((v, i) => ({ path: [...path, String(i)], value: v })) : [];
      if (Array.isArray(value)) return [];
      return isRecord(value) && part in value ? [{ path: [...path, part], value: value[part] }] : [];
    });
  }
  return found.map(({ path, value }) => ({ path: path.join("."), value }));
}

/**
 * The type's free-text fields present in `config`, each by its concrete path
 * and its current text: what the prompt shows the model of the open draft,
 * and the only paths a proposal may write.
 */
export function assistTextFields(config: unknown, spec: AssistTextSpec): { path: string; text: string }[] {
  return spec.fields.flatMap((pattern) =>
    expand(config, pattern).flatMap(({ path, value }) => (typeof value === "string" ? [{ path, text: value }] : [])),
  );
}

/** A deep copy of plain JSON (a draft is JSON: it came over the wire). */
const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;

/** Writes `text` at the dotted `path` of `target`, which exists (it came from {@link assistTextFields}). */
function writeAt(target: unknown, path: string, text: string): void {
  const parts = path.split(".");
  let node = target as Record<string, unknown> | unknown[];
  for (const part of parts.slice(0, -1)) node = (node as Record<string, unknown>)[part] as Record<string, unknown>;
  (node as Record<string, unknown>)[parts.at(-1)!] = text;
}

/** A rewritten text, or the refusal the model reads: not empty, not too long, the same preserved tokens. */
function checkText(path: string, before: string, after: unknown): string {
  if (typeof after !== "string" || after.trim() === "") throw new Error(`\`${path}\`: write a non-empty text.`);
  if (after.length > ASSIST_MAX_FIELD_CHARS) throw new Error(`\`${path}\`: at most ${ASSIST_MAX_FIELD_CHARS} characters.`);
  const kept = preservedTokens(before);
  if (JSON.stringify(kept) !== JSON.stringify(preservedTokens(after))) {
    throw new Error(
      `\`${path}\` must keep exactly these, verbatim and as many times: ${kept.length > 0 ? kept.join(" ") : "(none)"}. ` +
        "Do not add, remove or change a [[…]] expression, a {{…}} blank or an asset: reference.",
    );
  }
  return after;
}

/**
 * The proposal the model asked for, checked against the open draft `base`
 * and the type's `spec`: each edit on a declared text field the draft has,
 * the explanation, and — when the type declares a list — new items, filling
 * its empty rows first then appended (ADR-059's fill-and-append), never
 * repeating a text it holds, never past its maximum. Throws an `Error` the
 * model reads, naming what is allowed; a proposal that changes nothing is
 * refused too.
 */
export function proposeQuestionEdit(
  questionId: string,
  base: AssistDraftTexts,
  spec: AssistTextSpec,
  input: AssistEditInput,
): AssistEditQuestion {
  const fields = assistTextFields(base.config, spec);
  const byPath = new Map(fields.map((f) => [f.path, f.text]));
  const config = clone(base.config);
  const changes: AssistFieldChange[] = [];
  const edits = input.edits ?? [];
  if (edits.length + (input.add?.length ?? 0) > ASSIST_MAX_EDITS) throw new Error(`At most ${ASSIST_MAX_EDITS} fields per proposal.`);

  const seen = new Set<string>();
  for (const edit of edits) {
    const path = typeof edit?.path === "string" ? edit.path : "";
    const before = byPath.get(path);
    if (before === undefined) {
      throw new Error(
        `\`${path}\` is not a text you may rewrite. The texts are: ${[...byPath.keys()].join(", ") || "(none)"}, and the explanation.`,
      );
    }
    if (seen.has(path)) throw new Error(`\`${path}\` is edited twice.`);
    seen.add(path);
    const after = checkText(path, before, edit.text);
    if (after === before) continue;
    writeAt(config, path, after);
    changes.push({ path, before, after });
  }

  if (input.add && input.add.length > 0) {
    const append = spec.append;
    if (!append) throw new Error("This question type takes no new items; rewrite its texts only.");
    const list = expand(config, append.list)[0]?.value;
    if (!Array.isArray(list)) throw new Error(`The draft has no \`${append.list}\` list.`);
    const textOf = (item: unknown) => (isRecord(item) && typeof item[append.field] === "string" ? (item[append.field] as string) : "");
    const held = new Set(list.map((item) => textOf(item).trim()).filter((t) => t !== ""));
    for (const raw of input.add) {
      const text = checkText(`${append.list}[new]`, "", raw).trim();
      if (held.has(text)) throw new Error(`"${text}" is already in \`${append.list}\`.`);
      held.add(text);
      const empty = list.findIndex((item) => isRecord(item) && textOf(item).trim() === "");
      if (empty >= 0) {
        const path = `${append.list}.${empty}.${append.field}`;
        (list[empty] as Record<string, unknown>)[append.field] = text;
        changes.push({ path, before: null, after: text });
        continue;
      }
      if (list.length >= append.max) throw new Error(`\`${append.list}\` holds at most ${append.max} items.`);
      list.push({ ...clone(append.item), [append.field]: text });
      changes.push({ path: `${append.list}.${list.length - 1}.${append.field}`, before: null, after: text });
    }
  }

  let explanation = base.explanation;
  if (input.explanation !== undefined) {
    const after = checkText(EXPLANATION_FIELD, base.explanation, input.explanation);
    if (after !== base.explanation) {
      changes.push({ path: EXPLANATION_FIELD, before: base.explanation === "" ? null : base.explanation, after });
      explanation = after;
    }
  }

  if (changes.length === 0) throw new Error("The proposal changes nothing: the texts are already these.");
  return { kind: "edit_question", questionId, base, config, explanation, fields: changes };
}

/** Whether two drafts are the same JSON (the editor's against a proposal's base). */
export function sameDraft(a: AssistDraftTexts, b: AssistDraftTexts): boolean {
  return a.explanation === b.explanation && stableJson(a.config) === stableJson(b.config);
}

/** JSON with its object keys sorted: two configs equal in content compare equal whatever their key order. */
function stableJson(value: unknown): string {
  return JSON.stringify(value, (_key, v: unknown) =>
    isRecord(v) ? Object.fromEntries(Object.keys(v).sort().map((k) => [k, v[k]])) : v,
  );
}
