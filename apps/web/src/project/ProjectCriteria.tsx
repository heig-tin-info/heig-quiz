import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { AlertTriangle, RefreshCw } from "lucide-react";
import { useState } from "react";

import {
  CriteriaInvalid,
  PROJECT_CRITERIA_DEFAULTS,
  ProjectPatch,
  type CriteriaError,
  type CriteriaErrorCode,
  type CriterionKind,
  type ProjectCriteriaView,
  type ProjectDetail,
} from "@quiz/contracts";

import { api, ApiError, refusedWith } from "../api";
import { useConfirm } from "../confirm";
import { useT, type Dict } from "../i18n";
import { useToast } from "../notify";
import { projectCriteriaKey, projectKey } from "../queryKeys";
import { Alert, Badge, Button, cx, FieldError, QueryError, Select, SettingRow, Skeleton, T, TableHead, TextInput, type Tone } from "../ui";
import { refusalMessage, type WriteProject } from "./projectPage";

/*
 * Grading by criteria (ADR-106 §2), for the project's staff: the mode
 * switch's refusal, the evidence settings, and the snapshot of the source's
 * `criteria.yml` — read only, reloaded from the distribution repository by a
 * secondary button. Rows only: the caller's settings card holds them.
 */

/** The errors of a refused switch or reload (`409 criteria_invalid`), or null for any other failure. */
export function criteriaErrorsOf(error: unknown): CriteriaError[] | null {
  if (!(error instanceof ApiError) || !refusedWith(error, "criteria_invalid")) return null;
  const body = CriteriaInvalid.safeParse(error.body);
  return body.success ? body.data.errors : [];
}

/** Why `criteria.yml` was refused, one line per error — its path, then its code worded — under the field that asked. */
export function CriteriaErrors({ errors }: { errors: CriteriaError[] | null }) {
  const t = useT();
  if (errors === null) return null;
  return (
    <div className="pb-3">
      <Alert tone="danger" icon={AlertTriangle} title={t("project.criteria.invalid")}>
        <ul className="mt-1 space-y-0.5 text-[13px]">
          {errors.map((e, i) => (
            <li key={i}>
              <span className="font-mono">{e.path}</span> — {t(ERROR_LABEL[e.code], e.params)}
            </li>
          ))}
        </ul>
      </Alert>
    </div>
  );
}

/**
 * The write of a grading mode: a refused switch to `criteria` keeps its
 * errors for {@link CriteriaErrors}; anything else is the page's toast.
 */
export function useGradingModeWrite(write: WriteProject) {
  const [errors, setErrors] = useState<CriteriaError[] | null>(null);
  const writeMode = (gradingMode: ProjectDetail["gradingMode"]) => {
    setErrors(null);
    write({ gradingMode }, (error) => {
      const found = criteriaErrorsOf(error);
      if (found === null) return false;
      setErrors(found);
      return true;
    });
  };
  return { errors, writeMode };
}

/** Each refusal's wording: a code added to the contract does not compile until it is worded here, in `en` and `fr`. */
const ERROR_LABEL: Record<CriteriaErrorCode, keyof Dict> = {
  yaml_syntax: "project.criteria.error.yaml_syntax",
  not_mapping: "project.criteria.error.not_mapping",
  schema_v1: "project.criteria.error.schema_v1",
  schema_version: "project.criteria.error.schema_version",
  missing_criteria: "project.criteria.error.missing_criteria",
  no_criteria: "project.criteria.error.no_criteria",
  dotted_key: "project.criteria.error.dotted_key",
  unknown_key: "project.criteria.error.unknown_key",
  not_text: "project.criteria.error.not_text",
  not_string: "project.criteria.error.not_string",
  not_text_list: "project.criteria.error.not_text_list",
  missing_description: "project.criteria.error.missing_description",
  both_descriptions: "project.criteria.error.both_descriptions",
  bad_milestone: "project.criteria.error.bad_milestone",
  missing_awarded: "project.criteria.error.missing_awarded",
  both_points: "project.criteria.error.both_points",
  missing_points: "project.criteria.error.missing_points",
  not_integer: "project.criteria.error.not_integer",
  percent_max: "project.criteria.error.percent_max",
  zero_points: "project.criteria.error.zero_points",
  negative_bonus: "project.criteria.error.negative_bonus",
  bad_percent: "project.criteria.error.bad_percent",
  percent_range: "project.criteria.error.percent_range",
  not_numeric: "project.criteria.error.not_numeric",
  awarded_out_of_range: "project.criteria.error.awarded_out_of_range",
  branch_missing: "project.criteria.error.branch_missing",
  missing_file: "project.criteria.error.missing_file",
  too_large: "project.criteria.error.too_large",
  command_needs_network: "project.criteria.error.command_needs_network",
};

