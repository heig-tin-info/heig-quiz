# 7. Réutilisation de heig-classroom

Le dépôt `~/heig-classroom` est un projet du même auteur, en production, avec la même pile, le même IdP et les mêmes contraintes d'exploitation. **Le portail de quiz démarre par une copie de ce dépôt, élagué**, plutôt que par un dépôt vierge. Les agents qui coderont le produit doivent lire cette page avant de créer quoi que ce soit qui existe déjà là-bas.

## 7.1 Ce qu'est heig-classroom

Monorepo pnpm, deux applications :

| Chemin | Rôle | État |
|---|---|---|
| `apps/server` + `apps/web` | Portail GitHub Classroom : classes, devoirs, dépôts étudiants, notation par CI | Production, `classroom.chevallier.io` |
| `apps/codespace` | Portail d'environnements de développement supervisés : code-server, Podman rootful durci, mode examen SEB | En test |
| `packages/domain`, `packages/contracts` | Règles métier pures et schémas zod partagés | |

Pile : Node 22, TypeScript strict, Fastify 5, zod 4, Drizzle sur PostgreSQL, pg-boss, openid-client, React 19, Vite, Tailwind 4, TanStack Query, vitest, Playwright pour les captures. Tout est écrit en anglais : code, commentaires, documentation, commits. Seule l'interface utilisateur est traduite. **Ces conventions s'appliquent telles quelles au portail de quiz.**

Treize ADR dans `docs/adr/` documentent les choix. Les ADR 001, 002, 003, 004, 005, 006, 008, 009, 010 s'appliquent sans modification au quiz : monolithe modulaire, Fastify, Postgres et Drizzle, pg-boss, SSE sans WebSocket, ticker unique pour les deadlines, SPA React, VM et Compose, secrets hors dépôt et hors base.

## 7.2 À reprendre tel quel

| Élément | Chemin dans heig-classroom | Usage dans le quiz |
|---|---|---|
| Login OIDC edu-ID | `apps/server/src/auth/oidc.ts`, `auth/plugin.ts` | Identique. Authorization Code + PKCE, `state` et `nonce`, authentification client `private_key_jwt` pour edu-ID ou `client_secret` pour Keycloak en dev, découverte paresseuse avec cache. Le scope `https://eduid.ch/scope/userinfo.read` est déjà géré. |
| Capture des claims | `auth/claims.ts`, table `user_idp_claims` | Identique. Conserve tout ce que l'IdP livre pour diagnostiquer, sans jamais l'exposer. `affiliationsOf` extrait `eduPersonAffiliation`, c'est la source du rôle prof ou étudiant, voir F-AUTH-02. Note observée en production : `eduPersonPrimaryAffiliation` n'est pas livré. |
| Identité multi-adresses | `identity.ts`, table `user_emails` | Identique. edu-ID livre l'adresse choisie par l'utilisateur, parfois privée, alors que le roster GAPS contient l'adresse `@heig-vd.ch`. L'identité est un ensemble d'adresses, l'appariement du roster se fait sur cet ensemble, les collisions sont signalées au prof. Ce problème est déjà résolu, ne pas le redécouvrir. |
| Sessions opaques | `auth/session.ts` | Identique. Jeton aléatoire, seul le hash SHA-256 est stocké, cookie CSRF séparé. |
| Keycloak de développement | `docker-compose.dev.yml`, `infra/keycloak/hgc-dev-realm.json` | Identique. Un vrai OIDC même en dev, aucun "utilisateur courant" par variable d'environnement. Ajouter un client `quiz` au realm. |
| Configuration typée | `apps/server/src/config.ts` | Même schéma zod des variables d'environnement, avec le refus des valeurs de dev en production. |
| Import de roster | `packages/domain/src/roster.ts`, `apps/web/src/RosterImport.tsx`, `RosterTable.tsx` | Identique. Collage CSV ou dépôt d'un fichier Excel, détection permissive des colonnes nom, prénom, email, import atomique. Ajouter la colonne temps supplémentaire en pourcent, F-ORG-07. |
| Guards et chargeurs d'accès | `apps/server/src/modules/guards.ts` | Même motif : un seul prédicat `staffAccess`, les entités sont chargées si et seulement si l'utilisateur a accès à leur classroom, sinon 404 indiscernable d'une absence. |
| Journal d'audit | `audit.ts`, table `audit_log` | Identique, catalogue fermé d'actions en union TypeScript. Couvre F-ADMIN-04. |
| Bus d'événements et SSE | `events.ts`, `modules/events.ts`, `apps/web/src/live.ts` | À reprendre avec une extension, voir 7.3. Les événements sont des indices de rafraîchissement par sujets, jamais des données. Reconnexion native de `EventSource`, refetch TanStack Query, pas de replay. |
| File de tâches | `jobs.ts`, pg-boss | Identique. Remplace la table `jobs` maison prévue en 5.6. Files `grading.auto`, `grading.runner`, `grading.llm`, `export.pool`. |
| Ticker des deadlines | `ticker.ts`, `deadline.ts` | Même mécanisme : une boucle périodique, verrou consultatif Postgres, sélection SQL des tentatives dont `deadline_at + grâce <= now()` et non fermées, fermeture par UPDATE conditionnel. Période à ramener de 20 s à 1 s pour le quiz, ce qui reste trivial pour 100 tentatives ouvertes. Le principe "replanifier est gratuit, rattraper après une panne est gratuit" est exactement ce que demande F-LIVE-07 et F-LIVE-11. |
| Gel en deux temps | ADR-012 | Même logique pour les notes : note provisoire à la clôture, définitive à la publication, F-GRADE-09. L'heure de réception serveur fait foi, jamais l'heure du client. |
| Design system | `apps/web/DESIGN.md`, `apps/web/src/style.css`, `apps/web/src/ui.tsx`, `theme.ts`, `.claude/skills/hgc-ui/SKILL.md` | À reprendre en entier, voir 7.4. |
| i18n | `apps/web/src/i18n.tsx` | Même mécanisme : dictionnaire plat par locale, `t(key, vars)`, choix persisté sur le compte avec miroir localStorage. Différence : dans le quiz, les surfaces prof sont aussi traduites, N-I18N-01. |
| Mock navigateur | `apps/web/src/mock/`, `dev:mock`, `?as=teacher` | Identique. Permet de développer et de capturer chaque écran sans backend. |
| Captures d'écran | `apps/web/scripts/screenshots.mjs` | Identique. Chaque écran touché est capturé en 1440×900 et 390×844, clair et sombre. |
| Déploiement | `Dockerfile`, `compose.prod.yml`, `Caddyfile`, `deploy.sh`, `deploy.md`, service `backup` | Identique, en retirant Keycloak de la production. Le service de sauvegarde Postgres existe déjà. |
| Tests | `apps/server/src/test/db.ts` avec PGlite, conventions `*.db.test.ts` | Identique. Tests de base sans Postgres externe. |
| Rendu markdown | `apps/web/src/markdown.tsx` | Non. C'est un rendu minimal pour l'aide, contenu de confiance. Le quiz a besoin d'un vrai éditeur et d'un rendu assaini avec KaTeX, voir 5.1. |
| Intégration GitHub | `apps/server/src/github/`, `octokit` | Non. Supprimer. |
| Mailer | `mailer.ts`, `modules/email.ts` | Plus tard. Utile pour notifier la publication des résultats, F-GRADE-09, mais pas en phase 1. |

