import {
  Bot,
  BookOpen,
  Check,
  Clock,
  Laptop,
  Lock,
  Play,
  QrCode,
  Repeat,
  Sparkles,
} from "lucide-react";
import type { CSSProperties, ReactNode } from "react";

import { useT } from "../i18n";
import { cx, GithubIcon } from "../ui";
import { STILL, useInView, useStep } from "./motion";

/*
 * The animated scenes of the discovery page. Each is a miniature of a real
 * screen, drawn with the app's tokens (so it follows the theme by itself),
 * that loops while on screen and shows its end state under reduced motion.
 * They are pictures: `aria-hidden`, the text beside them says the same.
 */

const delay = (ms: number) => ({ "--delay": `${ms}ms` }) as CSSProperties;

/** A window of the app: hairline, card radius, three dots and a title. */
export function Frame({
  title,
  right,
  children,
  className,
}: {
  title: string;
  right?: ReactNode;
  children: ReactNode;
  className?: string;
}) {
  return (
    <div
      aria-hidden
      className={cx(
        "overflow-hidden rounded-sheet border border-line bg-surface text-left shadow-(--shadow-overlay)",
        className,
      )}
    >
      <div className="flex items-center gap-3 border-b border-line bg-surface-2 px-4 py-2.5">
        <span className="flex gap-1.5">
          <i className="size-2.5 rounded-full bg-(--q-red)" />
          <i className="size-2.5 rounded-full bg-(--q-yellow)" />
          <i className="size-2.5 rounded-full bg-(--q-green)" />
        </span>
        <span className="truncate text-xs font-medium text-fg-muted">{title}</span>
        <span className="ml-auto">{right}</span>
      </div>
      {children}
    </div>
  );
}

// --- Hero: the live dashboard of an exam ------------------------------------

const STUDENTS = ["Alice Rochat", "Bastien Morel", "Chloé Favre", "David Nguyen", "Emma Keller", "Félix Dubois"];
const QUESTIONS = 6;
// Each student's pace (steps per question) and start, so the rows fill unevenly.
const PACE = [2, 3, 2, 4, 3, 2];
const START = [0, 1, 3, 0, 2, 5];
const answerAt = (r: number, c: number) => START[r]! + c * PACE[r]!;
const GRID_LOOP = Math.max(...STUDENTS.map((_, r) => answerAt(r, QUESTIONS - 1))) + 8;

function useCountdown(running: boolean): string {
  const tick = useStep(1000, 3600, running);
  const left = 41 * 60 + 12 - (tick === STILL ? 0 : tick);
  return `${Math.floor(left / 60)}:${String(left % 60).padStart(2, "0")}`;
}

export function LiveGridScene({ compact }: { compact?: boolean }) {
  const t = useT();
  const [ref, inView] = useInView<HTMLDivElement>();
  const raw = useStep(550, GRID_LOOP, inView);
  const step = raw === STILL ? 11 : raw;
  const clock = useCountdown(inView);
  const done = STUDENTS.filter((_, r) => answerAt(r, QUESTIONS - 1) + 2 <= step).length;
  return (
    <div ref={ref}>
      <Frame
        title={t("discover.scene.liveTitle")}
        right={
          <span className="flex items-center gap-1.5 font-mono text-xs tabular-nums text-fg">
            <Clock className="size-3.5 text-fg-faint" />
            {clock}
          </span>
        }
      >
        <div className="px-4 pt-3 pb-4">
          <div className="mb-3 flex items-center gap-2 text-xs text-fg-muted">
            <span className="relative flex size-2">
              <span className="absolute inset-0 animate-ping rounded-full bg-success opacity-60" />
              <span className="relative size-2 rounded-full bg-success" />
            </span>
            {t("discover.scene.liveOnline", { n: 24 })}
            <span className="ml-auto tabular-nums">{t("discover.scene.liveDone", { n: done })}</span>
          </div>
          <div className="grid gap-1.5" style={{ gridTemplateColumns: `minmax(0,1fr) repeat(${QUESTIONS}, 1.6rem)` }}>
            <span />
            {Array.from({ length: QUESTIONS }, (_, c) => (
              <span key={c} className="text-center text-[11px] font-medium text-fg-faint">
                Q{c + 1}
              </span>
            ))}
            {STUDENTS.slice(0, compact ? 4 : STUDENTS.length).map((name, r) => (
              <Row key={name} name={name} r={r} step={step} />
            ))}
          </div>
        </div>
      </Frame>
    </div>
  );
}

