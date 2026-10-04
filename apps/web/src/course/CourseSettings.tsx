/**
 * The course page's Settings tab (F-ORG-12), in settings rows (DESIGN.md,
 * "Settings row"), the classroom's Settings tab's twin (F-ORG-13): what the
 * header's menu held — hiding (F-ORG-11), deletion (F-ORG-09) — and the name
 * and the code, which the header shows and no longer edits.
 *
 * Nothing here is accented: a settings tab has no primary. Delete is a
 * `danger-quiet` button whose confirmation is the `danger` one, as the
 * classroom's. The actions are `useCourseActions`', the card's own copy, so
 * the two readings of a course cannot drift.
 *
 * The name, the code and the deletion are an owner's (ADR-068): an assistant
 * sees only their own navigation's row, and one line saying why the rest is
 * not there — no disabled buttons, as a pool's read-only screens.
 */
import { Eye, EyeOff, Library, Trash2 } from "lucide-react";
import { useState } from "react";

import type { CourseSummary } from "@quiz/contracts";

import { useT } from "../i18n";
import { Button, Card, SectionHeading, SettingRow } from "../ui";
import { EditCourseModal } from "./modals";
import type { useCourseActions } from "./useCourseActions";

export function CourseSettings({
  course,
  actions,
}: {
  course: CourseSummary;
  actions: ReturnType<typeof useCourseActions>;
}) {
  const t = useT();
  const [editing, setEditing] = useState(false);
  const { isOwner } = actions;
  return (
    <div className="max-w-3xl space-y-8">
      <section className="space-y-3">
        <SectionHeading icon={Library} title={t("courses.settings.general")} />
        <Card className="divide-y divide-line px-5">
          {isOwner ? (
            <SettingRow title={t("courses.settings.identity")} desc={`${course.code} — ${course.name}`}>
              <Button variant="secondary" onClick={() => setEditing(true)}>
                {t("courses.settings.edit")}
              </Button>
            </SettingRow>
          ) : null}
          {/* Per user (ADR-032): what the caller's own navigation shows. */}
          <SettingRow
            title={t("courses.settings.visibility")}
            desc={t(course.hidden ? "courses.settings.hiddenDesc" : "courses.settings.shownDesc")}
          >
            <Button
              variant="secondary"
              loading={actions.hiding}
              onClick={() => actions.setHidden(!course.hidden)}
            >
              {course.hidden ? (
                <>
                  <Eye /> {t("courses.unhide")}
                </>
              ) : (
                <>
                  <EyeOff /> {t("courses.hide")}
                </>
              )}
            </Button>
          </SettingRow>
        </Card>
        {isOwner ? null : <p className="text-[13px] text-fg-muted">{t("courses.settings.ownerOnly")}</p>}
      </section>

      {isOwner ? (
        <section className="space-y-3">
          <SectionHeading title={t("courses.settings.lifecycle")} />
          <Card className="divide-y divide-line px-5">
            <SettingRow title={t("courses.delete")} desc={t("courses.settings.deleteDesc")}>
              <Button variant="danger-quiet" loading={actions.removing} onClick={() => void actions.remove()}>
                <Trash2 /> {t("courses.delete")}
              </Button>
            </SettingRow>
          </Card>
        </section>
      ) : null}

      {editing ? <EditCourseModal course={course} onClose={() => setEditing(false)} /> : null}
    </div>
  );
}
