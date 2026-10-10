import { prefersReducedMotion } from "@quiz/ui";
import { ExternalLink } from "lucide-react";
import { type CSSProperties, useEffect, useMemo, useState, useSyncExternalStore } from "react";

import { Logo } from "../Header";
import { useI18n } from "../i18n";
import { cx, Modal, Z } from "../ui";
import { createSignal, readStored, removeStored, writeStored } from "../ui/state";
import type { Ambient, FestiveArt } from "./art";
import { FESTIVE, type FestiveId, festiveOn } from "./calendar";
import { LOGO_BOX } from "./logo";

/**
 * The festive touches (ADR-093): on a few days of the year the logo of the
 * frame wears an accessory, a short ambient animation plays once a day, and
 * the accessory opens a sheet about the day. Drawn by the Shell only, so an
 * attempt, a preview, a projection, a confined (`seb`, `kiosk`) session and
 * the signed-out page never get any of it.
 */

export interface Festive {
  id: FestiveId;
  art: FestiveArt;
}

// --- The setting: on unless this browser said no (like the theme) ---

const KEY = "quiz-festive";
/** The day the ambient last played in this browser: once a day, not on every visit of the home. */
const PLAYED_KEY = "quiz-festive-played";
const { subscribe, emit } = createSignal();
const isOn = () => readStored(KEY) !== "off";

export function useFestiveEnabled(): boolean {
  return useSyncExternalStore(subscribe, isOn, isOn);
}

export function setFestiveEnabled(on: boolean) {
  if (on) removeStored(KEY);
  else writeStored(KEY, "off");
  emit();
}

// --- Today's costume ---

/** Today's festive day; in development, the one `?festive=<id>` asks for (screenshots). */
function today(): FestiveId | null {
  if (import.meta.env.DEV) {
    const asked = new URLSearchParams(window.location.search).get("festive");
    const found = FESTIVE.find((f) => f.id === asked);
    if (found) return found.id;
  }
  return festiveOn(new Date());
}

/**
 * Today's festive day with its drawings, once their chunk is in; null on an
 * ordinary day, when switched off, or where the caller wants none (`wanted`).
 */
export function useFestive(wanted = true): Festive | null {
  const on = useFestiveEnabled() && wanted;
  const [id] = useState(today);
  const [art, setArt] = useState<FestiveArt | null>(null);
  useEffect(() => {
    if (!on || !id) return;
    let live = true;
    // A chunk that fails to load (a deploy in between) costs the costume, nothing else.
    import("./art").then(
      (m) => live && setArt(m.ART[id]),
      () => {},
    );
    return () => {
      live = false;
    };
  }, [on, id]);
  return useMemo(() => (on && id && art ? { id, art } : null), [on, id, art]);
}

// --- The info button over the accessory, and its sheet ---

const percent = (value: number, of: number) => `${(value / of) * 100}%`;

/** A Wikipedia article (its title in that language: `festive.<id>.wiki`) in the interface language. */
const wikipediaUrl = (title: string, locale: string) =>
  `https://${locale}.wikipedia.org/wiki/${encodeURIComponent(title.replaceAll(" ", "_"))}`;

/**
 * A button laid exactly over the accessory, BESIDE the home button (never
 * inside it: a button holds no button). The rest of the logo still goes home.
 * Its parent is positioned and has the logo's box.
 */
export function FestiveInfo({ festive }: { festive: Festive }) {
  const { t, locale } = useI18n();
  const [open, setOpen] = useState(false);
  const [x, y, width, height] = festive.art.accessory.box;
  const title = t(`festive.${festive.id}.title`);
  return (
    <>
      <button
        type="button"
        aria-label={t("festive.about", { name: title })}
        title={title}
        onClick={() => setOpen(true)}
        className="absolute rounded-field"
        style={{
          left: percent(x, LOGO_BOX.width),
          top: percent(y, LOGO_BOX.height),
          width: percent(width, LOGO_BOX.width),
          height: percent(height, LOGO_BOX.height),
        }}
      />
      {open ? (
        <Modal title={title} onClose={() => setOpen(false)}>
          <div className="flex justify-center rounded-field bg-surface-2 px-6 pb-5 pt-10">
            <Logo className="w-56" accessory={festive.art.accessory} />
          </div>
          <p className="mt-4 text-fg-muted">{t(`festive.${festive.id}.text`)}</p>
          <a
            href={wikipediaUrl(t(`festive.${festive.id}.wiki`), locale)}
            target="_blank"
            rel="noreferrer"
            className="mt-3 inline-flex items-center gap-1.5 font-medium text-accent hover:underline"
          >
            {t("festive.wikipedia")}
            <ExternalLink className="size-3.5" aria-hidden />
          </a>
        </Modal>
      ) : null}
    </>
  );
}

