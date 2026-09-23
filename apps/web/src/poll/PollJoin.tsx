/**
 * `/p/:CODE` — one question, one tap, on the phone of whoever scanned the QR
 * (F-LIVE-13, and F-AUTH-05 for the participant with no account).
 *
 * It is the ONE route rendered before the session gate (`App.tsx`): a guest
 * has nothing to sign into, so this page decides for itself whether it needs
 * an account, and sends to the identity provider with a `next` back here.
 *
 * The four decisions:
 *   - Type: the poll title is a 12 px eyebrow over a 16 px name; the QUESTION
 *     is the only thing at reading size, drawn by the type's own player. A
 *     poll is read at four metres from a beamer and at thirty centimetres on
 *     a phone, and the phone is this screen.
 *   - Color: ONE accent, "Send" in the bottom bar. The reveal brings
 *     `success` and `danger`, which are the key and a wrong pick — semantic,
 *     never decoration.
 *   - Space: 24 between the name and the question card, 20 inside it, and the
 *     column is capped at 560 px — a poll is one question, not the 760 px
 *     paper the zen player lays out.
 *   - Finish: hairlines and a `surface` card on the warm canvas, one sticky
 *     bar with a hairline over it. No shadow: both are in the page flow.
 *
 * It does NOT reuse `PlayerShell`: there is no clock (a poll ends when the
 * teacher says so, not on a deadline), no progress strip over one question
 * and no hand-in dialog. It reuses what a poll genuinely shares with the
 * exam player — `QuestionHost`, and therefore the type's own player, its
 * strings and the sanitised markdown renderer.
 *
 * Sync is deliberately thin: no autosave. A poll is one deliberate tap, and
 * an answer that saved itself while the finger was still moving is a wrong
 * answer nobody asked to send. Pending → sent → error with a retry, and
 * nothing else.
 */
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Check, Send, SearchX } from "lucide-react";

import type { Me, PollPublicView, PublicConfig } from "@quiz/contracts";

import { api, ApiError } from "../api";
import { useT } from "../i18n";
import type { Route } from "../router";
import { isAnswered, QuestionHost } from "../student/QuestionHost";
import { Alert, Button, Card, EmptyState, Field, QueryError, Skeleton } from "../ui";
import { PollJoinReveal } from "./PollJoinReveal";
import { configKey, publicPollKey } from "../queryKeys";

/** How often a running poll is re-read: the reveal must land while reading. */
const POLL_MS = 3_000;

const errorCode = (error: unknown): string | null =>
  error instanceof ApiError ? ((error.body as { error?: string })?.error ?? null) : null;

const statusOf = (error: unknown): number | null =>
  error instanceof ApiError ? error.status : null;

const same = (a: unknown, b: unknown) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);

function Frame({ children }: { children: ReactNode }) {
  return (
    <main className="mx-auto flex min-h-dvh w-full max-w-115 flex-col justify-center px-4 py-10">
      {children}
    </main>
  );
}