const KIND_TONE: Record<CriterionKind, Tone> = { automatic: "green", llm: "accent", teacher: "zinc" };
const KIND_LABEL: Record<CriterionKind, keyof Dict> = {
  automatic: "project.criteria.kind.automatic",
  llm: "project.criteria.kind.llm",
  teacher: "project.criteria.kind.teacher",
};

/** A command or a list of paths as the teacher types it: words split on spaces. */
const words = (text: string) => text.trim().split(/\s+/).filter(Boolean);

/** An argv or a list of paths, written when the field is left, `null` when emptied (the default). */
function ListRow({
  title,
  desc,
  value,
  fallback,
  schema,
  disabled,
  onWrite,
}: {
  title: string;
  desc: string;
  value: string[] | null;
  fallback: readonly string[];
  schema: typeof ProjectPatch.shape.buildCommand | typeof ProjectPatch.shape.evidenceOutputs;
  disabled: boolean;
  onWrite: (value: string[] | null) => void;
}) {
  const t = useT();
  const shown = (value ?? []).join(" ");
  const [text, setText] = useState(shown);
  const [invalid, setInvalid] = useState(false);
  const id = `criteria-${title}`;
  const leave = () => {
    const next = words(text);
    const body = next.length === 0 ? null : next;
    if (!schema.safeParse(body).success) return setInvalid(true);
    setInvalid(false);
    if (body?.join(" ") !== value?.join(" ")) onWrite(body);
  };
  return (
    <div>
      <SettingRow title={title} desc={desc}>
        <TextInput
          id={id}
          aria-label={title}
          size="sm"
          className="w-72 font-mono"
          value={text}
          placeholder={fallback.join(" ")}
          disabled={disabled}
          onChange={(e) => setText(e.target.value)}
          onBlur={leave}
          aria-invalid={invalid || undefined}
        />
      </SettingRow>
      {invalid ? (
        <div className="pb-3">
          <FieldError id={id}>{t("project.criteria.invalidList")}</FieldError>
        </div>
      ) : null}
    </div>
  );
}

/**
 * A project graded by criteria: the tests criterion (one of the
 * snapshot's), the build and test commands and the outputs kept, and the
 * snapshot's table with its reload.
 */
