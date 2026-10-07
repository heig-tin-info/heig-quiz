/**
 * The portal pages, as HTML served by Fastify. No front-end framework
 * (analyse.md D8): the portal shows only a landing page and its refusals.
 *
 * The "session outside SEB" refusal page is not here: it is provided by
 * `seb/routes.ts` (`outsideSebPage`), so that the message does not vary with
 * the route that refuses.
 *
 * The text is French only, as in heig-classroom; the platform's en/fr
 * dictionaries do not reach this separate deployable (an open point of M6).
 */
export function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

const STYLE = `
:root { color-scheme: light dark; }
body { font-family: system-ui, sans-serif; margin: 2rem auto; max-width: 62rem; padding: 0 1rem;
       line-height: 1.5; }
header { display: flex; justify-content: space-between; align-items: baseline; gap: 1rem;
         border-bottom: 1px solid currentColor; padding-bottom: .5rem; margin-bottom: 1.5rem; }
h1 { font-size: 1.4rem; margin: 0; }
`;

function layout(title: string, nav: string, body: string): string {
  return `<!doctype html>
<html lang="fr">
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${escapeHtml(title)}</title><style>${STYLE}</style></head>
<body>
<header><h1>${escapeHtml(title)}</h1><nav>${nav}</nav></header>
${body}
</body></html>
`;
}

/** `/`: where a session comes from, since nothing opens here. */
export function landingPage(): string {
  return layout(
    "Environnements de développement",
    "",
    "<p>Un environnement s'ouvre depuis la plateforme, par le bouton <em>Ouvrir</em> " +
      "de l'activité.</p>",
  );
}

/** Generic portal error page, in French and without technical detail. */
export function errorPage(title: string, detail: string): string {
  return layout(title, `<a href="/">Retour</a>`, `<p>${escapeHtml(detail)}</p>`);
}

/**
 * Start refusal because the student's repository could not be fetched. The page
 * exists because the opposite — opening the editor on an empty directory —
 * happened in production on 2026-09-17: nothing signalled that the repository
 * was missing, and the student worked beside their submission. The cause is
 * short and free of git jargon; the full detail is in the portal log, not here.
 */
export function workspaceErrorPage(cause: string): string {
  return errorPage(
    "Espace de travail impossible à préparer",
    `Espace de travail impossible à préparer : ${cause} ; signalez-le à votre enseignant.`,
  );
}
