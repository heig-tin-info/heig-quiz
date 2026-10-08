/**
 * "Propose with AI": the admin starts the model pass that proposes the
 * sorting (ADR-081, second addendum §3), a background job of the server.
 * The run is polled while it runs; when it ends, the list is read again, so
 * its proposals show as pending decisions. Hidden when the platform has no
 * model: the screen works without one.
 */
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Sparkles } from "lucide-react";
import { useEffect, useRef, useState } from "react";

import type { ConceptSortRun, ConceptSortRunStatus } from "@quiz/contracts";

import { api, apiErrorMessage, refusedWith } from "../api";
import { useT } from "../i18n";
import { useLlmAvailability } from "../llmAvailability";
import { useToast } from "../notify";
import { adminConceptSortingKey, adminConceptSortRunKey } from "../queryKeys";
import { Button, cx } from "../ui";

export const RUN_POLL_MS = 3_000;

export function ProposeAction() {
  const t = useT();
  const qc = useQueryClient();
  const toast = useToast();
  const llm = useLlmAvailability();
  const available = llm.data?.available === true;

  const status = useQuery<ConceptSortRunStatus>({
    queryKey: adminConceptSortRunKey,
    queryFn: () => api("/app/api/admin/concept-sorting/run"),
    enabled: available,
    refetchInterval: (q) => (q.state.data?.run?.state === "running" ? RUN_POLL_MS : false),
  });
  const run = status.data?.run ?? null;
  const running = run?.state === "running";
  const [sawEnd, setSawEnd] = useState(false);

  // A run seen running that has ended: its proposals are in the list now.
  const last = useRef(run?.state);
  useEffect(() => {
    if (last.current === "running" && run?.state !== "running") {
      setSawEnd(true);
      void qc.invalidateQueries({ queryKey: adminConceptSortingKey, exact: true });
    }
    last.current = run?.state;
  }, [run?.state, qc]);

  const propose = useMutation({
    mutationFn: () => api<ConceptSortRunStatus>("/app/api/admin/concept-sorting/propose", { method: "POST" }),
    onSuccess: (res) => qc.setQueryData(adminConceptSortRunKey, res),
    onError: (err) => {
      // Another tab, or another admin, started one: show it.
      if (refusedWith(err, "concept_sort_running")) void status.refetch();
      else toast(apiErrorMessage(err, t("error.server")), "error");
    },
  });

  if (!available) return null;
  // A done run speaks only when it ended under the admin's eyes; a failed or partial one always.
  const line = run && (run.state !== "done" || sawEnd) ? runLine(t, run) : null;

  return (
    <div className="flex flex-wrap items-center justify-end gap-x-3 gap-y-1">
      <span role="status" className={cx("text-xs tabular-nums", line ? TONE[line.tone] : "")}>
        {line?.text}
      </span>
      <Button size="sm" variant="secondary" loading={propose.isPending || running} onClick={() => propose.mutate()}>
        {propose.isPending || running ? null : <Sparkles />} {t("admin.concepts.propose")}
      </Button>
    </div>
  );
}

type Translate = ReturnType<typeof useT>;
type Tone = "muted" | "warning" | "danger";
const TONE: Record<Tone, string> = { muted: "text-fg-muted", warning: "text-warning", danger: "text-danger" };

/** What the last run says beside the button: its progress, its end, or why it stopped. */
function runLine(t: Translate, run: ConceptSortRun): { tone: Tone; text: string } {
  if (run.state === "running") {
    return { tone: "muted", text: t("admin.concepts.run.running", { done: run.groupsDone, total: run.groupsTotal }) };
  }
  if (run.state === "failed") {
    return { tone: "danger", text: t("admin.concepts.run.failed", { reason: t(`admin.concepts.run.error.${run.error ?? "internal"}`) }) };
  }
  if (run.batchesFailed > 0) {
    const n = run.batchesFailed;
    return { tone: "warning", text: t(n === 1 ? "admin.concepts.run.partial.one" : "admin.concepts.run.partial", { n }) };
  }
  return { tone: "muted", text: t("admin.concepts.run.done") };
}
