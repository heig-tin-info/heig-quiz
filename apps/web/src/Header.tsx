import { useMutation, useQueryClient } from "@tanstack/react-query";
import {
  BookOpen,
  ChevronsUpDown,
  Code2,
  GraduationCap,
  LogOut,
  Moon,
  School,
  Settings as SettingsIcon,
  Sun,
} from "lucide-react";

import type { Me } from "@quiz/contracts";

import { api } from "./api";
import { useT } from "./i18n";
import { setThemeChoice, useResolvedTheme } from "./theme";
import { Avatar, cx, Menu, type MenuItem } from "./ui";

/**
 * The mark: a question mark inside the accent square. One glyph, drawn here
 * rather than borrowed from an icon set, because it is the only thing on the
 * page that is allowed to be the product's own.
 */
export function Logo({ className = "size-5" }: { className?: string }) {
  return (
    <span className="inline-flex shrink-0 items-center justify-center rounded-[10px] bg-accent p-1.5 text-on-fill">
      <svg
        viewBox="0 0 24 24"
        aria-hidden="true"
        fill="none"
        stroke="currentColor"
        strokeWidth="2.4"
        strokeLinecap="round"
        strokeLinejoin="round"
        className={className}
      >
        <path d="M8.5 8.5a3.5 3.5 0 1 1 4.6 3.33c-.9.3-1.6 1.1-1.6 2.05v.62" />
        <circle cx="11.5" cy="18" r="0.2" fill="currentColor" />
      </svg>
    </span>
  );
}

/**
 * Sign-out, shared by the account menu and the command palette. Dropping the
 * `me` query is what takes the app back to the landing page, and a second
 * copy of that would be a second place to get it wrong.
 */
export function useSignOut(): () => void {
  const qc = useQueryClient();
  const logout = useMutation({
    mutationFn: () => api("/app/auth/logout", { method: "POST" }),
    onSuccess: () => qc.setQueryData(["me"], null),
  });
  return () => logout.mutate();
}

/**
 * Account menu: settings, the teacher/student view switch, theme, the two
 * external links and sign-out. One trigger for the sidebar (full row) and
 * the mobile top bar (avatar only).
 */
export function UserMenu({
  me,
  compact,
  onOpenSettings,
  studentView,
  onToggleStudentView,
}: {
  me: Me;
  /** Avatar-only trigger (mobile top bar). */
  compact?: boolean;
  onOpenSettings: () => void;
  studentView?: boolean;
  onToggleStudentView?: () => void;
}) {
  const t = useT();
  // Shared store, so the Settings segmented control and this toggle can
  // never disagree about what is on screen.
  const theme = useResolvedTheme();
  const signOut = useSignOut();
  const items: MenuItem[] = [
    { label: t("menu.settings"), icon: SettingsIcon, onSelect: onOpenSettings },
    ...(onToggleStudentView
      ? [
          {
            label: studentView ? t("menu.teacherView") : t("menu.studentView"),
            icon: studentView ? School : GraduationCap,
            onSelect: onToggleStudentView,
          },
        ]
      : []),
    {
      label: theme === "dark" ? t("menu.lightTheme") : t("menu.darkTheme"),
      icon: theme === "dark" ? Sun : Moon,
      // Flips what is on screen and stores that as an explicit choice: a
      // toggle with two labels cannot express "system".
      onSelect: () => setThemeChoice(theme === "dark" ? "light" : "dark"),
    },
    { label: t("header.docs"), icon: BookOpen, href: DOCS_URL, separator: true },
    { label: t("header.sources"), icon: Code2, href: SOURCES_URL },
    { label: t("menu.signout"), icon: LogOut, onSelect: signOut, separator: true },
  ];
  return (
    <Menu
      items={items}
      label={t("menu.user")}
      align={compact ? "end" : "start"}
      trigger={
        compact ? (
          <button
            type="button"
            aria-label={t("menu.user")}
            className="rounded-full transition-opacity hover:opacity-80"
          >
            <Avatar me={me} className="size-8 text-xs" />
          </button>
        ) : (
          <button
            type="button"
            aria-label={t("menu.user")}
            className={cx(
              "flex w-full items-center gap-2.5 rounded-xl px-2 py-1.5 text-left transition-colors hover:bg-surface-2",
            )}
          >
            <Avatar me={me} className="size-8 text-xs" />
            <span className="min-w-0 flex-1">
              <span className="block truncate text-sm font-semibold leading-tight">
                {me.givenName} {me.familyName}
              </span>
              <span className="block truncate text-xs text-fg-muted">{me.email}</span>
            </span>
            <ChevronsUpDown className="size-4 shrink-0 text-fg-faint" />
          </button>
        )
      }
    />
  );
}

/** The two external destinations, shared with the command palette. */
export const DOCS_URL = "https://github.com/heig-tin-info/quiz/tree/main/docs";
export const SOURCES_URL = "https://github.com/heig-tin-info/quiz";
