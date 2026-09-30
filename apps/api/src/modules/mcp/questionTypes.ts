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
  rich: {
    summary: "Essay: the student writes a text, graded by hand by the teacher against a rubric.",
    rules: [
      "`prompt`, `rubric` and `reference` are Markdown. `rubric` is never shown to the student; `reference` is shown when the evaluation shows the expected answer.",
      "Write the rubric as a list of criteria, each with its points, so the grader can apply it.",
      '`format: "markdown"` gives the student a formatted editor, `"plain"` a bare text field.',
      "`maxChars` limits the answer in characters (markdown marks included); about 3000 fill an A4 page. Omit it for no limit.",
    ],
    example: {
      configVersion: 1,
      prompt: "Expliquez pourquoi une **récursion infinie** fait planter un programme C.",
      rubric: "- **2 pts** : la pile est bornée, chaque appel y empile un cadre.\n- **1 pt** : le noyau envoie `SIGSEGV`.",
      reference: "Chaque appel empile un cadre ; la pile finit par déborder sur une page de garde.",
      maxChars: 1500,
      format: "markdown",
    },
  },
  categorize: {
    summary: "Categorize: the student sorts cards into 2 to 6 labelled columns; some cards may be distractors that belong nowhere.",
    rules: [
      "`prompt`, every card `text` and every column `label` are Markdown; keep cards short (a word, an expression, one line of code).",
      "Every card and column has an `id`: an OPAQUE string of 4 to 40 lowercase letters and digits (`/^[a-z0-9]{4,40}$/`; use 8 random ones), unique in the question. Never an index, a label or a hint such as `int-entier`: the student sees the ids.",
      "The KEY is inside the columns: each column's `cards` lists the ids of the cards that belong there. A card may appear in one column at most.",
      "A card listed by no column is a DISTRACTOR: the student is expected to leave it out. At least one card must belong to a column.",
      "Limits: 2 to 6 columns, 1 to 30 cards.",
      "`ordered: true` makes the rank inside each column count too (list each column's `cards` in the expected order); a card is then right only at its exact rank.",
      "`shuffleCards` (default true) and `shuffleColumns` (default false: the column order often means something) shuffle per student.",
      'Leave `policy` to `inherit` unless the teacher asks: the evaluation decides. `"per_item"` gives each card its share (a distractor left out counts); `"all_or_nothing"` all the points only for a perfect answer. Under the evaluation\'s negative marking a misplaced card costs points.',
    ],
    example: {
      configVersion: 1,
      prompt: "Classez chaque type C selon sa **catégorie**.",
      columns: [
        { id: "k3v9qz1a", label: "Entier", cards: ["m2x7c4pd", "t8r1w6hn"] },
        { id: "b5n0ys2e", label: "Virgule flottante", cards: ["q4j9f3lu"] },
        { id: "w1g6ta8o", label: "Pointeur", cards: ["z7e2k5vb"] },
      ],
      cards: [
        { id: "m2x7c4pd", text: "`int`" },
        { id: "q4j9f3lu", text: "`double`" },
        { id: "z7e2k5vb", text: "`char *`" },
        { id: "t8r1w6hn", text: "`size_t`" },
        { id: "h0c3u9sy", text: "`string`" },
      ],
      ordered: false,
      shuffleCards: true,
      shuffleColumns: false,
      policy: "inherit",
    },
  },
  diagram: {
    summary:
      "Diagram: the student draws a diagram of one notation (UML class, use case, state machine, entity-relationship, flowchart, finite automaton, graph, free drawing), graded by hand against a reference.",
    rules: [
      "`prompt` and `rubric` are Markdown. `rubric` is never shown to the student; the `reference` is shown when the evaluation shows the expected answer.",
      "`kind` is `class`, `usecase`, `state`, `er`, `flow`, `automaton`, `graph` or `free`, and the reference and the starter may only hold that kind's elements (`t`) and links (`type`): class → `class` / `assoc`, `nav`, `inh`, `impl`, `dep`, `agg`, `comp`; usecase → `actor`, `usecase`, `system` / `assoc`, `incl`, `ext`, `inh`; state → `initial`, `state`, `final` / `strans`; er → `entity` / `erel`; flow → `terminal`, `action`, `decision` / `flow`; automaton → `astate` / `trans`; graph → `vertex` / `edge`, `arc`; free → `rect`, `square`, `circle`, `ellipse`, `triangle` (with `w`, `h`) and no link.",
      "A diagram is a SCENE, `{ nodes, links }`, never a text: there is no PlantUML, Mermaid or DOT over this API. A node is `{ id, t, x, y, name?, body? }`; a link is `{ id, type, a, b, name?, ma?, mb? }` where `a` and `b` are node ids.",
      "Every `id` is OPAQUE: 4 to 40 lowercase letters and digits (use 8 random ones), unique across the nodes AND the links of a scene. The starter reaches the student with its ids: never reuse the reference's ids in the starter.",
      "`x` and `y` are the top-left corner on a grid of 20 (multiples of 20). Leave about 200 between elements, left to right or top to bottom; the lines are routed on display.",
      "`body` holds lines: a class's members (`+ area() : double`, `---` starts the next compartment, `{static}` and `{abstract}` at the end of a member), an entity's attributes (`id : int PK`), a state's activities (`entry / light on`). `stereo` (without guillemets) and `abstract: true` are for a class only.",
      "A link's `name` is its label: a transition's `event [guard] / action`, an automaton's symbols, a graph's weight, a flowchart's `oui` / `non` leaving a decision, an association's name. `ma` and `mb` are the multiplicities (class: `1`, `0..*`) or cardinalities (er: `1`, `0..1`, `1..*`, `0..*`) at `a` and at `b`.",
      "An automaton state carries `initial: true` and/or `accept: true`. A use-case `system` boundary takes `w` and `h`.",
      "The `reference` must hold at least one element to publish. The `starter` is optional: what the student starts from (a few elements to complete), else an empty canvas.",
      "Limits: 80 elements (200 shapes for `free`), 160 links, 120 characters a name, 40 body lines of 200 characters, no line break or control character in any text.",
    ],
    example: {
      configVersion: 1,
      prompt: "Dessinez la **machine d'états** d'une porte qu'on peut ouvrir, fermer et verrouiller avec un code.",
      kind: "state",
      reference: {
        nodes: [
          { id: "d4q8m1zc", t: "initial", x: 60, y: 120 },
          { id: "h2w7k9vr", t: "state", x: 180, y: 120, name: "Fermée" },
          { id: "p5n3x0ta", t: "state", x: 480, y: 0, name: "Ouverte", body: ["entry / allumer la lampe"] },
          { id: "b8e1r6yu", t: "state", x: 480, y: 220, name: "Verrouillée" },
        ],
        links: [
          { id: "f0c7s2ln", type: "strans", a: "d4q8m1zc", b: "h2w7k9vr" },
          { id: "g6j4t8wo", type: "strans", a: "h2w7k9vr", b: "p5n3x0ta", name: "ouvrir" },
          { id: "m9a2v5ke", type: "strans", a: "p5n3x0ta", b: "h2w7k9vr", name: "fermer" },
          { id: "q1x8d3hs", type: "strans", a: "h2w7k9vr", b: "b8e1r6yu", name: "verrouiller [code ok]" },
          { id: "u7z0p4ci", type: "strans", a: "b8e1r6yu", b: "h2w7k9vr", name: "déverrouiller [code ok]" },
        ],
      },
      starter: {
        nodes: [
          { id: "w3k6e9ab", t: "initial", x: 60, y: 120 },
          { id: "y5r2n7cd", t: "state", x: 180, y: 120, name: "Fermée" },
        ],
        links: [{ id: "z8t1m4ef", type: "strans", a: "w3k6e9ab", b: "y5r2n7cd" }],
      },
      rubric: "- **1 pt** : trois états, l'état initial vers Fermée.\n- **1 pt** : les quatre transitions, avec la garde du code.",
    },
  },
  circuit: {
    summary: "Circuit: the student draws a schematic, graded by an ngspice simulation.",
    rules: [
      "Only write one when the teacher asks for an electronics question.",
      "Read an existing circuit question with `get_question` for a complete, working example.",
      'Each stimulus has an `analysis`. `{ "kind": "tran", "stopMs", "skipMs", "points" }` (the default) compares the output WAVEFORM: it passes when the RMS distance to the reference is at most `grading.tolerance` of the reference\'s swing.',
      'For a frequency response write `{ "kind": "ac", "fStartHz", "fStopHz", "pointsPerDecade" }` (0.01 Hz to 1 GHz, 5 to 200 points per decade, default 20, at most 2000 points in all). Its `source` MUST be `{ "kind": "dc", "volts": <bias> }`: the circuit is linearised around that DC bias and driven by a unit AC source, and the Bode plot of v(out) is compared.',
      "An AC stimulus passes when the student's Bode plot stays in an envelope around the reference's, set by `grading.bode` (`magDb` 1, `floorDb` 60, `phaseDeg` 10 by default; `phaseDeg: null` ignores the phase). Below the reference's peak minus `floorDb` the output only has to stay under that floor.",
      "Keep AC for linear small-signal circuits (filters, amplifiers biased in their linear range): a saturated op-amp or an unbiased diode gives a meaningless Bode plot.",
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
