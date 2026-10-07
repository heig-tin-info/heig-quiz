/**
 * The teacher assistant (ADR-080, F-LLM-07): a `ToolDock` on every teacher
 * screen — the round button at the bottom right, in the neutral ink, and the
 * chat it opens above it. Under `lg`, while the pool's bulk bar is up, the
 * dock steps aside (`data-assist-dock`, `style.css`).
 *
 * What it sends is the route pattern, the screen's help topic (the slot its
 * `PageHelpButton` fills) and the UI language (`context.ts`), with the
 * question. The conversation open in this tab survives a reload
 * (`sessionStorage`); the server keeps it 30 days. One that is gone — purged,
 * or deleted in another tab — is forgotten, and the question starts a new one.
 */
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowUp, History, MessageCircleQuestion, SquarePen, Trash2, X } from "lucide-react";
import { useCallback, useEffect, useRef, useState, type FormEvent } from "react";

import type {
  AssistAsk,
  AssistAvailability,
  AssistConversation,
  AssistConversationSummary,
  AssistReply,
  Me,
} from "@quiz/contracts";
import { ASSIST_MAX_MESSAGE_CHARS } from "@quiz/domain";
import { textareaClass } from "@quiz/ui";

import { api, apiErrorMessage, refusedWith } from "../api";
import { useConfirm } from "../confirm";
import { useI18n } from "../i18n";
import { Markdown } from "../markdown";
import { assistAvailabilityKey, assistConversationKey, assistConversationsKey } from "../queryKeys";
import type { Route } from "../router";
import { Alert, Badge, cx, IconButton, QueryError, RelativeTime, Spinner, ToolDock } from "../ui";
import { assistContext, assistVisible } from "./context";

const CONVERSATION_KEY = "quiz-assist-conversation";

/** The tab's open conversation; storage may throw (a private window) and is then simply forgotten. */
function storedConversation(): string | null {
  try {
    return sessionStorage.getItem(CONVERSATION_KEY);
  } catch {
    return null;
  }
}
function storeConversation(id: string | null): void {
  try {
    if (id) sessionStorage.setItem(CONVERSATION_KEY, id);
    else sessionStorage.removeItem(CONVERSATION_KEY);
  } catch {
    // A convenience: the conversation is still on the server, in the history.
  }
}

export function AssistDock({ me, route, teacherUi }: { me: Me; route: Route; teacherUi: boolean }) {
  const visible = assistVisible({ teacherUi, me, view: route.view });
  const availability = useQuery({
    queryKey: assistAvailabilityKey,
    queryFn: () => api<AssistAvailability>("/app/api/assist/availability"),
    enabled: visible,
    staleTime: 60_000,
    retry: false,
  });
  if (!visible || !availability.data?.available) return null;
  return <Dock route={route} stub={availability.data.stub} />;
}

function Dock({ route, stub }: { route: Route; stub: boolean }) {
  const { t } = useI18n();
  const [showHistory, setShowHistory] = useState(false);
  const [conversationId, setConversationId] = useState<string | null>(storedConversation);

  const select = useCallback((id: string | null) => {
    setConversationId(id);
    storeConversation(id);
    setShowHistory(false);
  }, []);

  return (
    <ToolDock
      icon={MessageCircleQuestion}
      openLabel={t("assist.open")}
      closeLabel={t("assist.close")}
      title={t("assist.title")}
      offset="var(--bottom-nav-h)"
      panelClassName="flex h-[min(36rem,calc(100dvh-var(--banner-h)-var(--bottom-nav-h)-var(--tool-dock-h)-5rem))] w-[24rem] flex-col"
      dockProps={{ "data-assist-dock": true }}
    >
      {(close) => (
        <>
          <header className="flex items-center gap-2 border-b border-line py-2 pr-2 pl-4">
            <h2 className="text-[15px] font-bold tracking-tight">{t("assist.title")}</h2>
            {stub ? <Badge tone="zinc">{t("assist.stub")}</Badge> : null}
            <span className="ml-auto flex items-center gap-1">
              <IconButton
                size="sm"
                label={showHistory ? t("assist.back") : t("assist.history")}
                onClick={() => setShowHistory((v) => !v)}
              >
                <History />
              </IconButton>
              <IconButton size="sm" label={t("assist.new")} onClick={() => select(null)}>
                <SquarePen />
              </IconButton>
              <IconButton size="sm" label={t("assist.close")} onClick={close}>
                <X />
              </IconButton>
            </span>
          </header>
          {showHistory ? (
            <HistoryList current={conversationId} onOpen={select} />
          ) : (
            <Chat route={route} conversationId={conversationId} onConversation={select} />
          )}
        </>
      )}
    </ToolDock>
  );
}

