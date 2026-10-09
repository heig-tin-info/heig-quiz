import {
  ArrowRight,
  Clock,
  EyeOff,
  KeyRound,
  Laptop,
  ListChecks,
  Lock,
  Moon,
  PenLine,
  Radio,
  ShieldCheck,
  Sun,
  Box,
  GraduationCap,
  type LucideIcon,
} from "lucide-react";
import { useCallback, useEffect, useRef, useState, type CSSProperties, type ReactNode } from "react";
import { prefersReducedMotion } from "@quiz/ui";

import { Logo } from "../Header";
import { type Dict, type Locale, useI18n } from "../i18n";
import { setThemeChoice, useResolvedTheme } from "../theme";
import { cx, GithubIcon, IconButton, IconLink, LinkButton, Segmented } from "../ui";
import "./discover.css";
import { useInView, useReveal } from "./motion";
import {
  AssistantScene,
  ClassroomScene,
  CodeScene,
  GradingScene,
  LiveGridScene,
  ModesScene,
  PollCard,
  PollScene,
  PoolScene,
  SubmittedToast,
  TestsCard,
} from "./scenes";
import {
  BrainstormType,
  CategorizeType,
  CircuitType,
  ClozeType,
  CodeImageType,
  CodeType,
  DiagramType,
  McqType,
  RichType,
  ShortType,
} from "./typeScenes";

/**
 * The public discovery page, `/discover` (DESIGN.md, "The discovery page"):
 * what Quiz is, for someone who has no account yet. Drawn with no session
 * and without waiting on `/me`, like the kiosk station. Its ONE primary
 * action is the same door as the landing page: sign in with Switch edu-ID.
 * Language and theme are chosen here too, for this browser only (no account
 * to persist them to).
 */

const SIGN_IN = "/app/auth/login";
const REPOSITORY = "https://github.com/heig-tin-info/heig-quiz";

type Key = keyof Dict;

export function DiscoverPage() {
  const { t } = useI18n();
  useEffect(() => {
    document.title = t("discover.docTitle");
    return () => {
      document.title = "Quiz";
    };
  }, [t]);
  return (
    <div className="discover min-h-dvh overflow-x-clip bg-canvas text-fg">
      <TopBar />
      <main>
        <Hero />
        <Ticker />
        <QuestionTypes />
        <Features />
        <Spotlight
          id="code"
          eyebrow="discover.code.eyebrow"
          title="discover.code.title"
          body="discover.code.body"
          points={["discover.code.p1", "discover.code.p2", "discover.code.p3"]}
          tone="var(--q-blue)"
          scene={<CodeScene />}
        />
        <Spotlight
          id="classroom"
          eyebrow="discover.class.eyebrow"
          title="discover.class.title"
          body="discover.class.body"
          points={["discover.class.p1", "discover.class.p2", "discover.class.p3"]}
          tone="var(--q-yellow)"
          scene={<ClassroomScene />}
          flip
        />
        <Spotlight
          id="assistant"
          eyebrow="discover.assist.eyebrow"
          title="discover.assist.title"
          body="discover.assist.body"
          points={["discover.assist.p1", "discover.assist.p2", "discover.assist.p3"]}
          tone="var(--q-green)"
          scene={<AssistantScene />}
        />
        <Security />
        <FinalCall />
      </main>
      <Footer />
    </div>
  );
}

// --- Top bar ---------------------------------------------------------------

