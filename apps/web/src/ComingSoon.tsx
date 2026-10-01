import { Construction } from "lucide-react";

import { type Dict, useT } from "./i18n";
import type { Navigate } from "./router";
import { homeLook } from "./student/BottomNav";
import { Card, EmptyState, PageHeader, ParentLink } from "./ui";

/**
 * The page of a route of the classroom merge whose screen is not built yet
 * (`CLASSROOM_PAGES`, `router.ts`): the page's name and "coming soon", with the
 * way home as its only link. Replaced route by route — the classroom's
 * Settings (M2-07) and Grades (M5-04), the project pages (M3-12) — and
 * deleted with the last of them.
 */
export function ComingSoon({
  title,
  navigate,
  teacherUi,
}: {
  /** The page's name, a key of the dictionary. */
  title: keyof Dict;
  navigate: Navigate;
  /** The home is named as the sidebar names it: Courses, or a student's Activities. */
  teacherUi: boolean;
}) {
  const t = useT();
  const home = t(homeLook(teacherUi).label);
  return (
    <div className="space-y-6">
      <PageHeader
        eyebrow={<ParentLink onClick={() => navigate({ view: "home" })}>{home}</ParentLink>}
        title={t(title)}
      />
      <Card className="px-6 py-4">
        <EmptyState icon={Construction} title={t("soon.title")}>
          {t("soon.body")}
        </EmptyState>
      </Card>
    </div>
  );
}
