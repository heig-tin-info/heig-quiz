/**
 * Every sentence the portal shows a person, in English, French and German
 * (root invariant 1, ADR-140). The portal is a separate deployable: it
 * cannot import the SPA's dictionaries, so it keeps its own, with the same
 * rule — `fr` and `de` are typed against the keys of `en`, so a missing
 * translation is a compile error. English and French are written; German is
 * translated (ADR-140 §2), drafted like the platform's, but neither this
 * German nor that of the student image's scripts is covered by the review
 * tracking of ADR-140 §7 or by the German copy lint (both in `apps/web`).
 *
 * The language comes from the browser's `Accept-Language`, English when it
 * names none of the portal's languages, as on the platform (ADR-140 §4,
 * settled question 76). Placeholders are `{name}`, filled by `t()`; the HTML
 * around them escapes the result.
 */
import type { FastifyRequest } from "fastify";

const en = {
  // --- pages (web/pages.ts) -------------------------------------------------
  landingTitle: "Development environments",
  landingBody: "An environment opens from the platform, with the Open button of the activity.",
  back: "Back",
  workspaceErrorTitle: "The workspace could not be prepared",
  workspaceErrorDetail: "The workspace could not be prepared: {cause}. Tell your teacher.",
  // --- causes of a workspace that could not be prepared (sessions/manager.ts)
  sourceRepository: "the source repository",
  causeNoAccess: "the portal has no access to {where}",
  causeNotFound: "repository {where} not found",
  causeDenied: "access denied to repository {where}",
  causeFetchFailed: "{where} could not be fetched",
  causeEmptyTemplate: "the teacher's template has no branch",
  // --- /launch (classroom/routes.ts) -----------------------------------------
  launchRefused: "Launch refused",
  launchMissingToken: "No launch token.",
  launchExpired: "This launch link has expired. Go back to the platform and open the activity again.",
  launchInvalid: "This launch link is not valid. Go back to the platform and open the activity again.",
  launchIncomplete: "This launch link is incomplete.",
  launchReplayed:
    "This launch link has already been used. Go back to the platform and open the activity again.",
  launchUnknownAssignment:
    "This activity was not synchronized from the platform. Tell your teacher: the activity must be saved on the platform before it is opened.",
  launchClosed: "This activity is not open at the moment.",
  launchSittingClosed: "Your session on this station has ended. Call the supervisor.",
  launchRepoMissing: "Your repository is not ready for this activity yet. Try again in a moment.",
  launchBadAssignmentId: "This activity has an identifier the portal cannot use.",
  quotaTitle: "Quota reached",
  quotaDetail: "All of your teacher's environment places are taken. Try again later.",
  // --- /review (classroom/routes.ts): a staff member opens a repository -----
  reviewExpired: "This link has expired. Go back to the project page and open the repository in the workspace again.",
  reviewInvalid: "This link is not valid. Go back to the project page and open the repository in the workspace again.",
  reviewReplayed:
    "This link has already been used. Go back to the project page and open the repository in the workspace again.",
  reviewRepoMissing: "This repository is not available.",
  reviewQuotaDetail:
    "All the workspace places of this project are taken, or the staff already have two repositories open in the workspace. Close one and try again.",
  examOnlyInSeb: "This exam opens only from Safe Exam Browser.",
  // --- Safe Exam Browser (seb/routes.ts) -------------------------------------
  unknownAssignment: "Unknown activity",
  outsideSebTitle: "Session outside Safe Exam Browser",
  outsideSebIntro:
    "This exam can only be opened from Safe Exam Browser, started from the link your teacher gave you.",
  outsideSebHelp:
    "If you think this is a mistake, call the invigilator: do not start again from another browser.",
  sebOtherMachine: "This session was opened from another computer.",
  sebNoExamSession: "No valid exam session in this browser.",
  // --- the proxy (proxy/index.ts) --------------------------------------------
  sessionUnknownTitle: "Unknown session",
  sessionUnknownDetail: "This session does not exist, or no longer does.",
  sessionDeniedTitle: "Session not allowed",
  sessionDeniedDetail: "This browser's access to the session has ended, or was never given. Open it again from the platform.",
  assignmentGoneDetail: "The activity of this session no longer exists.",
  sessionClosedTitle: "Session closed",
  sessionClosedDetail: "This session was closed. Open it again from the platform; your work is kept.",
  reviewClosedDetail:
    "This workspace was closed, and nothing of it is kept. Open the repository in the workspace again from the project page.",
  sessionUnavailableTitle: "Session unavailable",
  sessionRestartFailed: "The container could not be restarted. Your volume is intact; try again.",
  sessionNoAddress: "The container has no address.",
  portProxyTitle: "Port forwarding unavailable",
  portProxyDetail: "The online workspace does not open a program's ports in the browser.",
};