function TopBar() {
  const { t, locale, setLocale } = useI18n();
  const theme = useResolvedTheme();
  const [scrolled, setScrolled] = useState(false);
  useEffect(() => {
    const onScroll = () => setScrolled(window.scrollY > 8);
    onScroll();
    window.addEventListener("scroll", onScroll, { passive: true });
    return () => window.removeEventListener("scroll", onScroll);
  }, []);
  return (
    <header
      className={cx(
        "sticky top-0 z-30 transition-colors duration-300",
        scrolled ? "border-b border-line bg-canvas/80 backdrop-blur-md" : "border-b border-transparent",
      )}
    >
      <div className="mx-auto flex h-16 max-w-280 items-center gap-6 px-4 sm:px-8">
        <a href="/discover" aria-label="Quiz" className="shrink-0">
          <Logo className="w-24" />
        </a>
        <nav className="hidden items-center gap-5 text-sm text-fg-muted md:flex">
          <a href="#types" className="transition-colors hover:text-fg">{t("discover.nav.types")}</a>
          <a href="#features" className="transition-colors hover:text-fg">{t("discover.nav.features")}</a>
          <a href="#code" className="transition-colors hover:text-fg">{t("discover.nav.code")}</a>
          <a href="#security" className="transition-colors hover:text-fg">{t("discover.nav.security")}</a>
        </nav>
        <div className="ml-auto flex items-center gap-2">
          <Segmented<Locale>
            name="discover-locale"
            size="sm"
            label={t("discover.language")}
            value={locale}
            options={[
              { value: "fr", label: "FR" },
              { value: "en", label: "EN" },
            ]}
            onChange={(l) => setLocale(l, false)}
          />
          <IconButton
            label={theme === "dark" ? t("discover.themeLight") : t("discover.themeDark")}
            onClick={() => setThemeChoice(theme === "dark" ? "light" : "dark")}
          >
            {theme === "dark" ? <Sun /> : <Moon />}
          </IconButton>
          <IconLink label={t("discover.github")} href={REPOSITORY}>
            <GithubIcon />
          </IconLink>
          <LinkButton href={SIGN_IN} variant="secondary" size="sm" className="hidden sm:inline-flex">
            {t("discover.signinShort")}
          </LinkButton>
        </div>
      </div>
    </header>
  );
}

// --- Hero ------------------------------------------------------------------

function Hero() {
  const { t } = useI18n();
  const words = t("discover.hero.title").split(" ");
  const ink = t("discover.hero.ink");
  return (
    <section className="relative isolate pt-14 pb-20 sm:pt-20">
      <div className="discover-dots -z-10" />
      <div className="discover-aurora -z-10">
        <span />
        <span />
        <span />
        <span />
      </div>
      <div className="mx-auto max-w-280 px-4 text-center sm:px-8">
        <p className="rise-block mx-auto mb-6 inline-flex items-center gap-2 rounded-full border border-line bg-surface/70 px-3 py-1 text-xs font-medium text-fg-muted backdrop-blur">
          <GraduationCap className="size-3.5 text-(--q-blue)" />
          {t("discover.hero.eyebrow")}
        </p>
        <h1 className="mx-auto max-w-4xl text-4xl leading-[1.05] font-extrabold tracking-[-0.035em] text-balance sm:text-6xl lg:text-7xl">
          {words.map((w, i) => (
            <span key={i} className="rise-word" style={{ "--delay": `${120 + i * 70}ms` } as CSSProperties}>
              {w}&nbsp;
            </span>
          ))}
          <span className="rise-word" style={{ "--delay": `${120 + words.length * 70}ms` } as CSSProperties}>
            <span className="discover-ink">{ink}</span>
          </span>
        </h1>
        <p
          className="rise-block mx-auto mt-6 max-w-2xl text-base leading-relaxed text-fg-muted sm:text-lg"
          style={{ "--delay": "700ms" } as CSSProperties}
        >
          {t("discover.hero.body")}
        </p>
        <div className="rise-block mt-9 flex flex-col items-center justify-center gap-3 sm:flex-row" style={{ "--delay": "850ms" } as CSSProperties}>
          <LinkButton href={SIGN_IN} variant="primary" size="lg" className="w-full px-7 sm:w-auto">
            {t("landing.signin")}
          </LinkButton>
          <LinkButton href="#features" variant="ghost" size="lg" className="w-full sm:w-auto">
            {t("discover.hero.tour")} <ArrowRight />
          </LinkButton>
        </div>
      </div>

      {/* The product, moving: an exam's live dashboard and what floats around it. */}
      <div className="rise-block relative mx-auto mt-16 max-w-4xl px-4 sm:px-8" style={{ "--delay": "1000ms" } as CSSProperties}>
        <LiveGridScene />
        <div className="float-a absolute -top-10 -right-24 hidden xl:block" style={{ "--tilt": "3deg" } as CSSProperties}>
          <TestsCard />
        </div>
        <div className="float-b absolute -top-16 -left-36 hidden xl:block" style={{ "--tilt": "-3deg" } as CSSProperties}>
          <PollCard />
        </div>
        <div className="float-c absolute -bottom-5 right-6 hidden sm:block">
          <SubmittedToast />
        </div>
      </div>
    </section>
  );
}