function Row({ name, r, step }: { name: string; r: number; step: number }) {
  return (
    <>
      <span className="flex min-w-0 items-center gap-2 text-[13px] text-fg">
        <span className="grid size-5 shrink-0 place-items-center rounded-full bg-surface-3 text-[10px] font-semibold text-fg-muted">
          {name[0]}
        </span>
        <span className="truncate">{name}</span>
      </span>
      {Array.from({ length: QUESTIONS }, (_, c) => {
        const at = answerAt(r, c);
        const state = step >= at + 2 ? "validated" : step >= at ? "answered" : "empty";
        return (
          <span
            key={c}
            className={cx(
              "h-6 rounded-[6px] transition-colors duration-500",
              state === "validated" ? "bg-info" : state === "answered" ? "bg-info-mid" : "bg-surface-3",
            )}
          />
        );
      })}
    </>
  );
}

/** The card that floats over the hero: three tests turning green. */
export function TestsCard() {
  const t = useT();
  const [ref, inView] = useInView<HTMLDivElement>();
  const raw = useStep(700, 8, inView);
  const step = raw === STILL ? 7 : raw;
  return (
    <div ref={ref} aria-hidden className="w-56 rounded-card border border-line bg-surface p-3 shadow-(--shadow-popover)">
      <div className="mb-2 flex items-center gap-2 text-xs font-semibold text-fg">
        <Play className="size-3.5 text-success" />
        {t("discover.scene.tests")}
        <span className="ml-auto font-mono text-fg-muted tabular-nums">{Math.min(3, Math.max(0, step - 1))}/3</span>
      </div>
      {["test_empty", "test_sort", "test_dup"].map((name, i) => (
        <div key={name} className="flex items-center gap-2 py-0.5 font-mono text-[12px] text-fg-muted">
          {step > i + 1 ? (
            <Check className="pop-in size-3.5 text-success" />
          ) : (
            <span className="size-3.5 animate-pulse rounded-full bg-surface-3" />
          )}
          {name}
        </div>
      ))}
    </div>
  );
}

/** The poll card that floats over the hero: four bars growing. */
export function PollCard() {
  const t = useT();
  const [ref, inView] = useInView<HTMLDivElement>();
  const raw = useStep(1800, 4, inView);
  const round = raw === STILL ? 0 : raw;
  const sets = [
    [18, 62, 12, 8],
    [10, 70, 14, 6],
    [14, 58, 20, 8],
    [12, 66, 16, 6],
  ];
  const shares = sets[round]!;
  const colors = ["bg-(--q-red)", "bg-(--q-blue)", "bg-(--q-yellow)", "bg-(--q-green)"];
  return (
    <div ref={ref} aria-hidden className="w-60 rounded-card border border-line bg-surface p-3 shadow-(--shadow-popover)">
      <div className="mb-2 text-xs font-semibold text-fg">{t("discover.scene.pollQuestion")}</div>
      {["O(1)", "O(n)", "O(n log n)", "O(n²)"].map((label, i) => (
        <div key={label} className="mb-1 flex items-center gap-2">
          <span className="w-20 shrink-0 font-mono text-[11px] whitespace-nowrap text-fg-muted">{label}</span>
          <span className="h-2 flex-1 overflow-hidden rounded-full bg-surface-3">
            <span
              className={cx("block h-full rounded-full transition-[width] duration-1000 ease-out", colors[i])}
              style={{ width: `${shares[i]}%` }}
            />
          </span>
        </div>
      ))}
    </div>
  );
}

