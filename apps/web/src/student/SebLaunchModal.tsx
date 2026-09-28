/**
 * Issue #270: the steps before a Safe Exam Browser exam (install, download,
 * open), and the one-time `.seb` of ADR-027 from the one primary action.
 * "5 minutes" in its strings is `LAUNCH_TICKET_TTL_MS` (`auth/launch.ts`).
 */
import { useT } from "../i18n";
import { Button, Modal } from "../ui";

/** SEB's official download page (Windows, macOS, iOS). */
export const SEB_DOWNLOAD_URL = "https://safeexambrowser.org/download_en.html";

export function SebLaunchModal({
  evaluationId,
  title,
  onClose,
}: {
  evaluationId: string;
  title: string;
  onClose: () => void;
}) {
  const t = useT();
  const download = () => {
    window.location.assign(`/app/api/evaluations/${evaluationId}/seb`);
    onClose();
  };
  return (
    <Modal
      title={t("seb.launch.title")}
      subtitle={title}
      onClose={onClose}
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            {t("common.cancel")}
          </Button>
          <Button onClick={download}>{t("seb.launch.download")}</Button>
        </>
      }
    >
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
          <span className="font-medium text-fg">{t("seb.launch.file")}</span>{" "}
          {t("seb.launch.file.body")}
        </li>
        <li>
          <span className="font-medium text-fg">{t("seb.launch.open")}</span>{" "}
          {t("seb.launch.open.body")}
        </li>
      </ol>
      <p className="mt-4 text-[13px] text-fg-faint">{t("seb.launch.expired")}</p>
    </Modal>
  );
}