// --- The ticker of question types -----------------------------------------

const TYPES: readonly [Key, string][] = [
  ["discover.qt.mcq.name", "var(--q-red)"],
  ["discover.qt.short.name", "var(--q-yellow)"],
  ["discover.qt.cloze.name", "var(--q-blue)"],
  ["discover.qt.code.name", "var(--q-green)"],
  ["discover.qt.codeimage.name", "var(--q-red)"],
  ["discover.qt.circuit.name", "var(--q-yellow)"],
  ["discover.qt.rich.name", "var(--q-blue)"],
  ["discover.qt.categorize.name", "var(--q-green)"],
  ["discover.qt.diagram.name", "var(--q-red)"],
  ["discover.qt.brainstorm.name", "var(--q-yellow)"],
  ["discover.type.parameterized", "var(--q-blue)"],
  ["discover.type.poll", "var(--q-green)"],
];

function Ticker() {
  const { t } = useI18n();
  const items = TYPES.map(([k, c]) => (
    <span key={k} className="flex items-center gap-3 px-5 text-lg font-semibold tracking-tight whitespace-nowrap text-fg-muted sm:text-xl">
      <span className="size-2.5 rounded-full" style={{ background: c }} />
      {t(k)}
    </span>
  ));
  return (
    <section aria-label={t("discover.ticker")} className="border-y border-line bg-surface/60 py-5">
      <p className="sr-only">{TYPES.map(([k]) => t(k)).join(", ")}</p>
      <div className="marquee overflow-hidden" aria-hidden>
        <div className="marquee-track">
          {items}
          {items}
        </div>
      </div>
    </section>
  );
}

// --- Every question type, each with its own scene --------------------------

/**
 * The types of the registry (`packages/registry/src/server.ts`), in the
 * order a teacher meets them. `wide` cards span two columns from `lg`: the
 * scenes that need room to be read (code, circuit, diagram).
 */
const QTYPES: readonly { id: string; tone: string; scene: () => ReactNode; chips: number; wide?: boolean }[] = [
  { id: "mcq", tone: "var(--q-red)", scene: () => <McqType />, chips: 3 },
  { id: "short", tone: "var(--q-yellow)", scene: () => <ShortType />, chips: 3 },
  { id: "cloze", tone: "var(--q-blue)", scene: () => <ClozeType />, chips: 3 },
  { id: "code", tone: "var(--q-green)", scene: () => <CodeType />, chips: 3, wide: true },
  { id: "codeimage", tone: "var(--q-red)", scene: () => <CodeImageType />, chips: 2 },
  { id: "circuit", tone: "var(--q-yellow)", scene: () => <CircuitType />, chips: 3, wide: true },
  { id: "rich", tone: "var(--q-blue)", scene: () => <RichType />, chips: 3 },
  { id: "categorize", tone: "var(--q-green)", scene: () => <CategorizeType />, chips: 2 },
  { id: "diagram", tone: "var(--q-red)", scene: () => <DiagramType />, chips: 3 },
  { id: "brainstorm", tone: "var(--q-yellow)", scene: () => <BrainstormType />, chips: 2 },
];

function QuestionTypes() {
  const { t } = useI18n();
  const [ref, reveal] = useReveal<HTMLDivElement>();
  return (
    <section id="types" className="scroll-mt-20 py-24">
      <div ref={ref} className={cx("mx-auto max-w-280 px-4 sm:px-8", reveal)}>
        <SectionIntro eyebrow="discover.qt.eyebrow" title="discover.qt.title" body="discover.qt.body" />
        <div className="mt-14 grid gap-4 md:grid-cols-2 lg:grid-cols-3">
          {QTYPES.map((q, i) => (
            <TypeCard key={q.id} type={q} index={i} />
          ))}
        </div>
        <p className="mx-auto mt-10 max-w-2xl text-center text-sm leading-relaxed text-fg-muted">
          {t("discover.qt.footnote")}
        </p>
      </div>
    </section>
  );
}

