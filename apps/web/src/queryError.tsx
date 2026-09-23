import { AlertTriangle, RefreshCw } from "lucide-react";

import { apiErrorMessage } from "./api";
import { useT } from "./i18n";
import { Alert, Button, PageHeader } from "./ui/primitives";

/*
 * The two failure primitives that read an `ApiError`. They stay in the app,
 * beside `api.ts`, so that `ui/` never imports the HTTP client: the
 * presentational half (`Alert`, `PageHeader`) is a primitive, the message
 * extraction is not. `ui/index.tsx` re-exports both, so every screen keeps
 * importing them from `./ui`.
 */

/**
 * A query that failed: what could not be loaded, what the server said, and
 * the one thing that helps — asking again. `onRetry` is optional: some
 * failures (a one-shot list inside a form) have nothing to retry from here.
 */
export function QueryError({
  title,
  error,
  onRetry,
  retrying,
  fallback,
}: {
  title: string;
  error: unknown;
  onRetry?: () => void;
  retrying?: boolean;
  /**
   * Shown when the server sent no message of its own. It defaults to the
   * translated `error.server`: an English literal here was a French screen
   * one forgotten prop away (W9).
   */
  fallback?: string;
}) {
  const t = useT();
  return (
    <Alert
      tone="danger"
      icon={AlertTriangle}
      title={title}
      action={
        onRetry ? (
          <Button size="sm" variant="secondary" onClick={onRetry} loading={retrying}>
            <RefreshCw /> {t("common.retry")}
          </Button>
        ) : undefined
      }
    >
      {apiErrorMessage(error, fallback ?? t("error.server"))}
    </Alert>
  );
}

/**
 * A query that failed and took the WHOLE page with it. `QueryError` on its own
 * is an alert in a page frame; returned instead of the frame, it leaves the
 * document with no `<h1>` at all, and a screen reader with no way in (W3).
 * So the page keeps a heading — what could not be loaded — and the alert
 * underneath says what went wrong and offers the retry.
 */
export function PageError({
  title,
  ...rest
}: {
  /** The `<h1>`: what the page was, not what the server said. */
  title: string;
  error: unknown;
  onRetry?: () => void;
  retrying?: boolean;
  fallback?: string;
}) {
  const t = useT();
  return (
    <div className="space-y-6">
      <PageHeader title={title} />
      <QueryError title={t("error.title")} {...rest} />
    </div>
  );
}
