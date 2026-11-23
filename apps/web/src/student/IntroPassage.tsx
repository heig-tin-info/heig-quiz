import { useT } from "../i18n";
import { MarkdownView } from "../markdown/MarkdownView";
import { Card } from "../ui";

/**
 * The passage screen of ADR-084: the teacher's text before a question —
 * instructions, a transition, something to read or memorise — in place of
 * the question, until the student presses Continue (which `Player` draws
 * where the question's own actions go, as the screen's one primary action).
 *
 * The eyebrow names what follows, "Before question 3", in the place and the
 * style of the question's own "Question 3": the question list marks the
 * text's own entry, just before question 3, and the reader must not take the
 * text for a question to answer. The text is the teacher's markdown, rendered by the
 * one renderer a student sees (`MarkdownView`).
 *
 * Where Continue is one way (`forward_only`, `milestones`), one muted line
 * under the text says so before the student presses it: they cannot come
 * back to it.
 */
export function IntroPassage({
  source,
  index,
  oneWay,
}: {
  source: string;
  /** Zero-based position of the question the text precedes. */
  index: number;
  oneWay: boolean;
}) {
  const t = useT();
  return (
    <>
      <p
        aria-live="polite"
        className="mb-3 text-[13px] font-semibold uppercase tracking-wide text-fg-muted"
      >
        {t("player.intro.before", { n: index + 1 })}
      </p>
      <Card className="p-5 sm:p-6">
        <MarkdownView source={source} />
      </Card>
      {oneWay ? (
        <p className="mt-3 text-[13px] leading-relaxed text-fg-muted">{t("player.intro.oneWay")}</p>
      ) : null}
    </>
  );
}
