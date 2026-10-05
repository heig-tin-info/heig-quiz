# Projet

## Ce qu'est cet écran

Un projet : un dépôt GitHub privé par étudiant, ou par groupe, copié depuis
un dépôt source à vous. La CI du dépôt calcule le score ; Quiz gère
l'échéance, les fichiers protégés, les scores et la publication. L'action
principale suit l'état : **Publier** pour un brouillon, **Synchroniser**
quand la source a de l'avance, **Publier les scores** quand tout est
définitif.

## Le tableau

Une ligne par étudiant ou par groupe : le dépôt, l'état de l'invitation, le
dernier commit, la CI, les scores et les drapeaux (verrouillé, après
l'échéance, à vérifier, supprimé sur GitHub, accès à retirer). Une ligne
ouvre un panneau avec les exécutions, **Renvoyer** l'invitation, l'échéance
propre au dépôt, **Verrouiller maintenant** et la note de l'enseignant.

## Scores

Le score **courant** est celui de la dernière exécution reçue avant
l'échéance. À l'échéance il devient le score **gelé**, définitif après le
délai de grâce. La **revue finale** par LLM est demandée une fois par dépôt,
quand son gel est définitif. Le score **final** est celui de l'enseignant,
sinon celui de la revue, sinon le score gelé. Les étudiants voient un score
*indicatif* jusqu'à ce que vous **publiiez les scores**. Un score *à
vérifier* repose sur une exécution dont les fichiers protégés ont été
restaurés : il bloque la publication tant que vous n'avez pas saisi la note
de l'enseignant.

## Échéance

L'échéance est appliquée sur l'horloge du serveur ; ce qui compte pour un
push, c'est l'heure à laquelle Quiz l'a reçu. Pour un étudiant qui a droit
à plus de temps, donnez à son dépôt une échéance propre depuis son panneau.
Repousser l'échéance après qu'elle est passée rouvre le projet, après
confirmation.

## Fichiers protégés

Un push qui en touche un est recouvert par un commit de restauration de
Quiz ; le travail de l'étudiant n'est jamais réécrit. Au-delà de cinq
restaurations en une heure, le dépôt est signalé *fichiers protégés en
conflit* et vous réactivez la protection à la main.

## Synchronisation et fin du projet

Quand la source a de nouveaux commits, **Synchroniser** ouvre une pull
request par branche distribuée dans chaque dépôt ouvert ; l'étudiant la
fusionne, jamais Quiz. **Archiver** masque le projet. **Supprimer le
projet** efface ses lignes dans Quiz, jamais un dépôt sur GitHub.
