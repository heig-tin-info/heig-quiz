# Valeurs aléatoires

Donnez à chaque étudiant ses propres nombres : déclarez des variables,
écrivez-les dans la question, et chaque tentative tire ses propres
valeurs. Les questions à choix, à réponse courte et à trous les acceptent.

## Le tableau

Une ligne par variable, lue de haut en bas : une ligne ne lit que celles
qui sont au-dessus.

- **Nom** : une lettre ou `_`, puis des lettres, des chiffres ou `_` (`h`,
  `g`, `v0`).
- **Expression** : `randint(10, 100)` (un entier, bornes comprises),
  `uniform(1, 2)` (un réel), `choice([3.71, 9.81, 24.79])` (un élément
  d'une liste), ou une formule des lignes du dessus : `sqrt(2*h/g)`. Les
  fonctions sont `sqrt`, `abs`, `exp`, `log`, `round`, `floor`, `ceil`,
  `min`, `max`, `sin`, `cos`, `tan` et leurs cousines ; `pi` et `e` ; `^`
  est la puissance.
- **Format** : un entier, un nombre de décimales ou de chiffres
  significatifs. Une variable EST sa valeur formatée : `g` à 2 décimales
  vaut 9.81, et chaque formule en dessous lit 9.81.
- **Condition** (facultative) : `t > 1`. Un tirage où elle est fausse est
  tiré à nouveau.

## Dans la question

Écrivez `[[h]]` ou `[[sqrt(2*h/g)]]` partout : l'énoncé, les choix,
l'explication, un trou (`{{#[[t]]:1%}}`), la valeur et la tolérance d'un
nombre de réponse courte. `\[[` écrit les crochets eux-mêmes.

Le corrigé d'une réponse courte est un nombre : donnez-lui une tolérance
d'au moins la moitié du pas de son format (0.005 pour 2 décimales), sinon
la réponse exacte est comptée fausse. Pour un choix multiple, écrivez un
mauvais choix comme la formule d'une erreur classique (`[[sqrt(h/g)]]`) :
des choix qui se lisent pareil sont tirés à nouveau.

## Cinq tirages

Sous le tableau, cinq tirages tels que les étudiants les recevront,
calculés par le serveur exactement comme la publication les vérifie.
Ouvrez-en un pour le lire comme un étudiant, avec son corrigé.