/** A toast sliding in: someone just submitted. */
export function SubmittedToast() {
  const t = useT();
  const [ref, inView] = useInView<HTMLDivElement>();
  const raw = useStep(2600, STUDENTS.length, inView);
  const who = STUDENTS[raw === STILL ? 0 : raw]!;
  return (
    <div ref={ref} aria-hidden className="flex items-center gap-2 rounded-full border border-line bg-surface py-1.5 pr-4 pl-1.5 shadow-(--shadow-popover)">
      <span className="grid size-6 place-items-center rounded-full bg-success text-on-fill">
        <Check className="size-3.5" />
      </span>
      <span key={who} className="slide-in text-xs text-fg">
        {t("discover.scene.submitted", { name: who.split(" ")[0]! })}
      </span>
    </div>
  );
}

// --- Feature tab 1: the question editor ------------------------------------

export function PoolScene() {
  const t = useT();
  const [ref, inView] = useInView<HTMLDivElement>();
  const raw = useStep(900, 9, inView);
  const step = raw === STILL ? 8 : raw;
  const options = ["discover.scene.mcqA", "discover.scene.mcqB", "discover.scene.mcqC", "discover.scene.mcqD"] as const;
  return (
    <div ref={ref}>
      <Frame title={t("discover.scene.poolTitle")}>
        <div className="space-y-3 p-4">
          <div className="flex flex-wrap gap-1.5">
            {(["discover.scene.conceptPointers", "discover.scene.conceptMemory"] as const).map((k, i) =>
              step > i ? (
                <span key={k} className="pop-in rounded-full bg-accent-soft px-2.5 py-0.5 text-[11px] font-medium text-accent">
                  {t(k)}
                </span>
              ) : null,
            )}
            {step > 2 ? (
              <span className="pop-in rounded-full bg-info-soft px-2.5 py-0.5 text-[11px] font-medium text-info">
                {t("discover.scene.parameterized")}
              </span>
            ) : null}
          </div>
          <p className="text-sm font-semibold text-fg">
            {t("discover.scene.mcqStem")} <code className="rounded bg-surface-3 px-1 font-mono text-[12px]">p + {step > 5 ? 3 : "n"}</code> ?
          </p>
          <div className="space-y-1.5">
            {options.map((k, i) => {
              const right = i === 1 && step > 3;
              return (
                <div
                  key={k}
                  className={cx(
                    "flex items-center gap-2.5 rounded-field border px-3 py-2 text-[13px] transition-colors duration-500",
                    right ? "border-success bg-success-soft text-fg" : "border-line text-fg-muted",
                  )}
                >
                  <span
                    className={cx(
                      "grid size-4.5 place-items-center rounded-[5px] border transition-colors",
                      right ? "border-success bg-success text-on-fill" : "border-line-strong",
                    )}
                  >
                    {right ? <Check className="pop-in size-3" /> : null}
                  </span>
                  {t(k)}
                </div>
              );
            })}
          </div>
          <div className="flex items-center gap-2 border-t border-line pt-3 text-[11px] text-fg-faint">
            <span>{t("discover.scene.usedIn", { n: 4 })}</span>
            <span className="ml-auto flex items-end gap-0.5">
              {[40, 65, 52, 78].map((h, i) => (
                <span key={i} className="w-2 rounded-sm bg-info" style={{ height: step > 6 ? `${h / 5}px` : "2px", transition: "height .6s" }} />
              ))}
            </span>
            <span className="tabular-nums">{t("discover.scene.success", { n: step > 6 ? 71 : 0 })}</span>
          </div>
        </div>
      </Frame>
    </div>
  );
}

// --- Feature tab 2: from practice to the locked exam -----------------------

