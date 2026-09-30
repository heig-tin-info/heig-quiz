import { CloudOff, MonitorX } from "lucide-react";

import type { KioskDeviceAuthorization } from "@quiz/contracts";

import { usePublicConfig } from "../api";
import { Logo } from "../Header";
import { useT } from "../i18n";
import { PollQr } from "../poll/PollQr";
import { Spinner, useNow } from "../ui";
import { useKioskStation } from "./useKioskStation";

/**
 * `/kiosk` — a school Chromebook locked in a web kiosk (ADR-051, F-EVAL-28).
 * Nobody signs in here and nothing is clicked: the station attests itself,
 * then shows ONE thing, its code, with the QR of the phone's page beside it
 * and its own name above, read from two metres (DESIGN.md, "The kiosk
 * station"). A phone approves; the station opens the exam by itself.
 *
 * Drawn before the session gate (App.tsx): it never waits on `/me`.
 */
export function KioskPage() {
  const config = usePublicConfig();
  const phase = useKioskStation(config.data?.kiosk ?? null, !config.isLoading);
  const t = useT();

  return (
    <main className="flex min-h-dvh flex-col bg-canvas px-6 py-6 sm:px-12 sm:py-8">
      <header className="flex items-center justify-between gap-4">
        <Logo className="w-28" />
        <p className="text-[clamp(15px,1.3vw,18px)] text-fg-muted">{t("kiosk.title")}</p>
      </header>
      <div className="flex flex-1 flex-col items-center justify-center py-8 text-center">
        {phase.kind === "code" ? (
          <CodeScreen auth={phase.auth} expiresAt={phase.expiresAt} />
        ) : phase.kind === "not_recognised" || phase.kind === "unavailable" ? (
          <Trouble kind={phase.kind} />
        ) : (
          <Spinner
            label={t(phase.kind === "opening" ? "kiosk.opening" : "kiosk.starting")}
            className="py-24 [&_p]:text-[clamp(18px,1.6vw,24px)] [&_svg]:size-8"
          />
        )}
      </div>
    </main>
  );
}

/** `m:ss` until `at`, never below zero. */
function Countdown({ at }: { at: number }) {
  const t = useT();
  const now = useNow(1_000);
  const left = Math.max(0, Math.ceil((at - now) / 1000));
  const time = `${Math.floor(left / 60)}:${String(left % 60).padStart(2, "0")}`;
  return (
    <p className="text-[clamp(16px,1.4vw,20px)] text-fg-muted tabular-nums">
      {t("kiosk.expires", { time })}
    </p>
  );
}

function CodeScreen({ auth, expiresAt }: { auth: KioskDeviceAuthorization; expiresAt: number }) {
  const t = useT();
  // What a student types in a browser: the address without its scheme.
  const address = auth.verification_uri.replace(/^https?:\/\//, "");
  return (
    <div className="flex w-full max-w-5xl flex-col items-center gap-[clamp(20px,4vh,40px)]">
      <h1 className="text-[clamp(28px,3.4vw,48px)] leading-tight font-bold tracking-[-0.02em]">
        {auth.label}
      </h1>
      <div className="flex flex-col items-center gap-[clamp(24px,3vw,48px)] rounded-sheet border border-line bg-surface px-[clamp(24px,4vw,56px)] py-[clamp(24px,3vw,40px)] sm:flex-row">
        <PollQr
          value={auth.verification_uri_complete}
          label={t("kiosk.qr", { code: auth.user_code })}
          className="!size-[clamp(160px,20vw,280px)] !p-3"
        />
        <div className="flex flex-col items-center gap-3 sm:items-start">
          <p className="text-[clamp(14px,1.2vw,18px)] font-medium tracking-wide text-fg-muted uppercase">
            {t("kiosk.code")}
          </p>
          <p className="font-mono text-[clamp(56px,7.5vw,112px)] leading-none font-bold tracking-[0.04em] whitespace-nowrap">
            {auth.user_code}
          </p>
          <Countdown at={expiresAt} />
        </div>
      </div>
      <ol className="max-w-3xl list-decimal space-y-2 pl-8 text-left text-[clamp(17px,1.5vw,22px)] leading-snug text-fg-muted marker:font-bold marker:text-fg">
        <li>{t("kiosk.step.scan", { url: address })}</li>
        <li>{t("kiosk.step.check")}</li>
      </ol>
    </div>
  );
}

/** No code to show: the station is not a named one, or the platform cannot be reached. It tries again by itself. */
function Trouble({ kind }: { kind: "not_recognised" | "unavailable" }) {
  const t = useT();
  const Icon = kind === "not_recognised" ? MonitorX : CloudOff;
  return (
    <div role="alert" className="flex max-w-2xl flex-col items-center gap-4">
      <Icon className="size-14 text-fg-faint" aria-hidden />
      <h1 className="text-[clamp(28px,3.4vw,48px)] leading-tight font-bold tracking-[-0.02em]">
        {t(kind === "not_recognised" ? "kiosk.notRecognised.title" : "kiosk.unavailable.title")}
      </h1>
      <p className="text-[clamp(18px,1.8vw,26px)] text-fg-muted">
        {t(kind === "not_recognised" ? "kiosk.notRecognised.body" : "kiosk.unavailable.body")}
      </p>
    </div>
  );
}
