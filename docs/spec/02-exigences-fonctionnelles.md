# 2. Exigences fonctionnelles

Chaque exigence est identifiée `F-DOMAINE-nn`, avec sa phase P1 / P2 / P3 et sa priorité M / S / C. Une exigence doit être vérifiable par un test ou une démonstration.

## F-AUTH Authentification et comptes

| Id | Exigence | Phase | Prio |
|---|---|---|---|
| F-AUTH-01 | L'utilisateur se connecte via edu-ID en OpenID Connect. Aucun mot de passe local. | P1 | M |
| F-AUTH-02 | À la première connexion, le compte est créé avec nom, email et rôle déduit de l'affiliation edu-ID : `staff` ou `faculty` donne `teacher`, `student` donne `student`. | P1 | M |
| F-AUTH-03 | L'admin est identifié par une liste d'identifiants edu-ID en configuration. Il peut promouvoir ou rétrograder un utilisateur en `teacher`. | P1 | M |
| F-AUTH-04 | La session persiste 30 jours. Une déconnexion explicite est disponible. Un examen en cours ne demande jamais de se reconnecter. | P1 | M |
| F-AUTH-05 | Un participant sans compte peut rejoindre une évaluation en mode `poll` par un code de session, sous un pseudonyme ou anonymement selon le paramétrage. | P2 | M |

## F-ORG Cours, classrooms, rosters

| Id | Exigence | Phase | Prio |
|---|---|---|---|
| F-ORG-01 | Un prof crée un cours avec un nom et un code court. Il peut y ajouter d'autres profs. | P1 | M |
| F-ORG-02 | Un cours référence un ou plusieurs pools. Les évaluations du cours piochent dans ces pools. | P1 | M |
| F-ORG-03 | Un prof crée une classroom dans un cours avec un nom et une période. Une classroom peut être archivée. | P1 | M |
| F-ORG-04 | Le roster s'importe par CSV avec au moins l'email edu-ID. Les lignes déjà connues sont fusionnées, jamais dupliquées. | P1 | M |
| F-ORG-05 | Un étudiant dont l'email figure dans un roster est rattaché à la classroom dès sa première connexion. | P1 | M |
| F-ORG-06 | Une classroom expose un code de jonction. Un étudiant qui le saisit rejoint le roster. Le prof peut désactiver le code. | P1 | S |
| F-ORG-07 | Chaque ligne du roster porte un temps supplémentaire en pourcent, 0 par défaut, et une note libre. | P1 | M |
| F-ORG-08 | Le prof peut retirer un étudiant d'un roster. Ses tentatives passées sont conservées. | P1 | M |
| F-ORG-09 | Supprimer une classroom supprime ses évaluations, tentatives, réponses et corrections après une confirmation nommant la classroom. Les questions du pool ne sont pas touchées. | P1 | M |
| F-ORG-10 | Une classroom peut être dupliquée vers une nouvelle période, sans roster ni tentatives, avec ses évaluations en brouillon. | P2 | S |

## F-POOL Pools et organisation des questions

| Id | Exigence | Phase | Prio |
|---|---|---|---|
| F-POOL-01 | Chaque prof dispose d'un pool privé créé automatiquement et peut en créer d'autres. | P1 | M |
| F-POOL-02 | Un pool contient des catégories hiérarchiques et des questions. Une question est dans une seule catégorie ou à la racine. | P1 | M |
| F-POOL-03 | La liste des questions est filtrable par type, tags, difficulté, catégorie, texte libre sur le nom interne et l'énoncé. | P1 | M |
| F-POOL-04 | Une question peut être copiée vers un autre pool. La copie référence l'origine. | P1 | S |
| F-POOL-05 | Un pool peut être partagé avec d'autres profs avec un rôle `reader`, `contributor` ou `owner`. | P2 | S |
| F-POOL-06 | Un pool public global est lisible par tous les profs. L'admin désigne ses contributeurs. | P2 | S |
| F-POOL-07 | Un pool s'exporte en archive de fichiers YAML au format canonique, un fichier par question, arborescence des catégories en dossiers. L'import de cette archive recrée le pool ou fusionne dans un pool existant par id. | P1 | S |
| F-POOL-08 | Import de fichiers GIFT et Moodle XML pour les types supportés. Les questions non convertibles sont listées avec la raison. | P2 | C |

