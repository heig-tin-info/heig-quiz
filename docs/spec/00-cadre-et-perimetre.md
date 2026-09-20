# 0. Cadre, objectifs et périmètre

## 0.1 Contexte

- Projet d'un enseignant HEIG-VD pour ses propres cours. Développement par l'enseignant, assisté de Claude.
- Hébergement : une VM Hetzner, déploiement Docker Compose, un seul nœud.
- Utilisateurs : étudiants et enseignants HES-SO authentifiés par edu-ID, un administrateur.
- Usage principal : évaluations en classe (20 à 30 étudiants), exercices à la maison, sondages en direct, entraînement individuel.

## 0.2 Pourquoi un système maison

| Besoin | Moodle / CodeRunner | Wooclap, Kahoot, etc. | Ce projet |
|---|---|---|---|
| Auth edu-ID et appariement automatique des étudiants | Oui via Cyberlearn, mais lourd | Non | Oui, natif |
| Interface sobre et moderne, temps réel | Non | Oui, mais orientée animation | Oui |
| Questions code exécutées en sandbox | CodeRunner, UI datée | Non | Oui, natif |
| Correction assistée par LLM cadrée et validée par le prof | Non | Non | Oui, différenciateur |
| Pool de questions versionné, partagé, exportable en texte | Partiel | Non | Oui |
| Entraînement espacé sur les questions du cours | Non | Non | Oui, phase 2 |
| Gratuit, sans publicité, données sur un serveur maîtrisé | Oui | Non | Oui |

## 0.3 Objectifs

1. Un prof crée une évaluation de 10 questions à partir de son pool en moins de 10 minutes.
2. Un quiz de 30 étudiants se déroule sans incident réseau visible : chaque réponse est sauvée dès la saisie, une déconnexion ne perd rien.
3. Le tableau de bord du prof reflète l'état des étudiants en moins d'une seconde.
4. Les questions à correction automatique donnent une note provisoire dès la clôture. Les autres sont proposées par le LLM et validées par le prof en un passage.
5. L'export des notes au dixième, barème 1 à 6, est disponible en CSV dès la validation.
6. Tout le contenu d'un pool s'exporte en fichiers texte versionnables dans git et se réimporte sans perte.

## 0.4 Contraintes

- Équipe : une personne plus un assistant IA. La spec privilégie la simplicité d'exploitation : un dépôt, une base, une VM.
- Point de départ : le dépôt `~/heig-classroom` du même auteur, en production, fournit l'auth edu-ID, le design system, l'infrastructure de déploiement et le durcissement des conteneurs. Voir [07-reutilisation-heig-classroom.md](07-reutilisation-heig-classroom.md).
- Charge : 20 à 30 étudiants par quiz, 100 étudiants simultanés sur la plateforme, pics d'exécution de code de 30 runs en 10 secondes.
- Langues : interface en français et en anglais. Contenu des questions dans la langue du prof.
- Auth : edu-ID uniquement pour les comptes nominatifs. Un code de session permet la participation anonyme aux sondages.
- Données : réponses et notes sont des données personnelles. Voir [03-exigences-non-fonctionnelles.md](03-exigences-non-fonctionnelles.md), section données.
- Navigateurs : versions courantes de Chrome, Firefox, Safari, Edge. Mobile et tablette pour tous les types sauf le code et le drawing, qui restent utilisables mais optimisés pour desktop.

## 0.5 Phases

Priorité MoSCoW : M = must, S = should, C = could.

### Phase 1, MVP : faire passer un quiz noté en classe

| Domaine | Contenu | Prio |
|---|---|---|
| Auth | edu-ID OpenID Connect, rôles prof / étudiant / admin | M |
| Organisation | Cours, classroom, roster importé par CSV ou auto-inscription à la connexion | M |
| Pool | Pool privé par prof, catégories, tags, brouillon puis publication, versions numérotées | M |
| Questions | Choix multiples, texte court, texte à trou, code stdin/stdout | M |
| Évaluation | Mode examen chronométré, salle d'attente, navigation libre / forward only, mélange, temps supplémentaire par étudiant | M |
| Déroulement | Autosave, SSE temps réel, horloge serveur, pause, +1/+5/+10 min, clôture manuelle ou automatique | M |
| Correction | Auto pour les 4 types, panneau de validation, surcharge manuelle, re-correction annotée | M |
| Notes | Barème 1 à 6 au dixième, export CSV, feedback configurable | M |
| Tableau de bord | Grille étudiants x questions en direct, affichage / masquage des noms et réponses | M |
| Export | Format canonique YAML du pool, import / export, API à jeton | S |
| Expert | Bascule WYSIWYG / source, palette `Ctrl+K`, raccourcis | S |
| UX | Design system maison, clair / sombre, responsive | M |

