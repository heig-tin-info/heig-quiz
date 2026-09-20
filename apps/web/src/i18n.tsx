import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from "react";

import { api } from "./api";

/**
 * Lightweight i18n: a flat key -> string dictionary per locale, a `t(key,
 * vars)` helper with `{var}` interpolation, and a provider that persists the
 * chosen language to the user's account (so it follows them across devices)
 * with a localStorage mirror for an instant, flash-free first paint. English
 * is the fallback for any missing key or unset locale.
 *
 * Scope: EVERY user-facing surface goes through `t()`, teacher screens
 * included (N-I18N-01) — a teacher in Yverdon reads French. The dictionary is
 * flat and typed: `fr` is `Record<keyof Dict, string>`, so a key added in
 * English without its French twin is a compile error. Keep it that way.
 */
export type Locale = "en" | "fr";

export const LOCALES: { code: Locale; label: string }[] = [
  { code: "en", label: "English" },
  { code: "fr", label: "Français" },
];

const STORE_KEY = "quiz-locale";

const en = {
  "app.title": "Quiz",
  "landing.tagline":
    "Question pools, live evaluations and automatic grading for HEIG-VD courses.",
  "landing.signin": "Sign in with Switch edu-ID",
  "landing.devSignin": "Dev login",
  "landing.devHint": "Development only: pick a persona, no identity provider.",
  "landing.footer": "HEIG-VD — TIN Department",

  "header.docs": "Documentation",
  "header.sources": "Project sources",
  "menu.settings": "Settings",
  "menu.signout": "Sign out",
  "menu.user": "User menu",
  "menu.studentView": "Switch to student view",
  "menu.teacherView": "Back to teacher view",
  "menu.lightTheme": "Light theme",
  "menu.darkTheme": "Dark theme",
  "menu.studentViewBanner": "You are viewing the portal as a student.",
  "menu.openMenu": "Open menu",
  "menu.closeMenu": "Close menu",

  "common.cancel": "Cancel",
  "common.save": "Save",
  "common.create": "Create",
  "common.delete": "Delete",
  "common.edit": "Edit",
  "common.done": "Done",
  "common.actions": "Actions",
  "common.search": "Search…",
  "common.loading": "Loading…",
  "common.retry": "Retry",
  "common.showAll": "Show all ({n})",
  "error.server": "The server did not answer. Try again in a moment.",
  "error.save": "Could not save this change.",

  "nav.courses": "Courses",
  "nav.admin": "Administration",

  "courses.title": "Courses",
  "courses.subtitle": "A course holds its staff, its classrooms and its question pool.",
  "courses.new": "New course",
  "courses.newAction": "Create course",
  "courses.name": "Name",
  "courses.namePlaceholder": "Programmation C",
  "courses.code": "Code",
  "courses.codePlaceholder": "PRG1",
  "courses.createFailed": "Creation failed.",
  "courses.empty.title": "No courses yet",
  "courses.empty.body": "Create a course, then add the classrooms that follow it.",
  "courses.delete": "Delete course",
  "courses.deleteConfirm":
    "Delete “{name}”? Its classrooms, rosters and results go with it.",
  "courses.staff": "Staff",
  "courses.staffAdd": "Add a staff member",
  "courses.staffEmail": "E-mail of an existing account",
  "courses.staffRemove": "Remove from the staff",
  "courses.staffRemoveConfirm": "Remove {name} from the staff of “{course}”?",
  "courses.staffUnknown": "No account has signed in with this address yet.",

  "classrooms.title": "Classrooms",
  "classrooms.new": "New classroom",
  "classrooms.name": "Name",
  "classrooms.namePlaceholder": "PRG1-2026",
  "classrooms.period": "Period",
  "classrooms.periodPlaceholder": "2026-A",
  "classrooms.empty": "No classroom in this course yet.",
  "classrooms.students": "{n} students",
  "classrooms.students.one": "{n} student",
  "classrooms.claimed": "{n} claimed",
  "classrooms.archive": "Archive",
  "classrooms.unarchive": "Restore",
  "classrooms.archived": "archived",
  "classrooms.delete": "Delete classroom",
  "classrooms.deleteConfirm": "Delete “{name}”? Its roster and results go with it.",
  "classrooms.rename": "Rename",
  "classrooms.notFound": "This classroom does not exist, or you do not have access to it.",

  "roster.title": "Roster",
  "roster.add": "Add students",
  "roster.empty.title": "Empty roster",
  "roster.empty.body": "Import a list of students, or add them one by one.",
  "roster.col.lastName": "Last name",
  "roster.col.firstName": "First name",
  "roster.col.email": "E-mail",
  "roster.col.status": "Status",
  "roster.col.bonus": "Extra time",
  "roster.col.lastSignIn": "Last sign-in",
  "roster.rowActions": "Actions for {name}",
  "roster.status.claimed": "claimed",
  "roster.status.pending": "pending",
  "roster.status.conflict": "conflict",
  "roster.status.staff": "staff",
  "roster.emailChangeWarning": "Changing the e-mail will revoke the student's claim.",
  "roster.revoke": "Revoke claim",
  "roster.revokeConfirm": "Revoke {name}'s claim?",
  "roster.revokeBody":
    "The seat goes back to pending; the student claims it again on their next sign-in.",
  "roster.remove": "Remove from roster",
  "roster.removeConfirm": "Remove {name}?",
  "roster.removeBody": "The student leaves the roster. Their past results are kept.",
  "roster.removeFailed": "Could not remove this student.",
  "roster.revokeFailed": "Could not revoke this claim.",
  "roster.updateFailed": "Update failed",
  "roster.join": "Join as student",
  "roster.joined": "You have a seat in this classroom",

  "import.title": "Add students",
  "import.subtitle": "Last name, first name and e-mail — the student claims the seat on first sign-in",
  "import.fromFile": "From a file",
  "import.drop": "Drop an Excel or CSV file here, or click to browse",
  "import.dropHint":
    ".xlsx, .xls, .ods, .csv — the last name, first name, e-mail and extra-time columns are detected automatically (French headers work too); other columns are ignored.",
  "import.dropLabel": "Drop a roster file",
  "import.unreadable": "unreadable file",
  "import.oneStudent": "One student",
  "import.add": "Add",
  "import.pasted": "Pasted CSV",
  "import.importCsv": "Import CSV",
  "import.done": "Import done",
  "import.failed": "Import failed.",
  "import.rejected.one": "1 line rejected — see above.",
  "import.rejected": "{n} lines rejected — see above.",
  "import.line": "line {n}: {message}",
  "import.bonus": "Extra time (%)",

  "student.title": "My classrooms",
  "student.subtitle": "The classrooms you have joined.",
  "student.empty.title": "No classroom yet",
  "student.empty.body":
    "Your teacher adds you to a classroom with your school e-mail address. Sign in again once they have.",
  "student.teachers": "Taught by {names}",
  "student.bonus": "Extra time: +{n}%",

  "admin.title": "Administration",
  "admin.teachers": "Teachers",
  "admin.teachersHint":
    "A grant lets an address reach the teacher interface. It can be issued before the person ever signs in.",
  "admin.grant": "Grant",
  "admin.email": "E-mail",
  "admin.revoke": "Revoke",
  "admin.revokeConfirm": "Revoke the teacher role of {email}?",
  "admin.col.person": "Person",
  "admin.col.courses": "Courses",
  "admin.col.lastSignIn": "Last sign-in",
  "admin.col.granted": "Granted",
  "admin.pending": "has not signed in yet",
  "admin.empty.title": "No teachers",
  "admin.empty.body": "Grant the teacher role to an address to get started.",

  "settings.title": "Settings",
  "settings.profile": "Profile",
  "settings.changePicture": "Change picture",
  "settings.lastSignIn": "Last sign-in {date}",
  "settings.role.student": "Student",
  "settings.role.teacher": "Teacher",
  "settings.role.admin": "Administrator",
  "settings.preferences": "Preferences",
  "settings.language": "Language",
  "settings.languageHint": "Interface language, saved on your account.",
  "settings.appearance": "Appearance",
  "settings.appearanceHint": "Light, dark, or follow the system.",
  "settings.theme.light": "Light",
  "settings.theme.dark": "Dark",
  "settings.theme.system": "System",
  "settings.dateFormat": "Date format",
  "settings.dateFormatHint": "How dates and times are written across the portal.",
  "settings.notifications": "Notifications",
  "settings.notificationsBrowser": "Toasts shown in this browser only.",

  "avatar.title": "Profile picture",
  "notify.student_joined": "A student joins a classroom",
  "notify.roster_conflict": "A roster entry needs attention",

  "palette.open": "Search",
  "palette.openCourse": "Open course {name}",
  "palette.openClassroom": "Open classroom {name}",
  "palette.external": "External link",
  "palette.helpHint": "Help",
  "palette.switchLocale": "Switch to {language}",
  "palette.themeSystem": "Follow the system theme",
  "palette.title": "Command palette",
  "palette.placeholder": "Search a course, a classroom, an action…",
  "palette.noResult": "No result for “{query}”",
  "palette.result": "{n} result",
  "palette.results": "{n} results",
  "palette.hint.move": "to move",
  "palette.hint.run": "to run",
  "palette.hint.close": "to close",
  "palette.group.navigate": "Navigation",
  "palette.group.action": "Actions",
  "palette.group.help": "Help",

  "help.title": "Help",

  "dur.day": "{n} day",
  "dur.days": "{n} days",
  "dur.hour": "{n} hour",
  "dur.hours": "{n} hours",
  "dur.minute": "{n} minute",
  "dur.minutes": "{n} minutes",
  "dur.and": "and",
  "dur.soon": "less than a minute",
};

