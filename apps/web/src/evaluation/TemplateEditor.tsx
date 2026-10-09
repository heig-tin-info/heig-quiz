import { CopyPlus, FileStack, Settings2, Unlink } from "lucide-react";
import type { ReactNode } from "react";

import { TemplatePatch, type TemplateDetail } from "@quiz/contracts";
import { modeChangeable, TEMPLATE_TABS, type CourseTab } from "@quiz/domain";

import { isNotFound } from "../api";
import { useCourses } from "../course/parts";
import { useT } from "../i18n";
import { useErrorToast, useToast } from "../notify";
import type { Route } from "../router";
import { Trail, useTemplateCrumbs } from "../Trail";
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
  pageBox,
  SectionHeading,
  TabPanel,
  Tabs,
  Tip,
} from "../ui";
import { templateTarget } from "./editTarget";
import { useItemPane } from "./ItemPreview";
import { ItemsStep } from "./ItemsStep";
import { clockSummary } from "./clockSummary";
import { ModeControl } from "./ModeChoice";
import { ConfigSettings } from "./TimingStep";
import { UseTemplateDialog, useTemplateActions } from "./templates";
import { useConfigPatch } from "./usePatch";
import { useTemplate } from "./api";

/**
 * The editor of one evaluation template (F-EVAL-25, ADR-031 addendum c): its
 * title, its questions and its settings, changed in place through the
 * template's own routes.
 *
 * It is a thin page over the evaluation editor's own blocks — `ItemsStep`
 * with its picker and preview, `ConfigSettings` with its clock mode, retakes
 * and advanced options — handed a `templateTarget` instead of an
 * evaluation's. What a run has and a template does not is simply not passed:
 * no dates (a sentence stands in their place), no IP list, no launch step,
 * no dashboard, no roster, no duplicate, no staff attempt. The mode is a
 * badge beside the title and a control in the settings (ADR-092, a template
 * may always change it); the revision sits beside it, since that number is
 * what a classroom's copy is compared with.
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
 *
 * A wide route (`WIDE` in App.tsx) that draws its own box (`pageBox`), so
 * that the preview docked beside the question list widens the page by its
 * own width instead of squeezing the list.
 */
export function TemplateEditor({ id, navigate }: { id: string; navigate: (r: Route) => void }) {
  const t = useT();
  const detail = useTemplate(id);

  if (detail.isLoading) return boxed(<PageSkeleton header="title-and-bar" />);
  if (isNotFound(detail.error)) {
    return boxed(
      <EmptyState
        icon={FileStack}
        titleAs="h1"
        title={t("templates.notFound")}
        action={
          <Button variant="secondary" onClick={() => navigate({ view: "home" })}>
            {t("courses.backToList")}
          </Button>
        }
      />,
    );
  }
  if (detail.isError || !detail.data) {
    return boxed(
      <PageError title={t("templates.editor")} query={detail} />,
    );
  }
  return <Editor data={detail.data} navigate={navigate} />;
}

const boxed = (node: ReactNode) => <div style={pageBox(null)}>{node}</div>;

type Tab = (typeof TEMPLATE_TABS)[number];
const isTab = (v: string): v is Tab => (TEMPLATE_TABS as readonly string[]).includes(v);

function Editor({ data, navigate }: { data: TemplateDetail; navigate: (r: Route) => void }) {
  const t = useT();
  const toast = useToast();
  const toastError = useErrorToast();
  const { template } = data;
  const [rawTab, setTab] = useSearchParam("tab", "questions");
  const tab: Tab = isTab(rawTab) ? rawTab : "questions";

  const crumbs = useTemplateCrumbs(template.courseId, template.id, template.title);
  const course = useCourses().data?.find((c) => c.id === template.courseId) ?? null;
  const classrooms = course?.classrooms ?? [];
  const target = templateTarget(template.id, template.courseId);
  const patch = useConfigPatch(target);
  const actions = useTemplateActions(template.courseId, classrooms, {
    onDeleted: () => navigate({ view: "course", id: template.courseId, tab: "templates" }),
  });
  // Up to the course's Templates tab, where this template is a row; its pools
  // are relinked on the Linked pools tab.
  const toCourse = (tab: CourseTab = "templates") =>
    navigate({ view: "course", id: template.courseId, tab });

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

  const pane = useItemPane();
  const unlinked = data.items.filter((i) => i.poolUnlinked).length;
  const filled = data.items.length > 0;

  return (
    <div className="w-full space-y-6" style={pane.box(tab === "questions")}>
      <PageHeader
        help="courses"
        eyebrow={
          <Trail navigate={navigate} items={crumbs} />
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
          filled && actions.canUse ? (
            <Button onClick={() => actions.use(template)}>
              <CopyPlus /> {t("templates.use")}
            </Button>
          ) : null
        }
        menu={<Actions label={t("common.actions")} items={[actions.deleteItem(template)]} />}
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
            pane={pane}
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
                    <Button size="sm" variant="secondary" onClick={() => toCourse("pools")}>
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
              actions={<ModeControl config={template} changeable={modeChangeable(template.mode, "draft", 0)} patch={patch} />}
            />
            <FormError error={patch.error} title={t("eval.saveFailed")} />
            <ConfigSettings
              config={template}
              courseId={template.courseId}
              patch={patch}
              summary={clockSummary(template, t, isoDateTime)}
              holdsCategorize={data.items.some((i) => i.type === "categorize")}
              dates={() => (
                <p className="self-center text-[13px] text-fg-muted">{t("templates.datesLater")}</p>
              )}
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