function Chat({
  route,
  conversationId,
  onConversation,
}: {
  route: Route;
  conversationId: string | null;
  onConversation: (id: string | null) => void;
}) {
  const { t, locale } = useI18n();
  const qc = useQueryClient();
  const [draft, setDraft] = useState("");
  const input = useRef<HTMLTextAreaElement>(null);
  const end = useRef<HTMLDivElement>(null);

  const conversation = useQuery({
    queryKey: assistConversationKey(conversationId ?? ""),
    queryFn: () => api<AssistConversation>(`/app/api/assist/conversations/${conversationId}`),
    enabled: conversationId !== null,
    retry: false,
  });
  // Gone (purged, deleted in another tab, never ours): forgotten, so the next question starts a new one.
  const gone = conversation.isError;
  useEffect(() => {
    if (gone) onConversation(null);
  }, [gone, onConversation]);

  const ask = useMutation({
    mutationFn: (q: { message: string; conversationId: string | null }) =>
      api<AssistReply>("/app/api/assist/ask", {
        method: "POST",
        body: JSON.stringify({
          message: q.message,
          context: assistContext(route, locale),
          ...(q.conversationId ? { conversationId: q.conversationId } : {}),
        } satisfies AssistAsk),
      }),
    onSuccess: (reply) => {
      qc.setQueryData<AssistConversation>(assistConversationKey(reply.conversationId), (old) => ({
        id: reply.conversationId,
        createdAt: old?.createdAt ?? reply.exchange.createdAt,
        updatedAt: reply.exchange.createdAt,
        exchanges: [...(old?.exchanges ?? []), reply.exchange],
      }));
      void qc.invalidateQueries({ queryKey: assistConversationsKey, exact: true });
      onConversation(reply.conversationId);
      setDraft("");
    },
    onError: (error, q) => {
      // Purged while the page stood open: the question goes on in a new conversation.
      if (q.conversationId && refusedWith(error, "conversation_not_found")) {
        onConversation(null);
        ask.mutate({ message: q.message, conversationId: null });
      }
    },
  });

  useEffect(() => {
    input.current?.focus();
  }, [conversationId]);
  const exchanges = conversationId && !gone ? (conversation.data?.exchanges ?? []) : [];
  const count = exchanges.length + (ask.isPending ? 1 : 0);
  useEffect(() => {
    end.current?.scrollIntoView?.({ block: "end" });
  }, [count]);

  const submit = (e?: FormEvent) => {
    e?.preventDefault();
    const message = draft.trim();
    if (message === "" || ask.isPending) return;
    ask.mutate({ message, conversationId: gone ? null : conversationId });
  };
  const failed = ask.isError && !refusedWith(ask.error, "conversation_not_found");

  return (
    <>
      <div className="flex-1 space-y-4 overflow-y-auto px-4 py-4" aria-live="polite">
        {conversationId && !gone && conversation.isLoading ? <Spinner className="py-8" /> : null}
        {exchanges.length === 0 && !ask.isPending && !(conversationId && conversation.isLoading) ? (
          <div className="space-y-2 py-6 text-center">
            <MessageCircleQuestion className="mx-auto size-6 text-fg-faint" aria-hidden />
            <p className="text-sm font-semibold">{t("assist.empty.title")}</p>
            <p className="text-[13px] text-fg-muted">{t("assist.empty.body")}</p>
          </div>
        ) : null}
        {exchanges.map((e) => (
          <div key={e.id} className="space-y-4">
            <Question text={e.question} />
            <Answer text={e.answer} />
          </div>
        ))}
        {ask.isPending ? (
          <>
            <Question text={ask.variables.message} />
            <Spinner label={t("assist.thinking")} className="items-start py-1" />
          </>
        ) : null}
        {failed ? <Alert tone="danger">{apiErrorMessage(ask.error, t("assist.error"))}</Alert> : null}
        <div ref={end} />
      </div>
      <form onSubmit={submit} className="flex items-end gap-2 border-t border-line p-3">
        <label className="sr-only" htmlFor="assist-question">
          {t("assist.placeholder")}
        </label>
        <textarea
          id="assist-question"
          ref={input}
          rows={2}
          value={draft}
          maxLength={ASSIST_MAX_MESSAGE_CHARS}
          placeholder={t("assist.placeholder")}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) submit(e);
          }}
          className={cx(textareaClass, "max-h-32 min-h-10 flex-1 resize-none")}
        />
        <button
          type="submit"
          aria-label={t("assist.send")}
          disabled={draft.trim() === "" || ask.isPending}
          className="inline-flex size-9 shrink-0 items-center justify-center rounded-full bg-fg text-surface transition-[opacity,transform] duration-120 active:scale-[0.97] disabled:opacity-40"
        >
          <ArrowUp className="size-4" aria-hidden />
        </button>
      </form>
    </>
  );
}

