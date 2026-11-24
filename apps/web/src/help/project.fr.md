# Projet

## Ce qu'est cet écran

Un projet : un dépôt GitHub privé par étudiant, ou par groupe, copié depuis
un dépôt source à vous. La CI du dépôt calcule le score ; Quiz gère
l'échéance, les fichiers protégés, les scores et la publication. L'action
principale suit l'état : **Publier** pour un brouillon, **Synchroniser**
quand la source a de l'avance, **Publier les scores** quand tout est
définitif, **Ouvrir les dépôts** une fois terminé un test de labo passé sous
Safe Exam Browser.

## Tests de labo sous Safe Exam Browser

Pendant un test de labo sous Safe Exam Browser ou sur un poste kiosque,
personne n'est invité sur GitHub. Une fois tous les dépôts figés et les
scores publiés (pour un projet noté), la personne responsable du cours
peut **Ouvrir les dépôts** : les étudiants qui ont travaillé sont invités
en lecture seule. Ils lisent alors leur code, l'énoncé et les tests, et
chaque exécution de la CI avec ses journaux : un test qui affiche des cas cachés
dans ses journaux les dévoile. Une copie clonée ne peut pas être reprise.
Un dépôt sans travail reste fermé, signalé *rien à ouvrir*.
**Refermer l'accès**, dans l'onglet **Dépôts**, retire cet accès. Tant que
les dépôts sont ouverts, une échéance repoussée qui rouvrirait l'un d'eux
est refusée : refermez d'abord l'accès.

## Le tableau

Une ligne par étudiant ou par groupe : le dépôt, l'état de l'invitation, le
dernier commit, la CI, les scores et les drapeaux (verrouillé, après
l'échéance, à vérifier, supprimé sur GitHub, accès à retirer). Une ligne
ouvre la page du dépôt : ses membres avec leurs commits et **Renvoyer**, ses
commits semaine par semaine, ses exécutions, son échéance propre,
**Verrouiller maintenant** et ses scores. Les flèches en haut passent à la
ligne précédente ou suivante du tableau. Une fois le dépôt figé, le bouton
principal de la page est **Corriger** (notation par critères) ou le score
de l'enseignant.

## Scores

Le score **courant** est celui de la dernière exécution reçue avant
l'échéance. À l'échéance il devient le score **gelé**, définitif après le
délai de grâce. La **revue finale** par LLM est demandée une fois par dépôt,
quand son gel est définitif. Le score **final** est celui de l'enseignant,
sinon celui de la revue, sinon le score gelé. Les étudiants voient un score
*indicatif* jusqu'à ce que vous **publiiez les scores**. Un score *à
vérifier* repose sur une exécution dont les fichiers protégés ont été
restaurés : il bloque la publication tant que vous n'avez pas saisi le score
de l'enseignant.

Pour modifier une note après un échange avec un étudiant, cliquez sur la
note en fin de ligne dans l'onglet **Correction** : un écart relatif ou une
note absolue, avec une justification que les étudiants lisent une fois la
note publiée. Après la publication, seule la personne responsable du cours
peut ajuster une note ou modifier le score de l'enseignant.

## Contestations

Noté par critères, un projet dont les scores sont publiés peut être contesté, un critère d'un
dépôt à la fois, pendant les jours réglés dans **Réglages** (7 par défaut,
0 pour aucun). L'onglet **Correction** affiche le nombre de contestations
ouvertes et le délai au-dessus de la matrice, où le rôle Enseignant du cours
le clôt ou le prolonge ; **Contestés** garde les dépôts contestés, et une
bulle marque chaque cellule contestée. La réponse se donne sur l'écran de
correction, sous les critères : **Refuser** avec une réponse, ou
**Accepter**, éventuellement avec de nouveaux points (alors avec une
réponse). Les nouveaux points attendent la validation et la publication suivante des scores. Une fois les scores publiés, les points des critères, les
validations et les recorrections reviennent au rôle Enseignant du cours.

Un assistant IA relié par MCP peut proposer une réponse, avec de nouveaux
points et leur justification : un robot marque la cellule et le dépôt, et
la proposition s'affiche au-dessus de la réponse. **Confirmer**,
**Modifier** ou **Écarter** ; **Confirmer les propositions (n)**, dans
**Contestés**, confirme celles du projet.

## Échéance

L'échéance est appliquée sur l'horloge du serveur ; ce qui compte pour un
push, c'est l'heure à laquelle Quiz l'a reçu. Pour un étudiant qui a droit
à plus de temps, donnez à son dépôt une échéance propre depuis sa page.
Repousser l'échéance après qu'elle est passée rouvre le projet, après
confirmation.

## Fichiers protégés

Un push qui en touche un est recouvert par un commit de restauration de
Quiz ; le travail de l'étudiant n'est jamais réécrit. Au-delà de cinq
restaurations en une heure, le dépôt est signalé *fichiers protégés en
conflit* et vous réactivez la protection à la main.

## Synchronisation et fin du projet

Quand la source a de nouveaux commits, **Synchroniser** liste d'abord ce
qui serait envoyé : les fichiers ajoutés, modifiés et supprimés, les
fichiers protégés signalés. Un message facultatif dit aux étudiants ce qui
change et pourquoi ; ils le lisent sur la page du projet et dans la pull
request. La synchronisation ouvre ensuite une pull request par branche
distribuée dans chaque dépôt ouvert ; l'étudiant la fusionne, jamais Quiz.
Quand des dépôts ont été notés avant la mise à jour, la page mène à
l'écran de correction, où **Recorriger tous les dépôts** les note à
nouveau. **Archiver** masque le projet. **Supprimer le
projet** efface ses lignes dans Quiz, jamais un dépôt sur GitHub.
