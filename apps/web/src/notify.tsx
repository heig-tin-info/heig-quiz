import { AlertTriangle, Bell, CheckCircle2, Info, Loader2, X } from "lucide-react";
import { createContext, useCallback, useContext, useRef, useState, type ReactNode } from "react";

import { apiErrorMessage } from "./api";
import { useT, type Dict } from "./i18n";
import { Z } from "./ui";

/**
 * Toasts, bottom right, slide-in/out (see `toast-*` keyframes in style.css).
 * Two entry points share the stack:
 * - `useNotify()(sentence)` — a notification arriving (ADR-030, addendum
 *   §a): the App channel is the bell AND this toast. Which notifications
 *   toast, and when, is decided by `notifications/toasts.ts`; the sentence
 *   is the bell's, in the reader's language;
 * - `useToast()(message, tone?, options?)` — one-shot flow feedback, never
 *   gated: the user just did the action. `options.action` adds ONE button
 *   to the toast — Undo after a move of a group set (ADR-070 §6) — which
 *   runs it and dismisses the toast; `options.key` makes a toast replace
 *   the one standing with the same key, so only the latest move can be
 *   undone. `options.corner: "top"` puts it in the top-right stack instead,
 *   under the page's top bar when one publishes `--bar-h`, for a notice
 *   that must not land on a footer's actions.
 */

/**
 * `progress` is the "this has started" tone: an action taken from an overflow
 * menu has nowhere else to say so, because the menu closes as it is picked.
 * It is neutral on purpose — nothing has gone right or wrong yet.
 */
export type ToastTone = "success" | "error" | "warning" | "progress" | "info";

const TONE_ICONS: Record<ToastTone, typeof CheckCircle2> = {
  success: CheckCircle2,
  error: AlertTriangle,
  warning: AlertTriangle,
  progress: Loader2,
  info: Info,
};

const TONE_COLORS: Record<ToastTone, string> = {
  success: "text-success",
  error: "text-danger",
  warning: "text-warning",
  progress: "animate-spin text-fg-faint",
  info: "text-info",
};

/** The one button a toast may carry: what it says, and what it does. */
export interface ToastAction {
  label: string;
  run: () => void;
}

export interface ToastOptions {
  action?: ToastAction;
  /** A toast with this key replaces the one standing with the same key. */
  key?: string;
  /** `top`: the top-right stack, under the player's bar. Bottom right otherwise. */
  corner?: "top";
}

interface Toast {
  id: number;
  icon: typeof CheckCircle2;
  iconColor: string;
  message: string;
  action?: ToastAction;
  key?: string;
  corner?: "top" | undefined;
  /** Plays the exit animation; the entry is removed when it ends. */
  leaving?: boolean;
}

const ToastContext = createContext<{
  notify: (sentence: string) => void;
  toast: (message: string, tone?: ToastTone, options?: ToastOptions) => void;
}>({
  notify: () => {},
  toast: () => {},
});

export function useNotify() {
  return useContext(ToastContext).notify;
}

export function useToast() {
  return useContext(ToastContext).toast;
}

/**
 * The failed-mutation toast: what the server said, or the translated
 * `fallback`, always in the `error` tone. `onError: toastError("error.save")`
 * reads as what it does, where the long form repeated the same plumbing at
 * two dozen sites.
 */
export function useErrorToast(): (fallback: keyof Dict) => (error: unknown) => void {
  const toast = useToast();
  const t = useT();
  return (fallback) => (error) => toast(apiErrorMessage(error, t(fallback)), "error");
}

