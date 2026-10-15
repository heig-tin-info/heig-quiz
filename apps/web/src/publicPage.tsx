import { useEffect } from "react";

import { LOCALES } from "@quiz/domain";

import { type Locale, useI18n } from "./i18n";
import { routeToPath } from "./router";
import { Segmented } from "./ui";

/*
 * What the pages drawn with no session share (the landing page, `/discover`,
 * `/privacy`): a language switch, the footer's credit line, the tab's title.
 */

/**
 * The language, chosen for this browser only: a signed-out reader has no
 * account to persist it to. One option per interface language, named by its
 * code.
 */
export function LocaleSwitch({ name }: { name: string }) {
  const { t, locale, setLocale } = useI18n();
  return (
    <Segmented<Locale>
      name={name}
      size="sm"
      label={t("discover.language")}
      value={locale}
      options={LOCALES.map((l) => ({ value: l, label: l.toUpperCase() }))}
      onChange={(l) => setLocale(l, false)}
    />
  );
}

/** The footer's credit line, with the link to the "Data and privacy" page (N-DATA-07). */
export function FooterCredit({ className }: { className?: string }) {
  const { t } = useI18n();
  return (
    <span className={className}>
      {t("landing.footer")}
      {" · "}
      <a
        href={routeToPath({ view: "privacy" })}
        className="underline underline-offset-2 transition-colors hover:text-fg"
      >
        {t("privacy.title")}
      </a>
    </span>
  );
}

/** The tab's title while the page is up; "Quiz" again once it leaves. */
export function useDocumentTitle(title: string) {
  useEffect(() => {
    document.title = title;
    return () => {
      document.title = "Quiz";
    };
  }, [title]);
}
