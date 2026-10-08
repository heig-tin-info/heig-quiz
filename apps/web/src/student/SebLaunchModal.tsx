/**
 * Issue #270: the steps before a Safe Exam Browser exam (install, download,
 * open), and the one-time `.seb` of ADR-027 from the one primary action — an
 * evaluation's, or an `online_seb` project's workspace (D21, M6-07), whose
 * file opens the project's page in SEB, without a second sign-in.
 * "5 minutes" in its strings is `LAUNCH_TICKET_TTL_MS` (`auth/launch.ts`).
 *
 * An exam's conditions are drawn here too (ADR-079 §7): SEB may begin the
 * attempt directly (ADR-076 §4), so this dialog is the last place to read them
 * before the clock. They can run to twenty lines, so they never push the
 * steps out of sight: from `lg` the dialog is a reading one (`xl`, DESIGN.md)
 * with the steps in a left column that stays put while the conditions scroll
 * beside them; narrower, the steps come first and the conditions follow under
 * their heading. The footer, and its one primary action, stays in view, a
 * phone included.
 */
import type { EvaluationConditions } from "@quiz/contracts";

import { useId } from "react";

import { useT } from "../i18n";
import { Button, Modal } from "../ui";
import { ConditionsList } from "./ConditionsList";

/** SEB's official download page (Windows, macOS, iOS). */
export const SEB_DOWNLOAD_URL = "https://safeexambrowser.org/download_en.html";

/** The strings that differ between an exam's file and a workspace's. */
const COPY = {
  exam: { title: "seb.launch.title", file: "seb.launch.file", openBody: "seb.launch.open.body", download: "seb.launch.download" },
  workspace: {
    title: "seb.workspace.title",
    file: "seb.workspace.file",
    openBody: "seb.workspace.open.body",
    download: "seb.workspace.download",
  },
} as const;

export function SebLaunchModal({
  href,
  title,
  kind = "exam",
  conditions = null,
  onClose,
}: {
  /** The `.seb` download: `/app/api/evaluations/:id/seb` or `projectSebPath(id)`. */
  href: string;
  title: string;
  kind?: keyof typeof COPY;
  /** The exam's conditions, from its card; `null` (a workspace) shows none. */
  conditions?: EvaluationConditions | null;
  onClose: () => void;
}) {
  const t = useT();
  const conditionsId = useId();
  const copy = COPY[kind];
  const download = () => {
    window.location.assign(href);
    onClose();
  };
  return (
    <Modal
      title={t(copy.title)}
      subtitle={title}
      size={conditions ? "xl" : "md"}
      scroll
      onClose={onClose}
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            {t("common.cancel")}
          </Button>
          <Button onClick={download}>{t(copy.download)}</Button>
        </>
      }
    >
      <div className={conditions ? "lg:grid lg:grid-cols-[minmax(0,5fr)_minmax(0,6fr)] lg:gap-6" : undefined}>
        <div className="lg:sticky lg:top-0 lg:self-start">
          <ol className="list-decimal space-y-3 pl-5 text-sm text-fg-muted marker:font-semibold marker:text-fg">
            <li>
              <span className="font-medium text-fg">{t("seb.launch.install")}</span>{" "}
              {t("seb.launch.install.body")}{" "}
              <a
                href={SEB_DOWNLOAD_URL}
                target="_blank"
                rel="noreferrer"
                className="text-accent hover:underline"
              >
                safeexambrowser.org
              </a>
            </li>
            <li>
              <span className="font-medium text-fg">{t(copy.file)}</span>{" "}
              {t("seb.launch.file.body")}
            </li>
            <li>
              <span className="font-medium text-fg">{t("seb.launch.open")}</span>{" "}
              {t(copy.openBody)}
            </li>
          </ol>
          <p className="mt-4 text-[13px] text-fg-faint">{t("seb.launch.expired")}</p>
        </div>
        {conditions ? (
          <section aria-labelledby={conditionsId} className="mt-6 lg:mt-0">
            <p id={conditionsId} className="mb-2 text-sm font-semibold">
              {t("conditions.title")}
            </p>
            <ConditionsList conditions={conditions} />
          </section>
        ) : null}
      </div>
    </Modal>
  );
}
