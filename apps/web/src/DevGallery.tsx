import { DiagramEditor, DiagramView } from "@quiz/diagram/client";
import { DIAGRAM_KINDS, EXAMPLES, type DiagramKind, type Scene } from "@quiz/diagram/server";
import { Plot, SchematicEditor, SchematicView, withRoutes, type PlotProps, type SchematicEditorProps } from "@quiz/qt-circuit/canvas";
import { Pencil, Trash2, UserMinus, Users } from "lucide-react";
import { useState } from "react";

import { useT } from "./i18n";
import { MarkdownField } from "./markdown/MarkdownField";
import { MarkdownView } from "./markdown/MarkdownView";
import { diagramCanvasStrings } from "./questionTypes";
import {
  Actions,
  Button,
  Card,
  Countdown,
  GithubIcon,
  OrgAvatar,
  PeopleStack,
  PersonPill,
  Popover,
  PageHeader,
  Progress,
  ProgressSegments,
  Ring,
  SectionHeading,
  Segmented,
  SyncBadge,
  VerdictCell,
  useNow,
  type Person,
  type SegmentMark,
  type SyncState,
  type VerdictState,
} from "./ui";

/*
 * `/dev/ui` — every state of the primitives that HAVE states on one page, so a
 * screenshot pass covers them all instead of hunting them across five screens
 * that do not exist yet. Development only: App.tsx routes here behind
 * `import.meta.env.DEV`, and only for a teacher.
 *
 * It is a gallery, not a screen: the one-primary-action rule does not apply,
 * and it deliberately shows things side by side that never share a page.
 */

/** Three colleagues and the nine that make a row overflow. */
const PEOPLE: Person[] = [
  ["Marie", "Dupont"],
  ["Pierre", "Roulet"],
  ["Ada", "Lovelace"],
  ["Grace", "Hopper"],
  ["Margaret", "Hamilton"],
  ["Barbara", "Liskov"],
  ["Dennis", "Ritchie"],
  ["Alan", "Turing"],
  ["Edsger", "Dijkstra"],
  ["Donald", "Knuth"],
  ["Linus", "Torvalds"],
  ["Ken", "Thompson"],
].map(([givenName, familyName], i) => ({
  userId: `u${i + 1}`,
  givenName: givenName!,
  familyName: familyName!,
  email: `${givenName!.toLowerCase()}.${familyName!.toLowerCase()}@heig-vd.ch`,
  avatarUrl: null,
}));

const VERDICT_STATES: VerdictState[] = [
  "blank",
  "inProgress",
  "answered",
  "skipped",
  "done",
  "correct",
  "partial",
  "wrong",
  "pending",
];

const SYNC_STATES: SyncState[] = ["saved", "saving", "unsaved", "offline", "closed"];

/** The four facts of issue #89 side by side: answered, skipped, empty, flagged. */
const SEGMENT_DEMO: { mark: SegmentMark; flagged?: boolean }[] = [
  { mark: "answered" },
  { mark: "answered", flagged: true },
  { mark: "skipped" },
  { mark: "answered" },
  { mark: "unanswered", flagged: true },
  { mark: "skipped", flagged: true },
  { mark: "unanswered" },
  { mark: "unanswered" },
];

const SAMPLE = `## Arithmétique des pointeurs

Soit le fragment suivant, compilé sur une machine où \`sizeof(int)\` vaut 4 octets :

\`\`\`c
int t[5] = {10, 20, 30, 40, 50};   // cinq entiers contigus
int *p = t + 2;                    /* p pointe sur t[2] */
\`\`\`

Que vaut l'expression \`*(p + 1)\` ? La réponse est $t[3] = 40$, car
$p + n$ avance de $n \\times \\texttt{sizeof(int)}$ octets.

$$\\sum_{i=0}^{n-1} t[i] = 150$$

| Expression | Valeur |
| --- | --- |
| \`*p\` | 30 |
| \`*(p + 1)\` | 40 |
| \`p - t\` | 2 |

- [x] Lire l'énoncé
- [ ] Répondre
- [ ] Marquer comme faite

Voir la [documentation](https://en.cppreference.com/w/c/language/operator_arithmetic).

Ce qui suit est retiré par l'assainissement, et doit rester visible comme du texte inerte :

[cliquez ici](javascript:alert(1)) · ![pixel](https://evil.example/p.png)

<script>alert('xss')</script>

<img src="https://evil.example/pixel.png" onerror="alert(1)">`;