export type MessageKey = keyof typeof en;

const fr: Record<MessageKey, string> = {
  landingTitle: "Environnements de développement",
  landingBody: "Un environnement s'ouvre depuis la plateforme, par le bouton Ouvrir de l'activité.",
  back: "Retour",
  workspaceErrorTitle: "Espace de travail impossible à préparer",
  workspaceErrorDetail:
    "Espace de travail impossible à préparer : {cause} ; signalez-le à votre enseignant.",
  sourceRepository: "le dépôt source",
  causeNoAccess: "le portail n'a pas les accès à {where}",
  causeNotFound: "dépôt {where} introuvable",
  causeDenied: "accès refusé au dépôt {where}",
  causeFetchFailed: "récupération de {where} impossible",
  causeEmptyTemplate: "le modèle de l'enseignant ne contient aucune branche",
  launchRefused: "Lancement refusé",
  launchMissingToken: "Aucun jeton de lancement.",
  launchExpired:
    "Ce lien de lancement a expiré. Retournez sur la plateforme et ouvrez de nouveau l'activité.",
  launchInvalid:
    "Ce lien de lancement n'est pas valide. Retournez sur la plateforme et ouvrez de nouveau l'activité.",
  launchIncomplete: "Ce lien de lancement est incomplet.",
  launchReplayed:
    "Ce lien de lancement a déjà servi. Retournez sur la plateforme et ouvrez de nouveau l'activité.",
  launchUnknownAssignment:
    "Activité non synchronisée depuis la plateforme. Prévenez votre enseignant : l'activité doit être enregistrée sur la plateforme avant d'être lancée.",
  launchClosed: "La fenêtre d'ouverture de cette activité est close.",
  launchSittingClosed: "Votre session sur ce poste est terminée. Appelez la surveillance.",
  launchRepoMissing:
    "Votre dépôt n'est pas encore prêt pour cette activité. Réessayez dans quelques instants.",
  launchBadAssignmentId: "Cette activité porte un identifiant inutilisable par le portail.",
  quotaTitle: "Quota atteint",
  quotaDetail:
    "Toutes les places d'environnement de votre enseignant sont occupées. Réessayez plus tard.",
  reviewExpired:
    "Ce lien a expiré. Retournez sur la page du projet et ouvrez de nouveau le dépôt dans l'espace de travail.",
  reviewInvalid:
    "Ce lien n'est pas valide. Retournez sur la page du projet et ouvrez de nouveau le dépôt dans l'espace de travail.",
  reviewReplayed:
    "Ce lien a déjà servi. Retournez sur la page du projet et ouvrez de nouveau le dépôt dans l'espace de travail.",
  reviewRepoMissing: "Ce dépôt n'est pas disponible.",
  reviewQuotaDetail:
    "Toutes les places d'espace de travail de ce projet sont occupées, ou l'équipe a déjà deux dépôts ouverts dans l'espace de travail. Fermez-en un et réessayez.",
  examOnlyInSeb: "Cette épreuve ne s'ouvre que depuis Safe Exam Browser.",
  unknownAssignment: "Activité inconnue",
  outsideSebTitle: "Session hors Safe Exam Browser",
  outsideSebIntro:
    "Cette épreuve ne peut être ouverte que depuis Safe Exam Browser, lancé par le lien fourni par l'enseignant.",
  outsideSebHelp:
    "Si vous pensez que c'est une erreur, appelez le surveillant : ne recommencez pas depuis un autre navigateur.",
  sebOtherMachine: "Cette session a été ouverte depuis un autre poste.",
  sebNoExamSession: "Aucune session d'examen valide sur ce navigateur.",
  sessionUnknownTitle: "Session inconnue",
  sessionUnknownDetail: "Cette session n'existe pas ou plus.",
  sessionDeniedTitle: "Session non autorisée",
  sessionDeniedDetail:
    "L'accès de ce navigateur à la session a pris fin, ou n'a jamais été donné. Rouvrez-la depuis la plateforme.",
  assignmentGoneDetail: "L'activité de cette session a disparu.",
  sessionClosedTitle: "Session fermée",
  sessionClosedDetail:
    "Cette session a été fermée. Rouvrez-la depuis la plateforme ; votre travail est conservé.",
  reviewClosedDetail:
    "Cet espace de travail a été fermé, et rien n'en est conservé. Ouvrez de nouveau le dépôt dans l'espace de travail depuis la page du projet.",
  sessionUnavailableTitle: "Session indisponible",
  sessionRestartFailed: "Le conteneur n'a pas pu être relancé. Votre volume est intact ; réessayez.",
  sessionNoAddress: "Le conteneur n'a pas d'adresse.",
  portProxyTitle: "Redirection de port indisponible",
  portProxyDetail: "L'espace de travail en ligne n'ouvre pas les ports d'un programme dans le navigateur.",
};

