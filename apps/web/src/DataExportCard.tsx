/**
 * The user Settings' data card (N-DATA-04, ADR-112): one secondary action,
 * the personal data export. A plain link, like the results CSV: the file is
 * a GET the browser follows with the session cookie, and keeps the name the
 * server puts in its `content-disposition`.
 *
 * Shown on the account's own portal session only — the server refuses any
 * other (`ownSessionGuard`): an impersonation (`readOnly` in production, and
 * refused in development too), a `seb` or `kiosk` session.
 */
import { Download, FileJson } from "lucide-react";

import { PERSONAL_DATA_EXPORT_PATH, type Me } from "@quiz/contracts";

import { useT } from "./i18n";
import { Card, LinkButton, SectionHeading, SettingRow } from "./ui";

/** The account's own portal session: what the export route admits. */
export const mayExport = (me: Me): boolean =>
  (me.session?.kind ?? "portal") === "portal" && !me.session?.readOnly;

export function DataExportCard({ me }: { me: Me }) {
  const t = useT();
  if (!mayExport(me)) return null;
  return (
    <section className="space-y-3">
      <SectionHeading icon={FileJson} title={t("settings.data")} />
      <Card className="px-5">
        <SettingRow title={t("settings.dataExport")} desc={t("settings.dataExportHint")}>
          <LinkButton href={PERSONAL_DATA_EXPORT_PATH} download>
            <Download /> {t("settings.dataExportDownload")}
          </LinkButton>
        </SettingRow>
      </Card>
    </section>
  );
}