function TypeCard({ type, index }: { type: (typeof QTYPES)[number]; index: number }) {
  const { t } = useI18n();
  const [ref, reveal] = useReveal<HTMLElement>();
  const k = (s: string) => `discover.qt.${type.id}.${s}` as Key;
  return (
    <article
      ref={ref}
      className={cx(
        "group flex flex-col gap-4 rounded-card border border-line bg-surface p-3 transition-colors hover:border-line-strong",
        type.wide && "lg:col-span-2",
        reveal,
      )}
      style={{ "--delay": `${(index % 3) * 90}ms` } as CSSProperties}
    >
      {type.scene()}
      <div className="px-2 pb-2">
        <h3 className="flex items-center gap-2 text-base font-semibold">
          <span className="size-2.5 rounded-full" style={{ background: type.tone }} />
          {t(k("name"))}
        </h3>
        <p className="mt-1.5 text-sm leading-relaxed text-fg-muted">{t(k("body"))}</p>
        <ul className="mt-3 flex flex-wrap gap-1.5">
          {Array.from({ length: type.chips }, (_, c) => (
            <li key={c} className="rounded-full bg-surface-2 px-2.5 py-0.5 text-[12px] text-fg-muted">
              {t(k(`f${c + 1}`))}
            </li>
          ))}
        </ul>
      </div>
    </article>
  );
}

// --- Core features, as auto-advancing tabs ---------------------------------

const TABS: readonly {
  key: string;
  icon: LucideIcon;
  tone: string;
  scene: () => ReactNode;
}[] = [
  { key: "pool", icon: ListChecks, tone: "var(--q-red)", scene: () => <PoolScene /> },
  { key: "modes", icon: Lock, tone: "var(--q-yellow)", scene: () => <ModesScene /> },
  { key: "live", icon: Radio, tone: "var(--q-blue)", scene: () => <PollScene /> },
  { key: "grading", icon: PenLine, tone: "var(--q-green)", scene: () => <GradingScene /> },
];
const TAB_MS = 9000;