## 7.3 À adapter

**SSE**. Le bus de heig-classroom ne transporte que des indices, le client refetch. Pour le quiz, cela suffit au tableau de bord prof et à l'état de l'évaluation. Deux ajouts :

1. Un battement toutes les secondes sur le flux d'une tentative ouverte, porteur de `serverNow` et de `deadlineAt`, pour l'horloge, voir 5.4. Le battement de 25 s de heig-classroom reste pour les autres pages.
2. Un sujet `attempt:<id>` et un sujet `evaluation:<id>` dans la grammaire des topics, en plus de `classroom:<id>`, `teacher:<id>`, `user:<id>`.

L'écriture des réponses reste en REST, comme le prévoit l'ADR-005.

**Rôles**. heig-classroom traite prof et assistant comme des étiquettes sans niveau de permission. Le quiz garde cette simplicité : tout membre du staff d'un cours a les mêmes droits. Le rôle global `teacher` vient de l'affiliation edu-ID ou de la promotion par l'admin.

**Schéma**. Reprendre `users`, `user_emails`, `user_idp_claims`, `sessions`, `audit_log`, `avatars`, `classrooms`, `enrollments`. Supprimer `organizations`, `assignments`, `student_repos` et tout ce qui touche GitHub. Ajouter les tables de [01-glossaire-et-domaine.md](01-glossaire-et-domaine.md). heig-classroom utilise des UUID, le quiz aussi, la spec parlait d'ULID : **les UUID v7 sont retenus**, triables et générables côté client.

## 7.4 Ligne graphique

Le portail de quiz reprend le design system de heig-classroom tel quel. C'est déjà la ligne demandée dans le README : sobre, sans cadres, une action primaire par écran, jetons sémantiques, clair et sombre par échange de variables sans variante `dark:` dans le balisage.

