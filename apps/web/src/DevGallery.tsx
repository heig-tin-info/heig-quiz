import { useState } from "react";

import { useT } from "./i18n";
import { MarkdownField } from "./markdown/MarkdownField";
import { MarkdownView } from "./markdown/MarkdownView";
import {
  Card,
  Countdown,
  PageHeader,
  ProgressSegments,
  Ring,
  SectionHeading,
  SyncBadge,
  VerdictCell,
  useNow,
  type SegmentState,
  type SyncState,
  type VerdictState,
} from "./ui";

/*
 * `/dev/ui` — every state of the live primitives on one page, so a screenshot
 * pass covers them all instead of hunting them across five screens that do
 * not exist yet. Development only: App.tsx routes here behind
 * `import.meta.env.DEV`, and only for a teacher.
 *
 * It is a gallery, not a screen: the one-primary-action rule does not apply,
 * and it deliberately shows things side by side that never share a page.
 */

const VERDICT_STATES: VerdictState[] = [
  "blank",
  "inProgress",
  "answered",
  "correct",
  "partial",
  "wrong",
  "pending",
];

const SYNC_STATES: SyncState[] = ["saved", "saving", "offline", "closed"];

const SEGMENT_DEMO: SegmentState[] = [
  "done",
  "done",
  "answered",
  "current",
  "empty",
  "answered",
  "empty",
  "empty",
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

  const segments = SEGMENT_DEMO.map((state, i) => ({
    id: `q${i + 1}`,
    state: i === current ? ("current" as const) : state === "current" ? ("empty" as const) : state,
  }));

  return (
    <div className="space-y-8 pb-16">
      <PageHeader title={t("dev.ui.title")} description={t("dev.ui.subtitle")} />

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
              state: (i < 7 ? "done" : i === 7 ? "current" : i % 3 === 0 ? "answered" : "empty") as SegmentState,
            }))}
            label="Progress: question 8 of 20, at 360 px"
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
    </div>
  );
}