export function PollJoin({
  code,
  me,
  navigate,
}: {
  code: string;
  me: Me | null;
  navigate: (r: Route) => void;
}) {
  const t = useT();
  const queryClient = useQueryClient();
  const key = useMemo(() => publicPollKey(code), [code]);

  const poll = useQuery<PollPublicView>({
    queryKey: key,
    // A code that names no running poll is a SCREEN here, not a failure to
    // retry: the reader mistyped six characters and the page says so.
    retry: false,
    queryFn: () => api<PollPublicView>(`/app/api/p/${encodeURIComponent(code)}`),
    // The teacher's "Reveal" and the end of the poll are the two things that
    // must reach a phone nobody is touching. A poll runs for a minute or two,
    // so three seconds of polling is cheaper in every sense than a socket per
    // participant — and it stops by itself once the poll has ended.
    refetchInterval: (query) => (query.state.data?.state === "running" ? POLL_MS : false),
  });

  const view = poll.data ?? null;

  const join = useMutation({
    mutationFn: () =>
      api<PollPublicView>(`/app/api/p/${encodeURIComponent(code)}/join`, {
        method: "POST",
        body: "{}",
      }),
    onSuccess: (next) => queryClient.setQueryData(key, next),
  });

  const send = useMutation({
    mutationFn: (payload: unknown) =>
      api<PollPublicView>(`/app/api/p/${encodeURIComponent(code)}/answer`, {
        method: "POST",
        body: JSON.stringify({ payload }),
      }),
    onSuccess: (next) => queryClient.setQueryData(key, next),
    // A `410 attempt_closed` is not a network hiccup: the poll ended under
    // the finger. Re-read so the page says so instead of offering a retry
    // that would fail the same way.
    onError: (error) => {
      if (errorCode(error) === "attempt_closed") void poll.refetch();
    },
  });

  /*
   * `undefined` means "the reader has not touched anything", and the server's
   * copy shows through — which is what keeps the three-second refetch from
   * wiping a half-written answer out from under a thumb. One tap and the
   * local value wins until it has been sent.
   */
  const [draft, setDraft] = useState<unknown>(undefined);
  const stored = view?.me.answer ?? null;
  const answer = draft === undefined ? stored : draft;

  // A ref and not `join.status`: `mutate` is asynchronous, so two renders can
  // both read "idle" and the browser would join twice for one scan.
  const joinFired = useRef(false);

  /*
   * The page stays MOUNTED when the code changes (the not-found screen sends
   * the reader to another poll), so the two things that belong to one poll —
   * what was typed, and the fact that this browser has already joined — are
   * dropped with it. Everything else is keyed by the code already. It is
   * declared before the join below so that a code change resets the latch
   * before the effect that reads it runs.
   */
  useEffect(() => {
    joinFired.current = false;
    setDraft(undefined);
  }, [code]);

  /*
   * Joining is not a click. A guest who scanned a QR has already said
   * everything they meant to say by being here, and an account holder even
   * more so; the only join that is a decision is the one that needs a login,
   * and that one has a screen of its own below.
   */
  const needsJoin = view !== null && !view.me.loginRequired && !view.me.joined;
  const joinMutate = join.mutate;
  useEffect(() => {
    if (!needsJoin || joinFired.current) return;
    joinFired.current = true;
    joinMutate();
  }, [needsJoin, joinMutate]);

  // --- Loading -------------------------------------------------------------

  if (poll.isLoading) {
    return (
      <Frame>
        <div className="space-y-4" role="status" aria-label={t("join.loading")}>
          <Skeleton className="h-3 w-16" />
          <Skeleton className="h-5 w-48" />
          <Skeleton className="h-56 w-full rounded-card" />
        </div>
      </Frame>
    );
  }

  // --- No such poll, or a server that did not answer -----------------------

  if (poll.isError || view === null) {
    if (statusOf(poll.error) === 404) return <NotFound navigate={navigate} />;
    return (
      <Frame>
        <h1 className="mb-4 text-lg font-bold tracking-tight">{t("join.loadFailed")}</h1>
        <QueryError
          title={t("error.title")}
          error={poll.error}
          onRetry={() => void poll.refetch()}
          retrying={poll.isFetching}
        />
      </Frame>
    );
  }

  // --- The gate: this poll wants to know who is answering ------------------

  if (view.me.loginRequired) return <LoginGate code={code} title={view.title} />;

  const ended = view.state === "ended";
  const revealed = view.settings.revealed && view.solution !== null;
  const dirty = !same(answer, stored);
  const sent = stored !== null && !dirty;
  const closedByServer = errorCode(send.error) === "attempt_closed";

  return (
    <div className="flex min-h-dvh flex-col bg-canvas">
      <main className="mx-auto w-full max-w-140 flex-1 px-4 py-6 sm:px-6">
        <p className="text-[12px] font-medium uppercase tracking-wide text-fg-faint">
          {t("join.eyebrow")}
        </p>
        <h1 className="mt-0.5 text-base font-semibold leading-tight">{view.title}</h1>

        {ended ? (
          <div className="mt-5">
            <Alert tone="neutral" title={t("join.ended.title")}>
              {t("join.ended.body")}
            </Alert>
          </div>
        ) : null}

        <Card className="mt-6 px-4 py-5 sm:px-6">
          {revealed ? (
            <PollJoinReveal
              type={view.question.type}
              student={view.question.student}
              solution={view.solution}
              tally={view.tally}
              answer={stored}
            />
          ) : (
            <QuestionHost
              type={view.question.type}
              student={view.question.student}
              answer={answer}
              onChange={setDraft}
              readOnly={ended}
            />
          )}
        </Card>

        {join.isError ? (
          <div className="mt-4">
            <QueryError
              title={t("join.joinFailed")}
              error={join.error}
              onRetry={() => joinMutate()}
              retrying={join.isPending}
            />
          </div>
        ) : null}

        {send.isError ? (
          <div className="mt-4">
            {closedByServer ? (
              <Alert tone="warning" title={t("join.tooLate")} />
            ) : (
              <QueryError
                title={t("join.sendFailed")}
                error={send.error}
                onRetry={() => send.mutate(answer)}
                retrying={send.isPending}
              />
            )}
          </div>
        ) : null}

        <p className="mt-6 text-xs text-fg-faint">
          {me === null
            ? t("join.anonymously")
            : `${t("join.as", { name: me.givenName })}${
                view.settings.anonymous ? ` ${t("join.anonymousAccount")}` : ""
              }`}
        </p>
      </main>

      {ended || revealed ? null : (
        <footer className="sticky bottom-0 border-t border-line bg-surface">
          <div className="mx-auto flex w-full max-w-140 items-center gap-3 px-4 py-3 sm:px-6">
            {/* The whole sync report: a check and a word, in a polite live
                region, because "did that go?" is the only question a
                participant has after tapping. */}
            <p className="min-w-0 flex-1 text-[13px] text-fg-muted" role="status">
              {sent ? (
                <span className="inline-flex items-center gap-1.5 text-success">
                  <Check className="size-4" aria-hidden />
                  {t("join.sent")}
                </span>
              ) : null}
            </p>
            <Button
              variant="primary"
              size="lg"
              loading={send.isPending}
              disabled={!isAnswered(view.question.type, answer) || sent}
              onClick={() => send.mutate(answer)}
            >
              <Send aria-hidden />
              {stored === null ? t("join.send") : t("join.update")}
            </Button>
          </div>
        </footer>
      )}
    </div>
  );
}

