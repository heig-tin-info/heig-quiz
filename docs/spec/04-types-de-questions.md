# 4. Types de questions

## 4.1 Contrat d'un type de question

Un type est un package TypeScript qui exporte un objet `QuestionType` :

| Membre | Rôle |
|---|---|
| `id` | Identifiant stable, ex. `mcq`. Utilisé en base et dans le format canonique. |
| `configSchema` | Schéma zod de la configuration, énoncé compris. Validé à la publication et à l'import. |
| `answerSchema` | Schéma zod de la réponse étudiant. Validé à chaque autosave. |
| `defaultPoints(config)` | Points par défaut quand la question est ajoutée à une évaluation. |
| `toStudent(config, seed)` | Retourne la configuration visible par l'étudiant : sans clé, sans explication, sans tests cachés, choix mélangés selon la graine. Fonction pure, testée. |
| `grade(config, answer, ctx)` | Retourne `{ points, maxPoints, details }` ou `{ pending: 'runner' | 'llm' }`. `ctx` fournit la graine, les points de l'item, et les services runner et LLM. |
| `randomize(config, seed)` | Facultatif. Instancie les variables aléatoires. Retourne une configuration concrète. |
| `Editor` | Composant React d'édition du brouillon. |
| `Player` | Composant React de réponse. Reçoit la configuration étudiant, la réponse courante, un rappel `onChange`. |
| `Review` | Composant React de relecture : réponse, clé, correction, pour le prof et pour le feedback étudiant. |
| `Stats` | Facultatif. Composant d'agrégation des réponses d'un item, ex. répartition des choix. |
| `toCanonical` / `fromCanonical` | Conversion depuis et vers le format canonique, si différent de la configuration brute. |
| `toDrillGrade(grading)` | Facultatif. Convertit une correction en note de rappel 1 à 4 pour FSRS. |
| `configVersion`, `migrate(config, from)` | Version du schéma de configuration et montée de version à la lecture. Permet de faire évoluer un type sans migration SQL, voir 5.2. |
| `generate(ctx)` | Facultatif. Gabarits LLM du type pour "Générer la réponse", "Générer l'explication", "Générer une variante", voir 8.2. |
| `searchText(config)` | Texte indexé pour la recherche plein texte du pool. |

Règles :

- Un type n'a pas de tables. Sa configuration et ses réponses vivent en JSONB dans les tables du noyau.
- Un type ne fait pas d'appel réseau direct. Il passe par `ctx.runner` et `ctx.llm`.
- Les types de la phase 1 vivent dans le monorepo sous `packages/qt-*`, avec deux points d'entrée `server` et `client`, voir 5.2. Le chargement est statique, par deux registres.

## 4.2 Format canonique

Un fichier YAML par question. Les images sont dans un dossier `assets/` voisin, référencées par chemin relatif.

```yaml
id: 01J8Z3K9M2X5V7N4Q6R8T0W2Y4      # ULID stable, généré à la création
type: mcq
name: pointeurs-arithmetique-01      # nom interne
tags: [c, pointers, arithmetic]
difficulty: 2
version: 3
shuffleable: true
explanation: |
  `p + 1` avance de `sizeof(*p)` octets, donc de 4 pour un `int`.
config:
  prompt: |
    Soit `int *p` pointant sur l'adresse `0x1000`. Que vaut `p + 1` ?
  choices:
    - { text: "0x1001", correct: false }
    - { text: "0x1004", correct: true }
    - { text: "0x1008", correct: false }
  policy: all_or_nothing
```

Le champ `config` est propre au type. Les champs de tête sont communs. L'export d'un pool produit `pool.yaml` avec ses métadonnées, un dossier par catégorie, un fichier par question. L'import respecte les `id` : une question existante avec le même `id` reçoit une nouvelle version si le contenu diffère.

## 4.3 Valeurs aléatoires

Disponible pour `short`, `cloze`, `mcq`, `code` en phase 2.

```yaml
variables:
  R1: { min: 100, max: 10000, step: 100, unit: Ω }
  R2: { min: 1000, max: 100000, step: 1000, unit: Ω }
  G: { expr: "-R2 / R1", precision: 2 }
```