const AUTO_DISMISS_MS = 6000;

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const seq = useRef(0);

  // Two-step removal: flag `leaving` so the slide-out animation plays, the
  // element itself is dropped by its onAnimationEnd.
  const dismiss = useCallback((id: number) => {
    setToasts((prev) => prev.map((t) => (t.id === id ? { ...t, leaving: true } : t)));
  }, []);

  const drop = useCallback((id: number) => setToasts((prev) => prev.filter((t) => t.id !== id)), []);

  const push = useCallback(
    (icon: typeof CheckCircle2, iconColor: string, message: string, options: ToastOptions = {}) => {
      const id = ++seq.current;
      const { action, key, corner } = options;
      setToasts((prev) => {
        // The toast it replaces goes at once: two Undo buttons for one move would be one too many.
        const kept = prev.filter((t) => key === undefined || t.key !== key);
        // Five at most per corner: a burst at the bottom never evicts a top notice.
        const same = kept.filter((t) => t.corner === corner);
        const evicted = new Set(same.slice(0, Math.max(0, same.length - 4)));
        return [...kept.filter((t) => !evicted.has(t)), { id, icon, iconColor, message, action, key, corner }];
      });
      setTimeout(() => dismiss(id), AUTO_DISMISS_MS);
    },
    [dismiss],
  );

  const notify = useCallback((sentence: string) => push(Bell, "text-accent", sentence), [push]);

  const toast = useCallback(
    (message: string, tone: ToastTone = "success", options?: ToastOptions) => {
      push(TONE_ICONS[tone], TONE_COLORS[tone], message, options);
    },
    [push],
  );

  return (
    <ToastContext.Provider value={{ notify, toast }}>
      {children}
      {/* One polite live region per stack: a toast appearing is announced,
          and the dismiss buttons stay reachable with the keyboard (the
          wrapper is click-through, each toast is not). */}
      <ToastStack
        toasts={toasts.filter((t) => t.corner === undefined)}
        className="bottom-[calc(1rem+var(--bottom-nav-h)+var(--fab-h)+var(--tool-dock-h))]"
        dismiss={dismiss}
        drop={drop}
      />
      {/* Under the page's top bar, if it has one (`--bar-h`, the player's). */}
      <ToastStack
        toasts={toasts.filter((t) => t.corner === "top")}
        className="top-[calc(var(--banner-h)+var(--bar-h)+0.5rem)]"
        dismiss={dismiss}
        drop={drop}
      />
    </ToastContext.Provider>
  );
}

function ToastStack({
  toasts,
  className,
  dismiss,
  drop,
}: {
  toasts: Toast[];
  className: string;
  dismiss: (id: number) => void;
  /** Removes the entry once its exit animation has played. */
  drop: (id: number) => void;
}) {
  // `translate`, not `t`: each toast below is already called `t`, and a
  // shadowed translator is a runtime crash, not a type error.
  const translate = useT();
  return (
    <div
      aria-live="polite"
      aria-relevant="additions"
      className={`pointer-events-none fixed right-4 ${Z.toast} flex flex-col items-end gap-2 ${className}`}
    >
      {toasts.map((t) => {
        const Icon = t.icon;
        return (
          <div
            key={t.id}
            className={`pointer-events-auto flex max-w-sm items-start gap-2.5 rounded-menu border border-line bg-surface py-2.5 pl-3.5 pr-2 text-sm shadow-overlay ${t.leaving ? "toast-leave" : "toast-enter"}`}
            role="status"
            onAnimationEnd={() => {
              if (t.leaving) drop(t.id);
            }}
          >
            <Icon className={`mt-0.5 size-4 shrink-0 ${t.iconColor}`} />
            <span className="text-fg">{t.message}</span>
            {t.action ? (
              <button
                type="button"
                onClick={() => {
                  t.action!.run();
                  dismiss(t.id);
                }}
                className="-my-0.5 shrink-0 rounded-full px-2 py-0.5 font-semibold text-fg underline-offset-2 transition-colors hover:bg-surface-2 hover:underline"
              >
                {t.action.label}
              </button>
            ) : null}
            <button
              type="button"
              aria-label={translate("toast.dismiss")}
              onClick={() => dismiss(t.id)}
              className="ml-1 rounded-full p-1 text-fg-faint transition-colors hover:bg-surface-2 hover:text-fg"
            >
              <X className="size-3.5" />
            </button>
          </div>
        );
      })}
    </div>
  );
}
