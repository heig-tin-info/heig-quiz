import { ChevronRight, Eye } from "lucide-react";
import { useState } from "react";

import { evaluationConditionsOf, type EvaluationDetail } from "@quiz/contracts";

import { useT } from "../i18n";
import { LobbyScreen, type LobbyScreenView } from "../student/Lobby";
import { Card, Sheet } from "../ui";

/*
 * What the class will see once the room opens (#152, variant C's preview,
 * ADR-018 addendum): the student's own `LobbyScreen`, drawn from the
 * configuration the page already holds. It is the PURE half of the lobby —
 * mounting the connected one would open the `lobby:` stream, and a teacher
 * with a staff seat would then be counted present in the real room. Nobody
 * is present yet, so the ring reads 0 out of the roster; no question content
 * is involved, only the conditions the waiting room states (ADR-079).
 */

/** The waiting room's view of this evaluation, as the server builds it (`lobbyView`). */
export function lobbyPreviewView(detail: EvaluationDetail): LobbyScreenView {
  const { evaluation } = detail;
  return {
    evaluation: {
      id: evaluation.id,
      title: evaluation.title,
      state: "lobby",
      announcedDurationS: evaluation.durationS,
    },
    // ADR-079: the same builder the server uses, for a student with no extra time.
    conditions: evaluationConditionsOf({ ...evaluation, timeBonusPercent: 0 }),
  };
}

function Preview({ detail }: { detail: EvaluationDetail }) {
  return (
    <LobbyScreen view={lobbyPreviewView(detail)} present={0} enrolled={detail.roster?.enrolled ?? 0} compact />
  );
}

/** Desktop: a side column, a framed miniature of the student's page. */
export function LobbyPreviewColumn({ detail }: { detail: EvaluationDetail }) {
  const t = useT();
  return (
    <aside aria-label={t("launch.preview.title")} className="sticky top-6">
      <p className="mb-2 flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wide text-fg-faint">
        <Eye className="size-3.5" aria-hidden /> {t("launch.preview.title")}
      </p>
      <div className="rounded-card border border-line bg-canvas">
        <Preview detail={detail} />
      </div>
      <p className="mt-2 text-center text-xs text-fg-faint">{t("launch.preview.caption")}</p>
    </aside>
  );
}

/** Phone: one row that opens the same picture in a sheet. */
export function LobbyPreviewRow({ detail }: { detail: EvaluationDetail }) {
  const t = useT();
  const [open, setOpen] = useState(false);
  return (
    <>
      <Card className="overflow-hidden">
        <button
          type="button"
          onClick={() => setOpen(true)}
          className="flex w-full items-center gap-3 px-4 py-3.5 text-left transition-colors hover:bg-surface-2"
        >
          <Eye className="size-4.5 shrink-0 text-fg-faint" aria-hidden />
          <span className="min-w-0 flex-1">
            <span className="block text-sm font-semibold">{t("launch.preview.title")}</span>
            <span className="mt-0.5 block text-[13px] text-fg-muted">{t("launch.preview.row")}</span>
          </span>
          <ChevronRight className="size-4 shrink-0 text-fg-faint" aria-hidden />
        </button>
      </Card>
      {open ? (
        <Sheet title={t("launch.preview.title")} subtitle={t("launch.preview.caption")} onClose={() => setOpen(false)} flush>
          <div className="min-h-full bg-canvas">
            <Preview detail={detail} />
          </div>
        </Sheet>
      ) : null}
    </>
  );
}