const de: Record<MessageKey, string> = {
  landingTitle: "Entwicklungsumgebungen",
  landingBody: "Eine Umgebung wird auf der Plattform geöffnet, mit der Schaltfläche «Öffnen» der Aktivität.",
  back: "Zurück",
  workspaceErrorTitle: "Der Arbeitsbereich konnte nicht vorbereitet werden",
  workspaceErrorDetail:
    "Der Arbeitsbereich konnte nicht vorbereitet werden: {cause}. Wenden Sie sich an das Lehrteam.",
  sourceRepository: "das Quell-Repository",
  causeNoAccess: "das Portal hat keinen Zugriff auf {where}",
  causeNotFound: "Repository {where} nicht gefunden",
  causeDenied: "Zugriff auf Repository {where} verweigert",
  causeFetchFailed: "{where} konnte nicht abgerufen werden",
  causeEmptyTemplate: "die Vorlage der Lehrperson enthält keinen Branch",
  launchRefused: "Start abgelehnt",
  launchMissingToken: "Kein Start-Token.",
  launchExpired:
    "Dieser Startlink ist abgelaufen. Kehren Sie zur Plattform zurück und öffnen Sie die Aktivität erneut.",
  launchInvalid:
    "Dieser Startlink ist ungültig. Kehren Sie zur Plattform zurück und öffnen Sie die Aktivität erneut.",
  launchIncomplete: "Dieser Startlink ist unvollständig.",
  launchReplayed:
    "Dieser Startlink wurde bereits verwendet. Kehren Sie zur Plattform zurück und öffnen Sie die Aktivität erneut.",
  launchUnknownAssignment:
    "Diese Aktivität wurde nicht von der Plattform synchronisiert. Wenden Sie sich an das Lehrteam: Die Aktivität muss auf der Plattform gespeichert sein, bevor sie geöffnet wird.",
  launchClosed: "Diese Aktivität ist zurzeit nicht offen.",
  launchSittingClosed: "Ihre Sitzung an dieser Station ist beendet. Rufen Sie die Aufsicht.",
  launchRepoMissing:
    "Ihr Repository ist für diese Aktivität noch nicht bereit. Versuchen Sie es gleich noch einmal.",
  launchBadAssignmentId: "Diese Aktivität hat eine Kennung, die das Portal nicht verwenden kann.",
  quotaTitle: "Kontingent erreicht",
  quotaDetail: "Alle Umgebungsplätze Ihrer Lehrperson sind belegt. Versuchen Sie es später erneut.",
  reviewExpired:
    "Dieser Link ist abgelaufen. Kehren Sie zur Projektseite zurück und öffnen Sie das Repository erneut im Arbeitsbereich.",
  reviewInvalid:
    "Dieser Link ist ungültig. Kehren Sie zur Projektseite zurück und öffnen Sie das Repository erneut im Arbeitsbereich.",
  reviewReplayed:
    "Dieser Link wurde bereits verwendet. Kehren Sie zur Projektseite zurück und öffnen Sie das Repository erneut im Arbeitsbereich.",
  reviewRepoMissing: "Dieses Repository ist nicht verfügbar.",
  reviewQuotaDetail:
    "Alle Plätze im Arbeitsbereich für dieses Projekt sind belegt, oder das Lehrteam hat bereits zwei Repositories im Arbeitsbereich geöffnet. Schliessen Sie eines und versuchen Sie es erneut.",
  examOnlyInSeb: "Diese Prüfung lässt sich nur in Safe Exam Browser öffnen.",
  unknownAssignment: "Unbekannte Aktivität",
  outsideSebTitle: "Sitzung ausserhalb von Safe Exam Browser",
  outsideSebIntro:
    "Diese Prüfung lässt sich nur in Safe Exam Browser öffnen, gestartet über den Link Ihrer Lehrperson.",
  outsideSebHelp:
    "Wenn Sie einen Fehler vermuten, rufen Sie die Aufsicht. Starten Sie nicht in einem anderen Browser neu.",
  sebOtherMachine: "Diese Sitzung wurde von einem anderen Computer aus geöffnet.",
  sebNoExamSession: "Keine gültige Prüfungssitzung in diesem Browser.",
  sessionUnknownTitle: "Unbekannte Sitzung",
  sessionUnknownDetail: "Diese Sitzung existiert nicht oder nicht mehr.",
  sessionDeniedTitle: "Sitzung nicht erlaubt",
  sessionDeniedDetail:
    "Der Zugriff dieses Browsers auf die Sitzung ist beendet oder wurde nie erteilt. Öffnen Sie sie erneut über die Plattform.",
  assignmentGoneDetail: "Die Aktivität dieser Sitzung existiert nicht mehr.",
  sessionClosedTitle: "Sitzung geschlossen",
  sessionClosedDetail:
    "Diese Sitzung wurde geschlossen. Öffnen Sie sie erneut über die Plattform. Ihre Arbeit bleibt erhalten.",
  reviewClosedDetail:
    "Dieser Arbeitsbereich wurde geschlossen, und nichts davon bleibt erhalten. Öffnen Sie das Repository auf der Projektseite erneut im Arbeitsbereich.",
  sessionUnavailableTitle: "Sitzung nicht verfügbar",
  sessionRestartFailed:
    "Der Container konnte nicht neu gestartet werden. Ihr Volume ist intakt. Versuchen Sie es erneut.",
  sessionNoAddress: "Der Container hat keine Adresse.",
  portProxyTitle: "Portweiterleitung nicht verfügbar",
  portProxyDetail: "Der Online-Arbeitsbereich öffnet die Ports eines Programms nicht im Browser.",
};