## F-QST Questions et versions

| Id | Exigence | Phase | Prio |
|---|---|---|---|
| F-QST-01 | Une question porte un type, un nom interne visible du prof seulement, des tags, une difficulté de 1 à 5. | P1 | M |
| F-QST-02 | L'éditeur travaille sur le brouillon. Chaque modification est sauvée automatiquement. | P1 | M |
| F-QST-03 | Publier valide le brouillon contre le schéma du type et crée la version N+1 avec une note de changement facultative. Le brouillon reste égal à la version publiée jusqu'à la prochaine modification. | P1 | M |
| F-QST-04 | L'historique des versions est consultable avec diff de la configuration. Une version peut être restaurée dans le brouillon. | P1 | S |
| F-QST-05 | Une version peut être marquée `deprecated` avec un motif. Les évaluations qui l'utilisent l'affichent au prof. | P1 | S |
| F-QST-06 | L'énoncé et l'explication sont en markdown avec un éditeur WYSIWYG : titres, gras, listes, code, images collées ou glissées, équations KaTeX en ligne et en bloc. | P1 | M |
| F-QST-07 | Les images collées sont stockées sur le serveur et référencées par un id stable. L'export canonique les embarque. | P1 | M |
| F-QST-08 | Une question déclare si elle est mélangeable et si elle supporte des valeurs aléatoires. | P1 | M |
| F-QST-09 | L'éditeur propose un aperçu du player exactement tel que l'étudiant le verra, avec possibilité de répondre et de voir la correction. | P1 | M |
| F-QST-10 | Une question à valeurs aléatoires déclare des variables avec plage, pas et précision. Les expressions dans l'énoncé et la clé sont évaluées avec la graine de la tentative. Voir [04-types-de-questions.md](04-types-de-questions.md). | P2 | M |
| F-QST-11 | Supprimer une question la masque du pool. Elle reste résolue par les évaluations passées. La suppression définitive n'est possible que si aucune évaluation ne la référence. | P1 | M |

## F-EVAL Configuration d'une évaluation

