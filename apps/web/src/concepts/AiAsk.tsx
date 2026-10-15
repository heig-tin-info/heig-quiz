import { Sparkles } from "lucide-react";
import type { ReactNode } from "react";

import { apiErrorMessage } from "../api";
import { useT } from "../i18n";
import { Alert, Button } from "../ui";

/**
 * An on-demand call to the model on the curation screen (Fill with AI,
 * Propose relations with AI, Suggest a broader concept): a secondary button,
 * the hint saying what leaves and that it counts against the day's cap, and
 * the gateway's refusal worded (`apiErrorMessage`) under them.
 */
export function AiAsk({
  label,
  hint,
  pending,
  error,
  failedTitle,
  onAsk,
  disabled = false,
}: {
  label: string;
  hint: ReactNode;
  pending: boolean;
  error: unknown;
  failedTitle: string;
  onAsk: () => void;
  disabled?: boolean;
}) {
  const t = useT();
  return (
    <>
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
        <Button variant="secondary" size="sm" loading={pending} disabled={disabled} onClick={onAsk}>
          {pending ? null : <Sparkles />} {label}
        </Button>
        <p className="min-w-0 flex-1 basis-64 text-xs text-fg-muted">{hint}</p>
      </div>
      {error ? (
        <Alert tone="danger" title={failedTitle}>
          {apiErrorMessage(error, t("error.llmFailed"))}
        </Alert>
      ) : null}
    </>
  );
}