function Features() {
  const { t } = useI18n();
  const [active, setActive] = useState(0);
  // Hovering pauses the rotation for a while; choosing a tab, a key press or
  // focus inside stops it for good (WCAG 2.2.2), and so does reduced motion.
  const [hovered, setHovered] = useState(false);
  const [chosen, setChosen] = useState(prefersReducedMotion);
  const paused = hovered || chosen;
  const [ref, inView] = useInView<HTMLElement>();
  const [revealRef, reveal] = useReveal<HTMLDivElement>();
  const tabs = useRef<(HTMLButtonElement | null)[]>([]);
  const running = inView && !paused;
  useEffect(() => {
    if (!running) return;
    const id = window.setTimeout(() => setActive((a) => (a + 1) % TABS.length), TAB_MS);
    return () => window.clearTimeout(id);
  }, [running, active]);
  const select = useCallback((i: number, focus = false) => {
    setActive(i);
    setChosen(true);
    if (focus) tabs.current[i]?.focus();
  }, []);
  const tab = TABS[active]!;
  const k = (s: string) => `discover.feat.${tab.key}.${s}` as Key;
  return (
    <section id="features" ref={ref} className="scroll-mt-20 py-24">
      <div ref={revealRef} className={cx("mx-auto max-w-280 px-4 sm:px-8", reveal)}>
        <SectionIntro eyebrow="discover.feat.eyebrow" title="discover.feat.title" body="discover.feat.body" />
        <div
          role="tablist"
          aria-label={t("discover.feat.title")}
          className="mt-12 flex gap-1 overflow-x-auto border-b border-line"
          onFocus={() => setChosen(true)}
          onKeyDown={(e) => {
            const next = {
              ArrowRight: (active + 1) % TABS.length,
              ArrowLeft: (active + TABS.length - 1) % TABS.length,
              Home: 0,
              End: TABS.length - 1,
            }[e.key];
            if (next === undefined) return;
            e.preventDefault();
            select(next, true);
          }}
        >
          {TABS.map((x, i) => (
            <button
              key={x.key}
              ref={(el) => {
                tabs.current[i] = el;
              }}
              role="tab"
              type="button"
              id={`feat-tab-${x.key}`}
              aria-selected={i === active}
              aria-controls="feat-panel"
              tabIndex={i === active ? 0 : -1}
              onClick={() => select(i)}
              className={cx(
                "relative flex shrink-0 items-center gap-2 px-4 pt-2 pb-3.5 text-sm font-medium whitespace-nowrap transition-colors",
                i === active ? "text-fg" : "text-fg-faint hover:text-fg-muted",
              )}
            >
              <x.icon className="size-4.5" style={{ color: i === active ? x.tone : undefined }} />
              {t(`discover.feat.${x.key}.tab` as Key)}
              {i === active ? (
                <span className="absolute inset-x-0 -bottom-px h-0.5 bg-line-strong">
                  <span
                    key={`${active}-${paused}`}
                    className={cx("block h-full", running && "tab-progress")}
                    style={{ background: x.tone, "--dur": `${TAB_MS}ms` } as CSSProperties}
                  />
                </span>
              ) : null}
            </button>
          ))}
        </div>
        <div
          id="feat-panel"
          role="tabpanel"
          aria-labelledby={`feat-tab-${tab.key}`}
          className="mt-10 grid items-center gap-10 lg:grid-cols-[1.15fr_1fr]"
          onFocus={() => setChosen(true)}
          onPointerEnter={() => setHovered(true)}
          onPointerLeave={() => setHovered(false)}
        >
          <div key={tab.key} className="pop-in">
            {tab.scene()}
          </div>
          <div key={`${tab.key}-text`} className="space-y-2">
            {(["p1", "p2", "p3"] as const).map((p, i) => (
              <div
                key={p}
                className={cx("slide-in rounded-card p-5", i === 0 ? "bg-surface-2" : "")}
                style={{ "--delay": `${i * 110}ms` } as CSSProperties}
              >
                <h3 className="text-base font-semibold text-fg">{t(k(`${p}.title`))}</h3>
                <p className="mt-1.5 text-sm leading-relaxed text-fg-muted">{t(k(`${p}.body`))}</p>
              </div>
            ))}
          </div>
        </div>
      </div>
    </section>
  );
}

function SectionIntro({ eyebrow, title, body, center = true }: { eyebrow: Key; title: Key; body: Key; center?: boolean }) {
  const { t } = useI18n();
  return (
    <div className={cx("max-w-2xl", center && "mx-auto text-center")}>
      <p className="text-xs font-semibold tracking-[0.14em] text-accent uppercase">{t(eyebrow)}</p>
      <h2 className="mt-3 text-3xl leading-tight font-extrabold tracking-[-0.03em] text-balance sm:text-5xl">{t(title)}</h2>
      <p className="mt-4 text-base leading-relaxed text-fg-muted sm:text-lg">{t(body)}</p>
    </div>
  );
}

// --- Spotlights ------------------------------------------------------------

function Spotlight({
  id,
  eyebrow,
  title,
  body,
  points,
  tone,
  scene,
  flip,
}: {
  id: string;
  eyebrow: Key;
  title: Key;
  body: Key;
  points: readonly Key[];
  tone: string;
  scene: ReactNode;
  flip?: boolean;
}) {
  const { t } = useI18n();
  const [ref, reveal] = useReveal<HTMLDivElement>();
  return (
    <section id={id} className="scroll-mt-20 py-20">
      <div ref={ref} className={cx("mx-auto grid max-w-280 items-center gap-12 px-4 sm:px-8 lg:grid-cols-2", reveal)}>
        <div className={cx(flip && "lg:order-2")}>
          <p className="flex items-center gap-2 text-xs font-semibold tracking-[0.14em] uppercase" style={{ color: tone }}>
            <span className="h-px w-8" style={{ background: tone }} />
            <span className="text-fg-muted">{t(eyebrow)}</span>
          </p>
          <h2 className="mt-4 text-3xl leading-tight font-extrabold tracking-[-0.03em] text-balance sm:text-4xl">{t(title)}</h2>
          <p className="mt-4 text-base leading-relaxed text-fg-muted">{t(body)}</p>
          <ul className="mt-6 space-y-3">
            {points.map((p) => (
              <li key={p} className="flex gap-3 text-sm text-fg">
                <span className="mt-1.5 size-2 shrink-0 rounded-full" style={{ background: tone }} />
                {t(p)}
              </li>
            ))}
          </ul>
        </div>
        <div className="relative">
          <div
            className="absolute -inset-6 -z-10 rounded-[32px] opacity-[var(--glow)] blur-3xl"
            style={{ background: tone }}
          />
          {scene}
        </div>
      </div>
    </section>
  );
}