/** A journal page (ADR-049), to see `.md-doc` beside the question prose above. */
const LONG_FORM = `# Semaine 3 — Les pointeurs

Un pointeur est une variable qui contient l'adresse d'une autre variable. Cette
page reprend ce que nous avons vu en classe, avec les exemples du laboratoire,
et prépare le test de la semaine prochaine. Lisez-la en entier avant le
laboratoire : la dernière section contient les exercices à rendre.

## Déclarer et déréférencer

L'opérateur \`&\` donne l'adresse d'une variable, l'opérateur \`*\` lit ce qui se
trouve à une adresse. Les deux sont inverses l'un de l'autre, ce qui se vérifie
sur un exemple :

\`\`\`c
int x = 42;
int *p = &x;      // p contient l'adresse de x
printf("%d\\n", *p); /* affiche 42 */
\`\`\`

### Ce qu'il faut retenir

- un pointeur a un type, celui de ce qu'il désigne ;
- \`*p\` et \`x\` désignent le même objet tant que \`p == &x\` ;
- un pointeur non initialisé ne désigne rien de sûr.

> Un pointeur nul n'est pas un pointeur non initialisé : le premier ne désigne
> rien, le second désigne n'importe quoi.

---

#### Exercices

1. Écrivez une fonction \`swap\` qui échange deux entiers.
2. Expliquez pourquoi \`swap(a, b)\` ne peut pas fonctionner sans pointeurs.`;

/** The padding of the M1-04 rows, inside the shared `Row` card. */
const M104_ROW = "flex flex-wrap items-center gap-6 p-4 sm:p-5";

/** An organization's picture, drawn here so the gallery needs no network. */
const ORG_PICTURE = `data:image/svg+xml,${encodeURIComponent(
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 8 8"><rect width="8" height="8" fill="#1268a0"/><path d="M1 1h2v2H1zM5 1h2v2H5zM3 3h2v2H3zM1 5h2v2H1zM5 5h2v2H5z" fill="#e8f2f9"/></svg>',
)}`;

/* --- WP12, the `circuit` canvas -------------------------------------------
   The editor, the read-only view and the waveform plot, on one page, so the
   screenshot pass covers them before a `circuit` question exists to hold them.
   Their words come from the host, and a real question passes them through
   `t()`; here they keep the package's English defaults, like the hard-coded
   labels above — this page is development only and never ships. */

type CircuitSchematic = SchematicEditorProps["value"];
type CircuitPalette = SchematicEditorProps["palette"];
type CircuitSeries = NonNullable<PlotProps["series"]>;

const CIRCUIT_PALETTE: CircuitPalette = {
  kinds: ["R", "C", "L", "D", "DS", "DZ", "NPN", "PNP", "NMOS", "PMOS", "NMOSD", "PMOSD", "OPAMP", "GND", "VCC", "VEE"],
  maxComponents: 12,
};

