/**
 * Every sentence the portal shows a person, in English and in French (root
 * invariant 1). The portal is a separate deployable: it cannot import the
 * SPA's dictionaries, so it keeps its own two, with the same rule — `fr` is
 * typed against the keys of `en`, so a missing translation is a compile
 * error.
 *
 * The language comes from the browser's `Accept-Language`, French by
 * default (the students of HEIG-VD). Placeholders are `{name}`, filled by
 * `t()`; the HTML around them escapes the result.
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
  launchRepoMissing: "Your repository is not ready for this activity yet. Try again in a moment.",
  launchBadAssignmentId: "This activity has an identifier the portal cannot use.",
  quotaTitle: "Quota reached",
  quotaDetail: "All of your teacher's environment places are taken. Try again later.",
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
  sessionDeniedDetail: "Open the session from the platform: this browser has no cookie for it.",
  assignmentGoneDetail: "The activity of this session no longer exists.",
  sessionClosedTitle: "Session closed",
  sessionClosedDetail: "This session was closed. Open it again from the platform; your work is kept.",
  sessionUnavailableTitle: "Session unavailable",
  sessionRestartFailed: "The container could not be restarted. Your volume is intact; try again.",
  sessionNoAddress: "The container has no address.",
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
  launchRepoMissing:
    "Votre dépôt n'est pas encore prêt pour cette activité. Réessayez dans quelques instants.",
  launchBadAssignmentId: "Cette activité porte un identifiant inutilisable par le portail.",
  quotaTitle: "Quota atteint",
  quotaDetail:
    "Toutes les places d'environnement de votre enseignant sont occupées. Réessayez plus tard.",
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
    "Ouvrez la session depuis la plateforme : ce navigateur n'a pas de cookie pour elle.",
  assignmentGoneDetail: "L'activité de cette session a disparu.",
  sessionClosedTitle: "Session fermée",
  sessionClosedDetail:
    "Cette session a été fermée. Rouvrez-la depuis la plateforme ; votre travail est conservé.",
  sessionUnavailableTitle: "Session indisponible",
  sessionRestartFailed: "Le conteneur n'a pas pu être relancé. Votre volume est intact ; réessayez.",
  sessionNoAddress: "Le conteneur n'a pas d'adresse.",
};

export const LANGS = ["fr", "en"] as const;
export type Lang = (typeof LANGS)[number];
const DICTS: Record<Lang, Record<MessageKey, string>> = { en, fr };

/**
 * The first of `en` / `fr` in the browser's preference order, French when it
 * names neither. Quality values are honoured; the order of equal ones is kept.
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
  return ranked.map((r) => r.lang).find((l): l is Lang => (LANGS as readonly string[]).includes(l)) ?? "fr";
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
