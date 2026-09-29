import { useQuery } from "@tanstack/react-query";
import { CopyPlus, FileStack, Settings2, Unlink } from "lucide-react";

import { TemplatePatch, type TemplateDetail } from "@quiz/contracts";

import { api, ApiError } from "../api";
import { useCourses } from "../course/parts";
import { useT } from "../i18n";
import { useErrorToast, useToast } from "../notify";
import { templateKey } from "../queryKeys";
import type { Route } from "../router";
import { useSearchParam } from "../router";
import {
  Actions,
  Alert,
  Badge,
  Button,
  EditableTitle,
  EmptyState,
  FormError,
  isoDateTime,
  PageError,
  PageHeader,
  PageSkeleton,
  ParentLink,
  SectionHeading,
  TabPanel,
  Tabs,
  Tip,
} from "../ui";
import { templateTarget } from "./editTarget";
import { ItemsStep } from "./ItemsStep";
import { presetSettings } from "./presets";
import { presetSummary } from "./presetSummary";
import { ConfigSettings } from "./TimingStep";
import { UseTemplateDialog, useTemplateActions } from "./templates";
import { useConfigPatch } from "./usePatch";

/**
 * The editor of one evaluation template (F-EVAL-25, ADR-031 addendum c): its
 * title, its questions and its settings, changed in place through the
 * template's own routes.
 *
 * It is a thin page over the evaluation editor's own blocks — `ItemsStep`
 * with its picker and preview, `ConfigSettings` with its presets, retakes
 * and advanced options — handed a `templateTarget` instead of an
 * evaluation's. What a run has and a template does not is simply not
 * passed: no dates (a sentence stands in their place), no access code, no
 * IP list, no launch step, no dashboard, no roster, no duplicate, no staff
 * attempt. The mode is a badge, set at creation; the revision sits beside
 * it, since that number is what a classroom's copy is compared with.
 *
 * Two tabs and not the evaluation's three steps: there is nothing to launch,
 * so there is no way forward to walk, only two things to shape.
 *
 * The ONE primary action is "Use in a classroom": a template exists to
 * become an evaluation, and that is where an edit session ends. Adding
 * questions is the Questions section's own action, one step down — except
 * while the template holds none, where "Use in a classroom" would copy an
 * empty paper: then it is absent, and "Add questions" in the empty list is
 * the primary, as on a new evaluation.
 */
export function TemplateEditor({ id, navigate }: { id: string; navigate: (r: Route) => void }) {
  const t = useT();
  const detail = useQuery<TemplateDetail>({
    queryKey: templateKey(id),
    queryFn: () => api(`/app/api/templates/${id}`),
  });

  if (detail.isLoading) return <PageSkeleton header="title-and-bar" />;
  if (detail.error instanceof ApiError && detail.error.status === 404) {
    return (
      <EmptyState
        icon={FileStack}
        titleAs="h1"
        title={t("templates.notFound")}
        action={
          <Button variant="secondary" onClick={() => navigate({ view: "home" })}>
            {t("courses.backToList")}
          </Button>
        }
      />
    );
  }
  if (detail.isError || !detail.data) {
    return (
      <PageError
        title={t("templates.editor")}
        error={detail.error}
        onRetry={() => void detail.refetch()}
        retrying={detail.isFetching}
        fallback={t("error.server")}
      />
    );
  }
  return <Editor data={detail.data} navigate={navigate} />;
}

const TABS = ["questions", "settings"] as const;
type Tab = (typeof TABS)[number];
const isTab = (v: string): v is Tab => (TABS as readonly string[]).includes(v);