- **Jetons** : `canvas`, `surface`, `surface-2`, `surface-3`, `line`, `line-strong`, `fg`, `fg-muted`, `fg-faint`, `accent`, `accent-soft`, `on-fill`, `success`, `warning`, `danger` et leurs variantes `soft`. Définis dans `style.css`, documentés dans `DESIGN.md`, 230 lignes à lire en premier.
- **Typographie** : Manrope variable pour le texte, JetBrains Mono variable pour le code.
- **Primitives** dans `ui.tsx`, 2000 lignes : `Button`, `IconButton`, `Card`, `Badge`, `Alert`, `Field`, `Select`, `Textarea`, `Segmented`, `Switch`, `Tabs`, `Menu`, `Modal`, `Sheet`, `PageHeader`, `SectionHeading`, `Stat`, `EmptyState`, `Skeleton`, `Spinner`, `Progress`, styles de table `T` avec tri, `RangeCalendar`, `useConfirm`, `useLayer`, `useEscape`, `useNow`.
- **Règles** de la skill `hgc-ui` : cinq états par surface asynchrone, formulaires longs en `Sheet`, confirmations par `useConfirm`, sept colonnes au plus, clavier complet, capture d'écran obligatoire avant de déclarer un écran terminé.
- **Différence d'accent** : l'accent rouge HEIG-VD de heig-classroom peut être conservé ou remplacé par une teinte propre au quiz. Un seul jeton à changer.
- **À ajouter** pour le quiz : anneau de progression de la salle d'attente, compte à rebours, grille étudiants × questions, barre de progression des questions, cellules de verdict juste / partiel / faux avec icône. Ces composants entrent dans `ui.tsx` ou dans un `packages/ui` s'ils deviennent nombreux.

La skill `.claude/skills/hgc-ui/SKILL.md` est copiée dans le nouveau dépôt sous un nom propre au quiz, avec les chemins mis à jour.

## 7.5 Principe des runners

heig-classroom n'a pas de runner de code intégré : la notation se fait par GitHub Actions sur des runners éphémères auto-hébergés, ADR-007. Ce n'est pas le modèle du quiz. En revanche `apps/codespace` contient exactement le durcissement de conteneur dont le runner du quiz a besoin :

| Élément | Chemin | Usage dans le quiz |
|---|---|---|
| Options de durcissement | `apps/codespace/images/c-dev/run-hardened.sh` | Reprendre la liste : `--userns=auto`, `--cap-drop=ALL`, `--security-opt no-new-privileges`, profil seccomp, `--read-only`, `--pids-limit`, tmpfs de travail, `--network none`. Ce sont les options de N-SEC-06. |
| Profil seccomp | `apps/codespace/infra/seccomp/codespace.json` | Reprendre. Déjà testé avec une chaîne de compilation C. |
| Image C | `apps/codespace/images/c-dev/Containerfile` | Base pour l'image `runner-c`, en retirant code-server. Une image par langage, même structure. |
| Module moteur | `apps/codespace/src/engine/` | Pilotage de Podman en `--remote` via le socket, sortie `--format json`. Reprendre comme base de `apps/runner`. |
| Invariants | `apps/codespace/CLAUDE.md` | "Aucun secret dans le conteneur", "réseau fermé par construction", "durcissement dès le premier run". Recopier dans le `CLAUDE.md` du quiz. |
| Réseau interne nftables | `apps/codespace/infra/net/`, `infra/nft/` | Non nécessaire. Le runner du quiz est en `--network none`, il n'a pas de canal git à ouvrir. |
| Mode SEB | `apps/codespace/src/seb/` | Hors périmètre du quiz, voir 0.6. Reste disponible si un jour un examen surveillé est demandé. |

Conséquence sur [05-architecture.md](05-architecture.md), section 5.5 : le runner est piloté par **Podman rootful en `--remote`** comme le codespace, plutôt que par le socket Docker. gVisor reste l'option recommandée en plus, si la VM Hetzner l'accepte ; sinon le durcissement Podman du codespace est la référence, il est déjà éprouvé. Le codespace maintient une session longue par étudiant, le runner du quiz lance un conteneur par exécution de quelques secondes : le module moteur est repris, la gestion de sessions ne l'est pas.

## 7.6 Marche à suivre pour démarrer le dépôt

1. Copier heig-classroom dans un nouveau dépôt, historique non conservé.
2. Supprimer `apps/codespace` après avoir déplacé `images/c-dev`, `infra/seccomp`, `src/engine` vers `apps/runner`.
3. Dans `apps/server` : supprimer `github/`, `modules/webhooks.ts`, `repos.ts`, `sync.ts`, `codespace.ts`, `mailer.ts` pour l'instant, et les tables associées. Garder auth, identity, sessions, guards, audit, events, jobs, ticker, config, test.
4. Dans `apps/web` : garder `ui.tsx`, `style.css`, `theme.ts`, `i18n.tsx`, `Shell.tsx`, `Header.tsx`, `notify.tsx`, `confirm.tsx`, `RosterImport.tsx`, `RosterTable.tsx`, `SettingsPage.tsx`, `AdminPanel.tsx`, `mock/`, `scripts/`. Supprimer les écrans de devoirs.
5. Renommer le scope de package `@hgc` en un scope propre au quiz, mettre à jour `DESIGN.md` et la skill UI.
6. Créer `packages/core` avec le contrat `QuestionType` et le registre, puis `packages/qt-mcq` comme premier type, avant tout écran d'évaluation.
7. Vérifier que `pnpm build && pnpm typecheck && pnpm test` passe sur le squelette vide avant d'ajouter une fonctionnalité.
