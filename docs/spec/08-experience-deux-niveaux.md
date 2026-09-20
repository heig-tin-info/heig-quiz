# 8. Expérience à deux niveaux : profane et expert

La plateforme sert deux profils de profs avec la même interface. Le profane veut saisir une question comme dans un traitement de texte, cliquer sur un bouton pour obtenir la réponse, et lancer le quiz. L'expert veut écrire du markdown, des regex, versionner ses questions dans git, tout faire au clavier. Aucun des deux ne doit voir les outils de l'autre par défaut.

## 8.1 Principes

1. **Divulgation progressive.** Le chemin simple est le chemin par défaut. Les options avancées sont derrière une bascule, un menu ou la palette de commandes, jamais dans le flux principal.
2. **Une seule source de vérité.** Le WYSIWYG et la vue source éditent le même markdown. Le formulaire "réponse attendue" et le matcher regex écrivent la même configuration. Passer d'un mode à l'autre ne perd rien.
3. **Le LLM fait le travail ingrat, le prof décide.** Chaque bouton "Générer" produit une proposition dans le brouillon, visible, modifiable, jamais publiée seule.
4. **Tout ce que fait l'interface, l'API le fait.** Chaque écran est construit sur `/api/v1`. L'expert peut scripter ce que le profane clique.
5. **Le clavier d'abord pour l'expert, jamais requis pour le profane.** Tous les raccourcis ont un équivalent cliquable.

## 8.2 Mode profane

| Besoin | Réponse |
|---|---|
| Créer une question sans apprendre de syntaxe | Éditeur Tiptap en WYSIWYG : barre minimale gras, italique, code, liste, titre, image, équation. Coller une image l'insère. Coller un tableau depuis Excel le convertit. |
| Écrire une équation sans LaTeX | Bouton équation avec aperçu, saisie LaTeX assistée par palette de symboles, et bouton "Décrire l'équation" qui demande au LLM la traduction en LaTeX. |
| Ne pas connaître les types de questions | Écran "Nouvelle question" avec quatre cartes illustrées : choix, réponse courte, texte à trou, code. Les types avancés sous "Plus". |
| Créer vite un QCM | "Coller un QCM" : le prof colle un texte avec des lignes `A)`, `B)`, `*C)` ou `- [x]`, la plateforme reconnaît l'énoncé, les choix et la bonne réponse. |
| Obtenir la bonne réponse et l'explication | Bouton **Générer la réponse** dans chaque éditeur : le LLM coche les bons choix, remplit la réponse attendue, ou écrit la solution de référence pour une question code, puis rédige l'explication. Les propositions apparaissent surlignées, avec accepter ou rejeter. |
| Créer des cas de test sans écrire de test | Pour une question code : saisir des entrées, cliquer "Calculer les sorties attendues" qui exécute la solution de référence dans le runner et remplit les sorties. Pour `codeimage`, l'image attendue est produite de la même manière. |
| Vérifier que la question fonctionne | Onglet "Essayer" dans l'éditeur : le prof répond comme un étudiant et voit la correction. Aucune publication sans un essai réussi, rappel non bloquant. |
| Configurer un quiz sans se tromper | Trois écrans : choisir les questions, régler le temps, démarrer. Préréglages nommés : "Quiz noté 20 min", "Exercice de la semaine", "Sondage". Tout le reste sous "Options avancées". |
| Comprendre un paramètre | Chaque option a une phrase d'aide sous son libellé, pas une infobulle. |
| Corriger sans effort | Panneau de correction avec les propositions LLM triées par confiance. "Tout valider ce qui est confiance haute" en un clic, puis passage en revue des cas restants. |
| Voir ce que voit l'étudiant | Bouton "Aperçu étudiant" partout où une question ou une évaluation est affichée. |

## 8.3 Mode expert

