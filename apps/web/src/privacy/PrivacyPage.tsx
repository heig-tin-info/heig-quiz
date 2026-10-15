import { useEffect } from "react";

import { Logo } from "../Header";
import { type Locale, useI18n } from "../i18n";
import { MarkdownView } from "../markdown/MarkdownView";
import { PageHeader, Segmented } from "../ui";
import en from "./privacy.md?raw";
import fr from "./privacy.fr.md?raw";

/**
 * The "Data and privacy" page, `/privacy` (N-DATA-07): what the platform
 * records about a student, why, for how long, who sees it and which outside
 * services receive it. Static and public: drawn with no session and without
 * waiting on `/me`, like `/discover`, the same page for everyone signed in
 * or not, and it calls no API.
 *
 * The body is Markdown, one file per language beside this one, not `t()`
 * strings: a page of prose read as a document (the exception N-DATA-07
 * records). It is not under `src/help/`, whose files are the "?" drawer's
 * topics and the teacher assistant's corpus (ADR-080 §5); the assistant
 * already reads the full chapter, `docs/guide/data-protection.md`.
 *
 * A reading page has no primary action. The language is chosen here for
 * this browser only, as on `/discover`: a signed-out reader has no account
 * to persist it to.
 */
export const PRIVACY_SOURCES: Record<Locale, string> = { en, fr };

export function PrivacyPage() {
  const { t, locale, setLocale } = useI18n();
  useEffect(() => {
    document.title = `${t("privacy.title")} · Quiz`;
    return () => {
      document.title = "Quiz";
    };
  }, [t]);
  return (
    <div className="min-h-dvh bg-canvas text-fg">
      <header className="mx-auto flex h-16 max-w-3xl items-center gap-4 px-4 sm:px-8">
        <a href="/" aria-label={t("privacy.home")} className="shrink-0">
          <Logo className="w-24" />
        </a>
        <div className="ml-auto">
          <Segmented<Locale>
            name="privacy-locale"
            size="sm"
            label={t("discover.language")}
            value={locale}
            options={[
              { value: "fr", label: "FR" },
              { value: "en", label: "EN" },
            ]}
            onChange={(l) => setLocale(l, false)}
          />
        </div>
      </header>
      <main className="mx-auto max-w-3xl px-4 pt-6 pb-12 sm:px-8">
        <PageHeader title={t("privacy.title")} description={t("privacy.lead")} />
        <article className="mt-6 rounded-card border border-line bg-surface px-5 py-6 sm:px-10 sm:py-8">
          <MarkdownView source={PRIVACY_SOURCES[locale]} className="md-doc" />
        </article>
      </main>
      <footer className="pb-10 text-center text-xs text-fg-faint">{t("landing.footer")}</footer>
    </div>
  );
}
