/**
 * The words of a notification that leaves the platform (ADR-030): the e-mail
 * and the preview line of a Teams activity, rendered on the server in the
 * RECIPIENT's language (`users.locale`, English when unset), never the
 * sender's — and every user-facing string of the Teams app package (its
 * name, descriptions, tab and activity types), whose French and German
 * become the package's `fr.json` and `de.json`.
 *
 * One typed dictionary per language, the web app's rule mirrored: `fr` and
 * `de` are `Record<keyof typeof en, string>`, so a missing sentence is a
 * compile error. English and French are written, German is translated
 * (ADR-140). The bell is NOT rendered here — the web app turns the same
 * payload into its own sentence (`NotificationPanel.tsx`).
 *
 * Every value that comes from a user (a pool name, a title, a display name)
 * is escaped before it lands in HTML, and the subject line is flattened to
 * one line. The payload carries ids and titles only: nothing here can leak a
 * grade or question content, because nothing of the kind is ever passed in.
 * A `system_alert` (ADR-055 §5) carries check keys only; their causes and
 * measures are on the System status page it links to. An `account_dormant`
 * (ADR-117 §4) carries its stage only: it links first to the Settings, where
 * the data is downloaded, then to the sign-in, and has no settings footer,
 * since nobody can turn it off.
 */
import {
  ACCOUNT_KINDS,
  kindChannels,
  type NotificationKind,
  type NotificationPayload,
  type OutboundNotificationKind,
  type TeamsNotificationKind,
} from "@quiz/contracts";
import { FALLBACK_LOCALE, isLocale, SCHOOL_TIME_ZONE, type Locale } from "@quiz/domain";
import { escapeHtml } from "@quiz/docrender/highlight";

/**
 * A payload of a kind that may leave the app (`KIND_CHANNELS`): only those
 * are worded here. A kind kept in the bell (`impersonation_ended`) is
 * worded by the web app alone.
 */