export function ModesScene() {
  const t = useT();
  const [ref, inView] = useInView<HTMLDivElement>();
  const raw = useStep(1500, 3, inView);
  const mode = raw === STILL ? 2 : raw;
  const modes = [
    { icon: BookOpen, key: "discover.scene.modePractice", tone: "var(--q-green)" },
    { icon: Repeat, key: "discover.scene.modeReview", tone: "var(--q-blue)" },
    { icon: Lock, key: "discover.scene.modeExam", tone: "var(--q-red)" },
  ] as const;
  return (
    <div ref={ref}>
      <Frame title={t("discover.scene.modesTitle")}>
        <div className="space-y-4 p-4">
          <div className="relative flex rounded-full bg-surface-3 p-1">
            <span
              className="absolute inset-y-1 rounded-full bg-surface shadow-sm transition-[left] duration-500 ease-out"
              style={{ width: "calc((100% - 0.5rem) / 3)", left: `calc(0.25rem + ${mode} * (100% - 0.5rem) / 3)` }}
            />
            {modes.map((m, i) => (
              <span
                key={m.key}
                className={cx(
                  "relative z-10 flex flex-1 items-center justify-center gap-1.5 py-1.5 text-[12px] font-medium transition-colors",
                  i === mode ? "text-fg" : "text-fg-faint",
                )}
              >
                <m.icon className="size-3.5" style={{ color: i === mode ? m.tone : undefined }} />
                {t(m.key)}
              </span>
            ))}
          </div>
          <div key={mode} className="pop-in space-y-2">
            {(
              [
                ["discover.scene.modePractice1", "discover.scene.modePractice2"],
                ["discover.scene.modeReview1", "discover.scene.modeReview2"],
                ["discover.scene.modeExam1", "discover.scene.modeExam2"],
              ] as const
            )[mode]!.map((k, i) => (
              <div key={k} className="slide-in flex items-center gap-2 text-[13px] text-fg" style={delay(i * 120)}>
                <Check className="size-3.5 text-success" />
                {t(k)}
              </div>
            ))}
          </div>
          <div className="flex gap-2">
            {[
              { icon: Lock, label: "Safe Exam Browser" },
              { icon: Laptop, label: t("discover.scene.kiosk") },
            ].map((b) => (
              <span
                key={b.label}
                className={cx(
                  "flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-[11px] font-medium transition-all duration-500",
                  mode === 2 ? "border-accent/40 bg-accent-soft text-accent" : "border-line text-fg-faint opacity-50",
                )}
              >
                <b.icon className="size-3" />
                {b.label}
              </span>
            ))}
          </div>
        </div>
      </Frame>
    </div>
  );
}

// --- Feature tab 3: a poll on the projector --------------------------------

export function PollScene() {
  const t = useT();
  const [ref, inView] = useInView<HTMLDivElement>();
  const raw = useStep(160, 60, inView);
  const step = raw === STILL ? 59 : raw;
  const votes = Math.min(38, Math.round(step * 0.8));
  const shares = [0.13, 0.58, 0.21, 0.08];
  const colors = ["bg-(--q-red)", "bg-(--q-blue)", "bg-(--q-yellow)", "bg-(--q-green)"];
  return (
    <div ref={ref}>
      <Frame title={t("discover.scene.projectionTitle")}>
        <div className="flex gap-4 p-4">
          <div className="flex-1 space-y-2">
            <p className="text-sm font-semibold text-fg">{t("discover.scene.pollQuestion")}</p>
            {["O(1)", "O(n)", "O(n log n)", "O(n²)"].map((label, i) => (
              <div key={label}>
                <div className="flex justify-between font-mono text-[11px] text-fg-muted">
                  <span>{label}</span>
                  <span className="tabular-nums">{Math.round(shares[i]! * votes)}</span>
                </div>
                <span className="mt-0.5 block h-2.5 overflow-hidden rounded-full bg-surface-3">
                  <span
                    className={cx("block h-full rounded-full transition-[width] duration-150", colors[i])}
                    style={{ width: `${(shares[i]! * votes * 100) / 38}%` }}
                  />
                </span>
              </div>
            ))}
          </div>
          <div className="flex w-24 shrink-0 flex-col items-center justify-center gap-2 rounded-card bg-surface-2 p-2">
            <QrCode className="size-16 text-fg" strokeWidth={1.25} />
            <span className="font-mono text-[11px] text-fg-muted">#4821</span>
            <span className="text-xl font-bold tabular-nums text-fg">{votes}</span>
            <span className="-mt-2 text-[10px] text-fg-faint">{t("discover.scene.votes")}</span>
          </div>
        </div>
      </Frame>
    </div>
  );
}

// --- Feature tab 4: grading with a suggestion ------------------------------