| Id | Exigence | Phase | Prio |
|---|---|---|---|
| F-EVAL-01 | Le prof crée une évaluation dans une classroom avec un titre, un mode `exam`, `exercise` ou `poll`, et une liste ordonnée de questions prises dans les pools du cours. | P1 | M |
| F-EVAL-02 | Chaque item porte un nombre de points. Par défaut : 1 pour les types simples, le nombre de cas de test pour le code, le nombre de trous pour le texte à trou. | P1 | M |
| F-EVAL-03 | Ajouter une question fige sa version publiée courante. L'évaluation affiche quand une version plus récente existe et propose "mettre à jour" item par item ou globalement, tant qu'aucune tentative n'existe. | P1 | M |
| F-EVAL-04 | Paramètres de temps : `duration` durée par étudiant depuis son début, `deadline` heure de fin commune, `manual` clôture par le prof. `exam` exige `duration` ou `deadline`. `exercise` a une date limite. | P1 | M |
| F-EVAL-05 | Le temps supplémentaire du roster s'applique à `duration`. En mode `deadline` il prolonge la fin individuelle au-delà de la fin commune. | P1 | M |
| F-EVAL-06 | Salle d'attente : `skip` l'étudiant démarre seul, `auto` démarrage quand tous les présents sont là, `manual` le prof démarre. | P1 | M |
| F-EVAL-07 | Navigation : `free`, `forward_only`, `milestones` avec un drapeau par item au-delà duquel on ne revient pas. | P1 | M |
| F-EVAL-08 | Présentation : `zen` une question par écran, `continuous` défilement, `student_choice` uniquement si navigation `free`. | P1 | M |
| F-EVAL-09 | Mélange : ordre des questions oui / non, ordre des choix oui / non pour les questions mélangeables. L'ordre est dérivé de la graine de la tentative et stable pour un étudiant. | P1 | M |
| F-EVAL-10 | Barème : `linear` note = 1 + 5 × points / total, ou `threshold` note = 1 + 5 × points / seuil bornée à 6. Arrondi au dixième, méthode configurable : au plus proche par défaut. | P1 | M |
| F-EVAL-11 | Feedback : `none`, `on_release` après publication des résultats par le prof, `immediate` après validation d'une question par l'étudiant, réservé aux modes `exercise` et `poll`. Le feedback inclut ou non la clé de réponse et l'explication, deux options distinctes. | P1 | M |
| F-EVAL-12 | Une évaluation peut exiger un code d'accès saisi par l'étudiant, et restreindre les adresses IP à une liste de préfixes. | P1 | S |
| F-EVAL-13 | Une évaluation peut activer le mode plein écran recommandé et la journalisation des changements de visibilité d'onglet. Rien n'est bloquant, tout est visible du prof. | P2 | S |
| F-EVAL-14 | Une évaluation se duplique vers la même classroom ou une autre. | P1 | S |
| F-EVAL-15 | Une évaluation `exercise` peut autoriser plusieurs tentatives, avec conservation de la meilleure ou de la dernière. | P2 | C |

## F-LIVE Déroulement en direct

| Id | Exigence | Phase | Prio |
|---|---|---|---|
| F-LIVE-01 | L'étudiant voit sur sa page d'accueil les évaluations ouvertes de ses classrooms et y entre en un clic. | P1 | M |
| F-LIVE-02 | En salle d'attente il voit le nombre de présents sur le nombre d'inscrits, en anneau de progression, et la durée annoncée. | P1 | M |
| F-LIVE-03 | Avant de démarrer, le prof voit la liste des présents, des absents, et les étudiants avec temps supplémentaire, et confirme. | P1 | M |
| F-LIVE-04 | Le démarrage est propagé à tous les clients en moins d'une seconde. | P1 | M |
| F-LIVE-05 | Chaque modification de réponse est envoyée au serveur avec un délai de regroupement de 300 ms au plus, et acquittée. L'interface indique un état non sauvé ou hors ligne. | P1 | M |
| F-LIVE-06 | Après rechargement ou reconnexion, l'étudiant retrouve exactement l'état de ses réponses et sa position. | P1 | M |
| F-LIVE-07 | Le compte à rebours est calculé sur l'horloge du serveur. Le client corrige son décalage à chaque battement. Le serveur accepte une écriture jusqu'à la deadline plus 3 secondes de grâce, puis refuse. | P1 | M |
| F-LIVE-08 | L'étudiant peut marquer une question "faite". En `forward_only` marquer faite est irréversible et passe à la suivante. En `milestones` franchir le jalon demande une confirmation. | P1 | M |
| F-LIVE-09 | Une barre de progression montre les questions, leur état faite / vue / vide, et permet d'y aller si la navigation l'autorise. | P1 | M |
| F-LIVE-10 | L'étudiant peut rendre avant la fin après confirmation. À la deadline la tentative est fermée par le serveur. | P1 | M |
| F-LIVE-11 | Le prof peut mettre en pause, reprendre, ajouter 1, 5 ou 10 minutes à tous ou à un étudiant, et clôturer. Chaque action est propagée immédiatement et journalisée. | P1 | M |
| F-LIVE-12 | Un étudiant retardataire démarre avec la durée pleine en mode `duration`, ou jusqu'à la fin commune en mode `deadline`. Le prof peut lui accorder du temps individuellement. | P1 | M |
| F-LIVE-13 | Mode `poll` : une question, résultats agrégés en direct à l'écran du prof, révélation de la bonne réponse à la demande, possibilité de relancer la même question. | P2 | M |
| F-LIVE-14 | Le prof peut projeter une vue "présentation" sans nom d'étudiant : taux de complétion, et en `poll` la répartition des réponses. | P2 | S |

