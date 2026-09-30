/**
 * The words of a notification that leaves the platform (ADR-030): the e-mail
 * and the preview line of a Teams activity, rendered on the server in the
 * RECIPIENT's language (`users.locale`, English when unset), never the
 * sender's — and every user-facing string of the Teams app package (its
 * name, descriptions, tab and activity types), whose French half becomes the
 * package's `fr.json`.
 *
 * One typed dictionary, the web app's rule mirrored: `fr` is
 * `Record<keyof typeof en, string>`, so a missing French sentence is a
 * compile error. The bell is NOT rendered here — the web app turns the same
 * payload into its own sentence (`NotificationPanel.tsx`).
 *
 * Every value that comes from a user (a pool name, a title, a display name)
 * is escaped before it lands in HTML, and the subject line is flattened to
 * one line. The payload carries ids and titles only: nothing here can leak a
 * grade or question content, because nothing of the kind is ever passed in.
 */
import type { NotificationKind, NotificationPayload } from "@quiz/contracts";

export type MailLocale = "en" | "fr";

const en = {
  "results_released.subject": "Results available: {evaluationTitle}",
  "results_released.body": "The results of “{evaluationTitle}” are available.",
  "results_released.action": "See my results",
  "activity_scheduled.subject": "{count} exercises scheduled in {classroomName}",
  "activity_scheduled.subject.one": "An exercise scheduled in {classroomName}",
  "activity_scheduled.body": "{count} exercises were scheduled in {classroomName}.",
  "activity_scheduled.body.one": "An exercise was scheduled in {classroomName}.",
  "activity_scheduled.action": "See my activities",
  "activity_available.subject": "Exercise open: {evaluationTitle}",
  "activity_available.body": "The exercise “{evaluationTitle}” is open. You can take it now.",
  "activity_available.action": "Open the exercise",
  "deadline_approaching.subject": "Closes within 24 hours: {evaluationTitle}",
  "deadline_approaching.body": "“{evaluationTitle}” closes in less than 24 hours, and you have not submitted it yet.",
  "deadline_approaching.action": "Open the evaluation",
  "results_updated.subject": "Results updated: {evaluationTitle}",
  "results_updated.body": "Your grade for “{evaluationTitle}” changed after a correction.",
  "results_updated.action": "See my results",
  "pool_shared.subject": "A pool was shared with you: {poolName}",
  "pool_shared.body": "{byName} shared the pool “{poolName}” with you as {role}.",
  "pool_shared.action": "Open the pool",
  "pool_ownership.subject": "You now own the pool {poolName}",
  "pool_ownership.body": "You are now the owner of the pool “{poolName}” (from {fromName}).",
  "pool_ownership.action": "Open the pool",
  "student_joined.subject": "{count} students joined {classroomName}",
  "student_joined.subject.one": "A student joined {classroomName}",
  "student_joined.body": "{count} students took their seat in {classroomName}.",
  "student_joined.body.one": "A student took their seat in {classroomName}.",
  "student_joined.action": "Open the roster",
  "roster_conflict.subject": "{count} roster entries of {classroomName} need your decision",
  "roster_conflict.subject.one": "A roster entry of {classroomName} needs your decision",
  "roster_conflict.body": "{count} entries of the roster of {classroomName} could not be matched to an account on their own and need your decision.",
  "roster_conflict.body.one": "An entry of the roster of {classroomName} could not be matched to an account on its own and needs your decision.",
  "roster_conflict.action": "Open the roster",
  "grading_ready.subject": "{count} proposals to validate: {evaluationTitle}",
  "grading_ready.subject.one": "A proposal to validate: {evaluationTitle}",
  "grading_ready.body": "The automatic grading of “{evaluationTitle}” is finished. {count} proposals await your validation.",
  "grading_ready.body.one": "The automatic grading of “{evaluationTitle}” is finished. A proposal awaits your validation.",
  "grading_ready.action": "Open the grading",
  "pool_question_added.subject": "{count} questions published in {poolName}",
  "pool_question_added.subject.one": "A question published in {poolName}",
  "pool_question_added.body": "Colleagues published {count} questions in the pool “{poolName}”.",
  "pool_question_added.body.one": "A colleague published a question in the pool “{poolName}”.",
  "pool_question_added.action": "Open the pool",
  "role.reader": "reader",
  "role.contributor": "contributor",
  "role.owner": "owner",
  footer: "You receive this message from HEIG Quiz. Choose which notifications reach you, and where, in your settings:",
  "footer.link": "Notification settings",
  // The Teams app package (`teamsApp.ts`). Teams caps: name.short 30,
  // name.full 100, description.short 80, an activity's description and
  // templateText 128. The `{…}` of a templateText are the activity's
  // template parameters (`activityParameters`), filled by Teams.
  "app.name.short": "HEIG Quiz",
  "app.name.full": "HEIG Quiz notifications",
  "app.description.short": "Your HEIG Quiz notifications, in your Teams activity feed.",
  "app.description.full":
    "HEIG Quiz sends its notifications to your Teams activity feed: released results, pools shared with you, news of your classrooms and your evaluations. Open the app once and link it to your Quiz account, then choose in the platform's settings which notifications reach you in Teams.",
  "app.tab.name": "Home",
  "activity.results_released.description": "The results of an evaluation you took are released",
  "activity.results_released.template": "Results available: {evaluationTitle}",
  "activity.pool_shared.description": "A pool is shared with you",
  "activity.pool_shared.template": "{byName} shared the pool {poolName} with you",
  "activity.pool_ownership.description": "You become the owner of a pool",
  "activity.pool_ownership.template": "You now own the pool {poolName}",
  "activity.student_joined.description": "Students join one of your classrooms",
  "activity.student_joined.template": "New in {classroomName}: {count} student(s)",
  "activity.roster_conflict.description": "Roster entries of one of your classrooms need your decision",
  "activity.roster_conflict.template": "Roster of {classroomName}: {count} entry(ies) to decide",
  "activity.grading_ready.description": "Automatic grading finished and proposals await your validation",
  "activity.grading_ready.template": "Grading to validate: {evaluationTitle}",
  "activity.pool_question_added.description": "A colleague publishes questions in a pool you share",
  "activity.pool_question_added.template": "{poolName}: {count} new question(s)",
  "activity.activity_scheduled.description": "Exercises are scheduled in your classroom",
  "activity.activity_scheduled.template": "{classroomName}: {count} exercise(s) scheduled",
  "activity.activity_available.description": "An exercise opens",
  "activity.activity_available.template": "Exercise open: {evaluationTitle}",
  "activity.deadline_approaching.description": "An evaluation you have not submitted closes within 24 hours",
  "activity.deadline_approaching.template": "Closes within 24 hours: {evaluationTitle}",
  // Declared ahead of the kinds that will use them (ADR-030 §f): the app is
  // re-uploaded once for all of them. Their placeholders are the template
  // parameters those kinds will carry.
  "activity.results_updated.description": "Your grade of a released evaluation changes",
  "activity.results_updated.template": "Results updated: {evaluationTitle}",
} as const;