export function GradingScene() {
  const t = useT();
  const [ref, inView] = useInView<HTMLDivElement>();
  const raw = useStep(110, 90, inView);
  const step = raw === STILL ? 89 : raw;
  const reason = t("discover.scene.aiReason");
  const typed = reason.slice(0, Math.max(0, (step - 8) * 2));
  const accepted = step > 70;
  return (
    <div ref={ref}>
      <Frame title={t("discover.scene.gradingTitle")}>
        <div className="space-y-3 p-4">
          <div className="rounded-field bg-surface-2 p-3 text-[13px] leading-relaxed text-fg-muted">
            <span className="mb-1 block text-[11px] font-semibold text-fg-faint">Chloé Favre</span>
            {t("discover.scene.essay")}
          </div>
          <div className={cx("rounded-field border p-3 transition-colors duration-500", accepted ? "border-success/50 bg-success-soft" : "border-info/40 bg-info-soft")}>
            <div className="mb-1 flex items-center gap-1.5 text-[11px] font-semibold text-info">
              <Sparkles className="size-3.5" />
              {t("discover.scene.aiSuggestion")}
              <span className="ml-auto font-mono text-fg tabular-nums">{step > 6 ? "3.5 / 4" : "… / 4"}</span>
            </div>
            <p className={cx("min-h-10 text-[12px] leading-relaxed text-fg", typed.length < reason.length && "caret")}>{typed}</p>
          </div>
          <div className="flex items-center gap-2">
            <span
              className={cx(
                "rounded-full px-3.5 py-1.5 text-[12px] font-medium transition-all duration-300",
                accepted ? "scale-95 bg-success text-on-fill" : "bg-accent text-on-fill",
                step > 64 && step <= 70 && "pulse-ring",
              )}
            >
              {accepted ? t("discover.scene.accepted") : t("discover.scene.accept")}
            </span>
            <span className="text-[12px] text-fg-faint">{t("discover.scene.teacherDecides")}</span>
            {accepted ? <span className="pop-in ml-auto text-lg font-bold tabular-nums text-fg">5.3</span> : null}
          </div>
        </div>
      </Frame>
    </div>
  );
}

// --- Spotlight: code written, compiled and tested --------------------------

const CODE = `int sum(int *v, int n) {
    int s = 0;
    for (int i = 0; i < n; i++)
        s += v[i];
    return s;
}`;

export function CodeScene() {
  const t = useT();
  const [ref, inView] = useInView<HTMLDivElement>();
  const raw = useStep(45, CODE.length + 70, inView);
  const step = raw === STILL ? CODE.length + 69 : raw;
  const typed = CODE.slice(0, step);
  const after = step - CODE.length;
  const tests = [
    { name: "sum([1,2,3])", ok: true },
    { name: "sum([])", ok: true },
    { name: "sum([-4,4])", ok: true },
  ];
  return (
    <div ref={ref}>
      <Frame
        title="exercice-03.c"
        right={
          <span className={cx("flex items-center gap-1 rounded-full px-2.5 py-0.5 text-[11px] font-semibold transition-colors", after > 4 ? "bg-success text-on-fill" : "bg-surface-3 text-fg-muted")}>
            <Play className="size-3" /> {t("discover.scene.run")}
          </span>
        }
      >
        <pre className="min-h-38 overflow-hidden bg-surface px-4 py-3 font-mono text-[12.5px] leading-[1.6] text-fg">
          <code className={cx(after < 0 && "caret")}>{highlight(typed)}</code>
        </pre>
        <div className="min-h-28 border-t border-line bg-surface-2 px-4 py-3 font-mono text-[12px]">
          {after > 8 ? <div className="slide-in text-fg-faint">$ gcc -Wall exercice-03.c && ./tests</div> : null}
          {tests.map((test, i) =>
            after > 16 + i * 8 ? (
              <div key={test.name} className="slide-in flex items-center gap-2 text-fg">
                <Check className="size-3.5 text-success" /> {test.name}
              </div>
            ) : null,
          )}
          {after > 46 ? (
            <div className="pop-in mt-1 font-semibold text-success">{t("discover.scene.allPass")}</div>
          ) : null}
        </div>
      </Frame>
    </div>
  );
}

/** Keywords and numbers in colour: enough to read as code, nothing more. */
function highlight(code: string): ReactNode[] {
  return code.split(/(\bint\b|\bfor\b|\breturn\b|\b\d+\b)/).map((part, i) =>
    /^(int|for|return)$/.test(part) ? (
      <span key={i} className="text-(--q-blue)">{part}</span>
    ) : /^\d+$/.test(part) ? (
      <span key={i} className="text-warning">{part}</span>
    ) : (
      part
    ),
  );
}

