/**
 * The user Settings' data card (N-DATA-04, ADR-112): one secondary action,
 * the personal data export. Fetched rather than followed as a link, so a
 * refusal (the hourly limit, a server error) is a toast, never an error
 * body saved as the file; the file is saved under the server's own name
 * (`personalDataExportFileName`).
 *
 * Shown on a `portal` session only, which is what the server admits
 * (`ownSessionGuard`): an impersonation, a `seb` or a `kiosk` session is
 * another kind, and never sees the card.
 */
import { useMutation } from "@tanstack/react-query";
import { Download, FileJson } from "lucide-react";

import { PERSONAL_DATA_EXPORT_PATH, personalDataExportFileName, type Me, type PersonalDataExport } from "@quiz/contracts";

import { api, apiErrorMessage, refusalCodeOf } from "./api";
import { useT } from "./i18n";
import { useToast } from "./notify";
import { Button, Card, SectionHeading, SettingRow } from "./ui";

/** The account's own portal session: what the export route admits. */
const mayExport = (me: Me): boolean => (me.session?.kind ?? "portal") === "portal";

/** Hands the file to the browser's downloads, as the server names it. */
function save(file: PersonalDataExport) {
  const url = URL.createObjectURL(new Blob([JSON.stringify(file, null, 2)], { type: "application/json" }));
  const link = document.createElement("a");
  link.href = url;
  link.download = personalDataExportFileName(file.generatedAt);
  link.click();
  URL.revokeObjectURL(url);
}

export function DataExportCard({ me }: { me: Me }) {
  const t = useT();
  const toast = useToast();
  const download = useMutation({
    mutationFn: () => api<PersonalDataExport>(PERSONAL_DATA_EXPORT_PATH),
    onSuccess: save,
    onError: (error) =>
      toast(
        refusalCodeOf(error) === "rate_limited"
          ? t("settings.dataExportLimited")
          : apiErrorMessage(error, t("settings.dataExportFailed")),
        "error",
      ),
  });
  if (!mayExport(me)) return null;
  return (
    <section className="space-y-3">
      <SectionHeading icon={FileJson} title={t("settings.data")} />
      <Card className="px-5">
        <SettingRow title={t("settings.dataExport")} desc={t("settings.dataExportHint")}>
          <Button variant="secondary" loading={download.isPending} onClick={() => download.mutate()}>
            <Download /> {t("settings.dataExportDownload")}
          </Button>
        </SettingRow>
      </Card>
    </section>
  );
}
