import { AlertTriangle, Bell, CheckCircle2, Loader2, X } from "lucide-react";
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
 * - `useToast()(message, tone?)` — one-shot flow feedback, never gated: the
 *   user just did the action.
 */

/**
 * `progress` is the "this has started" tone: an action taken from an overflow
 * menu has nowhere else to say so, because the menu closes as it is picked.
 * It is neutral on purpose — nothing has gone right or wrong yet.
 */
type ToastTone = "success" | "error" | "warning" | "progress";

const TONE_ICONS: Record<ToastTone, typeof CheckCircle2> = {
  success: CheckCircle2,
  error: AlertTriangle,
  warning: AlertTriangle,
  progress: Loader2,
};

const TONE_COLORS: Record<ToastTone, string> = {
  success: "text-success",
  error: "text-danger",
  warning: "text-warning",
  progress: "animate-spin text-fg-faint",
};

interface Toast {
  id: number;
  icon: typeof CheckCircle2;
  iconColor: string;
  message: string;
  /** Plays the exit animation; the entry is removed when it ends. */
  leaving?: boolean;
}

const ToastContext = createContext<{
  notify: (sentence: string) => void;
  toast: (message: string, tone?: ToastTone) => void;
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
  // `translate`, not `t`: the toast being rendered below is already called
  // `t`, and a shadowed translator is a runtime crash, not a type error.
  const translate = useT();
  const [toasts, setToasts] = useState<Toast[]>([]);
  const seq = useRef(0);

  // Two-step removal: flag `leaving` so the slide-out animation plays, the
  // element itself is dropped by its onAnimationEnd.
  const dismiss = useCallback((id: number) => {
    setToasts((prev) => prev.map((t) => (t.id === id ? { ...t, leaving: true } : t)));
  }, []);

  const push = useCallback(
    (icon: typeof CheckCircle2, iconColor: string, message: string) => {
      const id = ++seq.current;
      setToasts((prev) => [...prev.slice(-4), { id, icon, iconColor, message }]);
      setTimeout(() => dismiss(id), AUTO_DISMISS_MS);
    },
    [dismiss],
  );

  const notify = useCallback((sentence: string) => push(Bell, "text-accent", sentence), [push]);

  const toast = useCallback(
    (message: string, tone: ToastTone = "success") => {
      push(TONE_ICONS[tone], TONE_COLORS[tone], message);
    },
    [push],
  );

  return (
    <ToastContext.Provider value={{ notify, toast }}>
      {children}
      {/* One polite live region around the stack: a toast appearing is
          announced, and the dismiss buttons stay reachable with the keyboard
          (the wrapper is click-through, each toast is not). */}
      <div
        aria-live="polite"
        aria-relevant="additions"
        className={`pointer-events-none fixed bottom-[calc(1rem+var(--bottom-nav-h))] right-4 ${Z.toast} flex flex-col items-end gap-2`}
      >
        {toasts.map((t) => {
          const Icon = t.icon;
          return (
            <div
              key={t.id}
              className={`pointer-events-auto flex max-w-sm items-start gap-2.5 rounded-menu border border-line bg-surface py-2.5 pl-3.5 pr-2 text-sm shadow-overlay ${t.leaving ? "toast-leave" : "toast-enter"}`}
              role="status"
              onAnimationEnd={() => {
                if (t.leaving) setToasts((prev) => prev.filter((x) => x.id !== t.id));
              }}
            >
              <Icon className={`mt-0.5 size-4 shrink-0 ${t.iconColor}`} />
              <span className="text-fg">{t.message}</span>
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
    </ToastContext.Provider>
  );
}