/**
 * The poll asks for an account. ONE primary action, and the dev door beside
 * it exactly as `Landing` offers it — the two are the same decision, so they
 * read the same way, and both carry a `next` back to this very code.
 */
function LoginGate({ code, title }: { code: string; title: string }) {
  const t = useT();
  const config = useQuery<PublicConfig>({
    queryKey: configKey,
    queryFn: () => api<PublicConfig>("/app/api/config"),
    retry: false,
  });
  const next = encodeURIComponent(`/p/${code}`);
  return (
    <Frame>
      <Card className="px-6 py-8 text-center">
        <p className="text-[12px] font-medium uppercase tracking-wide text-fg-faint">
          {t("join.eyebrow")}
        </p>
        <h1 className="mt-1 text-lg font-bold tracking-tight">{title}</h1>
        <p className="mt-4 text-sm leading-relaxed text-fg-muted">{t("join.login.body")}</p>
        <Button
          variant="primary"
          size="lg"
          className="mt-6 w-full"
          onClick={() => window.location.assign(`/app/auth/login?next=${next}`)}
        >
          {t("join.login.action")}
        </Button>
        {config.data?.devLogin ? (
          <>
            <Button
              variant="secondary"
              size="lg"
              className="mt-3 w-full"
              onClick={() => window.location.assign(`/app/auth/dev?next=${next}`)}
            >
              {t("landing.devSignin")}
            </Button>
            <p className="mt-2 text-xs text-fg-faint">{t("landing.devHint")}</p>
          </>
        ) : null}
      </Card>
    </Frame>
  );
}

/**
 * Six characters that name nothing. The QR is the normal way in, so this is
 * not a lobby — it is the one repair a reader who typed the URL by hand can
 * make, and the field IS the action.
 */
function NotFound({ navigate }: { navigate: (r: Route) => void }) {
  const t = useT();
  const [typed, setTyped] = useState("");
  const trimmed = typed.trim().toUpperCase();
  return (
    <Frame>
      <Card className="px-6 py-6">
        <EmptyState
          icon={SearchX}
          titleAs="h1"
          title={t("join.notFound.title")}
          className="py-6"
          action={
            <form
              className="flex items-end gap-2"
              onSubmit={(e) => {
                e.preventDefault();
                if (trimmed !== "") navigate({ view: "join", code: trimmed });
              }}
            >
              <Field
                label={t("join.code")}
                value={typed}
                autoComplete="off"
                autoCapitalize="characters"
                spellCheck={false}
                className="font-mono uppercase tracking-widest"
                onChange={(e) => setTyped(e.target.value)}
              />
              <Button type="submit" variant="primary" disabled={trimmed === ""}>
                {t("join.open")}
              </Button>
            </form>
          }
        >
          {t("join.notFound.body")}
        </EmptyState>
      </Card>
    </Frame>
  );
}