export type OutboundPayload = Extract<NotificationPayload, { kind: OutboundNotificationKind }>;
export function isOutboundPayload(payload: NotificationPayload): payload is OutboundPayload {
  return kindChannels(payload.kind).some((channel) => channel !== "bell");
}

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
  "contestation_resolved.subject": "Your contestation was answered: {evaluationTitle}",
  "contestation_resolved.body": "Your contestation on “{evaluationTitle}” was answered.",
  "contestation_resolved.action": "See my results",
  "contestation_filed.subject": "{count} contestations: {evaluationTitle}",
  "contestation_filed.subject.one": "A contestation: {evaluationTitle}",
  "contestation_filed.body": "{count} contestations were filed on “{evaluationTitle}”.",
  "contestation_filed.body.one": "The grading of a question of “{evaluationTitle}” was contested.",
  "contestation_filed.action": "Open the grading",
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
  "question_reported.subject": "{count} reports on {questionName}",
  "question_reported.subject.one": "A report on {questionName}",
  "question_reported.body": "{count} colleagues reported a problem on the question “{questionName}” of the pool “{poolName}”.",
  "question_reported.body.one": "A colleague reported a problem on the question “{questionName}” of the pool “{poolName}”.",
  "question_reported.action": "Open the question",
  "question_report_resolved.subject": "Your report was handled: {questionName}",
  "question_report_resolved.body": "A writer of the pool “{poolName}” resolved your report on the question “{questionName}”.",
  "question_report_resolved.action": "Open the question",
  // A public pool left the catalogue (ADR-095): one sentence per state.
  "pool_unpublished.unpublished.subject": "The pool {poolName} left the catalogue",
  "pool_unpublished.unpublished.body": "The owner of the pool “{poolName}” unpublished it: your subscription to it ended.",
  "pool_unpublished.course.subject": "The pool {poolName} left the catalogue",
  "pool_unpublished.course.body": "The owner of the pool “{poolName}” unpublished it: your course “{courseName}” no longer draws from it. Its evaluations keep their questions; link another pool or ask the owner to publish it again.",
  "pool_unpublished.deleted.subject": "The pool {poolName} was deleted",
  "pool_unpublished.deleted.body": "The owner of the pool “{poolName}” deleted it: your subscription to it ended.",
  "pool_unpublished.action": "Open the pools",
  // The project kinds (F-NOTIF-13, M3-09b): the project's name and counts,
  // never a score nor a student's name.
  "project_scheduled.subject": "Project announced: {projectTitle}",
  "project_scheduled.body": "The project “{projectTitle}” opens on {startAt}. You can accept it from then on.",
  "project_scheduled.unlinked.body": "The project “{projectTitle}” opens on {startAt}. Link your GitHub account before then, to accept it once it opens.",
  "project_scheduled.action": "Open the project",
  "project_published.subject": "New project: {projectTitle}",
  "project_published.body": "The project “{projectTitle}” is published in your classroom. Accept it to get your repository.",
  "project_published.unlinked.body": "The project “{projectTitle}” is published in your classroom. Link your GitHub account, then accept it to get your repository.",
  "project_published.action": "Open the project",
  "project_deadline_reminder.subject": "Deadline within 24 hours: {projectTitle}",
  "project_deadline_reminder.body": "The deadline of the project “{projectTitle}” is in less than 24 hours. Push what you want graded before it.",
  "project_deadline_reminder.action": "Open the project",
  "project_repo_invited.subject": "Your repository is ready: {projectTitle}",
  "project_repo_invited.body": "Your repository for the project “{projectTitle}” was created. Accept the invitation on GitHub to start working in it.",
  "project_repo_invited.action": "Open the project",
  "project_grade_final.subject": "Scores released: {projectTitle}",
  "project_grade_final.body": "The scores of the project “{projectTitle}” are released.",
  "project_grade_final.action": "See my score",
  "project_contestation_resolved.subject": "Your contestation was answered: {projectTitle}",
  "project_contestation_resolved.body": "The contestation of a criterion of the project “{projectTitle}” was answered.",
  "project_contestation_resolved.action": "Open the project",
  "project_contestation_filed.subject": "{count} contestations: {projectTitle}",
  "project_contestation_filed.subject.one": "A contestation: {projectTitle}",
  "project_contestation_filed.body": "{count} contestations were filed on criteria of “{projectTitle}”.",
  "project_contestation_filed.body.one": "The grading of a criterion of “{projectTitle}” was contested.",
  "project_contestation_filed.action": "Open the project",
  "project_deadline_applied.subject": "Deadline applied to {count} repositories: {projectTitle}",
  "project_deadline_applied.subject.one": "Deadline applied to a repository: {projectTitle}",
  "project_deadline_applied.body": "The deadline of “{projectTitle}” was applied to {count} repositories.",
  "project_deadline_applied.body.one": "The deadline of “{projectTitle}” was applied to a repository.",
  "project_deadline_applied.action": "Open the project",
  "project_provision_failed.subject": "{count} repositories could not be created: {projectTitle}",
  "project_provision_failed.subject.one": "A repository could not be created: {projectTitle}",
  "project_provision_failed.body": "{count} student repositories of “{projectTitle}” could not be created. Last cause: {reason}.",
  "project_provision_failed.body.one": "A student's repository of “{projectTitle}” could not be created: {reason}.",
  "project_provision_failed.action": "Open the project",
  "github_org_lost.subject": "GitHub organization lost: {classroomName}",
  "github_org_lost.body": "The organization {orgLogin} of {classroomName} was deleted on GitHub, or HEIG Quiz's app was uninstalled from it. Nothing can be written to its repositories until it is connected again.",
  "github_org_lost.action": "Open the classroom's settings",
  // Why a repository could not be made (`project_provision_failed.reason`).
  "reason.repo_name_taken": "a repository of that name exists already in the organization, which only the staff can resolve",
  "reason.github_error": "GitHub failed or refused, and the student may try again",
  "system_alert.failing.subject": "{host}: health checks failing",
  "system_alert.failing.body": "Health checks of {host} failed on two runs in a row: {checks}.",
  "system_alert.still_failing.subject": "{host}: health checks still failing",
  "system_alert.still_failing.body": "Health checks of {host} have been failing for more than a day: {checks}.",
  "system_alert.recovered.subject": "{host}: health checks back to OK",
  "system_alert.recovered.body": "Health checks of {host} that had failed are OK again: {checks}.",
  "system_alert.action": "Open the system status",
  // The account lifecycle (ADR-117 §4): never "deleted", the results stay.
  "account_dormant.notice.subject": "Your HEIG Quiz account has not been used for two years",
  "account_dormant.notice.body":
    "You have not used HEIG Quiz for two years. Sign in within a year to keep your account. Otherwise it will be anonymized: your name, addresses, picture and links leave it, and your results stay without your name. Download your data first if you want a copy.",
  "account_dormant.reminder.subject": "Your HEIG Quiz account will be anonymized in three months",
  "account_dormant.reminder.body":
    "You have not used HEIG Quiz for over two years. Sign in within three months to keep your account. Otherwise it will be anonymized: your name, addresses, picture and links leave it, and your results stay without your name. Download your data first if you want a copy.",
  "account_dormant.action": "Download my data",
  signin: "Sign in",
  // The administrator's "Send me a test e-mail" (ADR-055 §6): no kind, no preference.
  "test_mail.subject": "{host}: test e-mail",
  "test_mail.body": "This is a test e-mail from {host}, sent at your request from the System status page. If you are reading it, the platform's e-mail delivery works.",
  "test_mail.action": "Back to the system status",
  // The checks by name, as the System status page names them
  // (`admin.system.check.*` in the web's dictionaries).
  "check.ticker": "Live clock (ticker)",
  "check.attempts.overdue": "Attempts past their deadline",
  "check.evaluations.overdue": "Evaluations past their end",
  "check.tasks": "Scheduled tasks",
  "check.jobs": "Background jobs failed (24 h)",
  "check.runner": "Code runner",
  "check.evaluations.live": "Live evaluations",
  "check.connections.live": "Real-time connections",
  "check.database": "Database response",
  "check.database.size": "Database size",
  "check.database.connections": "Database connections",
  "check.disk": "Disk space",
  "check.backup": "Last backup",
  "check.offsite": "Off-site copy",
  "check.http.errors": "Server errors (24 h)",
  "check.service.mail": "E-mail",
  "check.service.signin": "Sign-in (identity provider)",
  "check.service.teams": "Microsoft Teams",
  "check.service.llm": "AI provider",
  "check.llm.budget": "AI spending today",
  "check.pdf": "PDF export",
  "check.service.github": "GitHub App",
  "check.accounts": "Account lifecycle",
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
  "activity.question_reported.description": "A colleague reports a problem on a question of a pool you write in",
  "activity.question_reported.template": "{questionName}: {count} report(s)",
  "activity.question_report_resolved.description": "A writer resolves your report on a question",
  "activity.question_report_resolved.template": "Report handled: {questionName}",
  "activity.pool_unpublished.description": "A public pool you use leaves the catalogue",
  "activity.pool_unpublished.template": "The pool {poolName} left the catalogue",
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
  // The project kinds (F-NOTIF-13), declared in the one bump of M3-09b (2.2.0).
  "activity.project_scheduled.description": "A project of your classroom is announced, with its opening date",
  "activity.project_scheduled.template": "{projectTitle} opens on {startAt}",
  "activity.project_published.description": "A project is published in your classroom",
  "activity.project_published.template": "New project: {projectTitle}",
  "activity.project_deadline_reminder.description": "The deadline of a project is within 24 hours",
  "activity.project_deadline_reminder.template": "Deadline within 24 hours: {projectTitle}",
  "activity.project_repo_invited.description": "Your repository for a project is ready on GitHub",
  "activity.project_repo_invited.template": "Your repository is ready: {projectTitle}",
  "activity.project_grade_final.description": "The scores of a project are released",
  "activity.project_grade_final.template": "Scores released: {projectTitle}",
  "activity.project_deadline_applied.description": "The deadline of one of your projects was applied to its repositories",
  "activity.project_deadline_applied.template": "{projectTitle}: deadline applied to {count} repository(ies)",
  "activity.project_provision_failed.description": "A student's repository of one of your projects could not be created",
  "activity.project_provision_failed.template": "{projectTitle}: {count} repository(ies) could not be created",
  "activity.github_org_lost.description": "The GitHub organization of one of your classrooms was deleted or the app uninstalled",
  "activity.github_org_lost.template": "GitHub organization lost: {classroomName}",
  // The contestations (ADR-139), the bump to 2.6.0.
  "activity.contestation_resolved.description": "Your contestation of a question is answered",
  "activity.contestation_resolved.template": "Contestation answered: {evaluationTitle}",
  "activity.contestation_filed.description": "The grading of a question of a released exam is contested",
  "activity.contestation_filed.template": "{evaluationTitle}: {count} contestation(s)",
  // A project's criterion contested (ADR-139 §13), the bump to 2.7.0.
  "activity.project_contestation_resolved.description": "Your contestation of a project criterion is answered",
  "activity.project_contestation_resolved.template": "Contestation answered: {projectTitle}",
  "activity.project_contestation_filed.description": "The grading of a criterion of a released project is contested",
  "activity.project_contestation_filed.template": "{projectTitle}: {count} contestation(s)",
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
  "contestation_resolved.subject": "Réponse à votre contestation : {evaluationTitle}",
  "contestation_resolved.body": "Votre contestation sur « {evaluationTitle} » a reçu une réponse.",
  "contestation_resolved.action": "Voir mes résultats",
  "contestation_filed.subject": "{count} contestations : {evaluationTitle}",
  "contestation_filed.subject.one": "Une contestation : {evaluationTitle}",
  "contestation_filed.body": "{count} contestations ont été déposées sur « {evaluationTitle} ».",
  "contestation_filed.body.one": "La correction d'une question de « {evaluationTitle} » a été contestée.",
  "contestation_filed.action": "Ouvrir la correction",
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
  "question_reported.subject": "{count} signalements sur {questionName}",
  "question_reported.subject.one": "Un signalement sur {questionName}",
  "question_reported.body": "{count} collègues ont signalé un problème sur la question « {questionName} » de la banque « {poolName} ».",
  "question_reported.body.one": "Un collègue a signalé un problème sur la question « {questionName} » de la banque « {poolName} ».",
  "question_reported.action": "Ouvrir la question",
  "question_report_resolved.subject": "Votre signalement a été traité : {questionName}",
  "question_report_resolved.body": "Un responsable de la banque « {poolName} » a traité votre signalement sur la question « {questionName} ».",
  "question_report_resolved.action": "Ouvrir la question",
  "pool_unpublished.unpublished.subject": "La banque {poolName} a quitté le catalogue",
  "pool_unpublished.unpublished.body": "Le propriétaire de la banque « {poolName} » l'a dépubliée : votre abonnement est terminé.",
  "pool_unpublished.course.subject": "La banque {poolName} a quitté le catalogue",
  "pool_unpublished.course.body": "Le propriétaire de la banque « {poolName} » l'a dépubliée : votre cours « {courseName} » n'y puise plus. Ses évaluations gardent leurs questions ; liez une autre banque ou demandez au propriétaire de la republier.",
  "pool_unpublished.deleted.subject": "La banque {poolName} a été supprimée",
  "pool_unpublished.deleted.body": "Le propriétaire de la banque « {poolName} » l'a supprimée : votre abonnement est terminé.",
  "pool_unpublished.action": "Ouvrir les banques",
  "project_scheduled.subject": "Projet annoncé : {projectTitle}",
  "project_scheduled.body": "Le projet « {projectTitle} » ouvre le {startAt}. Vous pourrez l'accepter dès ce moment.",
  "project_scheduled.unlinked.body": "Le projet « {projectTitle} » ouvre le {startAt}. Liez votre compte GitHub d'ici là, pour l'accepter dès son ouverture.",
  "project_scheduled.action": "Ouvrir le projet",
  "project_published.subject": "Nouveau projet : {projectTitle}",
  "project_published.body": "Le projet « {projectTitle} » est publié dans votre classe. Acceptez-le pour obtenir votre dépôt.",
  "project_published.unlinked.body": "Le projet « {projectTitle} » est publié dans votre classe. Liez votre compte GitHub, puis acceptez-le pour obtenir votre dépôt.",
  "project_published.action": "Ouvrir le projet",
  "project_deadline_reminder.subject": "Échéance dans les 24 heures : {projectTitle}",
  "project_deadline_reminder.body": "L'échéance du projet « {projectTitle} » tombe dans moins de 24 heures. Poussez ce que vous voulez voir évalué avant.",
  "project_deadline_reminder.action": "Ouvrir le projet",
  "project_repo_invited.subject": "Votre dépôt est prêt : {projectTitle}",
  "project_repo_invited.body": "Votre dépôt pour le projet « {projectTitle} » a été créé. Acceptez l'invitation sur GitHub pour commencer à y travailler.",
  "project_repo_invited.action": "Ouvrir le projet",
  "project_grade_final.subject": "Notes publiées : {projectTitle}",
  "project_grade_final.body": "Les notes du projet « {projectTitle} » sont publiées.",
  "project_grade_final.action": "Voir ma note",
  "project_contestation_resolved.subject": "Réponse à votre contestation : {projectTitle}",
  "project_contestation_resolved.body": "La contestation d'un critère du projet « {projectTitle} » a reçu une réponse.",
  "project_contestation_resolved.action": "Ouvrir le projet",
  "project_contestation_filed.subject": "{count} contestations : {projectTitle}",
  "project_contestation_filed.subject.one": "Une contestation : {projectTitle}",
  "project_contestation_filed.body": "{count} contestations ont été déposées sur des critères de « {projectTitle} ».",
  "project_contestation_filed.body.one": "La correction d'un critère de « {projectTitle} » a été contestée.",
  "project_contestation_filed.action": "Ouvrir le projet",
  "project_deadline_applied.subject": "Échéance appliquée à {count} dépôts : {projectTitle}",
  "project_deadline_applied.subject.one": "Échéance appliquée à un dépôt : {projectTitle}",
  "project_deadline_applied.body": "L'échéance de « {projectTitle} » a été appliquée à {count} dépôts.",
  "project_deadline_applied.body.one": "L'échéance de « {projectTitle} » a été appliquée à un dépôt.",
  "project_deadline_applied.action": "Ouvrir le projet",
  "project_provision_failed.subject": "{count} dépôts n'ont pas pu être créés : {projectTitle}",
  "project_provision_failed.subject.one": "Un dépôt n'a pas pu être créé : {projectTitle}",
  "project_provision_failed.body": "{count} dépôts d'étudiants de « {projectTitle} » n'ont pas pu être créés. Dernière cause : {reason}.",
  "project_provision_failed.body.one": "Le dépôt d'un étudiant de « {projectTitle} » n'a pas pu être créé : {reason}.",
  "project_provision_failed.action": "Ouvrir le projet",
  "github_org_lost.subject": "Organisation GitHub perdue : {classroomName}",
  "github_org_lost.body": "L'organisation {orgLogin} de {classroomName} a été supprimée sur GitHub, ou l'application HEIG Quiz en a été désinstallée. Rien ne peut être écrit dans ses dépôts tant qu'elle n'est pas reconnectée.",
  "github_org_lost.action": "Ouvrir les réglages de la classe",
  "reason.repo_name_taken": "un dépôt de ce nom existe déjà dans l'organisation, ce que seul l'encadrement peut résoudre",
  "reason.github_error": "GitHub a échoué ou refusé, et l'étudiant peut réessayer",
  "system_alert.failing.subject": "{host} : contrôles de santé en échec",
  "system_alert.failing.body": "Des contrôles de santé de {host} ont échoué deux fois de suite : {checks}.",
  "system_alert.still_failing.subject": "{host} : contrôles de santé toujours en échec",
  "system_alert.still_failing.body": "Des contrôles de santé de {host} échouent depuis plus d'un jour : {checks}.",
  "system_alert.recovered.subject": "{host} : contrôles de santé de nouveau OK",
  "system_alert.recovered.body": "Des contrôles de santé de {host} qui avaient échoué sont de nouveau OK : {checks}.",
  "system_alert.action": "Ouvrir l'état du système",
  "account_dormant.notice.subject": "Votre compte HEIG Quiz n'a pas servi depuis deux ans",
  "account_dormant.notice.body":
    "Vous n'avez pas utilisé HEIG Quiz depuis deux ans. Connectez-vous d'ici un an pour garder votre compte. Sinon, il sera anonymisé. Votre nom, vos adresses, votre photo et vos liens en seront retirés, et vos résultats resteront sans votre nom. Téléchargez d'abord vos données si vous voulez en garder une copie.",
  "account_dormant.reminder.subject": "Votre compte HEIG Quiz sera anonymisé dans trois mois",
  "account_dormant.reminder.body":
    "Vous n'avez pas utilisé HEIG Quiz depuis plus de deux ans. Connectez-vous d'ici trois mois pour garder votre compte. Sinon, il sera anonymisé. Votre nom, vos adresses, votre photo et vos liens en seront retirés, et vos résultats resteront sans votre nom. Téléchargez d'abord vos données si vous voulez en garder une copie.",
  "account_dormant.action": "Télécharger mes données",
  signin: "Se connecter",
  "test_mail.subject": "{host} : e-mail de test",
  "test_mail.body": "Ceci est un e-mail de test de {host}, envoyé à votre demande depuis la page État du système. Si vous le lisez, l'envoi des e-mails de la plateforme fonctionne.",
  "test_mail.action": "Retour à l'état du système",
  "check.ticker": "Horloge du direct (ticker)",
  "check.attempts.overdue": "Tentatives au-delà de leur échéance",
  "check.evaluations.overdue": "Évaluations au-delà de leur fin",
  "check.tasks": "Tâches planifiées",
  "check.jobs": "Tâches de fond en échec (24 h)",
  "check.runner": "Exécuteur de code",
  "check.evaluations.live": "Évaluations en cours",
  "check.connections.live": "Connexions temps réel",
  "check.database": "Réponse de la base de données",
  "check.database.size": "Taille de la base de données",
  "check.database.connections": "Connexions à la base de données",
  "check.disk": "Espace disque",
  "check.backup": "Dernière sauvegarde",
  "check.offsite": "Copie hors site",
  "check.http.errors": "Erreurs serveur (24 h)",
  "check.service.mail": "E-mail",
  "check.service.signin": "Connexion (fournisseur d'identité)",
  "check.service.teams": "Microsoft Teams",
  "check.service.llm": "Fournisseur d'IA",
  "check.llm.budget": "Dépenses d'IA du jour",
  "check.pdf": "Export PDF",
  "check.service.github": "Application GitHub",
  "check.accounts": "Cycle de vie des comptes",
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
  "activity.question_reported.description": "Un collègue signale un problème sur une question d'une banque où vous écrivez",
  "activity.question_reported.template": "{questionName} : {count} signalement(s)",
  "activity.question_report_resolved.description": "Un responsable traite votre signalement sur une question",
  "activity.question_report_resolved.template": "Signalement traité : {questionName}",
  "activity.pool_unpublished.description": "Une banque publique que vous utilisez quitte le catalogue",
  "activity.pool_unpublished.template": "La banque {poolName} a quitté le catalogue",
  "activity.activity_scheduled.description": "Des exercices sont planifiés dans votre classe",
  "activity.activity_scheduled.template": "{classroomName} : {count} exercice(s) planifié(s)",
  "activity.activity_available.description": "Un exercice s'ouvre",
  "activity.activity_available.template": "Exercice ouvert : {evaluationTitle}",
  "activity.deadline_approaching.description": "Une évaluation que vous n'avez pas rendue se termine dans les 24 heures",
  "activity.deadline_approaching.template": "Se termine dans les 24 heures : {evaluationTitle}",
  "activity.results_updated.description": "Votre note d'une évaluation publiée change",
  "activity.results_updated.template": "Résultats mis à jour : {evaluationTitle}",
  "activity.project_scheduled.description": "Un projet de votre classe est annoncé, avec sa date d'ouverture",
  "activity.project_scheduled.template": "{projectTitle} ouvre le {startAt}",
  "activity.project_published.description": "Un projet est publié dans votre classe",
  "activity.project_published.template": "Nouveau projet : {projectTitle}",
  "activity.project_deadline_reminder.description": "L'échéance d'un projet tombe dans les 24 heures",
  "activity.project_deadline_reminder.template": "Échéance dans les 24 heures : {projectTitle}",
  "activity.project_repo_invited.description": "Votre dépôt pour un projet est prêt sur GitHub",
  "activity.project_repo_invited.template": "Votre dépôt est prêt : {projectTitle}",
  "activity.project_grade_final.description": "Les notes d'un projet sont publiées",
  "activity.project_grade_final.template": "Notes publiées : {projectTitle}",
  "activity.project_deadline_applied.description": "L'échéance d'un de vos projets a été appliquée à ses dépôts",
  "activity.project_deadline_applied.template": "{projectTitle} : échéance appliquée à {count} dépôt(s)",
  "activity.project_provision_failed.description": "Le dépôt d'un étudiant d'un de vos projets n'a pas pu être créé",
  "activity.project_provision_failed.template": "{projectTitle} : {count} dépôt(s) n'ont pas pu être créés",
  "activity.github_org_lost.description": "L'organisation GitHub d'une de vos classes a été supprimée ou l'application désinstallée",
  "activity.github_org_lost.template": "Organisation GitHub perdue : {classroomName}",
  "activity.contestation_resolved.description": "Votre contestation d'une question reçoit une réponse",
  "activity.contestation_resolved.template": "Contestation traitée : {evaluationTitle}",
  "activity.contestation_filed.description": "La correction d'une question d'un examen publié est contestée",
  "activity.contestation_filed.template": "{evaluationTitle} : {count} contestation(s)",
  "activity.project_contestation_resolved.description": "Votre contestation d'un critère de projet reçoit une réponse",
  "activity.project_contestation_resolved.template": "Contestation traitée : {projectTitle}",
  "activity.project_contestation_filed.description": "La correction d'un critère d'un projet publié est contestée",
  "activity.project_contestation_filed.template": "{projectTitle} : {count} contestation(s)",
};

