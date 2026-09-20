# Ajouter des étudiants

## Ce que fait cet écran

Remplit la liste de la classe — les étudiants reprennent ensuite leur place
automatiquement à leur première connexion (adresse correspondante).

## Importer

Déposez un export **Excel ou CSV**. Les colonnes nom, prénom, e-mail et
temps supplémentaire sont détectées de façon permissive : accents et casse
ignorés, en-têtes français ou anglais, en-tête pas forcément en première
ligne, colonnes superflues ignorées.

La colonne de temps supplémentaire est facultative. Elle est reconnue sous
des noms comme `bonus`, `temps supplémentaire` ou `extra time`, et accepte
`25`, `25 %` ou `0.25`.

## Réimporter

L'import est atomique : une seule ligne fautive rejette tout le fichier, et
rien n'est écrit. Réimporter la même liste est sans danger — les places
existantes gardent leur rattachement, seuls les noms sont rafraîchis, et
rien n'est jamais supprimé implicitement. Une feuille SANS colonne de temps
supplémentaire n'efface jamais un aménagement saisi à la main.