/** An inverting amplifier into a load: every symbol family, wired for real. */
const CIRCUIT_DEMO: CircuitSchematic = withRoutes({
  components: [
    { id: "c1", kind: "R", x: 160, y: 160, m: [1, 0, 0, 1], name: "R1", value: "10k" },
    { id: "c2", kind: "R", x: 320, y: 100, m: [1, 0, 0, 1], name: "R2", value: "100k" },
    { id: "c3", kind: "OPAMP", x: 320, y: 180, m: [1, 0, 0, 1], name: "U1", value: "" },
    { id: "c4", kind: "GND", x: 280, y: 320, m: [1, 0, 0, 1], name: "GND", value: "" },
    { id: "c5", kind: "R", x: 680, y: 280, m: [0, 1, -1, 0], name: "R3", value: "1k" },
    { id: "c6", kind: "GND", x: 680, y: 400, m: [1, 0, 0, 1], name: "GND", value: "" },
    { id: "c7", kind: "C", x: 320, y: 40, m: [1, 0, 0, 1], name: "C1", value: "22p" },
  ],
  wires: [
    { id: "w1", a: { kind: "port", port: "in+" }, b: { kind: "pin", c: "c1", p: 0 }, via: [], points: [[0, 160], [120, 160]] },
    { id: "w2", a: { kind: "pin", c: "c1", p: 1 }, b: { kind: "pin", c: "c3", p: 0 }, via: [], points: [[200, 160], [280, 160]] },
    { id: "w3", a: { kind: "pin", c: "c2", p: 0 }, b: { kind: "pin", c: "c3", p: 0 }, via: [], points: [[280, 100], [280, 160]] },
    { id: "w4", a: { kind: "pin", c: "c2", p: 1 }, b: { kind: "pin", c: "c3", p: 2 }, via: [], points: [[360, 100], [360, 180]] },
    { id: "w5", a: { kind: "pin", c: "c7", p: 0 }, b: { kind: "pin", c: "c2", p: 0 }, via: [], points: [[300, 40], [280, 100]] },
    { id: "w6", a: { kind: "pin", c: "c7", p: 1 }, b: { kind: "pin", c: "c2", p: 1 }, via: [], points: [[340, 40], [360, 100]] },
    { id: "w7", a: { kind: "pin", c: "c3", p: 1 }, b: { kind: "pin", c: "c4", p: 0 }, via: [], points: [[280, 200], [280, 320]] },
    { id: "w8", a: { kind: "pin", c: "c3", p: 2 }, b: { kind: "pin", c: "c5", p: 0 }, via: [], points: [[360, 180], [680, 240]] },
    { id: "w9", a: { kind: "pin", c: "c5", p: 1 }, b: { kind: "pin", c: "c6", p: 0 }, via: [], points: [[680, 320], [680, 400]] },
    { id: "w10", a: { kind: "pin", c: "c3", p: 2 }, b: { kind: "port", port: "out+" }, via: [{ x: 580, y: 160 }], points: [[360, 180], [800, 160]] },
    { id: "w11", a: { kind: "port", port: "out-" }, b: { kind: "pin", c: "c6", p: 0 }, via: [], points: [[800, 320], [680, 400]] },
  ],
});

/** 5 ms of a 1 kHz sine through a gain of −2, with the reference beside it. */
function circuitSeries(gain: number, slew: number): CircuitSeries {
  const t: number[] = [];
  const vin: number[] = [];
  const vout: number[] = [];
  const iout: number[] = [];
  for (let i = 0; i < 250; i += 1) {
    const time = (i / 249) * 0.005;
    const drive = Math.sin(2 * Math.PI * 1000 * time);
    const out = gain * Math.sin(2 * Math.PI * 1000 * time - slew);
    t.push(time);
    vin.push(drive);
    vout.push(out);
    iout.push(out / 2500);
  }
  return { t, vin, vout, iout };
}

const CIRCUIT_SERIES = circuitSeries(-2, 0.35);
const CIRCUIT_EXPECTED = circuitSeries(-2, 0);

/** Four decades of an inverting amplifier of gain −10 with a pole at `cornerHz` (ADR-044). */
function circuitBode(cornerHz: number): CircuitSeries {
  const f: number[] = [];
  const magDb: number[] = [];
  const phaseDeg: number[] = [];
  for (let i = 0; i <= 80; i += 1) {
    const freq = 10 * 10 ** (i / 20);
    const ratio = freq / cornerHz;
    f.push(freq);
    magDb.push(20 - 10 * Math.log10(1 + ratio * ratio));
    phaseDeg.push(180 - (Math.atan(ratio) * 180) / Math.PI);
  }
  return { kind: "ac", f, magDb, phaseDeg };
}

const CIRCUIT_BODE = circuitBode(7000);
const CIRCUIT_BODE_EXPECTED = circuitBode(10_000);

/** A section of the gallery: a heading and a row of specimens. */
function Row({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="space-y-3">
      <SectionHeading title={title} />
      <Card className="flex flex-wrap items-center gap-6">{children}</Card>
    </section>
  );
}

