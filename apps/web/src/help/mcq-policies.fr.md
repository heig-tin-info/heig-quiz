# Notation des réponses multiples

Une question à **une** seule bonne réponse se note toujours en tout ou rien.
Ces cinq politiques décident de ce que vaut une question à **plusieurs**
bonnes réponses lorsque l'étudiant n'en coche qu'une partie.

## Trois niveaux

Chacun l'emporte sur le précédent.

- **Votre préférence**, dans Réglages — elle initialise les évaluations que vous créez, et rien d'autre : la changer ne touche jamais un quiz qui existe déjà.
- **L'évaluation**, dans ses options avancées — la politique qu'utilisent toutes ses questions, sauf celles qui en nomment une.
- **La question** elle-même, « héritée » par défaut, libre de choisir la sienne.

## Les cinq politiques

`C` est le nombre de choix corrects, `W` le nombre de choix faux, `c` le
nombre de choix corrects cochés et `w` le nombre de faux cochés.

- **Exact** (tout ou rien) — 1 si l'ensemble coché est exactement la clé, 0 sinon.
- **Vrai-faux** — chaque proposition est un vrai-faux à part entière : `(c + (W - w)) / (C + W)`. Ne rien cocher rapporte déjà `W / (C + W)`.
- **Distance** (discordances) — on compte les propositions prises à l'envers, dans un sens comme dans l'autre : `d = (C - c) + w`. Aucune discordance vaut 1, une vaut 0,5, deux valent 0,2, trois ou plus valent 0.
- **Symétrique** — `c/C - w/W` : une croix fausse coûte exactement ce qu'une croix juste rapporte, donc cocher au hasard ne vaut rien en moyenne.
- **Ripkey** — `c/C`, annulé à 0 par une seule croix fausse. Récompense l'étudiant qui ne coche que ce dont il est sûr.

Aucune politique ne descend sous zéro : répondre n'est jamais pire que ne
pas répondre.