// --- Spotlight: the classroom (journal and GitHub projects) ----------------

export function ClassroomScene() {
  const t = useT();
  const [ref, inView] = useInView<HTMLDivElement>();
  const raw = useStep(900, 10, inView);
  const step = raw === STILL ? 9 : raw;
  const pages = ["discover.scene.week1", "discover.scene.week2", "discover.scene.week3"] as const;
  const commits = ["discover.scene.commit1", "discover.scene.commit2", "discover.scene.commit3"] as const;
  return (
    <div ref={ref} className="grid gap-4 sm:grid-cols-2">
      <Frame title={t("discover.scene.journalTitle")}>
        <div className="space-y-1.5 p-4">
          {pages.map((k, i) => (
            <div
              key={k}
              className={cx(
                "flex items-center gap-2 rounded-field px-2.5 py-2 text-[13px] transition-all duration-500",
                step > i * 2 ? "bg-surface-2 text-fg opacity-100" : "text-fg-faint opacity-40",
              )}
            >
              <BookOpen className="size-3.5 text-(--q-yellow)" />
              {t(k)}
              <span className="ml-auto text-[11px] text-fg-faint">
                {step > i * 2 ? t("discover.scene.published") : t("discover.scene.scheduled")}
              </span>
            </div>
          ))}
        </div>
      </Frame>
      <Frame title={t("discover.scene.projectTitle")}>
        <div className="space-y-2 p-4">
          {commits.map((c, i) =>
            step > 2 + i * 2 ? (
              <div key={c} className="slide-in flex items-center gap-2 text-[12px]">
                <GithubIcon className="size-3.5 shrink-0 text-fg-muted" />
                <span className="truncate text-fg">{t(c)}</span>
                <Check className="ml-auto size-3.5 shrink-0 text-success" />
              </div>
            ) : (
              <div key={c} className="h-4.5 rounded bg-surface-3 opacity-50" />
            ),
          )}
          <div className="flex items-center justify-between border-t border-line pt-2 text-[11px] text-fg-faint">
            <span>{t("discover.scene.team")}</span>
            <span className="font-mono">main · a1f3c9e</span>
          </div>
        </div>
      </Frame>
    </div>
  );
}

// --- Spotlight: an assistant connected to the platform ---------------------

export function AssistantScene() {
  const t = useT();
  const [ref, inView] = useInView<HTMLDivElement>();
  const raw = useStep(700, 12, inView);
  const step = raw === STILL ? 11 : raw;
  const created = ["discover.scene.q1", "discover.scene.q2", "discover.scene.q3"] as const;
  return (
    <div ref={ref}>
      <Frame title={t("discover.scene.assistantTitle")}>
        <div className="space-y-3 p-4">
          <div className="ml-auto w-fit max-w-[85%] rounded-[14px] rounded-br-[4px] bg-accent px-3.5 py-2 text-[13px] text-on-fill">
            {t("discover.scene.prompt")}
          </div>
          {step > 1 ? (
            <div className="pop-in flex gap-2">
              <span className="grid size-7 shrink-0 place-items-center rounded-full bg-surface-3">
                <Bot className="size-4 text-fg-muted" />
              </span>
              <div className="flex-1 space-y-1.5 rounded-[14px] rounded-tl-[4px] bg-surface-2 px-3.5 py-2.5 text-[13px] text-fg">
                <p>{step > 2 ? t("discover.scene.reply") : "…"}</p>
                {created.map((k, i) =>
                  step > 3 + i * 2 ? (
                    <div key={k} className="pop-in flex items-center gap-2 rounded-field border border-line bg-surface px-2.5 py-1.5 text-[12px]">
                      <span className="rounded-full bg-success-soft px-2 py-0.5 text-[10px] font-semibold text-success">
                        {t("discover.scene.draft")}
                      </span>
                      <span className="truncate">{t(k)}</span>
                    </div>
                  ) : null,
                )}
              </div>
            </div>
          ) : null}
        </div>
      </Frame>
    </div>
  );
}