export type Dict = typeof en;

const fr: Record<keyof Dict, string> = {
  "app.title": "Quiz",
  "landing.tagline":
    "Banques de questions, évaluations en direct et correction automatique pour les cours de la HEIG-VD.",
  "landing.signin": "Se connecter avec Switch edu-ID",
  "landing.devSignin": "Connexion de développement",
  "landing.devHint": "Développement uniquement : choisir un personnage, sans fournisseur d'identité.",
  "landing.footer": "HEIG-VD — Département TIN",

  "header.docs": "Documentation",
  "header.sources": "Sources du projet",
  "menu.settings": "Réglages",
  "menu.signout": "Se déconnecter",
  "menu.user": "Menu du compte",
  "menu.studentView": "Passer en vue étudiant",
  "menu.teacherView": "Revenir en vue enseignant",
  "menu.lightTheme": "Thème clair",
  "menu.darkTheme": "Thème sombre",
  "menu.studentViewBanner": "Vous consultez le portail comme un étudiant.",
  "menu.openMenu": "Ouvrir le menu",
  "menu.closeMenu": "Fermer le menu",

  "common.cancel": "Annuler",
  "common.save": "Enregistrer",
  "common.create": "Créer",
  "common.delete": "Supprimer",
  "common.edit": "Modifier",
  "common.done": "Terminé",
  "common.actions": "Actions",
  "common.search": "Rechercher…",
  "common.loading": "Chargement…",
  "common.retry": "Réessayer",
  "common.showAll": "Tout afficher ({n})",
  "error.server": "Le serveur n'a pas répondu. Réessayez dans un instant.",
  "error.save": "Impossible d'enregistrer cette modification.",

  "nav.courses": "Cours",
  "nav.admin": "Administration",

  "courses.title": "Cours",
  "courses.subtitle": "Un cours porte son équipe, ses classes et sa banque de questions.",
  "courses.new": "Nouveau cours",
  "courses.newAction": "Créer le cours",
  "courses.name": "Nom",
  "courses.namePlaceholder": "Programmation C",
  "courses.code": "Code",
  "courses.codePlaceholder": "PRG1",
  "courses.createFailed": "La création a échoué.",
  "courses.empty.title": "Aucun cours",
  "courses.empty.body": "Créez un cours, puis ajoutez les classes qui le suivent.",
  "courses.delete": "Supprimer le cours",
  "courses.deleteConfirm":
    "Supprimer « {name} » ? Ses classes, listes et résultats disparaissent avec lui.",
  "courses.staff": "Équipe",
  "courses.staffAdd": "Ajouter une personne",
  "courses.staffEmail": "Adresse d'un compte existant",
  "courses.staffRemove": "Retirer de l'équipe",
  "courses.staffRemoveConfirm": "Retirer {name} de l'équipe de « {course} » ?",
  "courses.staffUnknown": "Aucun compte ne s'est encore connecté avec cette adresse.",

  "classrooms.title": "Classes",
  "classrooms.new": "Nouvelle classe",
  "classrooms.name": "Nom",
  "classrooms.namePlaceholder": "PRG1-2026",
  "classrooms.period": "Période",
  "classrooms.periodPlaceholder": "2026-A",
  "classrooms.empty": "Aucune classe dans ce cours.",
  "classrooms.students": "{n} étudiants",
  "classrooms.students.one": "{n} étudiant",
  "classrooms.claimed": "{n} rattachés",
  "classrooms.archive": "Archiver",
  "classrooms.unarchive": "Restaurer",
  "classrooms.archived": "archivée",
  "classrooms.delete": "Supprimer la classe",
  "classrooms.deleteConfirm":
    "Supprimer « {name} » ? Sa liste et ses résultats disparaissent avec elle.",
  "classrooms.rename": "Renommer",
  "classrooms.notFound": "Cette classe n'existe pas, ou vous n'y avez pas accès.",

  "roster.title": "Liste",
  "roster.add": "Ajouter des étudiants",
  "roster.empty.title": "Liste vide",
  "roster.empty.body": "Importez une liste d'étudiants, ou ajoutez-les un par un.",
  "roster.col.lastName": "Nom",
  "roster.col.firstName": "Prénom",
  "roster.col.email": "Adresse e-mail",
  "roster.col.status": "État",
  "roster.col.bonus": "Temps suppl.",
  "roster.col.lastSignIn": "Dernière connexion",
  "roster.rowActions": "Actions pour {name}",
  "roster.status.claimed": "rattaché",
  "roster.status.pending": "en attente",
  "roster.status.conflict": "conflit",
  "roster.status.staff": "équipe",
  "roster.emailChangeWarning": "Changer l'adresse annulera le rattachement de l'étudiant.",
  "roster.revoke": "Annuler le rattachement",
  "roster.revokeConfirm": "Annuler le rattachement de {name} ?",
  "roster.revokeBody":
    "La place repasse en attente ; l'étudiant la reprend à sa prochaine connexion.",
  "roster.remove": "Retirer de la liste",
  "roster.removeConfirm": "Retirer {name} ?",
  "roster.removeBody": "L'étudiant quitte la liste. Ses résultats passés sont conservés.",
  "roster.removeFailed": "Impossible de retirer cet étudiant.",
  "roster.revokeFailed": "Impossible d'annuler ce rattachement.",
  "roster.updateFailed": "La mise à jour a échoué",
  "roster.join": "S'inscrire comme étudiant",
  "roster.joined": "Vous avez une place dans cette classe",

  "import.title": "Ajouter des étudiants",
  "import.subtitle":
    "Nom, prénom et adresse e-mail — l'étudiant reprend sa place à sa première connexion",
  "import.fromFile": "Depuis un fichier",
  "import.drop": "Déposez un fichier Excel ou CSV ici, ou cliquez pour parcourir",
  "import.dropHint":
    ".xlsx, .xls, .ods, .csv — les colonnes nom, prénom, e-mail et temps supplémentaire sont détectées automatiquement ; les autres colonnes sont ignorées.",
  "import.dropLabel": "Déposer un fichier de liste",
  "import.unreadable": "fichier illisible",
  "import.oneStudent": "Un étudiant",
  "import.add": "Ajouter",
  "import.pasted": "CSV collé",
  "import.importCsv": "Importer le CSV",
  "import.done": "Import terminé",
  "import.failed": "L'import a échoué.",
  "import.rejected.one": "1 ligne rejetée — voir ci-dessus.",
  "import.rejected": "{n} lignes rejetées — voir ci-dessus.",
  "import.line": "ligne {n} : {message}",
  "import.bonus": "Temps supplémentaire (%)",

  "student.title": "Mes classes",
  "student.subtitle": "Les classes dans lesquelles vous êtes inscrit.",
  "student.empty.title": "Aucune classe",
  "student.empty.body":
    "Votre enseignant vous ajoute à une classe avec votre adresse d'école. Reconnectez-vous ensuite.",
  "student.teachers": "Enseigné par {names}",
  "student.bonus": "Temps supplémentaire : +{n} %",

  "admin.title": "Administration",
  "admin.teachers": "Enseignants",
  "admin.teachersHint":
    "Une autorisation donne à une adresse l'accès à l'interface enseignant. Elle peut être accordée avant la première connexion.",
  "admin.grant": "Autoriser",
  "admin.email": "Adresse e-mail",
  "admin.revoke": "Révoquer",
  "admin.revokeConfirm": "Révoquer le rôle enseignant de {email} ?",
  "admin.col.person": "Personne",
  "admin.col.courses": "Cours",
  "admin.col.lastSignIn": "Dernière connexion",
  "admin.col.granted": "Accordée",
  "admin.pending": "ne s'est pas encore connecté",
  "admin.empty.title": "Aucun enseignant",
  "admin.empty.body": "Autorisez une adresse pour commencer.",

  "settings.title": "Réglages",
  "settings.profile": "Profil",
  "settings.changePicture": "Changer l'image",
  "settings.lastSignIn": "Dernière connexion {date}",
  "settings.role.student": "Étudiant",
  "settings.role.teacher": "Enseignant",
  "settings.role.admin": "Administrateur",
  "settings.preferences": "Préférences",
  "settings.language": "Langue",
  "settings.languageHint": "Langue de l'interface, enregistrée sur votre compte.",
  "settings.appearance": "Apparence",
  "settings.appearanceHint": "Clair, sombre, ou selon le système.",
  "settings.theme.light": "Clair",
  "settings.theme.dark": "Sombre",
  "settings.theme.system": "Système",
  "settings.dateFormat": "Format de date",
  "settings.dateFormatHint": "Comment les dates et les heures sont écrites dans le portail.",
  "settings.notifications": "Notifications",
  "settings.notificationsBrowser": "Bulles affichées dans ce navigateur uniquement.",

  "avatar.title": "Image de profil",
  "notify.student_joined": "Un étudiant rejoint une classe",
  "notify.roster_conflict": "Une entrée de liste demande une décision",

  "palette.open": "Rechercher",
  "palette.openCourse": "Ouvrir le cours {name}",
  "palette.openClassroom": "Ouvrir la classe {name}",
  "palette.external": "Lien externe",
  "palette.helpHint": "Aide",
  "palette.switchLocale": "Passer en {language}",
  "palette.themeSystem": "Suivre le thème du système",
  "palette.title": "Palette de commandes",
  "palette.placeholder": "Rechercher un cours, une classe, une action…",
  "palette.noResult": "Aucun résultat pour « {query} »",
  "palette.result": "{n} résultat",
  "palette.results": "{n} résultats",
  "palette.hint.move": "pour naviguer",
  "palette.hint.run": "pour exécuter",
  "palette.hint.close": "pour fermer",
  "palette.group.navigate": "Navigation",
  "palette.group.action": "Actions",
  "palette.group.help": "Aide",

  "help.title": "Aide",

  "dur.day": "{n} jour",
  "dur.days": "{n} jours",
  "dur.hour": "{n} heure",
  "dur.hours": "{n} heures",
  "dur.minute": "{n} minute",
  "dur.minutes": "{n} minutes",
  "dur.and": "et",
  "dur.soon": "moins d'une minute",
};