/**
 * German, a translated language (ADR-140 §2): drafted from the English, by
 * the rules of the web app's German (Swiss spelling, «Sie», the glossary of
 * spec 01 §1.5). A Teams template keeps the English's parameters; where a
 * count would need a plural form the template cannot choose, it stands
 * after a colon.
 */
const de: Record<Key, string> = {
  "results_released.subject": "Ergebnisse verfügbar: {evaluationTitle}",
  "results_released.body": "Die Ergebnisse von «{evaluationTitle}» sind verfügbar.",
  "results_released.action": "Meine Ergebnisse ansehen",
  "activity_scheduled.subject": "{count} Übungen in {classroomName} geplant",
  "activity_scheduled.subject.one": "Eine Übung in {classroomName} geplant",
  "activity_scheduled.body": "In {classroomName} wurden {count} Übungen geplant.",
  "activity_scheduled.body.one": "In {classroomName} wurde eine Übung geplant.",
  "activity_scheduled.action": "Meine Aktivitäten ansehen",
  "activity_available.subject": "Übung offen: {evaluationTitle}",
  "activity_available.body": "Die Übung «{evaluationTitle}» ist offen. Sie können sie jetzt bearbeiten.",
  "activity_available.action": "Übung öffnen",
  "deadline_approaching.subject": "Schliesst in den nächsten 24 Stunden: {evaluationTitle}",
  "deadline_approaching.body": "«{evaluationTitle}» schliesst in weniger als 24 Stunden, und Sie haben noch nicht abgegeben.",
  "deadline_approaching.action": "Test öffnen",
  "results_updated.subject": "Ergebnisse aktualisiert: {evaluationTitle}",
  "results_updated.body": "Ihre Note für «{evaluationTitle}» hat sich nach einer Korrektur geändert.",
  "results_updated.action": "Meine Ergebnisse ansehen",
  "contestation_resolved.subject": "Ihre Beanstandung wurde beantwortet: {evaluationTitle}",
  "contestation_resolved.body": "Ihre Beanstandung zu «{evaluationTitle}» wurde beantwortet.",
  "contestation_resolved.action": "Meine Ergebnisse ansehen",
  "contestation_filed.subject": "{count} Beanstandungen: {evaluationTitle}",
  "contestation_filed.subject.one": "Eine Beanstandung: {evaluationTitle}",
  "contestation_filed.body": "Zu «{evaluationTitle}» gingen {count} Beanstandungen ein.",
  "contestation_filed.body.one": "Die Korrektur einer Frage von «{evaluationTitle}» wurde beanstandet.",
  "contestation_filed.action": "Korrektur öffnen",
  "pool_shared.subject": "Ein Fragenpool wurde mit Ihnen geteilt: {poolName}",
  "pool_shared.body": "{byName} hat den Fragenpool «{poolName}» mit Ihnen geteilt (Rolle: {role}).",
  "pool_shared.action": "Fragenpool öffnen",
  "pool_ownership.subject": "Der Fragenpool {poolName} gehört jetzt Ihnen",
  "pool_ownership.body": "Der Fragenpool «{poolName}» gehört jetzt Ihnen (übergeben von {fromName}).",
  "pool_ownership.action": "Fragenpool öffnen",
  "student_joined.subject": "{count} Studierende sind {classroomName} beigetreten",
  "student_joined.subject.one": "Eine Person ist {classroomName} beigetreten",
  "student_joined.body": "{count} Studierende haben ihren Platz in {classroomName} eingenommen.",
  "student_joined.body.one": "Eine studierende Person hat ihren Platz in {classroomName} eingenommen.",
  "student_joined.action": "Klassenliste öffnen",
  "roster_conflict.subject": "{count} Einträge der Klassenliste von {classroomName} brauchen Ihre Entscheidung",
  "roster_conflict.subject.one": "Ein Eintrag der Klassenliste von {classroomName} braucht Ihre Entscheidung",
  "roster_conflict.body": "{count} Einträge der Klassenliste von {classroomName} konnten nicht automatisch einem Konto zugeordnet werden und brauchen Ihre Entscheidung.",
  "roster_conflict.body.one": "Ein Eintrag der Klassenliste von {classroomName} konnte nicht automatisch einem Konto zugeordnet werden und braucht Ihre Entscheidung.",
  "roster_conflict.action": "Klassenliste öffnen",
  "grading_ready.subject": "{count} Vorschläge zu validieren: {evaluationTitle}",
  "grading_ready.subject.one": "Ein Vorschlag zu validieren: {evaluationTitle}",
  "grading_ready.body": "Die automatische Korrektur von «{evaluationTitle}» ist abgeschlossen. {count} Vorschläge warten auf Ihre Validierung.",
  "grading_ready.body.one": "Die automatische Korrektur von «{evaluationTitle}» ist abgeschlossen. Ein Vorschlag wartet auf Ihre Validierung.",
  "grading_ready.action": "Korrektur öffnen",
  "pool_question_added.subject": "{count} Fragen in {poolName} veröffentlicht",
  "pool_question_added.subject.one": "Eine Frage in {poolName} veröffentlicht",
  "pool_question_added.body": "Im Fragenpool «{poolName}» wurden {count} Fragen veröffentlicht.",
  "pool_question_added.body.one": "Im Fragenpool «{poolName}» wurde eine Frage veröffentlicht.",
  "pool_question_added.action": "Fragenpool öffnen",
  "question_reported.subject": "{count} Meldungen zu {questionName}",
  "question_reported.subject.one": "Eine Meldung zu {questionName}",
  "question_reported.body": "Zur Frage «{questionName}» des Fragenpools «{poolName}» gingen {count} Meldungen ein.",
  "question_reported.body.one": "Zur Frage «{questionName}» des Fragenpools «{poolName}» ging eine Meldung ein.",
  "question_reported.action": "Frage öffnen",
  "question_report_resolved.subject": "Ihre Meldung wurde erledigt: {questionName}",
  "question_report_resolved.body": "Ihre Meldung zur Frage «{questionName}» im Fragenpool «{poolName}» wurde erledigt.",
  "question_report_resolved.action": "Frage öffnen",
  // A public pool left the catalogue (ADR-095): one sentence per state.
  "pool_unpublished.unpublished.subject": "Der Fragenpool {poolName} ist nicht mehr im Katalog",
  "pool_unpublished.unpublished.body": "Der Fragenpool «{poolName}» wurde aus dem Katalog genommen: Ihr Abonnement ist beendet.",
  "pool_unpublished.course.subject": "Der Fragenpool {poolName} ist nicht mehr im Katalog",
  "pool_unpublished.course.body": "Der Fragenpool «{poolName}» wurde aus dem Katalog genommen: Ihr Kurs «{courseName}» bezieht keine Fragen mehr daraus. Seine Tests behalten ihre Fragen. Verknüpfen Sie einen anderen Fragenpool, oder bitten Sie die verantwortliche Person, ihn wieder zu veröffentlichen.",
  "pool_unpublished.deleted.subject": "Der Fragenpool {poolName} wurde gelöscht",
  "pool_unpublished.deleted.body": "Der Fragenpool «{poolName}» wurde gelöscht: Ihr Abonnement ist beendet.",
  "pool_unpublished.action": "Fragenpools öffnen",
  // The project kinds (F-NOTIF-13, M3-09b): the project's name and counts,
  // never a score nor a student's name.
  "project_scheduled.subject": "Projekt angekündigt: {projectTitle}",
  "project_scheduled.body": "Das Projekt «{projectTitle}» beginnt am {startAt}. Ab dann können Sie es annehmen.",
  "project_scheduled.unlinked.body": "Das Projekt «{projectTitle}» beginnt am {startAt}. Verknüpfen Sie vorher Ihr GitHub-Konto, um es dann annehmen zu können.",
  "project_scheduled.action": "Projekt öffnen",
  "project_published.subject": "Neues Projekt: {projectTitle}",
  "project_published.body": "Das Projekt «{projectTitle}» ist in Ihrer Klasse veröffentlicht. Nehmen Sie es an, um Ihr Repository zu erhalten.",
  "project_published.unlinked.body": "Das Projekt «{projectTitle}» ist in Ihrer Klasse veröffentlicht. Verknüpfen Sie Ihr GitHub-Konto und nehmen Sie es dann an, um Ihr Repository zu erhalten.",
  "project_published.action": "Projekt öffnen",
  "project_deadline_reminder.subject": "Frist in weniger als 24 Stunden: {projectTitle}",
  "project_deadline_reminder.body": "Die Frist des Projekts «{projectTitle}» endet in weniger als 24 Stunden. Pushen Sie vorher, was korrigiert werden soll.",
  "project_deadline_reminder.action": "Projekt öffnen",
  "project_repo_invited.subject": "Ihr Repository ist bereit: {projectTitle}",
  "project_repo_invited.body": "Ihr Repository für das Projekt «{projectTitle}» wurde erstellt. Nehmen Sie die Einladung auf GitHub an, um darin zu arbeiten.",
  "project_repo_invited.action": "Projekt öffnen",
  "project_grade_final.subject": "Scores freigegeben: {projectTitle}",
  "project_grade_final.body": "Die Scores des Projekts «{projectTitle}» sind freigegeben.",
  "project_grade_final.action": "Meinen Score ansehen",
  "project_contestation_resolved.subject": "Ihre Beanstandung wurde beantwortet: {projectTitle}",
  "project_contestation_resolved.body": "Die Beanstandung eines Kriteriums des Projekts «{projectTitle}» wurde beantwortet.",
  "project_contestation_resolved.action": "Projekt öffnen",
  "project_contestation_filed.subject": "{count} Beanstandungen: {projectTitle}",
  "project_contestation_filed.subject.one": "Eine Beanstandung: {projectTitle}",
  "project_contestation_filed.body": "Zu Kriterien von «{projectTitle}» gingen {count} Beanstandungen ein.",
  "project_contestation_filed.body.one": "Die Korrektur eines Kriteriums von «{projectTitle}» wurde beanstandet.",
  "project_contestation_filed.action": "Projekt öffnen",
  "project_deadline_applied.subject": "Frist auf {count} Repositories angewendet: {projectTitle}",
  "project_deadline_applied.subject.one": "Frist auf ein Repository angewendet: {projectTitle}",
  "project_deadline_applied.body": "Die Frist von «{projectTitle}» wurde auf {count} Repositories angewendet.",
  "project_deadline_applied.body.one": "Die Frist von «{projectTitle}» wurde auf ein Repository angewendet.",
  "project_deadline_applied.action": "Projekt öffnen",
  "project_provision_failed.subject": "{count} Repositories konnten nicht erstellt werden: {projectTitle}",
  "project_provision_failed.subject.one": "Ein Repository konnte nicht erstellt werden: {projectTitle}",
  "project_provision_failed.body": "{count} Repositories von Studierenden für «{projectTitle}» konnten nicht erstellt werden. Letzte Ursache: {reason}.",
  "project_provision_failed.body.one": "Ein Repository für «{projectTitle}» konnte nicht erstellt werden: {reason}.",
  "project_provision_failed.action": "Projekt öffnen",
  "github_org_lost.subject": "GitHub-Organisation verloren: {classroomName}",
  "github_org_lost.body": "Die Organisation {orgLogin} von {classroomName} wurde auf GitHub gelöscht, oder die App von HEIG Quiz wurde dort deinstalliert. In ihre Repositories kann nichts geschrieben werden, bis sie wieder verbunden ist.",
  "github_org_lost.action": "Einstellungen der Klasse öffnen",
  // Why a repository could not be made (`project_provision_failed.reason`).
  "reason.repo_name_taken": "Name in der Organisation schon vergeben (nur das Lehrteam kann das beheben)",
  "reason.github_error": "Fehler oder Ablehnung durch GitHub (Studierende können es erneut versuchen)",
  "system_alert.failing.subject": "{host}: Systemchecks schlagen fehl",
  "system_alert.failing.body": "Systemchecks von {host} sind zweimal hintereinander fehlgeschlagen: {checks}.",
  "system_alert.still_failing.subject": "{host}: Systemchecks schlagen weiterhin fehl",
  "system_alert.still_failing.body": "Systemchecks von {host} schlagen seit mehr als einem Tag fehl: {checks}.",
  "system_alert.recovered.subject": "{host}: Systemchecks wieder OK",
  "system_alert.recovered.body": "Fehlgeschlagene Systemchecks von {host} sind wieder OK: {checks}.",
  "system_alert.action": "Systemstatus öffnen",
  // The account lifecycle (ADR-117 §4): never "deleted", the results stay.
  "account_dormant.notice.subject": "Ihr Konto bei HEIG Quiz wurde seit zwei Jahren nicht benutzt",
  "account_dormant.notice.body":
    "Sie haben HEIG Quiz seit zwei Jahren nicht benutzt. Melden Sie sich innerhalb eines Jahres an, um Ihr Konto zu behalten. Sonst wird es anonymisiert: Ihr Name, Ihre Adressen, Ihr Bild und Ihre Verknüpfungen werden entfernt, und Ihre Ergebnisse bleiben ohne Ihren Namen erhalten. Laden Sie vorher Ihre Daten herunter, wenn Sie eine Kopie möchten.",
  "account_dormant.reminder.subject": "Ihr Konto bei HEIG Quiz wird in drei Monaten anonymisiert",
  "account_dormant.reminder.body":
    "Sie haben HEIG Quiz seit über zwei Jahren nicht benutzt. Melden Sie sich innerhalb von drei Monaten an, um Ihr Konto zu behalten. Sonst wird es anonymisiert: Ihr Name, Ihre Adressen, Ihr Bild und Ihre Verknüpfungen werden entfernt, und Ihre Ergebnisse bleiben ohne Ihren Namen erhalten. Laden Sie vorher Ihre Daten herunter, wenn Sie eine Kopie möchten.",
  "account_dormant.action": "Meine Daten herunterladen",
  signin: "Anmelden",
  // The administrator's "Send me a test e-mail" (ADR-055 §6): no kind, no preference.
  "test_mail.subject": "{host}: Test-E-Mail",
  "test_mail.body": "Dies ist eine Test-E-Mail von {host}, auf Ihre Anfrage von der Seite Systemstatus gesendet. Wenn Sie sie lesen, funktioniert der E-Mail-Versand der Plattform.",
  "test_mail.action": "Zurück zum Systemstatus",
  // The checks by name, as the System status page names them
  // (`admin.system.check.*` in the web's dictionaries).
  "check.ticker": "Live-Uhr (Ticker)",
  "check.attempts.overdue": "Versuche nach ihrer Frist",
  "check.evaluations.overdue": "Tests nach ihrem Ende",
  "check.tasks": "Geplante Aufgaben",
  "check.jobs": "Fehlgeschlagene Hintergrundjobs (24 h)",
  "check.runner": "Code-Runner",
  "check.evaluations.live": "Laufende Tests",
  "check.connections.live": "Echtzeitverbindungen",
  "check.database": "Antwortzeit der Datenbank",
  "check.database.size": "Grösse der Datenbank",
  "check.database.connections": "Datenbankverbindungen",
  "check.disk": "Speicherplatz",
  "check.backup": "Letztes Backup",
  "check.offsite": "Externe Kopie",
  "check.http.errors": "Serverfehler (24 h)",
  "check.service.mail": "E-Mail",
  "check.service.signin": "Anmeldung (Identitätsanbieter)",
  "check.service.teams": "Microsoft Teams",
  "check.service.llm": "KI-Anbieter",
  "check.llm.budget": "KI-Ausgaben heute",
  "check.pdf": "PDF-Export",
  "check.service.github": "GitHub App",
  "check.accounts": "Lebenszyklus der Konten",
  // A pool's roles, as the web's `share.role.*` name them.
  "role.reader": "Lesezugriff",
  "role.contributor": "Mitarbeit",
  "role.owner": "Verantwortlich",
  footer: "Sie erhalten diese Nachricht von HEIG Quiz. In Ihren Einstellungen wählen Sie, welche Benachrichtigungen Sie wo erhalten:",
  "footer.link": "Benachrichtigungseinstellungen",
  // The Teams app package (`teamsApp.ts`), under the same caps as the English.
  "app.name.short": "HEIG Quiz",
  "app.name.full": "Benachrichtigungen von HEIG Quiz",
  "app.description.short": "Ihre Benachrichtigungen von HEIG Quiz in Ihrem Teams-Aktivitätsfeed.",
  "app.description.full":
    "HEIG Quiz sendet seine Benachrichtigungen in Ihren Teams-Aktivitätsfeed: freigegebene Ergebnisse, mit Ihnen geteilte Fragenpools, Neuigkeiten aus Ihren Klassen und Tests. Öffnen Sie die App einmal und verknüpfen Sie sie mit Ihrem Quiz-Konto. Wählen Sie dann in den Einstellungen der Plattform, welche Benachrichtigungen Sie in Teams erhalten.",
  "app.tab.name": "Startseite",
  "activity.results_released.description": "Die Ergebnisse eines Tests, an dem Sie teilgenommen haben, sind freigegeben",
  "activity.results_released.template": "Ergebnisse verfügbar: {evaluationTitle}",
  "activity.pool_shared.description": "Ein Fragenpool wird mit Ihnen geteilt",
  "activity.pool_shared.template": "{byName} hat den Fragenpool {poolName} mit Ihnen geteilt",
  "activity.pool_ownership.description": "Ein Fragenpool wird Ihnen übergeben",
  "activity.pool_ownership.template": "Der Fragenpool {poolName} gehört jetzt Ihnen",
  "activity.student_joined.description": "Studierende treten einer Ihrer Klassen bei",
  "activity.student_joined.template": "Neue Studierende in {classroomName}: {count}",
  "activity.roster_conflict.description": "Einträge der Klassenliste einer Ihrer Klassen brauchen Ihre Entscheidung",
  "activity.roster_conflict.template": "Offene Einträge der Klassenliste von {classroomName}: {count}",
  "activity.grading_ready.description": "Die automatische Korrektur ist abgeschlossen, Vorschläge warten auf Ihre Validierung",
  "activity.grading_ready.template": "Korrektur zu validieren: {evaluationTitle}",
  "activity.pool_question_added.description": "In einem Fragenpool, den Sie teilen, werden Fragen veröffentlicht",
  "activity.pool_question_added.template": "Neue Fragen in {poolName}: {count}",
  "activity.question_reported.description": "Zu einer Frage eines Fragenpools, an dem Sie mitarbeiten, wird ein Problem gemeldet",
  "activity.question_reported.template": "Meldungen zu {questionName}: {count}",
  "activity.question_report_resolved.description": "Ihre Meldung zu einer Frage wird erledigt",
  "activity.question_report_resolved.template": "Meldung erledigt: {questionName}",
  "activity.pool_unpublished.description": "Ein öffentlicher Fragenpool, den Sie nutzen, verlässt den Katalog",
  "activity.pool_unpublished.template": "Der Fragenpool {poolName} ist nicht mehr im Katalog",
  "activity.activity_scheduled.description": "In Ihrer Klasse werden Übungen geplant",
  "activity.activity_scheduled.template": "Geplante Übungen in {classroomName}: {count}",
  "activity.activity_available.description": "Eine Übung wird geöffnet",
  "activity.activity_available.template": "Übung offen: {evaluationTitle}",
  "activity.deadline_approaching.description": "Ein Test, den Sie noch nicht abgegeben haben, schliesst in den nächsten 24 Stunden",
  "activity.deadline_approaching.template": "Schliesst in den nächsten 24 Stunden: {evaluationTitle}",
  "activity.results_updated.description": "Ihre Note in einem Test mit freigegebenen Ergebnissen ändert sich",
  "activity.results_updated.template": "Ergebnisse aktualisiert: {evaluationTitle}",
  "activity.project_scheduled.description": "Ein Projekt Ihrer Klasse wird mit seinem Startdatum angekündigt",
  "activity.project_scheduled.template": "{projectTitle} beginnt am {startAt}",
  "activity.project_published.description": "Ein Projekt wird in Ihrer Klasse veröffentlicht",
  "activity.project_published.template": "Neues Projekt: {projectTitle}",
  "activity.project_deadline_reminder.description": "Die Frist eines Projekts endet in weniger als 24 Stunden",
  "activity.project_deadline_reminder.template": "Frist in weniger als 24 Stunden: {projectTitle}",
  "activity.project_repo_invited.description": "Ihr Repository für ein Projekt ist auf GitHub bereit",
  "activity.project_repo_invited.template": "Ihr Repository ist bereit: {projectTitle}",
  "activity.project_grade_final.description": "Die Scores eines Projekts sind freigegeben",
  "activity.project_grade_final.template": "Scores freigegeben: {projectTitle}",
  "activity.project_deadline_applied.description": "Die Frist eines Ihrer Projekte wurde auf seine Repositories angewendet",
  "activity.project_deadline_applied.template": "Frist von {projectTitle} auf Repositories angewendet: {count}",
  "activity.project_provision_failed.description": "Ein Repository eines Ihrer Projekte konnte nicht erstellt werden",
  "activity.project_provision_failed.template": "Nicht erstellte Repositories von {projectTitle}: {count}",
  "activity.github_org_lost.description": "Die GitHub-Organisation einer Ihrer Klassen wurde gelöscht oder die App deinstalliert",
  "activity.github_org_lost.template": "GitHub-Organisation verloren: {classroomName}",
  "activity.contestation_resolved.description": "Ihre Beanstandung einer Frage wird beantwortet",
  "activity.contestation_resolved.template": "Beanstandung beantwortet: {evaluationTitle}",
  "activity.contestation_filed.description": "Die Korrektur einer Frage einer Prüfung mit freigegebenen Ergebnissen wird beanstandet",
  "activity.contestation_filed.template": "Beanstandungen zu {evaluationTitle}: {count}",
  "activity.project_contestation_resolved.description": "Ihre Beanstandung eines Projektkriteriums wird beantwortet",
  "activity.project_contestation_resolved.template": "Beanstandung beantwortet: {projectTitle}",
  "activity.project_contestation_filed.description": "Die Korrektur eines Kriteriums eines Projekts mit freigegebenen Scores wird beanstandet",
  "activity.project_contestation_filed.template": "Beanstandungen zu {projectTitle}: {count}",
};