type Key = keyof typeof en;

const fr: Record<Key, string> = {
  "results_released.subject": "Résultats disponibles : {evaluationTitle}",
  "results_released.body": "Les résultats de « {evaluationTitle} » sont disponibles.",
  "results_released.action": "Voir mes résultats",
  "activity_scheduled.subject": "{count} exercices planifiés dans {classroomName}",
  "activity_scheduled.subject.one": "Un exercice planifié dans {classroomName}",
  "activity_scheduled.body": "{count} exercices ont été planifiés dans {classroomName}.",
  "activity_scheduled.body.one": "Un exercice a été planifié dans {classroomName}.",
  "activity_scheduled.action": "Voir mes activités",
  "activity_available.subject": "Exercice ouvert : {evaluationTitle}",
  "activity_available.body": "L'exercice « {evaluationTitle} » est ouvert. Vous pouvez le faire dès maintenant.",
  "activity_available.action": "Ouvrir l'exercice",
  "deadline_approaching.subject": "Se termine dans les 24 heures : {evaluationTitle}",
  "deadline_approaching.body": "« {evaluationTitle} » se termine dans moins de 24 heures et vous n'avez pas encore rendu votre travail.",
  "deadline_approaching.action": "Ouvrir l'évaluation",
  "results_updated.subject": "Résultats mis à jour : {evaluationTitle}",
  "results_updated.body": "Votre note de « {evaluationTitle} » a changé après une correction.",
  "results_updated.action": "Voir mes résultats",
  "pool_shared.subject": "Une banque a été partagée avec vous : {poolName}",
  "pool_shared.body": "{byName} a partagé la banque « {poolName} » avec vous comme {role}.",
  "pool_shared.action": "Ouvrir la banque",
  "pool_ownership.subject": "Vous êtes propriétaire de la banque {poolName}",
  "pool_ownership.body": "Vous êtes désormais propriétaire de la banque « {poolName} » (de {fromName}).",
  "pool_ownership.action": "Ouvrir la banque",
  "student_joined.subject": "{count} étudiants ont rejoint {classroomName}",
  "student_joined.subject.one": "Un étudiant a rejoint {classroomName}",
  "student_joined.body": "{count} étudiants ont pris leur place dans {classroomName}.",
  "student_joined.body.one": "Un étudiant a pris sa place dans {classroomName}.",
  "student_joined.action": "Ouvrir la liste",
  "roster_conflict.subject": "{count} entrées de la liste de {classroomName} demandent votre décision",
  "roster_conflict.subject.one": "Une entrée de la liste de {classroomName} demande votre décision",
  "roster_conflict.body": "{count} entrées de la liste de {classroomName} n'ont pas pu être rattachées d'elles-mêmes à un compte et demandent votre décision.",
  "roster_conflict.body.one": "Une entrée de la liste de {classroomName} n'a pas pu être rattachée d'elle-même à un compte et demande votre décision.",
  "roster_conflict.action": "Ouvrir la liste",
  "grading_ready.subject": "{count} propositions à valider : {evaluationTitle}",
  "grading_ready.subject.one": "Une proposition à valider : {evaluationTitle}",
  "grading_ready.body": "La correction automatique de « {evaluationTitle} » est terminée. {count} propositions attendent votre validation.",
  "grading_ready.body.one": "La correction automatique de « {evaluationTitle} » est terminée. Une proposition attend votre validation.",
  "grading_ready.action": "Ouvrir la correction",
  "pool_question_added.subject": "{count} questions publiées dans {poolName}",
  "pool_question_added.subject.one": "Une question publiée dans {poolName}",
  "pool_question_added.body": "Des collègues ont publié {count} questions dans la banque « {poolName} ».",
  "pool_question_added.body.one": "Un collègue a publié une question dans la banque « {poolName} ».",
  "pool_question_added.action": "Ouvrir la banque",
  "role.reader": "lecteur",
  "role.contributor": "contributeur",
  "role.owner": "propriétaire",
  footer: "Vous recevez ce message de HEIG Quiz. Choisissez quelles notifications vous parviennent, et où, dans vos réglages :",
  "footer.link": "Réglages des notifications",
  "app.name.short": "HEIG Quiz",
  "app.name.full": "Notifications HEIG Quiz",
  "app.description.short": "Vos notifications HEIG Quiz, dans le flux d'activité de Teams.",
  "app.description.full":
    "HEIG Quiz envoie ses notifications dans votre flux d'activité Teams : résultats publiés, banques partagées avec vous, nouvelles de vos classes et de vos évaluations. Ouvrez l'application une fois et liez-la à votre compte Quiz, puis choisissez dans les réglages de la plateforme quelles notifications vous parviennent dans Teams.",
  "app.tab.name": "Accueil",
  "activity.results_released.description": "Les résultats d'une évaluation que vous avez passée sont publiés",
  "activity.results_released.template": "Résultats disponibles : {evaluationTitle}",
  "activity.pool_shared.description": "Une banque est partagée avec vous",
  "activity.pool_shared.template": "{byName} a partagé la banque {poolName} avec vous",
  "activity.pool_ownership.description": "Vous devenez propriétaire d'une banque",
  "activity.pool_ownership.template": "Vous êtes propriétaire de la banque {poolName}",
  "activity.student_joined.description": "Des étudiants rejoignent l'une de vos classes",
  "activity.student_joined.template": "Nouveau dans {classroomName} : {count} étudiant(s)",
  "activity.roster_conflict.description": "Des entrées de la liste d'une de vos classes demandent votre décision",
  "activity.roster_conflict.template": "Liste de {classroomName} : {count} entrée(s) à trancher",
  "activity.grading_ready.description": "La correction automatique est terminée et des propositions attendent votre validation",
  "activity.grading_ready.template": "Correction à valider : {evaluationTitle}",
  "activity.pool_question_added.description": "Un collègue publie des questions dans une banque que vous partagez",
  "activity.pool_question_added.template": "{poolName} : {count} nouvelle(s) question(s)",
  "activity.activity_scheduled.description": "Des exercices sont planifiés dans votre classe",
  "activity.activity_scheduled.template": "{classroomName} : {count} exercice(s) planifié(s)",
  "activity.activity_available.description": "Un exercice s'ouvre",
  "activity.activity_available.template": "Exercice ouvert : {evaluationTitle}",
  "activity.deadline_approaching.description": "Une évaluation que vous n'avez pas rendue se termine dans les 24 heures",
  "activity.deadline_approaching.template": "Se termine dans les 24 heures : {evaluationTitle}",
  "activity.results_updated.description": "Votre note d'une évaluation publiée change",
  "activity.results_updated.template": "Résultats mis à jour : {evaluationTitle}",
};