| Besoin | Réponse |
|---|---|
| Écrire en markdown | Bascule "Source" dans l'éditeur, `Ctrl+Shift+M`, avec coloration et aperçu côte à côte. Le choix est mémorisé par utilisateur. |
| Matchers précis | Dans l'éditeur de réponse courte, "Avancé" révèle la liste de matchers : regex avec testeur en direct sur des exemples saisis, tolérance numérique, unités. Le formulaire simple reste un matcher `exact` unique. |
| Éditer la configuration brute | "Modifier en YAML" ouvre la question au format canonique dans un éditeur Monaco avec validation par le schéma du type et diff avant enregistrement. |
| Versionner dans git | Export et import YAML depuis l'interface, API REST à jeton, CLI `quiz pull` et `quiz push`. Le dossier exporté est lisible et diffable. |
| Automatiser | Jetons d'API personnels dans les réglages, OpenAPI généré, exemples `curl` dans la documentation. |
| Tout faire au clavier | Palette de commandes `Ctrl+K`, raccourcis globaux, navigation par `j` `k` dans les listes, `Enter` pour ouvrir, `Esc` pour fermer. |
| Traiter en masse | Sélection multiple dans le pool : ajouter un tag, déplacer de catégorie, exporter, ajouter à une évaluation. |
| Inspecter | Historique des versions avec diff, journal des appels LLM, journal des événements d'une tentative, export brut d'une évaluation en JSON. |
| Brancher un LLM à soi | Clé API personnelle, choix du modèle par usage, gabarits de prompts modifiables par prof, phase 3. |
| Rédiger depuis son outil | Serveur MCP, phase 3 : créer et lire des brouillons depuis Claude Desktop ou Claude Code. |

## 8.4 Palette de commandes

`Ctrl+K` ou `Cmd+K` partout. Une seule zone de saisie, résultats groupés, navigation clavier.

| Groupe | Exemples |
|---|---|
| Navigation | Aller au cours, à la classroom, au pool, aux réglages |
| Questions | Recherche plein texte et par tag `#pointers`, par type `type:code`, par difficulté `diff:3` ; ouvrir, essayer, ajouter à l'évaluation en cours d'édition |
| Actions contextuelles | Sur une évaluation : démarrer, pause, ajouter 5 minutes, clôturer, publier les résultats. Sur une question : publier, dupliquer, générer une variante, exporter |
| Création | Nouvelle question de type X, nouvelle évaluation, nouveau pool |
| Préférences | Thème, langue, mode source par défaut |
| Aide | Raccourcis, documentation, données et confidentialité |

Les actions sont fournies par les écrans montés, via un registre de commandes dans `packages/ui`. Un écran déclare ses commandes avec libellé, raccourci, condition et handler. La palette ne connaît pas les modules.

## 8.5 Raccourcis

| Contexte | Raccourci | Action |
|---|---|---|
| Global | `Ctrl+K` | Palette |
| Global | `?` | Liste des raccourcis |
| Global | `g` puis `p` / `c` / `s` | Aller au pool / aux cours / aux réglages |
| Éditeur | `Ctrl+S` | Sauver le brouillon, déjà automatique, rassure |
| Éditeur | `Ctrl+Shift+P` | Publier |
| Éditeur | `Ctrl+Shift+M` | Basculer WYSIWYG / source |
| Éditeur | `Ctrl+Enter` | Essayer la question |
| Éditeur code | ceux de VS Code | Monaco |
| Player étudiant | `Alt+→` `Alt+←` | Question suivante / précédente |
| Player étudiant | `Ctrl+Enter` | Marquer faite, ou exécuter le code dans une question code |
| Tableau de bord | `n` `r` `s` | Basculer noms / réponses / résultats |
| Tableau de bord | `Space` | Pause / reprise |
| Correction | `v` `→` | Valider et passer au suivant |

## 8.6 Fonctions qui font la différence

- **Générer une variante** : même question, autres valeurs ou autre contexte, en brouillon lié à l'original par `origin_question_id`.
- **Générer un quiz** : durée, tags, difficulté, et la plateforme compose un brouillon d'évaluation à partir des statistiques de temps de réponse. Phase 3.
- **Code de session et QR code** pour rejoindre un sondage ou une classroom depuis un téléphone.
- **Vue projection** sans nom : anneau de présence en salle d'attente, répartition en direct pour un sondage, taux de complétion pendant un quiz.
- **Différence d'image** pour `codeimage`, curseur de comparaison et pourcentage.
- **Historique de tentative** pour le support : reconstruction de la suite des révisions d'une réponse avec horodatage serveur.
- **Aperçu de cinq instanciations** pour une question à valeurs aléatoires, avec bouton "figer".
- **Statistiques dans le pool** : sur la fiche d'une question, taux de réussite et temps moyen par version, pour choisir la bonne question en un coup d'œil.
- **Coller depuis Moodle** : un fichier GIFT déposé sur le pool est importé, les questions non convertibles sont listées.
- **Correction par lot** : filtre par confiance, par question, par écart entre proposition LLM et score moyen.
- **Mode zen** pour l'étudiant, une question par écran, barre de progression, sans chrome inutile.