- L'énoncé et la clé utilisent `{{R1}}`, `{{G}}`. Les expressions sont évaluées par un évaluateur arithmétique restreint, sans accès au langage hôte : opérateurs, fonctions mathématiques usuelles, constantes.
- La graine d'instanciation est celle de la tentative combinée à l'id de l'item. Rejouer une tentative donne les mêmes valeurs.
- L'éditeur affiche cinq instanciations pour vérification, et un bouton "figer" pour convertir en question fixe.

## 4.4 Choix multiples `mcq`

**Configuration** : `prompt` markdown, `choices[]` avec `text` markdown et `correct`, `mode` `single` ou `multiple`, `maxSelections` facultatif, `policy`, `penalty` facteur 0 à 1 par défaut 1, `allowNegative` par défaut faux.

**Réponse** : `selected[]` indices des choix dans l'ordre canonique. Le mélange est appliqué par `toStudent`, la réponse est toujours en indices canoniques.

**Notation**, avec C bonnes réponses, W mauvaises, c bonnes cochées, w mauvaises cochées :

| Politique | Formule | Commentaire |
|---|---|---|
| `all_or_nothing` | 1 si c = C et w = 0, sinon 0 | Défaut pour `single` |
| `partial` | max(0, (c − w) / C) | Une erreur annule une bonne |
| `penalized` | max(0, c / C − penalty × w / W) | Une erreur coûte une fraction de W |

Si `allowNegative` est vrai, la borne inférieure devient −1. Le résultat est multiplié par les points de l'item.

**Éditeur** : liste de choix, une case par choix pour marquer correct, ajout par Entrée, réordonnement par glisser, aperçu en direct.

## 4.5 Texte court `short`

**Configuration** (`configVersion: 2`) : `prompt`, `kind` `text` / `number` / `date` / `time`, les `constraints` de ce `kind`, les `prefilters` de la question, et `matchers[]` évalués dans l'ordre, la première correspondance donne les points.

**Contraintes du champ** — elles disent ce que le champ ACCEPTE, jamais ce qu'il attend. Elles ne font donc pas partie de la clé : `toStudent` les transmet et le player les impose dans l'input, où le navigateur les applique lui-même.

| `kind` | Contraintes | Champ de l'étudiant |
|---|---|---|
| `text` | `minLength` défaut 0, `maxLength` défaut 255, plafond dur 500 | `input type="text"` avec `minlength` et `maxlength` |
| `number` | `min` et `max` facultatives (vides = non bornées), `integer` défaut faux | `input type="number"` avec `min`, `max` et `step` |
| `date` | `from` et `to` facultatives | `input type="date"` avec `min` et `max` |
| `time` | aucune | `input type="time"` |

Une seule contrainte pèse sur la correction : `integer`. Une réponse non entière à une question entière vaut 0, quels que soient les matchers. Les autres appartiennent au champ, jamais au barème — une réponse enregistrée avant qu'une contrainte soit resserrée est corrigée sur son mérite. Un matcher `number` dont la valeur attendue n'est pas entière dans une question entière est refusé à la publication, avec la clé `short.integer_expected`.

**Prefilters** — deux normalisations décidées UNE fois pour la question, appliquées à la réponse de l'étudiant ET à chaque valeur `exact` avant la comparaison. L'entrée d'un `regex` les subit aussi ; son drapeau `i`, lui, reste le sien.

| Prefilter | Défaut | Effet |
|---|---|---|
| `trim` | vrai | Retire les espaces de début et de fin, des deux côtés |
| `lowercase` | vrai | Compare en minuscules, pliage français, les accents restent significatifs (décision D9) |

Les suites d'espaces à l'intérieur d'une réponse sont toujours réduites à un seul espace. En v1 ces trois réglages vivaient sur chaque matcher `exact` (`caseSensitive`, `trim`, `collapseSpaces`) : la migration v1 → v2 lit `trim` et `caseSensitive` du PREMIER matcher `exact` pour en faire les prefilters de la question, puis les retire de tous les matchers.

| Matcher | Champs | Sémantique |
|---|---|---|
| `exact` | `value` | Égalité après les prefilters de la question |
| `regex` | `pattern`, `flags` | Correspondance complète, sur l'entrée préfiltrée |
| `number` | `value`, `tolerance`, `toleranceMode` `abs` / `rel`, `unit` facultative acceptée ou ignorée | Comparaison numérique, virgule et point acceptés |
| `date`, `time` | `value`, `tolerance` en jours ou minutes | Formats locaux acceptés, normalisés en ISO |
| `llm` | `rubric` markdown, `reference` facultative | Correction LLM proposée, phase 2 |