// --- The ambient layer ---

interface Sprite {
  html: string;
  style: CSSProperties;
}

const rand = (min: number, max: number) => min + Math.random() * (max - min);
const pick = <T,>(xs: readonly T[]) => xs[Math.floor(Math.random() * xs.length)]!;

/** The centre of the logo on screen, where a burst comes out. */
function logoCentre(): { x: number; y: number } {
  for (const el of document.querySelectorAll(".quiz-logo")) {
    const r = el.getBoundingClientRect();
    if (r.width > 0) return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
  }
  return { x: 0, y: 0 };
}

/** The sprites of one run, and when the last has gone (ms): five seconds at most (WCAG 2.2.2). */
function scatter(ambient: Ambient): { sprites: Sprite[]; end: number } {
  const burst = ambient.mode === "burst";
  const origin = burst ? logoCentre() : { x: 0, y: 0 };
  let end = 0;
  const sprites = Array.from({ length: ambient.count }, () => {
    const delay = burst ? rand(0.4, 0.6) : rand(0, 1.2);
    const duration = burst ? rand(2.2, 3.2) : rand(2.8, 3.8);
    end = Math.max(end, delay + duration);
    const style = {
      "--s": `${rand(...ambient.size)}px`,
      "--c": pick(ambient.colors),
      "--d": `${duration}s`,
      "--delay": `${delay}s`,
      "--x": `${ambient.mode === "drift" ? rand(-5, 55) : rand(0, 100)}vw`,
      "--y": `${rand(8, 88)}vh`,
      "--sway": `${rand(8, 26)}px`,
      "--r": `${burst ? rand(-540, 540) : rand(-40, 40)}deg`,
      "--ox": `${origin.x}px`,
      "--oy": `${origin.y}px`,
      "--dx": `${rand(-5, 55)}vw`,
      "--dy": `${rand(-6, 4)}vh`,
    } as CSSProperties;
    return { html: pick(ambient.sprites), style };
  });
  return { sprites, end: end * 1000 };
}

/**
 * Once a day, on a page that may play it (`playable`: the home and the lists,
 * nothing else asking for the reader's attention), the day's sprites cross
 * the screen behind every surface — a burst comes out of the logo over them —
 * and the layer empties. Leaving the page stops it. Under reduced motion it
 * never plays.
 */
export function FestiveAmbient({ playable }: { playable: boolean }) {
  const festive = useFestive();
  const [sprites, setSprites] = useState<Sprite[] | null>(null);
  useEffect(() => {
    if (!festive || !playable || prefersReducedMotion()) return;
    const stamp = `${festive.id} ${new Date().toDateString()}`;
    if (readStored(PLAYED_KEY) === stamp) return;
    writeStored(PLAYED_KEY, stamp);
    const run = scatter(festive.art.ambient);
    setSprites(run.sprites);
    const timer = window.setTimeout(() => setSprites(null), run.end);
    return () => {
      window.clearTimeout(timer);
      setSprites(null);
    };
  }, [festive, playable]);
  if (!festive || !sprites) return null;
  const { mode, motion } = festive.art.ambient;
  return (
    <div aria-hidden className={cx("festive-layer", `festive-${mode}`, mode === "burst" ? Z.festive : Z.festiveBehind)}>
      {sprites.map((sprite, k) => (
        <span key={k} className="festive-sprite" style={sprite.style}>
          <span className={`festive-move-${motion}`} dangerouslySetInnerHTML={{ __html: sprite.html }} />
        </span>
      ))}
    </div>
  );
}
