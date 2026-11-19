import { useMutation, useQueryClient } from "@tanstack/react-query";
import { ArrowRight } from "lucide-react";
import { useState } from "react";

import { GradeAdjustmentWrite, type ProjectGradingRepo, type ProjectRepoScores } from "@quiz/contracts";
import { adjustGrade, formatGrade, GRADE_ADJUSTMENT_COMMENT_MAX, validGradeAdjustment, type GradeAdjustmentKind } from "@quiz/domain";

import { api } from "../../api";
import { Grade } from "../../Grade";
import { useT } from "../../i18n";
import { useToast } from "../../notify";
import { FormError } from "../../queryError";
import { projectKey } from "../../queryKeys";
import { Alert, Button, Field, FormDialog, isoDateTime, Segmented, Textarea } from "../../ui";
import { gradeWriteRefusal } from "../projectPage";

const VALUE_DESC_ID = "grade-adjust-value-desc";

/**
 * What the dialog sends, as the contract reads it (`GradeAdjustmentWrite`,
 * invariant 7): the kind, the value as typed, the justification. Null while
 * the contract refuses it — no value, a delta of 0 or off the tenth, a grade
 * outside 1 … 6, no justification.
 */
export function gradeAdjustmentBody(kind: GradeAdjustmentKind, value: string, comment: string): GradeAdjustmentWrite | null {
  if (value.trim() === "") return null;
  return GradeAdjustmentWrite.safeParse({ kind, value: Number(value), comment }).data ?? null;
}

/**
 * The grade adjustment of one repository (ADR-135), opened from the mark at
 * the end of its row in the Grading tab's matrix: Relative (a delta) or
 * Absolute (the grade itself), the value, the justification the student
 * reads with the released grade, and the preview "base → result" by the
 * domain's own rule (`adjustGrade`). A group's repository names every member
 * it affects. An existing adjustment says who wrote it and when, warns when
 * an absolute pin's base moved (Adjust keeps it over the base of now), and
 * offers its removal. The one primary action is Adjust; the server's
 * refusals (`not_frozen`, `no_grade`, `owner_required`) are worded under the
 * fields.
 */