const DICTS: Record<MailLocale, Record<Key, string>> = { en, fr };

/** The whole dictionary of one language (the Teams app package reads it). */
export function serverText(locale: MailLocale): Record<Key, string> {
  return DICTS[locale];
}

/** The five characters that matter in text and in a quoted attribute. */
export function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/** `{name}` placeholders; `encode` is applied to the template AND each value. */
function fill(
  template: string,
  vars: Record<string, string>,
  encode: (s: string) => string,
): string {
  return encode(template).replace(/\{(\w+)\}/g, (whole, name: string) =>
    name in vars ? encode(vars[name]!) : whole,
  );
}

const plain = (s: string) => s;

/** One line, no control character: a subject is a header once it is sent. */
function oneLine(s: string): string {
  // eslint-disable-next-line no-control-regex
  return s.replace(/[\u0000-\u001f\u007f]+/g, " ").trim();
}

/** The values a kind's sentences read, and the page its link opens. */
function varsOf(payload: NotificationPayload, t: Record<Key, string>): Record<string, string> {
  switch (payload.kind) {
    case "results_released":
      return { evaluationTitle: payload.evaluationTitle };
    case "pool_shared":
      return { poolName: payload.poolName, byName: payload.byName, role: t[`role.${payload.role}`] };
    case "pool_ownership":
      return { poolName: payload.poolName, fromName: payload.fromName };
    case "activity_scheduled":
    case "student_joined":
    case "roster_conflict":
      return { classroomName: payload.classroomName, count: String(payload.count) };
    case "activity_available":
      // The sentences name an exercise, and `{evaluationTitle}` is a template
      // parameter of the Teams app its users installed: renaming it would
      // need a new TEAMS_APP_VERSION that every one of them re-uploads.
      return { evaluationTitle: payload.activityTitle };
    case "deadline_approaching":
    case "results_updated":
      return { evaluationTitle: payload.evaluationTitle };
    case "grading_ready":
      return { evaluationTitle: payload.evaluationTitle, count: String(payload.count) };
    case "pool_question_added":
      return { poolName: payload.poolName, count: String(payload.count) };
  }
}

