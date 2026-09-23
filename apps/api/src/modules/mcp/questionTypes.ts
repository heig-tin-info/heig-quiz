/**
 * What an LLM needs to write a question config it has never seen: the JSON
 * Schema of the type's `configSchema` (generated, so it cannot drift from the
 * gate a publication goes through), a few sentences of authoring rules the
 * schema cannot say, and — for the types whose shape is not obvious — a
 * complete valid example.
 *
 * The prose lives here and not in the `qt-*` packages because it is written
 * for a model, not for a teacher: the packages' strings are i18n keys.
 */
import { z } from "zod";

import { questionType, registeredServerIds } from "@quiz/registry/server";

interface TypeGuide {
  summary: string;
  rules: string[];
  example?: unknown;
}

const GUIDES: Record<string, TypeGuide> = {
  mcq: {
    summary: "Multiple choice: one prompt, 2 to 12 choices, one or several correct.",
    rules: [
      "`prompt` and every choice `text` are Markdown.",
      '`mode: "single"` needs exactly one correct choice; `"multiple"` needs at least one.',
      "Leave `policy` to `inherit` unless the teacher asks for a scoring policy: the evaluation decides.",
      "Write plausible distractors of similar length and register; avoid 'all of the above'.",
    ],
    example: {
      configVersion: 2,
      prompt: "Que signifie le mot **« prolixe »** ?",
      mode: "single",
      choices: [
        { text: "Qui parle ou écrit trop longuement", correct: true },
        { text: "Qui se tait obstinément", correct: false },
        { text: "Qui s'exprime avec élégance", correct: false },
        { text: "Qui contredit systématiquement", correct: false },
      ],
    },
  },
  short: {
    summary: "Short answer: the student types a word, a number, a date or a time, matched against a key.",
    rules: [
      "`kind` is `text`, `number`, `date` or `time`; the constraints of that kind only are read.",
      "`prefilters` (trim, lowercase) apply to the answer AND to each `exact` value: write values in lower case.",
      "List every acceptable spelling as its own `exact` matcher, with and without accents or articles when a student may reasonably omit them.",
      "A `regex` matcher is for families of answers; a `number` matcher takes a `tolerance` (`toleranceMode` abs or rel).",
      "A matcher's `points` (0..1) gives partial credit for an almost-right answer.",
      "The `llm` matcher kind is refused at publication: never use it.",
    ],
    example: {
      configVersion: 2,
      prompt: "Quelle figure de style consiste à atténuer une idée pour en suggérer davantage ?",
      kind: "text",
      placeholder: "une figure de style",
      constraints: { maxLength: 40 },
      prefilters: { trim: true, lowercase: true },
      matchers: [
        { kind: "exact", value: "litote" },
        { kind: "exact", value: "la litote" },
        { kind: "exact", value: "euphémisme", points: 0.5 },
      ],
    },
  },
  cloze: {
    summary: "Fill in the blanks: a Markdown text with blanks written inline between double braces.",
    rules: [
      "`{{answer}}` is a text blank; `{{answer|other accepted}}` lists alternatives.",
      "`{{=right|wrong1|wrong2}}` is a dropdown: the option after `=` is the correct one.",
      "`{{#3.14:0.01}}` is a number with an absolute tolerance, `{{#3.14:1%}}` a relative one.",
      "`{{/^regex$/i}}` is a regular expression; `{{2*answer}}` weighs the blank twice.",
      "`\\{{` writes literal braces. The text needs at least one blank.",
    ],
    example: {
      configVersion: 2,
      caseSensitive: false,
      text:
        "Dans *Les Fleurs du mal*, {{Baudelaire|Charles Baudelaire}} emploie souvent " +
        "l'{{=alexandrin|octosyllabe|décasyllabe}}, un vers de {{#12}} syllabes.",
    },
  },
  code: {
    summary: "Code: the student completes a program, graded by running it in the sandboxed runner.",
    rules: [
      "Only write one when the teacher asks for a programming question.",
      "The tests and the reference solution must agree: publish, then the teacher can run the Try panel.",
      "Read an existing code question with `get_question` for a complete, working example.",
    ],
  },
  circuit: {
    summary: "Circuit: the student draws a schematic, graded by an ngspice simulation.",
    rules: [
      "Only write one when the teacher asks for an electronics question.",
      "Read an existing circuit question with `get_question` for a complete, working example.",
    ],
  },
};

/** The JSON Schema of what a publication accepts, without the `$schema` noise. */
function configJsonSchema(type: string): unknown {
  const schema = z.toJSONSchema(questionType(type).configSchema, {
    io: "input",
    unrepresentable: "any",
  }) as Record<string, unknown>;
  delete schema.$schema;
  return schema;
}

export function describeQuestionType(type: string) {
  const guide = GUIDES[type];
  return {
    type,
    summary: guide?.summary ?? "",
    rules: guide?.rules ?? [],
    configSchema: configJsonSchema(type),
    ...(guide?.example === undefined ? {} : { example: guide.example }),
  };
}

/** One line per registered type: enough to choose, `describe` for the rest. */
export function questionTypeSummaries() {
  return registeredServerIds().map((type) => ({ type, summary: GUIDES[type]?.summary ?? "" }));
}

/**
 * The gate a publication will apply, run BEFORE anything is created, so a
 * malformed config costs the model one round trip and leaves no half-written
 * question behind. The route's own publication still validates on its own.
 */
export function checkConfig(type: string, config: unknown) {
  const parsed = questionType(type).configSchema.safeParse(config);
  if (parsed.success) return null;
  return parsed.error.issues.map((i) => ({ path: i.path.join("."), message: i.message }));
}
