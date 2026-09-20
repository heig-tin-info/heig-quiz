# 3. Exigences non fonctionnelles

## 3.1 Performance et charge

| Id | Exigence |
|---|---|
| N-PERF-01 | 100 étudiants connectés simultanément, 30 dans une même évaluation, sans dégradation perceptible. |
| N-PERF-02 | Un autosave est acquitté en moins de 200 ms côté serveur au 95e percentile. |
| N-PERF-03 | Une action du prof, démarrer, pause, ajouter du temps, clôturer, est visible chez tous les étudiants en moins d'une seconde. |
| N-PERF-04 | Le runner absorbe 30 exécutions demandées en 10 secondes avec un temps de réponse inférieur à 5 secondes pour un programme trivial. Concurrence configurable, 4 par défaut sur une VM 4 vCPU. |
| N-PERF-05 | Chargement initial d'une page d'évaluation sous 2 secondes sur une connexion 4G moyenne. Le bundle du player de code est chargé à la demande. |
| N-PERF-06 | La VM cible : 4 vCPU, 8 Go, 80 Go SSD. La spec ne suppose pas de scaling horizontal. |

## 3.2 Résilience pendant une évaluation

| Id | Exigence |
|---|---|
| N-RES-01 | Aucune réponse acquittée n'est perdue. L'acquittement n'est envoyé qu'après écriture en base. |
| N-RES-02 | Le client conserve les réponses non acquittées en mémoire et les renvoie avec leur révision à la reconnexion. Un indicateur visible signale l'état hors ligne. |
| N-RES-03 | La connexion temps réel se rétablit automatiquement avec repli exponentiel, et rejoue l'état courant de l'évaluation à la reconnexion. |
| N-RES-04 | Un redémarrage du serveur d'application pendant une évaluation n'invalide ni les sessions ni les tentatives. Les deadlines sont en base, pas en mémoire. |
| N-RES-05 | Sauvegarde de la base toutes les heures pendant les heures d'enseignement et quotidienne sinon, conservée 30 jours, hors de la VM. Restauration testée avant la mise en production. |
| N-RES-06 | Une procédure documentée de secours : le prof peut exporter à tout moment l'état brut des réponses d'une évaluation en cours. |

## 3.3 Sécurité

| Id | Exigence |
|---|---|
| N-SEC-01 | Auth uniquement par edu-ID OpenID Connect avec PKCE. Cookies de session `HttpOnly`, `Secure`, `SameSite=Lax`. |
| N-SEC-02 | TLS obligatoire, certificats automatiques. HSTS. En-têtes CSP stricts, pas de script inline hors nonce. |
| N-SEC-03 | Toute autorisation est vérifiée côté serveur par ressource : un étudiant n'accède qu'à ses tentatives, un prof qu'à ses classrooms et pools. |
| N-SEC-04 | Le contenu servi à un étudiant pendant une évaluation exclut la clé de réponse, l'explication, les cas de test cachés et les métadonnées du pool. Le filtrage est fait par le type de question dans une fonction dédiée, testée. |
| N-SEC-05 | Le markdown rendu est assaini. Les images sont servies depuis le même domaine. |
| N-SEC-06 | Sandbox du runner : conteneur par exécution, sans réseau, système de fichiers en lecture seule sauf un répertoire de travail temporaire, limites CPU, mémoire, pids, taille de sortie et temps mur, utilisateur non privilégié, runtime gVisor. Aucun secret de la plateforme n'est monté. |
| N-SEC-07 | Limitation du nombre d'exécutions par étudiant et par minute, et par évaluation. |
| N-SEC-08 | Les clés API LLM sont chiffrées au repos avec une clé d'application hors base. Jamais renvoyées au client. |
| N-SEC-09 | Journal d'audit des actions sensibles avec auteur, horodatage, ressource. |
| N-SEC-10 | Anti-triche léger, jamais bloquant : journalisation des pertes de focus et des changements d'adresse IP pendant une tentative, code d'accès, restriction IP facultative. L'étudiant est informé que ces événements sont enregistrés. |
| N-SEC-11 | Dépendances mises à jour automatiquement par PR, image de base du runner reconstruite chaque semaine. |

## 3.4 Données personnelles

