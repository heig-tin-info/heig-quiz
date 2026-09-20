/**
 * The teacher pressed pause (F-LIVE-11, decision D17).
 *
 * Pausing must actually stop work, so this covers the question: it is not a
 * badge or a disabled field, it is the screen. Nothing is lost — the autosave
 * keeps what was typed and sends it again on `evaluation.state → running` —
 * and the overlay says exactly that, because a student who believes their
 * last sentence vanished will retype it instead of waiting.
 *
 * No action: there is nothing the student can do, and a button that does
 * nothing is worse than no button. It is not a focus trap either: the page
 * behind it is inert and read-only anyway, and trapping focus in a panel with
 * no control is a dead end for a keyboard.
 */
import { PauseCircle } from "lucide-react";

import { useT } from "../i18n";

export function PausedOverlay({ show }: { show: boolean }) {
  const t = useT();
  if (!show) return null;
  return (
    <div
      role="status"
      aria-live="polite"
      className="fixed inset-0 z-40 flex items-center justify-center bg-canvas/85 px-4 backdrop-blur-[2px]"
    >
      <div className="w-full max-w-115 rounded-card border border-line bg-surface px-6 py-8 text-center">
        <PauseCircle className="mx-auto size-8 text-fg-faint" aria-hidden />
        <h2 className="mt-4 text-lg font-bold tracking-tight">{t("player.paused.title")}</h2>
        <p className="mt-2 text-sm leading-relaxed text-fg-muted">{t("player.paused.body")}</p>
      </div>
    </div>
  );
}