/** One specimen with its state name underneath, so a screenshot is readable. */
function Specimen({ name, children }: { name: string; children: React.ReactNode }) {
  return (
    <div className="flex min-w-20 flex-col items-center gap-1.5">
      {children}
      <span className="font-mono text-[11px] text-fg-faint">{name}</span>
    </div>
  );
}

export function DevGallery() {
  const t = useT();
  const now = useNow(1000);
  const [source, setSource] = useState(SAMPLE);
  const [current, setCurrent] = useState(3);

  const segments = SEGMENT_DEMO.map((demo, i) => ({
    id: `q${i + 1}`,
    ...demo,
    current: i === current,
  }));

  return (
    <div className="space-y-8 pb-16">
      <PageHeader title={t("dev.ui.title")} description={t("dev.ui.subtitle")} />

      <Row title={t("dev.ui.actions")}>
        <Specimen name="one">
          <Actions label="One" items={[{ label: "Delete", icon: Trash2, danger: true }]} />
        </Specimen>
        <Specimen name="two">
          <Actions
            label="Two"
            items={[
              { label: "Rename", icon: Pencil },
              { label: "Delete", icon: Trash2, danger: true },
            ]}
          />
        </Specimen>
        <Specimen name="three">
          <Actions
            label="Three"
            items={[
              { label: "Rename", icon: Pencil },
              { label: "Remove from the staff", icon: UserMinus },
              { label: "Delete", icon: Trash2, danger: true },
            ]}
          />
        </Specimen>
        <Specimen name="disabled">
          <Actions
            label="Disabled"
            items={[
              { label: "Rename", icon: Pencil, disabled: true },
              { label: "Delete", icon: Trash2, danger: true },
            ]}
          />
        </Specimen>
      </Row>

      <Row title={t("dev.ui.popover")}>
        <Specimen name="click">
          <Popover label={t("dev.ui.popover")} trigger={<Button size="sm" variant="secondary">{t("dev.ui.popover")}</Button>}>
            <p className="text-[13px] text-fg-muted">{t("dev.ui.subtitle")}</p>
          </Popover>
        </Specimen>
        <Specimen name="hover">
          <Popover open="hover" align="start" label={t("dev.ui.popover")} trigger={<Button size="sm" variant="ghost">{t("dev.ui.popover")}</Button>}>
            <p className="text-[13px] text-fg-muted">{t("dev.ui.subtitle")}</p>
          </Popover>
        </Specimen>
      </Row>

      <Row title={t("dev.ui.people")}>
        <Specimen name="pill">
          <PersonPill person={PEOPLE[0]!} />
        </Specimen>
        <Specimen name="stack">
          <PeopleStack people={PEOPLE.slice(0, 3)} />
        </Specimen>
        <Specimen name="overflow">
          <PeopleStack
            people={PEOPLE}
            actions={() => [{ label: "Remove from the staff", icon: UserMinus, danger: true }]}
          />
        </Specimen>
      </Row>

      <Row title={t("dev.ui.countdown")}>
        <Specimen name="normal">
          <Countdown deadlineAt={now + 14 * 60_000 + 32_000} now={now} warnUnderS={300} />
        </Specimen>
        <Specimen name="hours">
          <Countdown deadlineAt={now + 3 * 3_600_000} now={now} warnUnderS={300} />
        </Specimen>
        <Specimen name="warning">
          <Countdown deadlineAt={now + 4 * 60_000} now={now} warnUnderS={300} />
        </Specimen>
        <Specimen name="danger">
          <Countdown deadlineAt={now + 42_000} now={now} warnUnderS={300} />
        </Specimen>
        <Specimen name="over">
          <Countdown deadlineAt={now - 5_000} now={now} warnUnderS={300} />
        </Specimen>
      </Row>

      <Row title={t("dev.ui.ring")}>
        <Ring value={18} max={24} label={t("dev.ui.lobby", { present: 18, enrolled: 24 })}>
          <span className="text-[34px] font-medium leading-none tracking-tight tabular-nums">75%</span>
          <span className="mt-0.5 text-[13px] text-fg-muted">{t("dev.ui.present")}</span>
        </Ring>
        <Ring value={5} max={24} size={120} thickness={8} label={t("dev.ui.lobby", { present: 5, enrolled: 24 })}>
          <span className="text-xl font-medium tabular-nums">5</span>
        </Ring>
        <Ring value={24} max={24} size={72} thickness={6} label={t("dev.ui.lobby", { present: 24, enrolled: 24 })} />
      </Row>

      <Row title={t("dev.ui.segments")}>
        <div className="w-full max-w-md">
          <ProgressSegments
            segments={segments}
            label={`Progress: question ${current + 1} of ${segments.length}`}
            onSelect={(_, i) => setCurrent(i)}
          />
        </div>
        <div className="w-[312px] rounded-card border border-dashed border-line p-3">
          <ProgressSegments
            segments={Array.from({ length: 20 }, (_, i) => ({
              id: `n${i}`,
              mark: (i < 7 || i % 3 === 0 ? "answered" : i % 4 === 0 ? "skipped" : "unanswered") as SegmentMark,
              current: i === 7,
              flagged: i === 4 || i === 12,
              locked: i < 3,
            }))}
            label="Progress: question 8 of 20, at 360 px"
          />
        </div>
        <div className="w-[312px] rounded-card border border-dashed border-line p-3">
          <ProgressSegments
            segments={Array.from({ length: 40 }, (_, i) => ({
              id: `s${i}`,
              mark: (i < 20 || i % 3 === 0 ? "answered" : i % 7 === 0 ? "skipped" : "unanswered") as SegmentMark,
              current: i === 23,
              flagged: i === 17,
            }))}
            label="Progress: question 24 of 40, scrolling"
            onSelect={() => {}}
          />
        </div>
      </Row>

      <Row title={t("dev.ui.verdicts")}>
        {VERDICT_STATES.map((state) => (
          <Specimen key={state} name={state}>
            <div className="w-22">
              <VerdictCell state={state} value={state === "blank" ? undefined : "NULL"} onClick={() => {}} />
            </div>
          </Specimen>
        ))}
      </Row>

      <Row title={t("dev.ui.sync")}>
        {SYNC_STATES.map((state) => (
          <Specimen key={state} name={state}>
            <SyncBadge state={state} />
          </Specimen>
        ))}
      </Row>

      <section className="space-y-3">
        <SectionHeading title={t("dev.ui.markdown")} />
        <Card>
          <MarkdownField
            value={source}
            onChange={setSource}
            label={t("dev.ui.markdown")}
            onUploadImage={async (file) => {
              await new Promise((r) => setTimeout(r, 400));
              return { id: `demo-${file.name.replace(/\W+/g, "-").toLowerCase()}` };
            }}
          />
        </Card>
      </section>

      <section className="space-y-3">
        <SectionHeading title={t("dev.ui.markdownView")} />
        <Card>
          <MarkdownView source={source} />
        </Card>
      </section>

      <section className="space-y-3">
        <SectionHeading title={t("dev.ui.diagramEditor")} />
        <DiagramEditorDemo />
      </section>

      <section className="space-y-3">
        <SectionHeading title={t("dev.ui.diagramView")} />
        <div className="grid items-start gap-4 lg:grid-cols-2">
          {(["state", "automaton", "er", "flow"] as const).map((k) => (
            <Card key={k}>
              <DiagramView kind={k} value={EXAMPLES[k]} maxHeight={260} strings={diagramCanvasStrings(t)} />
            </Card>
          ))}
        </div>
      </section>

      <section className="space-y-3">
        <SectionHeading title={t("dev.ui.circuitEditor")} />
        <CircuitEditorDemo />
      </section>

      <section className="space-y-3">
        <SectionHeading title={t("dev.ui.circuitView")} />
        <div className="grid items-start gap-4 lg:grid-cols-2">
          <Card>
            <SchematicView schematic={CIRCUIT_DEMO} height={260} />
          </Card>
          <div className="space-y-4">
            <Plot series={CIRCUIT_SERIES} expected={CIRCUIT_EXPECTED} title={t("dev.ui.sine")} height={200} />
            <Plot series={CIRCUIT_BODE} expected={CIRCUIT_BODE_EXPECTED} title={t("dev.ui.bode")} height={180} />
            <Plot series={null} height={120} />
          </div>
        </div>
      </section>

      {/* M1-04, the primitives of the classroom merge. Last, so that the
          sections above keep their place in the screenshot; padded inside,
          without touching the shared `Row`. */}
      <Row title={t("dev.ui.brand")}>
        <div className={M104_ROW}>
          <Specimen name="beside lucide">
            <span className="flex items-center gap-2 text-fg-muted">
              <Pencil className="size-4" />
              <GithubIcon className="size-4" />
              <Users className="size-4" />
            </span>
          </Specimen>
          <Specimen name="size-5, fg">
            <GithubIcon className="size-5 text-fg" />
          </Specimen>
          <Specimen name="button">
            <Button size="sm" variant="secondary">
              <GithubIcon /> GitHub
            </Button>
          </Specimen>
          <Specimen name="actions">
            <Actions label="GitHub" items={[{ label: "GitHub", icon: GithubIcon }]} />
          </Specimen>
        </div>
      </Row>

      <Row title={t("dev.ui.orgAvatar")}>
        <div className={M104_ROW}>
          {(["xs", "sm", "md"] as const).map((size) => (
            <Specimen key={size} name={`${size}, picture`}>
              <OrgAvatar login="heig-tin-info" src={ORG_PICTURE} size={size} />
            </Specimen>
          ))}
          {(["xs", "sm", "md"] as const).map((size) => (
            <Specimen key={size} name={`${size}, initials`}>
              <OrgAvatar login="heig-tin-info" size={size} />
            </Specimen>
          ))}
          <Specimen name="failed">
            <OrgAvatar login="prg1-2026" src="/missing-org-avatar.png" size="md" />
          </Specimen>
          <Specimen name="beside a name">
            <span className="flex items-center gap-2 text-sm font-medium">
              <OrgAvatar login="heig-tin-info" /> heig-tin-info
            </span>
          </Specimen>
        </div>
      </Row>

      <Row title={t("dev.ui.progress")}>
        <div className="w-full max-w-md p-4 sm:p-5">
          <Progress label={t("dev.ui.progressExplore")} />
        </div>
      </Row>

      <section className="space-y-3">
        <SectionHeading title={t("dev.ui.longForm")} />
        <Card className="p-4 sm:p-6">
          <MarkdownView source={LONG_FORM} className="md-doc" />
        </Card>
      </section>
    </div>
  );
}

