# Éditeur de question

## Le brouillon s'enregistre seul

Vous éditez toujours le brouillon. Il est enregistré peu après que vous avez
cessé de taper, et le badge à côté du titre répond à « est-ce que c'est
sauvé ? ». Un brouillon incomplet est enregistré tel quel ; c'est la
publication qui réclame ce qui manque.

## Trois onglets

- **Éditer** — le formulaire du type de question, l'explication, et les
  propriétés à droite : nom interne, catégorie, difficulté, tags, mélange
  des choix pour chaque étudiant.
- **Essayer** — répondez à votre propre question et voyez la correction.
  Rien n'est enregistré.
- **Versions** — chaque version publiée, avec sa note de changement. Vous
  pouvez la consulter, la restaurer dans le brouillon, ou la déprécier en
  indiquant pourquoi.

## Les tags

Le champ des tags propose le vocabulaire déjà utilisé dans la banque, avec le
nombre de questions portant chaque tag et la description en une ligne de ce
qu'il désigne. Choisissez-en un plutôt que de taper un synonyme : deux
orthographes de la même idée coupent la banque en deux. Un mot que personne
n'a encore employé est proposé comme **Créer « … »**, et la description vous
est demandée dans la foulée — c'est elle que lira le prochain enseignant.
Cliquez un tag pour écrire ou modifier sa description ; appuyez sur Retour
arrière dans le champ vide pour retirer le dernier.

## Écrire l'énoncé

L'énoncé et l'explication s'écrivent comme dans un traitement de texte. Le
markdown est ce qui est stocké en dessous : `**gras**`, `$math$` et les
blocs de code délimités fonctionnent si vous préférez les taper. Une image
collée est envoyée au serveur et référencée par un identifiant stable. Le
bouton tableau insère un tableau GFM de 3 × 3 ; le curseur dans un tableau,
le menu voisin ajoute et retire lignes et colonnes.

## Noter une question à réponses multiples

Une question à choix multiples qui a plusieurs bonnes réponses se note selon
une politique, et sa valeur par défaut est **héritée de l'évaluation** :
vous la réglez une fois par quiz, ou une fois pour tous les quiz que vous
créez, et une question ne nomme la sienne que lorsqu'il le faut vraiment.
Les cinq politiques, et ce que chacune donne pour une réponse à moitié
juste, sont expliquées dans « Notation des réponses multiples ».

## Une question à réponse courte

Le type de réponse — texte, nombre, date ou heure — décide de ce qu'est le
champ de l'étudiant, et les contraintes posées à côté décident de ce que ce
champ accepte : une longueur, un intervalle de valeurs, une fenêtre de dates.
L'étudiant est arrêté pendant qu'il tape plutôt qu'averti après coup, et rien
de tout cela ne livre la réponse.

Les deux **prétraitements**, « Rogner les espaces » et « Minuscules », se
décident une fois pour toute la question : ils s'appliquent à la réponse de
l'étudiant et à chaque texte accepté avant la comparaison, si bien qu'une clé
à cinq réponses acceptées ne repose plus cinq fois la même question sur la
casse. Seul « Entier » touche aussi la note : une réponse non entière à une
question entière est fausse.

## Une question à trous

L'énoncé s'écrit dans le même champ riche que les autres, et un trou y est un
objet : tapez `{{` et le champ demande ce qu'il contient — `Newton` pour une
réponse, `Newton|newton` pour des variantes, `=a|b|c` pour une liste,
`#3.14` pour un nombre, `/^N$/i` pour une expression régulière, `2*` devant
n'importe lequel pour un poids double. Le trou devient une pastille que l'on
clique pour la modifier, et les accolades, les barres et les étoiles sont
réécrites telles quelles. Dans un bloc de code, un trou reste du texte : «
complétez ce code » fonctionne comme il se lit.

Les **listes prédéfinies** sont une liste déroulante écrite une fois. Nommez
un ensemble (`1`, `2`, … par défaut), donnez ses options, cochez la bonne,
puis écrivez `{{1}}` dans le texte. Deux raisons de la préférer : c'est la
seule liste qui tienne dans une cellule de TABLEAU, où un `|` couperait la
ligne en deux, et les mêmes quatre options réutilisées dans huit trous ne font
qu'un seul endroit à corriger au lieu de huit.

## Publier

**Publier** valide le brouillon contre le schéma du type et crée la version
suivante, avec une note de changement facultative. Une version publiée ne
change jamais : corriger une clé, c'est publier à nouveau.
**Aperçu étudiant** montre le brouillon tel que l'étudiant le reçoit — sans
clé, sans explication.

## Raccourcis

`Ctrl+S` enregistre, `Ctrl+Entrée` essaie la question, `Ctrl+Shift+P`
publie, `Ctrl+Shift+M` affiche l'aperçu étudiant. `Ctrl+K` ouvre la palette
de commandes, qui porte les trois mêmes actions.
