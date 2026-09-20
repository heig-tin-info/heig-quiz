/**
 * `/results/:attemptId` — the student's own feedback.
 *
 * TODO(WP10): `packages/contracts` carries no `GET /attempts/:id/feedback`
 * yet — the `results` module and its per-item review are WP10's. Until it
 * lands this page states the one true thing (the answers are in, the result
 * is not published) instead of inventing a grade or 404-ing a link the home
 * page already offers.
 *
 * When the endpoint exists, this becomes: the grade header (`Stat` points +
 * grade), then one card per item rendered by the type's own `Review`, and the
 * feedback policy decides what each card may show.
 */
import { Hourglass } from "lucide-react";

import { useT } from "../i18n";
import type { Route } from "../router";
import { Button, Card, EmptyState, PageHeader } from "../ui";

export function Feedback({
  navigate,
}: {
  /** Read once the WP10 endpoint exists; the placeholder needs nothing. */
  attemptId: string;
  navigate: (r: Route) => void;
}) {
  const t = useT();
  return (
    <div className="space-y-6">
      <PageHeader title={t("feedback.title")} />
      <Card>
        <EmptyState
          icon={Hourglass}
          title={t("feedback.pending.title")}
          action={
            <Button variant="primary" onClick={() => navigate({ view: "home" })}>
              {t("feedback.home")}
            </Button>
          }
        >
          {t("feedback.pending.body")}
        </EmptyState>
      </Card>
    </div>
  );
}