Chaque matcher peut porter `points` en fraction, défaut 1, pour accepter une réponse partiellement juste.

**Éditeur** : le `kind` est un contrôle segmenté, les contraintes de ce `kind` sont sur la même ligne, à sa droite ; les prefilters sont deux cases au-dessous de la liste des réponses acceptées.

**Réponse** : `text` chaîne.

## 4.6 Texte à trou `cloze`

**Configuration** : `text` markdown contenant des trous, `caseSensitive` global par défaut faux. Le player rend le markdown avec un champ ou une liste à chaque trou. Les trous ont un poids égal par défaut.

Syntaxe des trous, inspirée de Moodle Cloze, simplifiée :

| Syntaxe | Signification |
|---|---|
| `{{Newton}}` | Champ texte, réponse `Newton`, égalité normalisée |
| `{{Newton\|Isaac Newton}}` | Alternatives acceptées |
| `{{=Newton\|Maxwell\|Faraday\|Galilée}}` | Liste déroulante, `=` marque la bonne option, ordre mélangé si la question est mélangeable |
| `{{#3.14:0.01}}` | Numérique avec tolérance absolue |
| `{{#3.14:1%}}` | Numérique avec tolérance relative |
| `{{/^[0-9a-f]+$/i}}` | Expression régulière |
| `{{2*Newton}}` | Poids 2 pour ce trou |
| `\{{` | Accolades littérales |

Dans un bloc de code markdown les trous restent actifs, ce qui permet "complétez ce code". Une question `code` n'utilise pas cette syntaxe.

À l'intérieur d'un trou, une barre oblique inverse devant une ponctuation ASCII rend ce caractère littéral : `\|`, `\}`, `\*`, `\\` sont les quatre que l'on rencontre, et la règle est plus large pour que l'éditeur de trou (ci-dessous) puisse écrire n'importe quelle réponse — une réponse commençant par `#`, `/` ou `=` deviendrait sinon un nombre, une regex ou une liste.

**Éditeur de trou.** Le corps d'un trou est une grammaire, pas une valeur : on ne le tape pas. Taper `{{`, cliquer une puce existante, presser le bouton « Insérer un trou » ou Entrée sur une puce sélectionnée ouvre une carte ancrée sous la puce, qui demande la FORME du trou — l'une de ces réponses, liste déroulante, nombre, regex — plus le poids. Elle lit le corps existant et le réécrit avec les fonctions du domaine (`parseBlankBody` / `formatBlank`), jamais par concaténation : ce que la carte montre et ce que le correcteur lit ne peuvent pas diverger. La syntaxe brute reste disponible dans le volet source markdown.

**Un trou dans une cellule de tableau.** Un `|` non échappé sépare deux colonnes, mais un `|` À L'INTÉRIEUR d'un trou n'en est pas un. Côté domaine c'est acquis : `parseCloze` tourne AVANT le markdown et remplace chaque trou par une sentinelle (décision D5), si bien que la ligne est découpée sur une cellule qui ne contient plus de barre. Côté éditeur riche, c'est à lui de le garantir : il remplace le `|` d'un corps de trou par un caractère de la zone privée à la lecture et le rétablit à la toute fin de la sérialisation, après que le rendu du tableau a aligné ses colonnes. `{{=passante|bloquée}}` dans une cellule est donc une écriture normale.

Les `label` d'une liste atteignent l'étudiant — ce sont les options — mais jamais `correct`.

**Réponse** : `blanks[]` chaînes dans l'ordre d'apparition.

**Notation** : somme des poids des trous justes sur la somme des poids.

## 4.7 Code `code`

**Configuration** :

```yaml
config:
  prompt: markdown
  language: c            # c, cpp, python, js, rust en phase 1
  template: |            # code initial, avec régions verrouillées
    #include <stdio.h>
    // @@lock
    int main(void) {
    // @@endlock
        // votre code
        return 0;
    }
  files:                 # fichiers additionnels lus par le programme, facultatif
    - { name: data.csv, content: "..." }
  action: run            # check compile seulement, run exécute
  compileArgs: "-Wall -Wextra -std=c17"
  limits: { timeMs: 2000, memoryMb: 128, outputKb: 64 }
  runsPerMinute: 10
  tests:
    mode: io             # io ou tap
    cases:
      - { name: "cas simple", stdin: "3 4\n", expected: "7\n", visible: true, points: 1 }
      - { name: "négatifs", stdin: "-3 4\n", expected: "1\n", visible: false, points: 1 }
    compare: { trimTrailing: true, ignoreCase: false, numeric: null }
```