function Editor({ data, navigate }: { data: TemplateDetail; navigate: (r: Route) => void }) {
  const t = useT();
  const toast = useToast();
  const toastError = useErrorToast();
  const { template } = data;
  const [rawTab, setTab] = useSearchParam("tab", "questions");
  const tab: Tab = isTab(rawTab) ? rawTab : "questions";

  const course = useCourses().data?.find((c) => c.id === template.courseId) ?? null;
  const classrooms = course?.classrooms ?? [];
  const target = templateTarget(template.id, template.courseId);
  const patch = useConfigPatch(target);
  const actions = useTemplateActions(template.courseId, classrooms, {
    onDeleted: () => navigate({ view: "course", id: template.courseId }),
  });
  const toCourse = () => navigate({ view: "course", id: template.courseId });

  // The same schema the route validates: a title trimmed to nothing never
  // leaves the browser. A title alone does not move the revision.
  const rename = (title: string) => {
    const parsed = TemplatePatch.safeParse({ title });
    if (!parsed.success) return;
    patch.mutate(parsed.data, {
      onSuccess: () => toast(t("sync.saved"), "success"),
      onError: toastError("eval.saveFailed"),
    });
  };

  const unlinked = data.items.filter((i) => i.poolUnlinked).length;
  const filled = data.items.length > 0;

  return (
    <div className="space-y-6">
      <PageHeader
        help="courses"
        eyebrow={
          <ParentLink onClick={toCourse}>
            {course ? `${course.code} — ${course.name}` : t("templates.title")}
          </ParentLink>
        }
        title={
          <span className="flex flex-wrap items-baseline gap-3">
            <EditableTitle
              value={template.title}
              onSave={rename}
              editLabel={t("templates.rename.of", { title: template.title })}
              inputLabel={t("eval.titleLabel")}
            />
            <Badge tone="zinc">{t(`eval.mode.${template.mode}`)}</Badge>
            <Tip label={t("templates.revision.hint")}>
              <span className="text-sm font-normal tabular-nums text-fg-muted">
                {t("templates.revision", { n: template.revision })}
              </span>
            </Tip>
          </span>
        }
        actions={
          <>
            {filled && actions.canUse ? (
              <Button onClick={() => actions.use(template)}>
                <CopyPlus /> {t("templates.use")}
              </Button>
            ) : null}
            <Actions label={t("common.actions")} items={[actions.deleteItem(template)]} />
          </>
        }
      />

      <Tabs
        value={tab}
        onChange={(v) => setTab(v)}
        label={t("templates.editor")}
        idPrefix="template-tab"
        items={[
          { value: "questions", label: t("eval.step.questions"), count: data.items.length },
          { value: "settings", label: t("templates.settings") },
        ]}
      />

      <TabPanel idPrefix="template-tab" value={tab}>
        {tab === "questions" ? (
          <ItemsStep
            target={target}
            detail={data}
            // A template has no attempt and is never opened: nothing freezes it.
            lock={null}
            navigate={navigate}
            addVariant={filled ? "secondary" : "primary"}
            notices={
              unlinked > 0 ? (
                <Alert
                  tone="warning"
                  icon={Unlink}
                  title={
                    unlinked === 1
                      ? t("templates.unlinkedCount.one")
                      : t("templates.unlinkedCount", { n: unlinked })
                  }
                  action={
                    <Button size="sm" variant="secondary" onClick={toCourse}>
                      {t("templates.openCourse")}
                    </Button>
                  }
                >
                  {t("templates.unlinkedCount.body")}
                </Alert>
              ) : null
            }
          />
        ) : (
          <div className="space-y-5">
            <SectionHeading
              icon={Settings2}
              title={t("templates.settings")}
              description={t("templates.settings.desc")}
            />
            <FormError error={patch.error} title={t("eval.saveFailed")} />
            <ConfigSettings
              config={template}
              totalPoints={data.totalPoints}
              patch={patch}
              presetOf={(preset) => presetSettings(preset, template.mode)}
              summary={presetSummary(template, t, isoDateTime)}
              holdsCategorize={data.items.some((i) => i.type === "categorize")}
              dates={
                <p className="self-center text-[13px] text-fg-muted">{t("templates.datesLater")}</p>
              }
            />
          </div>
        )}
      </TabPanel>

      {actions.using ? (
        <UseTemplateDialog
          template={actions.using}
          classrooms={classrooms}
          onClose={actions.closeUse}
          navigate={navigate}
        />
      ) : null}
    </div>
  );
}