/** The portal's own list (ADR-140 §4): not `@quiz/domain`'s `LOCALES`. */
export const LANGS = ["fr", "en", "de"] as const;
export type Lang = (typeof LANGS)[number];
const DICTS: Record<Lang, Record<MessageKey, string>> = { en, fr, de };
/** What a reader whose browser names none of `LANGS` reads, as on the platform. */
const FALLBACK: Lang = "en";

/**
 * The first of `LANGS` in the browser's preference order, English when it
 * names none. Quality values are honoured; the order of equal ones is kept.
 */
export function langOf(acceptLanguage: string | undefined): Lang {
  const ranked = (acceptLanguage ?? "")
    .split(",")
    .map((part, index) => {
      const [tag = "", ...params] = part.trim().split(";");
      const q = params.map((p) => /^\s*q=([0-9.]+)\s*$/.exec(p)?.[1]).find((v) => v !== undefined);
      return { lang: tag.trim().toLowerCase().split("-")[0] ?? "", q: q === undefined ? 1 : Number(q), index };
    })
    .filter((r) => r.q > 0)
    .sort((a, b) => b.q - a.q || a.index - b.index);
  return ranked.map((r) => r.lang).find((l): l is Lang => (LANGS as readonly string[]).includes(l)) ?? FALLBACK;
}

export function requestLang(request: Pick<FastifyRequest, "headers">): Lang {
  return langOf(request.headers["accept-language"]);
}

export function t(lang: Lang, key: MessageKey, vars: Record<string, string> = {}): string {
  return DICTS[lang][key].replace(/\{(\w+)\}/g, (whole, name: string) => vars[name] ?? whole);
}

/** Why a workspace could not be prepared: a key and the repository it names. */
export type CauseKey =
  | "causeNoAccess"
  | "causeNotFound"
  | "causeDenied"
  | "causeFetchFailed"
  | "causeEmptyTemplate";

export interface BootstrapCause {
  readonly key: CauseKey;
  /** `<owner>/<name>`, or null when the source repository is unknown. */
  readonly repo: string | null;
}

export function causeText(lang: Lang, cause: BootstrapCause): string {
  return t(lang, cause.key, { where: cause.repo ?? t(lang, "sourceRepository") });
}
