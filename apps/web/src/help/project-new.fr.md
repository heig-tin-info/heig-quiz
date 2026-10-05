# Nouveau projet

## Ce qu'est cet écran

Il crée un projet en **brouillon** : les étudiants ne voient rien tant que
vous ne le publiez pas depuis sa page. Quiz construit un dépôt de
distribution privé dans l'organisation de la classe, à partir du dépôt
source que vous choisissez.

## L'essentiel

Un **Nom**, un **Dépôt source** de l'organisation de la classe et une
**Échéance**. Le dépôt source, les branches et l'historique sont figés à la
création : pour les changer, supprimez le brouillon et recommencez.

## Options avancées

- **Branches** : la première choisie devient la branche par défaut des
  étudiants.
- **Historique** : **Un commit** par branche, ou **Tout l'historique**.
- **Publication** : à la main, ou à la date de début.
- **À l'échéance** : **Verrouiller** refuse tout push ; **Marquer** laisse le
  dépôt ouvert et ajoute un commit repère.
- **Délai de grâce** : minutes après l'échéance avant que le travail soit
  gelé.
- **Score** : **Automatique**, ou **Aucun** (ni score, ni revue).
- **Barème** : linéaire, ou le score est la note (sur 6).
- **Fichiers protégés** : restaurés par Quiz si un étudiant les modifie.
  Retirer `grading.yml` permet à un étudiant de fausser l'évaluation.
- **Groupes** : un dépôt par groupe d'une répartition.
