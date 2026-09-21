# Les questions d'une banque

## Catégories

Tant qu'une banque est ouverte, ses catégories apparaissent dans la barre
latérale gauche, sous **Banques de questions** : **Toutes les questions**,
**Non classées**, puis l'arborescence. En choisir une restreint le tableau.
L'arborescence sert aussi à créer une catégorie ou une sous-catégorie, à la
renommer, à la déplacer parmi ses voisines et à la supprimer : ses questions
repassent alors à la racine, aucune n'est supprimée.

## Recherche et filtres

Le champ de recherche porte sur le nom interne et l'énoncé. **Filtres**
ouvre le type, la difficulté, les tags et **Afficher les questions
supprimées**. Ce qui est actif revient en pastilles amovibles sous la barre,
avec le nombre de questions qu'elles laissent.

Le champ accepte aussi les filtres sous forme de mots, plus rapides que le
panneau une fois le vocabulaire connu :

| Écrit | Signifie |
| --- | --- |
| `tag:pointeurs`, `tag:#pointeurs` | les questions portant ce tag |
| `type:mcq`, `type:short`, `type:cloze`, `type:code` | ce type de question |
| `difficulty:3` | exactement 3 |
| `difficulty:>3`, `difficulty:>=2`, `difficulty:<3`, `difficulty:<=4` | une borne |
| `difficulty:2-4` | un intervalle |
| `version:v2`, `version:2` | version publiée 2 |
| `version:>1`, `version:>=2`, `version:<3`, `version:1-3` | une borne, un intervalle |
| `"une phrase entière"` | ces mots ensemble |

Le reste est du texte libre. Plusieurs `tag:` s'additionnent ; deux bornes
`version:` se resserrent. Ce que vous tapez et ce que vous cochez sont le
MÊME filtre : les deux apparaissent en pastilles, et retirer une pastille
retire aussi le mot du champ. Juste après `tag:` ou `type:`, une courte liste
s'ouvre sous le champ — tapez pour la resserrer, les flèches pour vous
déplacer, Entrée pour insérer, Échap pour fermer.

## Le tableau, les cartes et le regroupement

Une ligne par question : le type en icône devant le nom interne (survolez-la
pour son nom), les tags, la difficulté en cinq points, la version publiée, la
dernière modification en distance — survolez-la pour la date exacte. Un clic
ouvre l'éditeur. Chaque ligne porte modifier, dupliquer et supprimer à son
extrémité.

Cliquer un en-tête de colonne trie toute la banque, pas seulement les
questions déjà chargées ; recliquer inverse l'ordre. Par défaut : la dernière
modification, la plus récente en tête.

À côté des filtres, trois contrôles changent la manière dont la liste est
dessinée : **cartes ou tableau**, **regrouper par** (rien, type, tag ou
catégorie) et le **tri**, seul endroit d'où trier par type puisqu'il a perdu
sa colonne. Une question portant trois tags apparaît dans les trois sections.
Tout cela est retenu pour la prochaine visite.

## Une banque partagée avec vous

Si votre siège sur la banque est **lecteur**, l'écran montre les questions et
aucune action : ni nouvelle question, ni modification, ni duplication, ni
suppression, ni cases à cocher. Ouvrir une question reste possible — la lire,
c'est l'ouvrir.

## Plusieurs à la fois

Cochez les lignes : une barre apparaît en bas — ajouter un tag, les déplacer
dans une catégorie, les supprimer. Elle rend compte une fois, à la fin.

## Nouvelle question, versions

**Nouvelle question** demande le type et un nom interne, puis ouvre
l'éditeur. Seule une version publiée peut servir dans une évaluation — le
brouillon jamais, et publier crée le numéro suivant. Supprimer une question
la retire de la banque ; les résultats déjà enregistrés sont conservés.