/** The diagram editor (ADR-046), one kind at a time, with the teacher's text tab. */
function DiagramEditorDemo() {
  const t = useT();
  const [kind, setKind] = useState<DiagramKind>("class");
  const [scenes, setScenes] = useState<Record<DiagramKind, Scene>>(() => ({ ...EXAMPLES }));
  return (
    <div className="space-y-3">
      <Segmented
        name="dev-diagram-kind"
        label={t("dev.ui.diagramKind")}
        value={kind}
        options={DIAGRAM_KINDS.map((k) => ({ value: k, label: t(`qt.diagram.e.kind.${k}`) }))}
        onChange={setKind}
        size="sm"
        wrap
      />
      <DiagramEditor
        key={kind}
        kind={kind}
        value={scenes[kind]}
        onChange={(next) => setScenes((all) => ({ ...all, [kind]: next }))}
        withText
        height={480}
        strings={diagramCanvasStrings(t)}
      />
    </div>
  );
}

/** The editor is controlled, so the gallery has to hold its value. */
function CircuitEditorDemo() {
  const [schematic, setSchematic] = useState<CircuitSchematic>(CIRCUIT_DEMO);
  return (
    <SchematicEditor
      value={schematic}
      onChange={setSchematic}
      palette={CIRCUIT_PALETTE}
      supplies={{ vcc: 12, vee: -12 }}
      highlightPins={[{ c: "c5", p: 1 }]}
    />
  );
}