export const DICTS: Record<Locale, Record<string, string>> = { en, fr };

export type TFunction = (key: keyof Dict, vars?: Record<string, string | number>) => string;

function translate(locale: Locale, key: string, vars?: Record<string, string | number>): string {
  const raw = DICTS[locale]?.[key] ?? DICTS.en[key] ?? key;
  if (!vars) return raw;
  return raw.replace(/\{(\w+)\}/g, (_, k: string) => String(vars[k] ?? `{${k}}`));
}

interface I18nValue {
  locale: Locale;
  setLocale: (l: Locale, persist?: boolean) => void;
  t: TFunction;
}

const I18nContext = createContext<I18nValue>({
  locale: "en",
  setLocale: () => {},
  t: (k) => translate("en", k),
});

export function I18nProvider({ children }: { children: ReactNode }) {
  const [locale, setLocaleState] = useState<Locale>(() => {
    const stored = localStorage.getItem(STORE_KEY);
    return stored === "fr" || stored === "en" ? stored : "en";
  });
  useEffect(() => {
    document.documentElement.lang = locale;
  }, [locale]);
  const setLocale = useCallback((l: Locale, persist = true) => {
    setLocaleState(l);
    localStorage.setItem(STORE_KEY, l);
    if (persist) {
      void api("/app/api/me", { method: "PATCH", body: JSON.stringify({ locale: l }) }).catch(
        () => {},
      );
    }
  }, []);
  const t = useCallback<TFunction>((key, vars) => translate(locale, key, vars), [locale]);
  return <I18nContext.Provider value={{ locale, setLocale, t }}>{children}</I18nContext.Provider>;
}

export function useI18n() {
  return useContext(I18nContext);
}

export function useT(): TFunction {
  return useContext(I18nContext).t;
}

/** "4 days, 2 hours and 23 minutes" — localized, largest three units. */
export function formatDuration(ms: number, t: TFunction): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const days = Math.floor(total / 86400);
  const hours = Math.floor((total % 86400) / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const parts: string[] = [];
  if (days > 0) parts.push(t(days === 1 ? "dur.day" : "dur.days", { n: days }));
  if (hours > 0) parts.push(t(hours === 1 ? "dur.hour" : "dur.hours", { n: hours }));
  if (minutes > 0 || parts.length === 0) {
    if (minutes === 0 && parts.length === 0) return t("dur.soon");
    parts.push(t(minutes === 1 ? "dur.minute" : "dur.minutes", { n: minutes }));
  }
  if (parts.length === 1) return parts[0]!;
  const last = parts.pop()!;
  return `${parts.join(", ")} ${t("dur.and")} ${last}`;
}