/**
 * The kinds whose `count` only serves the fold (§e) and never the sentence:
 * how many corrections were folded into a `results_updated` is not news to a
 * student. They have no `.one` sentence.
 */
const UNCOUNTED_KINDS: ReadonlySet<NotificationKind> = new Set(["results_updated"]);

/**
 * The key of a kind's subject or body: a kind that counts has a singular
 * sentence of its own (`.one`), since "1 students" is not a sentence in
 * either language.
 */
function sentenceKey(payload: NotificationPayload, part: "subject" | "body"): Key {
  const one =
    "count" in payload && payload.count === 1 && !UNCOUNTED_KINDS.has(payload.kind) ? ".one" : "";
  return `${payload.kind}.${part}${one}` as Key;
}

/**
 * Where a notification takes its reader in the app, the same page the bell
 * opens (`notificationRoute` in the web app).
 */
export function notificationPath(payload: NotificationPayload): string {
  switch (payload.kind) {
    case "results_released":
    case "results_updated":
      return `/attempts/${payload.attemptId}/feedback`;
    case "pool_shared":
    case "pool_ownership":
    case "pool_question_added":
      return `/pools/${payload.poolId}`;
    case "student_joined":
    case "roster_conflict":
      return `/classrooms/${payload.classroomId}?tab=roster`;
    case "grading_ready":
      return `/evaluations/${payload.evaluationId}/grading`;
    // The student home lists what is coming; the page of an attempt lets the
    // student in (the server decides between the lobby and the player).
    case "activity_scheduled":
      return "/";
    case "deadline_approaching":
      return `/take/${payload.evaluationId}`;
    case "activity_available":
      switch (payload.activityKind) {
        case "evaluation":
          return `/take/${payload.activityId}`;
      }
  }
}