## F-DASH Tableau de bord du prof en direct

| Id | Exigence | Phase | Prio |
|---|---|---|---|
| F-DASH-01 | Grille étudiants en lignes, questions en colonnes. Chaque cellule montre l'état : vide, en cours, faite, et après correction juste / partiel / faux. | P1 | M |
| F-DASH-02 | Interrupteurs : afficher les noms, afficher les réponses, afficher les résultats. Noms masqués donne un pseudonyme stable par ligne. | P1 | M |
| F-DASH-03 | Colonnes : score en cours, temps restant individuel, état de connexion, dernier événement. Tri par colonne. | P1 | M |
| F-DASH-04 | Ligne de total par question : taux de complétion, et après correction taux de réussite. | P1 | M |
| F-DASH-05 | Un clic sur une cellule ouvre la réponse de l'étudiant en lecture. | P1 | M |
| F-DASH-06 | Mode plein écran adapté à la projection. | P1 | S |

## F-GRADE Correction

| Id | Exigence | Phase | Prio |
|---|---|---|---|
| F-GRADE-01 | À la clôture, toutes les réponses des types déterministes sont corrigées automatiquement et validées. Une réponse absente vaut 0. | P1 | M |
| F-GRADE-02 | Les réponses des types à correction LLM sont envoyées anonymisées au fournisseur configuré, avec l'énoncé, la grille de critères et la réponse de référence. La proposition contient les points par critère, une justification et une confiance. | P2 | M |
| F-GRADE-03 | Panneau de correction : parcours par étudiant dans l'ordre du quiz, ou par question à travers tous les étudiants. Le nom de l'étudiant est masqué par défaut. | P1 | M |
| F-GRADE-04 | Le prof valide une proposition, un lot filtré, par exemple toutes les propositions à confiance haute, ou toutes les propositions d'une question, ou modifie les points et un commentaire avant de valider. | P1 | M |
| F-GRADE-05 | Le prof peut surcharger n'importe quelle correction, y compris automatique, avec un commentaire obligatoire. La correction précédente est conservée en `superseded`. | P1 | M |
| F-GRADE-06 | Re-correction : après publication d'une nouvelle version de question, le prof peut relancer la correction automatique d'un item sur toutes les tentatives. Chaque correction relancée porte l'annotation "re-corrigé avec la version N" et l'ancienne est conservée. | P1 | M |
| F-GRADE-07 | Un commentaire du prof par réponse est visible de l'étudiant selon la politique de feedback. | P1 | S |
| F-GRADE-08 | Un étudiant peut signaler une question depuis ses résultats avec un motif. Le prof voit les signalements sur le panneau de correction. | P2 | S |
| F-GRADE-09 | La publication des résultats fige les notes et notifie les étudiants. Une re-correction après publication met à jour les notes et marque l'évaluation "modifiée après publication". | P1 | M |

## F-RES Résultats et notes

| Id | Exigence | Phase | Prio |
|---|---|---|---|
| F-RES-01 | Vue des notes d'une évaluation : par étudiant, points, note au dixième, temps utilisé, moyenne, médiane, écart type, histogramme. | P1 | M |
| F-RES-02 | Export CSV : email, nom, points par item, total, note. Séparateur point-virgule, encodage UTF-8 avec BOM pour Excel. | P1 | M |
| F-RES-03 | Vue par question : énoncé, bonne réponse, explication, répartition des réponses, pour un choix multiple le pourcentage par choix, taux de réussite, temps moyen. Défilement linéaire pour la correction en classe. | P1 | M |
| F-RES-04 | L'étudiant voit ses résultats publiés : points par question, note, et selon le feedback sa réponse, la clé, l'explication, le commentaire du prof. | P1 | M |
| F-RES-05 | Vue cumulée par classroom : notes de toutes les évaluations publiées, moyenne pondérée configurable. | P2 | S |