export function GradeAdjustDialog({
  projectId,
  repo,
  members,
  onClose,
}: {
  projectId: string;
  repo: ProjectGradingRepo;
  /** The students the repository's grade is theirs: its group's members, or its student. */
  members: readonly string[];
  onClose: () => void;
}) {
  const t = useT();
  const qc = useQueryClient();
  const toast = useToast();
  const current = repo.adjustment;
  // The grade before any adjustment: the adjustment's base when there is one, else the grade itself.
  const base = current ? current.base : repo.grade;
  const [kind, setKind] = useState<GradeAdjustmentKind>(current?.kind ?? "relative");
  const [value, setValue] = useState(current ? String(current.value) : "");
  const [comment, setComment] = useState(current?.comment ?? "");
  const body = gradeAdjustmentBody(kind, value, comment);
  // The preview reads the value alone: the justification is the write's, not the grade's.
  const typed = value.trim() === "" ? Number.NaN : Number(value);
  const result =
    base !== null && validGradeAdjustment({ kind, value: typed }) ? adjustGrade(base, { kind, value: typed, baseAtWrite: base })!.grade : null;

  const write = useMutation({
    mutationFn: (sent: GradeAdjustmentWrite | null) =>
      api<ProjectRepoScores>(
        `/app/api/projects/${projectId}/repos/${repo.id}/grade-adjustment`,
        sent ? { method: "PUT", body: JSON.stringify(sent) } : { method: "DELETE" },
      ),
    onSuccess: (_, sent) => {
      // The matrix, the page's rows and the gradebook read the grade again.
      void qc.invalidateQueries({ queryKey: projectKey(projectId) });
      toast(t(sent ? "project.adjust.saved" : "project.adjust.removed"), "success");
      onClose();
    },
  });
  const switchKind = (next: GradeAdjustmentKind) => {
    setKind(next);
    // A delta is no grade, nor the other way round: the field starts again, an absolute from the base.
    setValue(next === "absolute" && base !== null ? formatGrade(base) : "");
  };

  return (
    <FormDialog
      title={t("project.adjust.title", { name: repo.label })}
      onClose={onClose}
      onSubmit={() => body && write.mutate(body)}
      submitLabel={t("project.adjust.submit")}
      submitting={write.isPending && write.variables !== null}
      canSubmit={body !== null && !write.isPending}
      error={<FormError error={write.error} describe={(error) => gradeWriteRefusal(error, t)} />}
    >
      {members.length > 1 ? <p className="text-[13px] text-fg-muted">{t("project.adjust.members", { names: members.join(", ") })}</p> : null}
      {current?.baseMoved && current.baseAtWrite !== null && current.base !== null ? (
        <Alert tone="warning" title={t("project.adjust.baseMoved", { from: formatGrade(current.baseAtWrite), to: formatGrade(current.base) })}>
          {t("project.adjust.baseMoved.body")}
        </Alert>
      ) : null}
      <div className="space-y-1.5">
        <span id="grade-adjust-kind" className="block text-[13px] font-medium">
          {t("project.adjust.kind")}
        </span>
        <Segmented<GradeAdjustmentKind>
          name="grade-adjust-kind"
          labelledBy="grade-adjust-kind"
          value={kind}
          onChange={switchKind}
          options={[
            { value: "relative", label: t("project.adjust.kind.relative") },
            { value: "absolute", label: t("project.adjust.kind.absolute") },
          ]}
        />
      </div>
      <div className="space-y-1.5">
        <div className="flex flex-wrap items-end gap-x-6 gap-y-3">
          <Field
            label={t(kind === "relative" ? "project.adjust.delta" : "project.adjust.grade")}
            aria-describedby={VALUE_DESC_ID}
            type="number"
            inputMode="decimal"
            step={0.1}
            min={kind === "relative" ? -5 : 1}
            max={kind === "relative" ? 5 : 6}
            width="w-28"
            className="text-right tabular-nums"
            autoFocus
            value={value}
            onChange={(e) => setValue(e.target.value)}
          />
          {base !== null ? (
            <p className="flex h-[34px] items-center gap-2 text-lg font-semibold tabular-nums" data-testid="grade-adjust-preview">
              <span className="sr-only">{t("project.adjust.preview")}</span>
              <Grade value={base} />
              <ArrowRight aria-hidden className="size-4 text-fg-faint" />
              {result === null ? <span className="text-fg-faint">—</span> : <Grade value={result} />}
            </p>
          ) : null}
        </div>
        {/* Under the row, not the 7 rem field: the range reads on one line. */}
        <p id={VALUE_DESC_ID} className="text-xs text-fg-muted">
          {t(kind === "relative" ? "project.adjust.delta.desc" : "project.adjust.grade.desc")}
        </p>
      </div>
      <div className="space-y-1.5">
        <Textarea
          label={t("project.adjust.comment")}
          rows={3}
          maxLength={GRADE_ADJUSTMENT_COMMENT_MAX}
          className="min-h-20"
          value={comment}
          onChange={(e) => setComment(e.target.value)}
        />
        <p className="text-xs text-fg-muted">{t("project.adjust.comment.hint")}</p>
      </div>
      {current ? (
        <div className="flex flex-wrap items-center justify-between gap-2 border-t border-line pt-3">
          <span className="text-xs text-fg-faint">{t("project.adjust.by", { by: current.by ?? "—", date: isoDateTime(current.at) })}</span>
          <Button
            variant="danger-quiet"
            size="sm"
            loading={write.isPending && write.variables === null}
            disabled={write.isPending}
            onClick={() => write.mutate(null)}
          >
            {t("project.adjust.remove")}
          </Button>
        </div>
      ) : null}
    </FormDialog>
  );
}