| Id | Exigence |
|---|---|
| N-DATA-01 | Base légale : traitement nécessaire à la mission d'enseignement du prof. Les données sont stockées sur un serveur en Europe, VM Hetzner. |
| N-DATA-02 | Données traitées : identité edu-ID, appartenance aux classrooms, réponses, corrections, notes, événements de tentative, cartes de drill. |
| N-DATA-03 | Rétention : les données d'une classroom ou d'une évaluation sont conservées jusqu'à leur suppression par le prof. La suppression est effective et non réversible, y compris dans les sauvegardes au-delà de 30 jours. |
| N-DATA-04 | Un étudiant peut consulter et exporter toutes ses données depuis son profil, format JSON. |
| N-DATA-05 | Envoi à un fournisseur LLM : contenu anonymisé, sans nom, email, identifiant, ni métadonnées de classroom. Le prof est informé du fournisseur utilisé. Le fournisseur est configuré en mode sans conservation quand l'option existe. |
| N-DATA-06 | Les statistiques de questions dans le pool sont agrégées et ne permettent pas de remonter à un étudiant. |
| N-DATA-07 | Une page "Données et confidentialité" décrit ces règles aux étudiants, en français et en anglais. |

## 3.5 Accessibilité et internationalisation

| Id | Exigence |
|---|---|
| N-A11Y-01 | Conformité WCAG 2.1 AA visée sur les parcours étudiant et le tableau de bord prof : contraste, navigation clavier complète, focus visible, étiquettes, lecteur d'écran sur les formulaires. |
| N-A11Y-02 | Le player est utilisable au clavier seul. Raccourcis documentés : question suivante, précédente, marquer faite. |
| N-A11Y-03 | L'information n'est jamais portée par la couleur seule. Les états juste / faux / partiel ont une icône. |
| N-A11Y-04 | Taille de police et zoom navigateur jusqu'à 200 % sans perte de fonction. |
| N-I18N-01 | Interface en français et en anglais, langue choisie par l'utilisateur, par défaut celle du navigateur. Toutes les chaînes passent par le système de traduction. |
| N-I18N-02 | Dates, heures et nombres formatés selon la locale. L'horloge affichée est en heure locale de l'utilisateur. |
| N-I18N-03 | Le contenu des questions n'est pas traduit. |

## 3.6 Compatibilité

| Id | Exigence |
|---|---|
| N-COMPAT-01 | Deux dernières versions majeures de Chrome, Firefox, Safari, Edge. Safari iOS et Chrome Android pour les parcours étudiant. |
| N-COMPAT-02 | Largeur minimale supportée : 360 px. Types code et drawing : optimisés dès 1024 px, utilisables en dessous. |
| N-COMPAT-03 | Thèmes clair et sombre, préférence système par défaut, choix mémorisé. |

## 3.7 Exploitation

| Id | Exigence |
|---|---|
| N-OPS-01 | Déploiement par Docker Compose : reverse proxy, application, base Postgres, runner. Une commande pour mettre à jour. |
| N-OPS-02 | Journaux structurés JSON, niveau configurable. Métriques de base : requêtes, latence, connexions temps réel actives, file du runner. |
| N-OPS-03 | Page de santé interne : base, runner, espace disque, dernière sauvegarde. |
| N-OPS-04 | Migrations de schéma versionnées et appliquées au démarrage. Toujours compatibles avec la version précédente pour permettre un retour arrière. |
| N-OPS-05 | Aucun déploiement pendant une évaluation en cours : le script de mise à jour refuse si une évaluation est `running` sauf option de forçage. |

## 3.8 Qualité et maintenabilité

| Id | Exigence |
|---|---|
| N-QUAL-01 | TypeScript strict de bout en bout, schémas partagés entre client et serveur. |
| N-QUAL-02 | Tests unitaires sur tous les graders et sur le filtrage des contenus servis aux étudiants. Tests d'intégration sur le cycle de vie d'une évaluation. Un test de bout en bout par parcours principal. |
| N-QUAL-03 | Chaque type de question est un package isolé avec la même interface. Ajouter un type ne modifie pas le noyau. |
| N-QUAL-04 | Documentation : ce dossier `docs/`, un guide d'exploitation, un guide d'auteur de type de question. |

## 3.9 Principes UX

Ces principes cadrent le design system, détaillé plus tard dans un document dédié.

1. **Sobriété** : pas de cadres autour des champs, hiérarchie par l'espace et la typographie, une seule action primaire par écran.
2. **Prévisibilité côté étudiant** : l'interface d'examen est conventionnelle dans ses affordances. Les champs de saisie sont identifiables au repos, les boutons ont un libellé. L'innovation visuelle se concentre sur l'interface prof.
3. **Réactivité** : tout changement d'état est visible sans rechargement. L'état de synchronisation est toujours affiché pendant une évaluation.
4. **Un minimum de décisions** : les paramètres d'évaluation ont des valeurs par défaut sensées. Le prof lance un quiz en trois écrans : choisir les questions, régler le temps, démarrer.
5. **Le contenu d'abord** : l'énoncé occupe l'espace, la chrome de l'application est réduite à une barre supérieure avec logo, sections, et à droite utilisateur, thème, aide.
6. **Cohérence** : un composant par usage, des jetons de design pour couleurs, espacements, rayons, et une bibliothèque d'icônes unique.
