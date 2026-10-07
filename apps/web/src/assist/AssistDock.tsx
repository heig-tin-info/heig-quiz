/**
 * The teacher assistant (ADR-080, F-LLM-07): a round button at the bottom
 * right of every teacher screen, and the chat it opens above it.
 *
 * Like the calculator (ADR-069) the panel is a NON-modal floating layer: the
 * screen behind stays readable and usable, nothing is trapped, Escape or the
 * button closes it and gives focus back to the button. The button is the
 * neutral ink, never the accent, which stays the screen's primary action.
 * Its wrapper is a tool dock (`data-tool-dock`): the toasts rise above it;
 * under `lg` it steps aside while the pool's bulk bar is up (`style.css`).
 *
 * What it sends is the route pattern, the screen's help topic and the UI
 * language (`context.ts`), with the question. The conversation open in this
 * tab survives a reload (`sessionStorage`); the server keeps it 30 days.
 */
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowUp, History, MessageCircleQuestion, SquarePen, Trash2, X } from "lucide-react";
import { useEffect, useId, useRef, useState, type FormEvent } from "react";

import type {
  AssistAsk,
  AssistAvailability,
  AssistConversation,
  AssistConversationSummary,
  AssistMessage,
  AssistReply,
  Me,
} from "@quiz/contracts";
import { ASSIST_MAX_MESSAGE_CHARS } from "@quiz/domain";
import { textareaClass } from "@quiz/ui";

import { api, apiErrorMessage } from "../api";
import { useConfirm } from "../confirm";
import { useI18n } from "../i18n";
import { Markdown } from "../markdown";
import { assistAvailabilityKey, assistConversationKey, assistConversationsKey } from "../queryKeys";
import type { Route } from "../router";
import { Alert, Badge, cx, IconButton, QueryError, RelativeTime, Spinner, Z } from "../ui";
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
  const [open, setOpen] = useState(false);
  const [showHistory, setShowHistory] = useState(false);
  const [conversationId, setConversationId] = useState<string | null>(storedConversation);
  const trigger = useRef<HTMLButtonElement>(null);
  const panelId = useId();
  const titleId = useId();

  const select = (id: string | null) => {
    setConversationId(id);
    storeConversation(id);
    setShowHistory(false);
  };
  const close = () => {
    setOpen(false);
    trigger.current?.focus();
  };

  return (
    <div data-tool-dock data-assist-dock>
      {open ? (
        <section
          id={panelId}
          role="dialog"
          aria-modal="false"
          aria-labelledby={titleId}
          onKeyDown={(e) => {
            if (e.key !== "Escape") return;
            e.stopPropagation();
            close();
          }}
          className={cx(
            "fixed right-4 bottom-[calc(var(--bottom-nav-h)+var(--tool-dock-h)+1rem)] flex h-[min(36rem,calc(100dvh-var(--banner-h)-var(--bottom-nav-h)-var(--tool-dock-h)-5rem))] w-[24rem] max-w-[calc(100vw-2rem)] flex-col rounded-sheet border border-line bg-surface shadow-overlay sm:right-6",
            Z.tool,
          )}
        >
          <header className="flex items-center gap-2 border-b border-line py-2 pr-2 pl-4">
            <h2 id={titleId} className="text-[15px] font-bold tracking-tight">
              {t("assist.title")}
            </h2>
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
        </section>
      ) : null}
      <button
        ref={trigger}
        type="button"
        aria-label={open ? t("assist.close") : t("assist.open")}
        aria-expanded={open}
        aria-controls={open ? panelId : undefined}
        onClick={() => (open ? close() : setOpen(true))}
        className={cx(
          "fixed right-4 bottom-[calc(var(--bottom-nav-h)+1rem)] inline-flex size-12 items-center justify-center rounded-full border shadow-popover transition-[background-color,transform] duration-120 active:scale-[0.97] sm:right-6",
          // Open, the neutral ink fill of a pressed toggle, as the calculator's: never the accent.
          open ? "border-fg bg-fg text-surface" : "border-line bg-surface text-fg hover:bg-surface-2",
          Z.tool,
        )}
      >
        <MessageCircleQuestion className="size-5" aria-hidden />
      </button>
    </div>
  );
}

function Chat({
  route,
  conversationId,
  onConversation,
}: {
  route: Route;
  conversationId: string | null;
  onConversation: (id: string) => void;
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
  const ask = useMutation({
    mutationFn: (message: string) =>
      api<AssistReply>("/app/api/assist/ask", {
        method: "POST",
        body: JSON.stringify({
          message,
          context: assistContext(route, locale),
          ...(conversationId ? { conversationId } : {}),
        } satisfies AssistAsk),
      }),
    onSuccess: (reply) => {
      qc.setQueryData<AssistConversation>(assistConversationKey(reply.conversationId), (old) => ({
        id: reply.conversationId,
        createdAt: old?.createdAt ?? reply.question.createdAt,
        updatedAt: reply.answer.createdAt,
        messages: [...(old?.messages ?? []), reply.question, reply.answer],
      }));
      void qc.invalidateQueries({ queryKey: assistConversationsKey, exact: true });
      onConversation(reply.conversationId);
      setDraft("");
    },
  });

  // A conversation gone (purged, deleted in another tab) is forgotten: a new one starts.
  const gone = conversation.isError;
  useEffect(() => {
    input.current?.focus();
  }, [conversationId]);
  const messages: AssistMessage[] = conversationId && !gone ? (conversation.data?.messages ?? []) : [];
  const count = messages.length + (ask.isPending ? 1 : 0);
  useEffect(() => {
    end.current?.scrollIntoView?.({ block: "end" });
  }, [count]);

  const submit = (e?: FormEvent) => {
    e?.preventDefault();
    const message = draft.trim();
    if (message === "" || ask.isPending) return;
    ask.mutate(message);
  };

  return (
    <>
      <div className="flex-1 space-y-4 overflow-y-auto px-4 py-4" aria-live="polite">
        {conversationId && !gone && conversation.isLoading ? <Spinner className="py-8" /> : null}
        {messages.length === 0 && !ask.isPending && !(conversationId && conversation.isLoading) ? (
          <div className="space-y-2 py-6 text-center">
            <MessageCircleQuestion className="mx-auto size-6 text-fg-faint" aria-hidden />
            <p className="text-sm font-semibold">{t("assist.empty.title")}</p>
            <p className="text-[13px] text-fg-muted">{t("assist.empty.body")}</p>
          </div>
        ) : null}
        {messages.map((m) => (
          <Bubble key={m.id} message={m} />
        ))}
        {ask.isPending ? (
          <>
            <Bubble message={{ role: "user", content: ask.variables }} />
            <Spinner label={t("assist.thinking")} className="items-start py-1" />
          </>
        ) : null}
        {ask.isError ? (
          <Alert tone="danger">{apiErrorMessage(ask.error, t("assist.error"))}</Alert>
        ) : null}
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

function Bubble({ message }: { message: Pick<AssistMessage, "role" | "content"> }) {
  if (message.role === "user") {
    return (
      <p className="ml-8 rounded-card bg-surface-2 px-3 py-2 text-sm whitespace-pre-wrap text-fg">{message.content}</p>
    );
  }
  return (
    <div className="space-y-2 text-sm leading-relaxed text-fg">
      <Markdown source={message.content} />
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
