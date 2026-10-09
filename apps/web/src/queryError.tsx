import { AlertTriangle, RefreshCw } from "lucide-react";

import { apiErrorMessage } from "./api";
import { useT } from "./i18n";
import { Button, ErrorText } from "./ui/controls";
import { Alert } from "./ui/feedback";
import { PageHeader } from "./ui/page";

/*
 * The failure primitives that read an `ApiError`. They stay in the app,
 * beside `api.ts`, so that `ui/` never imports the HTTP client: the
 * presentational half (`Alert`, `PageHeader`) is a primitive, the message
 * extraction is not. `ui/index.tsx` re-exports them, so every screen keeps
 * importing them from `./ui`.
 */

/** The part of a query result a failure reads: TanStack Query's shape. */
type FailedQuery = { error: unknown; refetch: () => unknown; isFetching: boolean };

/**
 * What failed and how to ask again: either one `query` (its error, its
 * refetch, its fetching flag, so the three can never come from two queries),
 * or the three spelled out, for a mutation or an error that is not a
 * query's own.
 */
type Failure =
  | { query: FailedQuery; error?: never; onRetry?: never; retrying?: never }
  | { query?: never; error: unknown; onRetry?: () => void; retrying?: boolean };

type QueryErrorProps = Failure & {
  title: string;
  /**
   * Shown when the server sent no message of its own. It defaults to the
   * translated `error.server`: an English literal here was a French screen
   * one forgotten prop away (W9).
   */
  fallback?: string;
};

/**
 * A query that failed: what could not be loaded, what the server said, and
 * the one thing that helps — asking again. `onRetry` is optional: some
 * failures (a one-shot list inside a form) have nothing to retry from here.
 */
export function QueryError({ title, fallback, ...failure }: QueryErrorProps) {
  const t = useT();
  const query = failure.query;
  const { error, onRetry, retrying } = query
    ? { error: query.error, onRetry: () => void query.refetch(), retrying: query.isFetching }
    : failure;
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
export function PageError({ title, ...rest }: QueryErrorProps) {
  const t = useT();
  return (
    <div className="space-y-6">
      <PageHeader title={title} />
      <QueryError title={t("error.title")} {...rest} />
    </div>
  );
}

/**
 * A write that failed, said where the reader acted: nothing while `error` is
 * null (a mutation's `error` is null until it fails), otherwise what the
 * server said, or `fallback`.
 *
 * Without a `title` it is the one-line paragraph a dialog puts under its
 * fields (`FormDialog`'s `error` slot). With one it is a danger `Alert` —
 * the shape a step, a sheet or a page uses, where a bare red line would be
 * lost among the sections.
 */
export function FormError({
  error,
  fallback,
  title,
  describe,
}: {
  error: unknown;
  /** Defaults to the translated `error.server`, like `QueryError`'s. */
  fallback?: string;
  title?: string;
  /** Words the error itself (a module's refusal codes), in place of `apiErrorMessage`. */
  describe?: (error: unknown) => string;
}) {
  const t = useT();
  if (error == null) return null;
  const message = describe ? describe(error) : apiErrorMessage(error, fallback ?? t("error.server"));
  return title ? (
    <Alert tone="danger" title={title}>
      {message}
    </Alert>
  ) : (
    <ErrorText>{message}</ErrorText>
  );
}