function Question({ text }: { text: string }) {
  return <p className="ml-8 rounded-card bg-surface-2 px-3 py-2 text-sm whitespace-pre-wrap text-fg">{text}</p>;
}

function Answer({ text }: { text: string }) {
  return (
    <div className="space-y-2 text-sm leading-relaxed text-fg">
      <Markdown source={text} />
    </div>
  );
}

function HistoryList({ current, onOpen }: { current: string | null; onOpen: (id: string | null) => void }) {
  const { t } = useI18n();
  const qc = useQueryClient();
  const confirm = useConfirm();
  const list = useQuery({
    queryKey: assistConversationsKey,
    queryFn: () => api<AssistConversationSummary[]>("/app/api/assist/conversations"),
  });
  const remove = useMutation({
    mutationFn: (id: string) => api(`/app/api/assist/conversations/${id}`, { method: "DELETE" }),
    onSuccess: (_, id) => {
      qc.removeQueries({ queryKey: assistConversationKey(id) });
      void qc.invalidateQueries({ queryKey: assistConversationsKey, exact: true });
      if (id === current) onOpen(null);
    },
  });

  if (list.isLoading) return <Spinner className="flex-1" />;
  if (list.isError) {
    return (
      <div className="p-4">
        <QueryError title={t("assist.history.error")} error={list.error} onRetry={() => void list.refetch()} />
      </div>
    );
  }
  const rows = list.data ?? [];
  return (
    <div className="flex-1 overflow-y-auto">
      <p className="border-b border-line px-4 py-2 text-[12px] text-fg-faint">{t("assist.retention")}</p>
      {rows.length === 0 ? (
        <p className="px-4 py-8 text-center text-sm text-fg-muted">{t("assist.history.empty")}</p>
      ) : (
        <ul className="divide-y divide-line">
          {rows.map((c) => (
            <li key={c.id} className="flex items-center gap-2 pr-2">
              <button
                type="button"
                onClick={() => onOpen(c.id)}
                className={cx(
                  "min-w-0 flex-1 px-4 py-2.5 text-left hover:bg-surface-2",
                  c.id === current && "font-semibold",
                )}
              >
                <span className="block truncate text-sm">{c.preview}</span>
                <RelativeTime iso={c.updatedAt} className="text-[12px] text-fg-faint" />
              </button>
              <IconButton
                size="sm"
                danger
                label={t("assist.delete")}
                onClick={async () => {
                  const yes = await confirm({
                    title: t("assist.delete.title"),
                    message: t("assist.delete.body"),
                    confirmLabel: t("assist.delete"),
                    danger: true,
                  });
                  if (yes) remove.mutate(c.id);
                }}
              >
                <Trash2 />
              </IconButton>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