- **Régions verrouillées** : marquées par des commentaires `@@lock` / `@@endlock` dans la syntaxe de commentaire du langage. Le player les rend en lecture seule et grisées. Le serveur reconstruit le fichier final à partir du template et des régions éditables, jamais du texte brut du client, ce qui empêche de modifier une région verrouillée.
- **Mode `io`** : chaque cas envoie `stdin` et compare `stdout`. Un cas vaut ses points si la sortie correspond. C'est le mode de la phase 1.
- **Mode `tap`**, phase 3 : le prof fournit `testFile` et `command`. Le runner exécute la commande et lit un flux TAP sur stdout : `ok 1 - nom` et `not ok 2 - nom`. Chaque ligne est un cas. Des bibliothèques TAP existent pour C, Python, JS, Rust.
- **Points** : la somme des points des cas. Une option `allOrNothing` sur la question donne tout ou rien.
- **Boutons du player** : "Vérifier" compile, "Exécuter" lance les cas visibles et affiche pour chacun stdin, sortie attendue, sortie obtenue, verdict. Une zone stdin libre permet un essai manuel. Les cas cachés ne sont exécutés qu'à la correction.
- **Réponse** : `regions[]` contenu de chaque région éditable, `lastRun` résumé du dernier run pour le tableau de bord.
- **Éditeur de code** : Monaco, thème aligné sur la plateforme, raccourcis VS Code, tabulation configurable, sans serveur de langage.

## 4.8 Réponse riche `rich`, phase 2

**Configuration** : `prompt`, `rubric[]` critères avec `label`, `points`, `description`, `reference` réponse modèle facultative, `maxWords` facultatif, `allowImages`.

**Réponse** : `markdown` avec images collées.

**Notation** : `grade` retourne `pending: 'llm'`. Le service LLM reçoit l'énoncé, la grille, la référence, la réponse anonymisée, et doit répondre en JSON : points par critère, justification courte par critère, confiance `low` / `medium` / `high`. Le prof valide dans le panneau de correction. Sans fournisseur configuré, la correction est manuelle avec la grille comme formulaire.

## 4.9 CodeImage `codeimage`, phase 3

Extension de `code`. Le programme écrit sur stdout une image au format PPM binaire `P6`, dimensions imposées par la question, 300 × 300 par défaut. Ce protocole est indépendant du langage et tient en dix lignes dans chaque langage. La question fournit l'image attendue, produite par la solution du prof exécutée dans le runner.

Player : image obtenue à droite, bascule vers l'image attendue, vue différence en surimpression avec curseur, pourcentage de similarité. Notation : pourcentage de pixels égaux à une tolérance par canal près, seuils de points configurables, ex. 100 % des points dès 98 % de similarité.

## 4.10 Drawing `drawing`, phase 3

Canevas minimaliste : rectangle, ellipse, ligne, flèche, trait libre, texte. Sélection, déplacement, suppression, annulation. Base technique candidate : Excalidraw en mode embarqué, ce qui évite d'écrire un éditeur.

**Réponse** : scène JSON et rendu PNG généré côté client à chaque autosave. **Notation** : LLM avec vision sur le PNG, grille de critères comme `rich`. Sinon manuelle.

## 4.11 Pick-place `circuit`, phase 3

Palette de composants à gauche : résistance, condensateur, diode, ampli op, sources, masse. Placement sur une grille, rotation, fils avec ponts, étiquettes de valeur. Une bibliothèque de symboles SVG normalisés.

**Réponse** : liste de composants avec position et valeur, liste de fils, rendu PNG. Le noyau ne calcule pas de netlist. **Notation** : LLM avec vision et grille de critères, ou manuelle. La comparaison de netlist est hors périmètre, voir [00-cadre-et-perimetre.md](00-cadre-et-perimetre.md).

## 4.12 Sondage `poll`, phase 2

Ce n'est pas un type de question mais un mode d'évaluation à un seul item, qui accepte `mcq`, `short` et une variante `scale` de 1 à N. Le `Stats` du type alimente l'écran de projection en direct.