### Phase 2 : LLM, exercices, statistiques

| Domaine | Contenu | Prio |
|---|---|---|
| Questions | Réponse riche markdown corrigée par LLM, valeurs numériques aléatoires | M |
| LLM | "Générer la réponse", variantes, explications, sorties attendues calculées par la solution de référence, correction proposée, clé API par prof ou institutionnelle | M |
| Expert | CLI `quiz pull` / `push`, édition YAML brute, testeur de regex, opérations en masse | S |
| Évaluation | Mode exercice ouvert avec délai, mode sondage une question avec code de session | M |
| Pools | Pools partagés entre profs, rôles lecteur / contributeur / propriétaire, fork avec provenance | S |
| Statistiques | Indices de difficulté et de discrimination par version, analyse des distracteurs, temps de réponse | S |
| Drill | Entraînement espacé FSRS, drill quotidien / hebdomadaire, points forts et faibles par tag | S |
| Import | GIFT et Moodle XML | C |

### Phase 3 : types avancés et extensibilité

| Domaine | Contenu | Prio |
|---|---|---|
| Questions | CodeImage, drawing, pick-place composants électroniques | S |
| Code | Tests unitaires TAP, fichiers additionnels, régions verrouillées, langages supplémentaires | S |
| Plugins | Packages de questions externes, chargés au build | C |
| Génération | "Generate 10 min quiz" par tags et difficulté | C |
| Intégrations | Serveur MCP pour rédiger depuis un client LLM | C |

## 0.6 Hors périmètre

- Proctoring lourd : webcam, verrouillage de l'appareil, Safe Exam Browser.
- Correction de schémas électroniques par simulation ou comparaison de netlist. Le pick-place est corrigé par LLM ou manuellement.
- Gestion de plans d'études, de crédits, d'absences. La plateforme exporte des notes, elle ne les administre pas.
- Multi-tenant institutionnel : un seul admin, une seule instance.
- Éditeur de code avec serveur de langage complet. Monaco avec coloration et raccourcis suffit.
- Installation de plugins à chaud depuis un dépôt distant.

## 0.7 Risques

| Risque | Impact | Mitigation |
|---|---|---|
| Panne de la VM pendant un examen | Élevé | Autosave côté serveur à chaque saisie, reprise transparente, sauvegardes, procédure de bascule documentée, mode papier de secours |
| Évasion de la sandbox de code | Élevé | Conteneurs sans réseau, gVisor, limites CPU / mémoire / pids / temps, image en lecture seule, pas de secrets accessibles |
| Correction LLM erronée sur une note officielle | Moyen | Toujours validée par le prof, justification par critère, score de confiance, re-correction tracée |
| Coût ou indisponibilité du fournisseur LLM | Moyen | Correction différée, jamais dans le chemin critique du quiz, clé par prof |
| Fuite des questions du pool | Moyen | Le pool n'est jamais servi aux étudiants, seules les questions d'une évaluation en cours le sont, sans la clé |
| Dérive du périmètre | Élevé | Phases figées, toute nouvelle idée va dans la phase 3 ou hors périmètre |

## 0.8 Journal des décisions

| Date | Décision |
|---|---|
| 2026-09-19 | Système maison plutôt que Moodle ou outil SaaS |
| 2026-09-19 | Correction LLM pour réponses riches et drawing, validée par le prof |
| 2026-09-19 | Barème 1 à 6 au dixième, temps supplémentaire en % par étudiant |
| 2026-09-19 | Rétention complète jusqu'à suppression par le prof |
| 2026-09-19 | Versionnage brouillon puis publication, numéro incrémenté |
| 2026-09-19 | Charge cible 30 par quiz, 100 simultanés |
| 2026-09-19 | Temps réel : SSE plus REST, événements porteurs de données pour le direct, pas de WebSocket |
| 2026-09-19 | Deux niveaux d'interface, profane par défaut, expert par divulgation progressive |
| 2026-09-19 | Démarrer par une copie élaguée de heig-classroom : auth, ligne graphique, SSE, pg-boss, ticker, déploiement, durcissement Podman du codespace |