export function CriteriaRows({ project, disabled, write }: { project: ProjectDetail; disabled: boolean; write: WriteProject }) {
  const t = useT();
  const qc = useQueryClient();
  const toast = useToast();
  const [reloadErrors, setReloadErrors] = useState<CriteriaError[] | null>(null);
  const [unknownTests, setUnknownTests] = useState(false);
  const view = useQuery<ProjectCriteriaView>({
    queryKey: projectCriteriaKey(project.id),
    queryFn: () => api(`/app/api/projects/${project.id}/criteria`),
  });
  const reload = useMutation({
    mutationFn: () => api<ProjectCriteriaView>(`/app/api/projects/${project.id}/criteria/reload`, { method: "POST" }),
    onSuccess: () => {
      setReloadErrors(null);
      // The project too: a load may pre-fill its tests criterion.
      void qc.invalidateQueries({ queryKey: projectKey(project.id) });
    },
    onError: (error) => {
      const found = criteriaErrorsOf(error);
      if (found === null) toast(refusalMessage(error, t), "error");
      else setReloadErrors(found);
    },
  });

  if (view.isPending) return <Skeleton className="my-3 h-24" />;
  if (view.isError) return <QueryError title={t("project.criteria.loadFailed")} query={view} />;
  const { snapshot } = view.data;
  const writeTests = (testsCriterion: string | null) => {
    setUnknownTests(false);
    write({ testsCriterion }, (error) => {
      if (!refusedWith(error, "unknown_criterion")) return false;
      setUnknownTests(true);
      return true;
    });
  };
  const columns = [
    { key: "section", label: t("project.criteria.section"), className: T.colHigh },
    { key: "criterion", label: t("project.criteria.criterion") },
    { key: "max", label: t("project.criteria.max"), right: true },
    { key: "kind", label: t("project.criteria.kind") },
  ];

  return (
    <>
      <SettingRow title={t("project.criteria.tests")} desc={t("project.criteria.tests.desc")}>
        <Select
          id="criteria-tests"
          aria-label={t("project.criteria.tests")}
          size="sm"
          width="w-72"
          value={project.testsCriterion ?? ""}
          disabled={disabled || snapshot === null}
          aria-invalid={unknownTests || undefined}
          onChange={(e) => writeTests(e.target.value === "" ? null : e.target.value)}
        >
          <option value="">{t("project.criteria.tests.default", { id: PROJECT_CRITERIA_DEFAULTS.testsCriterion })}</option>
          {snapshot?.leaves.map((leaf) => (
            <option key={leaf.id} value={leaf.id}>
              {leaf.id}
            </option>
          ))}
        </Select>
      </SettingRow>
      {unknownTests ? (
        <div className="pb-3">
          <FieldError id="criteria-tests">{t("project.criteria.tests.unknown")}</FieldError>
        </div>
      ) : null}
      <ListRow
        key={`b${project.buildCommand?.join(" ")}`}
        title={t("project.criteria.build")}
        desc={t("project.criteria.build.desc")}
        value={project.buildCommand}
        fallback={PROJECT_CRITERIA_DEFAULTS.buildCommand}
        schema={ProjectPatch.shape.buildCommand}
        disabled={disabled}
        onWrite={(buildCommand) => write({ buildCommand })}
      />
      <ListRow
        key={`t${project.testCommand?.join(" ")}`}
        title={t("project.criteria.test")}
        desc={t("project.criteria.test.desc")}
        value={project.testCommand}
        fallback={PROJECT_CRITERIA_DEFAULTS.testCommand}
        schema={ProjectPatch.shape.testCommand}
        disabled={disabled}
        onWrite={(testCommand) => write({ testCommand })}
      />
      <ListRow
        key={`o${project.evidenceOutputs?.join(" ")}`}
        title={t("project.criteria.outputs")}
        desc={t("project.criteria.outputs.desc")}
        value={project.evidenceOutputs}
        fallback={PROJECT_CRITERIA_DEFAULTS.evidenceOutputs}
        schema={ProjectPatch.shape.evidenceOutputs}
        disabled={disabled}
        onWrite={(evidenceOutputs) => write({ evidenceOutputs })}
      />
      <SettingRow
        stacked
        title={t("project.criteria.table")}
        desc={
          snapshot === null
            ? t("project.criteria.table.none")
            : t("project.criteria.table.desc", {
                sha: snapshot.sourceSha.slice(0, 7),
                max: snapshot.max,
                bonus: snapshot.bonusMax,
              })
        }
      >
        <div>
          <Button variant="secondary" size="sm" loading={reload.isPending} disabled={disabled} onClick={() => reload.mutate()}>
            {reload.isPending ? null : <RefreshCw />}
            {t("project.criteria.reload")}
          </Button>
        </div>
        <CriteriaErrors errors={reloadErrors} />
        {snapshot === null ? null : (
          <div className={cx(T.container, "overflow-x-auto")}>
            <table className={T.table}>
              <TableHead columns={columns} />
              <tbody>
                {snapshot.leaves.map((leaf) => (
                  <tr key={leaf.id} className={T.row}>
                    <td className={cx(T.td, T.colHigh, "align-top font-mono text-[13px] text-fg-muted")}>{leaf.sectionPath.join(".") || "—"}</td>
                    <td className={cx(T.td, "align-top")}>
                      <span className="font-mono text-[13px] font-semibold">{leaf.id.split(".").at(-1)}</span>
                      {leaf.milestone ? (
                        <Badge tone="zinc" className="ml-2">
                          {leaf.milestone}
                        </Badge>
                      ) : null}
                      <p className="mt-0.5 text-[13px] text-fg-muted">{leaf.description}</p>
                    </td>
                    <td className={cx(T.td, "align-top text-right tabular-nums")}>
                      {leaf.bonusPoints !== undefined ? `+${leaf.bonusPoints}` : leaf.maxPoints}
                    </td>
                    <td className={cx(T.td, "align-top")}>
                      <Badge tone={KIND_TONE[leaf.kind]}>{t(KIND_LABEL[leaf.kind])}</Badge>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </SettingRow>
    </>
  );
}

/**
 * On a locked project not yet released (ADR-106 §1), not graded by
 * criteria: the way into it, a confirmed secondary button — the page's
 * primary action stays the page's. (Out of it: the mode's row, while the
 * project is in it.)
 */
export function CriteriaSwitchRow({ disabled, write }: { disabled: boolean; write: WriteProject }) {
  const t = useT();
  const confirm = useConfirm();
  const { errors, writeMode } = useGradingModeWrite(write);
  const ask = async () => {
    if (await confirm({ title: t("project.criteria.switchConfirm.title"), message: t("project.criteria.switchConfirm.body"), confirmLabel: t("project.criteria.switch.action") })) {
      writeMode("criteria");
    }
  };
  return (
    <div>
      <SettingRow title={t("project.criteria.switch")} desc={t("project.criteria.switch.desc")}>
        <Button variant="secondary" size="sm" disabled={disabled} onClick={() => void ask()}>
          {t("project.criteria.switch.action")}
        </Button>
      </SettingRow>
      <CriteriaErrors errors={errors} />
    </div>
  );
}