## F-STAT Statistiques de questions

| Id | Exigence | Phase | Prio |
|---|---|---|---|
| F-STAT-01 | Pour chaque version de question : nombre d'expositions, taux de réussite, points moyens, temps de réponse moyen, min, max, par année. | P2 | S |
| F-STAT-02 | Indice de difficulté p, indice de discrimination par corrélation point bisériale avec le total, analyse des distracteurs pour les choix multiples. | P2 | S |
| F-STAT-03 | Les statistiques sont visibles dans le pool sur la fiche de la question et servent de filtres. | P2 | S |
| F-STAT-04 | "Générer un quiz" : durée cible, tags, difficulté, nombre de questions, en s'appuyant sur le temps moyen de réponse. Le résultat est un brouillon d'évaluation éditable. | P3 | C |

## F-LLM Assistance par LLM

| Id | Exigence | Phase | Prio |
|---|---|---|---|
| F-LLM-01 | L'admin configure des fournisseurs : Anthropic, OpenAI, ou compatible OpenAI, avec modèle et clé institutionnelle facultative. Chaque prof peut renseigner sa propre clé, chiffrée au repos. | P2 | M |
| F-LLM-02 | Dans l'éditeur : générer une variante de la question, proposer la clé de réponse, rédiger l'explication, proposer des distracteurs. Le résultat arrive dans le brouillon, jamais publié automatiquement. | P2 | M |
| F-LLM-03 | La correction LLM est décrite en F-GRADE-02. Aucun appel LLM n'est fait pendant le déroulement d'une évaluation. | P2 | M |
| F-LLM-04 | Toute donnée envoyée est anonymisée : pas de nom, email ni identifiant étudiant. Les appels sont journalisés avec le modèle, le nombre de tokens et le coût estimé, par prof. | P2 | M |
| F-LLM-05 | Sans clé configurée, l'action "copier le prompt" fournit le prompt complet à coller dans un client externe, et "coller la réponse" l'importe. | P2 | S |
| F-LLM-06 | Serveur MCP exposant la lecture et l'écriture de brouillons de questions, pour rédiger depuis un client LLM. | P3 | C |

## F-DRILL Entraînement

| Id | Exigence | Phase | Prio |
|---|---|---|---|
| F-DRILL-01 | Chaque question rencontrée par un étudiant dans une évaluation devient une carte de drill. Le prof peut aussi ouvrir un pool entier au drill pour une classroom. | P2 | S |
| F-DRILL-02 | L'ordonnancement suit FSRS. L'étudiant note sa réponse ou la correction automatique fournit la note de rappel. | P2 | S |
| F-DRILL-03 | L'étudiant a un onglet drill avec la session du jour ou de la semaine, de N questions, durée configurée par le prof ou l'admin. | P2 | S |
| F-DRILL-04 | Le drill est opt-in. Le prof voit des agrégats par classroom et par tag, jamais le détail individuel par défaut. | P2 | S |
| F-DRILL-05 | L'étudiant voit par tag un indicateur de maîtrise dérivé de la rétention FSRS, et ses points forts et faibles. | P2 | S |

## F-ADMIN Administration

| Id | Exigence | Phase | Prio |
|---|---|---|---|
| F-ADMIN-01 | Liste des utilisateurs, rôles, dernière connexion. Promotion en prof. | P1 | M |
| F-ADMIN-02 | État du runner : langages disponibles, file d'attente, temps moyen, erreurs. | P1 | M |
| F-ADMIN-03 | Paramètres globaux : fournisseurs LLM, durée par défaut des drills, message d'annonce. | P2 | S |
| F-ADMIN-04 | Journal d'audit des actions sensibles : suppression, re-correction, changement de rôle, publication de résultats. | P1 | S |