export interface RenderedNotification {
  subject: string;
  /** The plain-text part of the e-mail. */
  text: string;
  /** The HTML part of the e-mail. */
  html: string;
  /** What the notification is about, by name (the evaluation, the pool): the Teams activity's topic. */
  topic: string;
  /** The body as one line: the Teams activity's preview. */
  preview: string;
}

/** What Teams shows of an activity's topic and preview; longer is cut with an ellipsis. */
export const TEAMS_LINE_MAX = 150;

/** One line of at most {@link TEAMS_LINE_MAX} characters, an ellipsis marking a cut. */
function teamsLine(s: string): string {
  const line = oneLine(s);
  return line.length > TEAMS_LINE_MAX ? `${line.slice(0, TEAMS_LINE_MAX - 1)}…` : line;
}

/** Narrows `users.locale` (null, or a value this dictionary lacks) to a language. */
export function mailLocale(locale: string | null | undefined): MailLocale {
  return locale === "fr" ? "fr" : "en";
}

/**
 * Renders one notification for one recipient. `webUrl` is where a browser
 * reaches the SPA (`WEB_URL`, which defaults to `PUBLIC_URL`; `config.ts` strips its
 * trailing slash, once for every caller).
 */
export function renderNotification(
  payload: NotificationPayload,
  locale: MailLocale,
  webUrl: string,
): RenderedNotification {
  const t = DICTS[locale];
  const kind: NotificationKind = payload.kind;
  const vars = varsOf(payload, t);
  const base = webUrl;
  const link = `${base}${notificationPath(payload)}`;
  const settings = `${base}/settings`;

  const subject = oneLine(fill(t[sentenceKey(payload, "subject")], vars, plain));
  const body = fill(t[sentenceKey(payload, "body")], vars, plain);
  const action = t[`${kind}.action`];

  const text = [body, "", `${action}: ${link}`, "", "--", `${t.footer} ${settings}`].join("\n");

  const bodyHtml = fill(t[sentenceKey(payload, "body")], vars, escapeHtml);
  const html = `<div style="font-family:system-ui,-apple-system,sans-serif;max-width:560px;margin:0 auto;padding:24px;color:#18181b">
  <p style="font-size:13px;font-weight:600;letter-spacing:.02em;color:#71717a;margin:0 0 16px">HEIG Quiz</p>
  <p style="font-size:15px;line-height:1.6;margin:0 0 20px">${bodyHtml}</p>
  <p style="margin:0 0 28px"><a href="${escapeHtml(link)}" style="background:#18181b;color:#ffffff;text-decoration:none;padding:10px 16px;border-radius:8px;font-size:14px;font-weight:500">${escapeHtml(action)}</a></p>
  <p style="font-size:12px;line-height:1.5;color:#71717a;border-top:1px solid #e4e4e7;padding-top:12px;margin:0">${escapeHtml(t.footer)} <a href="${escapeHtml(settings)}" style="color:#71717a">${escapeHtml(t["footer.link"])}</a></p>
</div>`;

  const topic =
    teamsLine(vars.evaluationTitle ?? vars.poolName ?? vars.classroomName ?? "") || t["app.name.short"];
  const preview = teamsLine(body);

  return { subject, text, html, topic, preview };
}

/** The `{name}` placeholders of a template, in order. */
export function placeholders(template: string): string[] {
  return [...template.matchAll(/\{(\w+)\}/g)].map((m) => m[1]!);
}

/**
 * The template parameters of a Teams activity: exactly the placeholders of
 * the kind's `templateText` (the same in both languages — a test holds them
 * to it), valued from the payload. Teams fills the text in the language of
 * the recipient's client, so no value here is a translated word.
 */
export function activityParameters(payload: NotificationPayload): Record<string, string> {
  const vars = varsOf(payload, en);
  return Object.fromEntries(
    placeholders(en[`activity.${payload.kind}.template`]).map((name) => [name, oneLine(vars[name] ?? "")]),
  );
}
