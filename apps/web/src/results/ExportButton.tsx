import { Download } from "lucide-react";

import { useT } from "../i18n";
import { LinkButton } from "../ui";
import { gradingLinks } from "../grading";

/**
 * F-RES-02, as a plain link: the CSV is a GET the browser can do on its own,
 * so it goes out as a real navigation carrying the session cookie. No fetch,
 * no blob, no object URL to revoke — and the file keeps the name the server
 * puts in its `content-disposition`.
 */
export function ExportButton({ evaluationId }: { evaluationId: string }) {
  const t = useT();
  return (
    <LinkButton href={gradingLinks(evaluationId).csvPath} download>
      <Download /> {t("results.export")}
    </LinkButton>
  );
}
