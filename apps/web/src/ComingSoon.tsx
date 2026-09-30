import { Construction } from "lucide-react";

import { type Dict, useT } from "./i18n";
import type { Navigate } from "./router";
import { Card, EmptyState, PageHeader, ParentLink } from "./ui";

/**
 * The page of a route of the classroom merge whose screen is not built yet
 * (`CLASSROOM_PAGES`, `flags.ts`): the page's name and "coming soon", with the
 * way home as its only link. Replaced route by route — the student's Courses
 * and classroom page (M5-02), the classroom's Settings (M2-07), Journal
 * (M4-04) and Grades (M5-04), the project pages (M3-12) — and deleted with
 * the last of them.
 */
export function ComingSoon({
  title,
  detail,
  navigate,
}: {
  /** The page's name, a key of the dictionary. */
  title: keyof Dict;
  /** What the address named beyond the page, such as a journal path. */
  detail?: string;
  navigate: Navigate;
}) {
  const t = useT();
  return (
    <div className="space-y-6">
      <PageHeader
        eyebrow={<ParentLink onClick={() => navigate({ view: "home" })}>{t("shome.title")}</ParentLink>}
        title={t(title)}
        description={detail}
      />
      <Card className="px-6 py-4">
        <EmptyState icon={Construction} title={t("soon.title")}>
          {t("soon.body")}
        </EmptyState>
      </Card>
    </div>
  );
}