// --- Security --------------------------------------------------------------

const GUARDS: readonly [string, LucideIcon, string][] = [
  ["seb", Lock, "var(--q-red)"],
  ["kiosk", Laptop, "var(--q-yellow)"],
  ["clock", Clock, "var(--q-blue)"],
  ["answers", EyeOff, "var(--q-green)"],
  ["sandbox", Box, "var(--q-red)"],
  ["identity", KeyRound, "var(--q-blue)"],
];

function Security() {
  const { t } = useI18n();
  const [ref, reveal] = useReveal<HTMLDivElement>();
  return (
    <section id="security" className="scroll-mt-20 border-y border-line bg-surface py-24">
      <div ref={ref} className={cx("mx-auto max-w-280 px-4 sm:px-8", reveal)}>
        <div className="mx-auto mb-4 grid size-12 place-items-center rounded-full bg-accent-soft text-accent">
          <ShieldCheck className="size-6" />
        </div>
        <SectionIntro eyebrow="discover.sec.eyebrow" title="discover.sec.title" body="discover.sec.body" />
        <div className="mt-14 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {GUARDS.map(([key, Icon, tone], i) => (
            <div
              key={key}
              className="sec-card slide-in rounded-card border border-line bg-canvas p-6 transition-colors hover:border-line-strong"
              style={{ "--delay": `${i * 80}ms` } as CSSProperties}
            >
              <span
                className="sec-icon grid size-10 place-items-center rounded-field"
                style={{ background: `color-mix(in srgb, ${tone} 14%, transparent)`, color: tone }}
              >
                <Icon className="size-5" />
              </span>
              <h3 className="mt-4 text-base font-semibold">{t(`discover.sec.${key}.title` as Key)}</h3>
              <p className="mt-1.5 text-sm leading-relaxed text-fg-muted">{t(`discover.sec.${key}.body` as Key)}</p>
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}

// --- The last call, and the footer -----------------------------------------

function FinalCall() {
  const { t } = useI18n();
  const [ref, reveal] = useReveal<HTMLDivElement>();
  return (
    <section className="px-4 py-24 sm:px-8">
      <div
        ref={ref}
        className={cx(
          "relative isolate mx-auto max-w-280 overflow-hidden rounded-[28px] border border-line bg-surface px-6 py-16 text-center sm:px-12",
          reveal,
        )}
      >
        <div className="discover-aurora -z-10 opacity-80">
          <span />
          <span />
          <span />
          <span />
        </div>
        <Logo className="mx-auto w-44" />
        <h2 className="mx-auto mt-8 max-w-2xl text-3xl leading-tight font-extrabold tracking-[-0.03em] text-balance sm:text-5xl">
          {t("discover.cta.title")}
        </h2>
        <p className="mx-auto mt-4 max-w-xl text-base leading-relaxed text-fg-muted">{t("discover.cta.body")}</p>
        <LinkButton href={SIGN_IN} variant="primary" size="lg" className="mt-8 px-7">
          {t("landing.signin")}
        </LinkButton>
      </div>
    </section>
  );
}

function Footer() {
  const { t } = useI18n();
  return (
    <footer className="mx-auto flex max-w-280 flex-col items-center justify-between gap-3 px-4 pb-10 text-xs text-fg-faint sm:flex-row sm:px-8">
      <span>{t("landing.footer")}</span>
      <span>{t("discover.footer.made")}</span>
    </footer>
  );
}