const DICTS: Record<Locale, Record<Key, string>> = { en, fr, de };

/** The whole dictionary of one language (the Teams app package reads it). */
export function serverText(locale: Locale): Record<Key, string> {
  return DICTS[locale];
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

/** The `Intl` tag of each language's dates in a message. */
const DATE_TAGS: Record<Locale, string> = { en: "en-GB", fr: "fr-CH", de: "de-CH" };

/**
 * An instant as the school reads it (`SCHOOL_TIME_ZONE`), in digits only —
 * `06.11.2026 16:30` in French, `06.11.2026, 16:30` in German,
 * `06/11/2026, 16:30` in English: a Teams template parameter is never a
 * translated word.
 */
function schoolDateTime(at: string, locale: Locale): string {
  return new Intl.DateTimeFormat(DATE_TAGS[locale], {
    timeZone: SCHOOL_TIME_ZONE,
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).format(new Date(at));
}

/** The values a kind's sentences read, and the page its link opens. */
function varsOf(payload: OutboundPayload, locale: Locale): Record<string, string> {
  const t = DICTS[locale];
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
    case "contestation_resolved":
      return { evaluationTitle: payload.evaluationTitle };
    case "grading_ready":
    case "contestation_filed":
      return { evaluationTitle: payload.evaluationTitle, count: String(payload.count) };
    case "pool_question_added":
      return { poolName: payload.poolName, count: String(payload.count) };
    case "question_reported":
      return { poolName: payload.poolName, questionName: payload.questionName, count: String(payload.count) };
    case "question_report_resolved":
      return { poolName: payload.poolName, questionName: payload.questionName };
    case "pool_unpublished":
      return { poolName: payload.poolName, courseName: payload.courseName ?? "" };
    case "project_scheduled":
      return { projectTitle: payload.projectTitle, startAt: schoolDateTime(payload.startAt, locale) };
    case "project_published":
    case "project_deadline_reminder":
    case "project_repo_invited":
    case "project_grade_final":
    case "project_contestation_resolved":
      return { projectTitle: payload.projectTitle };
    case "project_deadline_applied":
    case "project_contestation_filed":
      return { projectTitle: payload.projectTitle, count: String(payload.count) };
    case "project_provision_failed":
      return { projectTitle: payload.projectTitle, count: String(payload.count), reason: t[`reason.${payload.reason}`] };
    case "github_org_lost":
      return { classroomName: payload.classroomName, orgLogin: payload.orgLogin };
    case "system_alert":
      // `{host}` is added by `renderNotification`, which knows the address.
      return { checks: payload.checks.map((key) => t[`check.${key}`]).join(", ") };
    case "account_dormant":
      return {};
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
function sentenceKey(payload: OutboundPayload, part: "subject" | "body"): Key {
  // A kind with a state (`system_alert`) has one sentence per state.
  // A payload that says the recipient has no linked GitHub account has another body (M3-14d).
  const state = "state" in payload ? `.${payload.state}` : part === "body" && "githubLinked" in payload ? ".unlinked" : "";
  const one =
    "count" in payload && payload.count === 1 && !UNCOUNTED_KINDS.has(payload.kind) ? ".one" : "";
  return `${payload.kind}${state}.${part}${one}` as Key;
}

/**
 * Where a notification takes its reader in the app, the same page the bell
 * opens (`notificationRoute` in the web app).
 */
export function notificationPath(payload: OutboundPayload): string {
  switch (payload.kind) {
    case "results_released":
    case "results_updated":
    case "contestation_resolved":
      return `/attempts/${payload.attemptId}/feedback`;
    case "pool_shared":
    case "pool_ownership":
    case "pool_question_added":
      return `/pools/${payload.poolId}`;
    case "pool_unpublished":
      return "/pools";
    case "question_reported":
    case "question_report_resolved":
      return `/questions/${payload.questionId}?tab=reports`;
    case "student_joined":
    case "roster_conflict":
      return `/classrooms/${payload.classroomId}?tab=roster`;
    case "grading_ready":
      return `/evaluations/${payload.evaluationId}/grading`;
    // The grading panel on its contested filter (ADR-139).
    case "contestation_filed":
      return `/evaluations/${payload.evaluationId}/grading?filter=contested`;
    // The student home lists what is coming; the page of an attempt lets the
    // student in (the server decides between the lobby and the player).
    case "activity_scheduled":
      return "/";
    case "deadline_approaching":
      return `/take/${payload.evaluationId}`;
    case "system_alert":
      return "/admin?tab=system";
    // The Settings, where "Download my data" is (N-DATA-04); reaching them signs in.
    case "account_dormant":
      return "/settings";
    // The project: the staff's page, or the student's view of it (M3-13).
    case "project_scheduled":
    case "project_published":
    case "project_deadline_reminder":
    case "project_repo_invited":
    case "project_grade_final":
    case "project_contestation_resolved":
    case "project_deadline_applied":
    case "project_provision_failed":
    case "project_contestation_filed":
      return `/projects/${payload.projectId}`;
    case "github_org_lost":
      return `/classrooms/${payload.classroomId}/settings`;
    case "activity_available":
      switch (payload.activityKind) {
        case "evaluation":
          return `/take/${payload.activityId}`;
        // Never sent for a project, which has kinds of its own (F-NOTIF-13):
        // the student's Activities, which list it.
        case "project":
          return "/";
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
export function mailLocale(locale: string | null | undefined): Locale {
  return isLocale(locale) ? locale : FALLBACK_LOCALE;
}

/**
 * Renders one notification for one recipient. `webUrl` is where a browser
 * reaches the SPA (`WEB_URL`, which defaults to `PUBLIC_URL`; `config.ts` strips its
 * trailing slash, once for every caller).
 */
export function renderNotification(
  payload: OutboundPayload,
  locale: Locale,
  webUrl: string,
): RenderedNotification {
  const t = DICTS[locale];
  const kind: OutboundNotificationKind = payload.kind;
  const vars: Record<string, string> = { ...varsOf(payload, locale), host: hostOf(webUrl) };
  // An account kind: no toggle to point at, and the sign-in that keeps the account.
  const account = ACCOUNT_KINDS.includes(kind);
  const mail = composeMail(t, {
    subject: sentenceKey(payload, "subject"),
    body: sentenceKey(payload, "body"),
    vars,
    action: t[`${kind}.action`],
    path: notificationPath(payload),
    webUrl,
    ...(account ? { footer: false, secondary: { action: t.signin, path: "/" } } : {}),
  });
  const topic =
    teamsLine(vars.evaluationTitle ?? vars.projectTitle ?? vars.poolName ?? vars.classroomName ?? "") || t["app.name.short"];
  const preview = teamsLine(fill(t[sentenceKey(payload, "body")], vars, plain));

  return { ...mail, topic, preview };
}

/**
 * The administrator's test e-mail (ADR-055 §6): the same layout as every
 * message, naming the platform, and linking back to the System status.
 */
export function renderTestMail(locale: Locale, webUrl: string): Pick<RenderedNotification, "subject" | "text" | "html"> {
  const t = DICTS[locale];
  return composeMail(t, {
    subject: "test_mail.subject",
    body: "test_mail.body",
    vars: { host: hostOf(webUrl) },
    action: t["test_mail.action"],
    path: "/admin?tab=system",
    webUrl,
    // Not a notification: no preference chose it, so no settings footer.
    footer: false,
  });
}

/**
 * One e-mail: its subject on one line, a plain-text part and an HTML part, a
 * button to `path`, a plain link to `secondary` when given, and — unless
 * `footer: false` — the line pointing at the notification settings.
 */
function composeMail(
  t: Record<Key, string>,
  m: {
    subject: Key;
    body: Key;
    vars: Record<string, string>;
    action: string;
    path: string;
    webUrl: string;
    footer?: boolean;
    secondary?: { action: string; path: string };
  },
): Pick<RenderedNotification, "subject" | "text" | "html"> {
  const link = `${m.webUrl}${m.path}`;
  const second = m.secondary ? { action: m.secondary.action, link: `${m.webUrl}${m.secondary.path}` } : null;
  const settings = `${m.webUrl}/settings`;
  const footer = m.footer ?? true;
  const subject = oneLine(fill(t[m.subject], m.vars, plain));
  const body = fill(t[m.body], m.vars, plain);
  const text = [
    body,
    "",
    `${m.action}: ${link}`,
    ...(second ? [`${second.action}: ${second.link}`] : []),
    ...(footer ? ["", "--", `${t.footer} ${settings}`] : []),
  ].join("\n");
  const bodyHtml = fill(t[m.body], m.vars, escapeHtml);
  const footerHtml = footer
    ? `\n  <p style="font-size:12px;line-height:1.5;color:#71717a;border-top:1px solid #e4e4e7;padding-top:12px;margin:0">${escapeHtml(t.footer)} <a href="${escapeHtml(settings)}" style="color:#71717a">${escapeHtml(t["footer.link"])}</a></p>`
    : "";
  const secondHtml = second
    ? `\n  <p style="font-size:14px;margin:-12px 0 28px"><a href="${escapeHtml(second.link)}" style="color:#18181b">${escapeHtml(second.action)}</a></p>`
    : "";
  const html = `<div style="font-family:system-ui,-apple-system,sans-serif;max-width:560px;margin:0 auto;padding:24px;color:#18181b">
  <p style="font-size:13px;font-weight:600;letter-spacing:.02em;color:#71717a;margin:0 0 16px">HEIG Quiz</p>
  <p style="font-size:15px;line-height:1.6;margin:0 0 20px">${bodyHtml}</p>
  <p style="margin:0 0 28px"><a href="${escapeHtml(link)}" style="background:#18181b;color:#ffffff;text-decoration:none;padding:10px 16px;border-radius:8px;font-size:14px;font-weight:500">${escapeHtml(m.action)}</a></p>${secondHtml}${footerHtml}
</div>`;
  return { subject, text, html };
}

/** The host of the SPA's address: which platform a system alert is about (production, staging). */
function hostOf(webUrl: string): string {
  try {
    return new URL(webUrl).host;
  } catch {
    return webUrl;
  }
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
export function activityParameters(
  payload: Extract<NotificationPayload, { kind: TeamsNotificationKind }>,
): Record<string, string> {
  const vars = varsOf(payload, "en");
  return Object.fromEntries(
    placeholders(en[`activity.${payload.kind}.template`]).map((name) => [name, oneLine(vars[name] ?? "")]),
  );
}
