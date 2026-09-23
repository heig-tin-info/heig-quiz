import { useMutation, useQueryClient } from "@tanstack/react-query";
import {
  BookOpen,
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
import quizLogo from "./assets/quiz.svg";
import { useT } from "./i18n";
import { setThemeChoice, useResolvedTheme } from "./theme";
import { Avatar, cx, IconButton, Menu, Segmented, type MenuItem } from "./ui";
import { meKey } from "./queryKeys";

/**
 * The mark: the product's wordmark — four speech bubbles spelling Q U I Z,
 * the first of them the HEIG red. It is an <img>, not inline SVG: the file is
 * the identity as it is delivered elsewhere (slides, the intranet), and a
 * copy retyped into JSX is a second version to keep in step. Its four colours
 * are its own, outside the token scale, which is why nothing else on a screen
 * is allowed them.
 *
 * `className` carries the WIDTH; the height follows. It is a drawn word, so
 * it is sized like a word — about 200 px in the sidebar, 110 px in the phone
 * top bar, 220 px on the door — and never like a 20 px icon.
 */
export function Logo({ className = "w-28", id }: { className?: string; id?: string }) {
  return <img src={quizLogo} id={id} alt="Quiz" className={cx("h-auto", className)} />;
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
    onSuccess: () => qc.setQueryData(meKey, null),
  });
  return () => logout.mutate();
}

/**
 * The master switch of the frame: TEACHER or STUDENT, on every page a teacher
 * can be on (ADR-018 addendum).
 *
 * It used to be a button on the evaluation configuration page and nowhere
 * else, so a teacher who had launched the quiz — and was therefore on the
 * live dashboard — could start the exam and not join it. The switch belongs
 * to the frame for the same reason the theme toggle does: it is about the
 * whole window, not about the page under it.
 *
 * The four decisions, so it reads as chrome and not as a call to action:
 *   - Type: 12 px pills, under the 14 px of the navigation rows above them.
 *   - Color: none on the desktop control. The track is `surface-3` and the
 *     selected pill is `surface` — the screen's one accent stays on the
 *     page's primary action, and the student view says what it is with the
 *     banner. The phone's icon keeps `IconButton`'s pressed chip, which is
 *     how every other toggle of the product says "on".
 *   - Space: it shares the bottom block with the account row, one hairline
 *     under the navigation, 8 px between the two.
 *   - Finish: hairline and surfaces, no shadow; it sits in the flow.
 *
 * `compact` is the phone top bar, which has no room for two words: one
 * `IconButton` that draws the view it switches TO, with that as its label.
 */
export function ViewModeToggle({
  studentView,
  onToggle,
  compact,
}: {
  studentView: boolean;
  onToggle: () => void;
  /** Icon-only trigger (mobile top bar). */
  compact?: boolean;
}) {
  const t = useT();
  if (compact) {
    return (
      <IconButton
        label={studentView ? t("menu.teacherView") : t("menu.studentView")}
        active={studentView}
        onClick={onToggle}
      >
        {studentView ? <School /> : <GraduationCap />}
      </IconButton>
    );
  }
  return (
    <Segmented
      name="view-as"
      label={t("view.label")}
      size="sm"
      value={studentView ? "student" : "teacher"}
      // A radio group answers with the value it was given, and only a
      // CHANGE flips anything: re-selecting the mode already on screen must
      // not re-enter the student view and overwrite the way back.
      onChange={(value) => {
        if ((value === "student") !== studentView) onToggle();
      }}
      options={[
        {
          value: "teacher",
          label: (
            <span className="inline-flex items-center gap-1.5">
              <School className="size-3.5" aria-hidden /> {t("view.teacher")}
            </span>
          ),
        },
        {
          value: "student",
          label: (
            <span className="inline-flex items-center gap-1.5">
              <GraduationCap className="size-3.5" aria-hidden /> {t("view.student")}
            </span>
          ),
        },
      ]}
    />
  );
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
          </button>
        )
      }
    />
  );
}

/** The two external destinations, shared with the command palette. */
export const DOCS_URL = "https://heig-tin-info.github.io/heig-quiz/";
export const SOURCES_URL = "https://github.com/heig-tin-info/heig-quiz";
