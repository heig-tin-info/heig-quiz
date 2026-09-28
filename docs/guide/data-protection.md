# Protection des données

Cette page décrit ce que la plateforme fait des données personnelles de ses utilisateurs, étudiants et enseignants. Elle s'appuie sur le code tel qu'il est aujourd'hui : chaque affirmation renvoie à un fichier du [dépôt](https://github.com/heig-tin-info/heig-quiz), et ce qui n'a pas pu être établi depuis le code est signalé « À confirmer ».

!!! info "Langue"

    Contrairement au reste de la documentation, cette page est rédigée en français : elle s'adresse d'abord aux étudiants et aux enseignants de la HEIG-VD.

## Cadre et démarche

La plateforme est utilisée par des enseignants de la HEIG-VD, établissement de droit public vaudois membre de la HES-SO. Le texte de référence est la Loi vaudoise sur la protection des données personnelles (LPrD, BLV 172.65), actuellement en cours de révision.

Cette page ne dit pas si le traitement satisfait à cette loi ; ce n'est pas à la documentation d'un logiciel d'en juger. Elle décrit, de bonne foi, ce qui est mis en œuvre, ce qui ne l'est pas encore et ce qui reste à vérifier. La section [Limites connues](#limites-connues-et-ameliorations-prevues) en fait la liste, suivie dans l'issue [#274](https://github.com/heig-tin-info/heig-quiz/issues/274).

Qui est formellement responsable du traitement (la HEIG-VD, un département, l'enseignant) et si ce traitement a été annoncé à une autorité ou à un délégué à la protection des données : **À confirmer**.

## Données collectées et origine

La plateforme reçoit des données de trois sources : Switch edu-ID à la connexion, la liste de classe importée par l'enseignant, et ce que l'utilisateur fait sur la plateforme.

### À la connexion, depuis Switch edu-ID

À chaque connexion, edu-ID transmet l'identité du compte et la plateforme la recopie (`apps/api/src/auth/oidc.ts`, `apps/api/src/auth/login.ts`) :

| Donnée | Usage |
| --- | --- |
| Identifiant edu-ID (`sub`, `swissEduPersonUniqueID`) | Reconnaître le compte d'une connexion à l'autre |
| Prénom, nom, adresse e-mail | Afficher la personne, la rattacher à sa place dans une classe |
| Adresses e-mail supplémentaires (institutionnelle, privée, liées) | Rattacher une place créée avec une autre adresse du même compte |
| Affiliations (`staff@heig-vd.ch`, `student@…`) | Décider du rôle enseignant ou étudiant |
| Adresse d'une photo, si edu-ID en fournit une | Afficher un portrait |

Deux tables méritent une mention. `user_emails` garde toute adresse vue une fois pour un compte, même si l'affiliation correspondante a pris fin. `user_idp_claims` garde l'ensemble des informations transmises par edu-ID lors de la dernière connexion, sans tri : le code l'explique par le diagnostic des problèmes de connexion (`apps/api/src/auth/claims.ts`). Ces informations ne sont affichées nulle part et aucune route ne les expose.

Les claims qu'edu-ID libère effectivement pour les comptes HEIG-VD, photo comprise : **À confirmer**.

### Depuis la liste de classe

L'enseignant importe un tableur avec, pour chaque étudiant, nom, prénom, adresse e-mail et, s'il y a lieu, un pourcentage de temps supplémentaire (`packages/domain/src/roster.ts`). Il peut ajouter une note libre sur un étudiant, que celui-ci ne voit jamais (`apps/api/src/db/org.ts`).

### Pendant l'utilisation

| Donnée | Détail |
| --- | --- |
| Réponses | Enregistrées au fil de la saisie, avec les questions marquées « à revoir » |
| Tentatives | Heure de début, échéance, remise, temps supplémentaire accordé, dernier signe de vie |
| Journal de tentative | Changements d'onglet, pertes de focus de la fenêtre, reconnexions, pauses et prolongations (`apps/web/src/attempt/signals.ts`) |
| Corrections | Points, commentaire de l'enseignant, historique des modifications |
| Notes publiées | Un instantané des notes au moment de la publication |
| Photo de profil | Si l'utilisateur en téléverse une |
| Notifications | Messages de la plateforme, préférences, liaison avec un compte Microsoft Teams |
| Sondages anonymes | Une empreinte du cookie du navigateur, sans identité |

Le journal de tentative est tenu pour toute évaluation, que le réglage « Journaliser les changements d'onglet » soit activé ou non (voir [Limites connues](#limites-connues-et-ameliorations-prevues)).

L'adresse IP n'est pas enregistrée dans la base, à une exception près : un refus d'accès par Safe Exam Browser la note dans le journal d'audit. Elle figure en revanche dans le journal technique de chaque requête (`apps/api/src/redact.ts`). La plateforme n'enregistre ni le navigateur utilisé, ni la frappe au clavier, ni de mesure d'audience.

## Finalités

Les données servent à :

- identifier la personne et lui donner accès à ses classes ;
- faire passer les évaluations : horloge, temps supplémentaire, sauvegarde des réponses ;
- corriger, automatiquement ou par l'enseignant, et publier les résultats ;
- permettre à l'enseignant de suivre le déroulement d'une évaluation, y compris le journal de tentative ;
- envoyer des notifications, si elles sont activées ;
- produire des statistiques par évaluation pour l'enseignant (voir [Statistiques](#statistiques-et-anonymisation)) ;
- garder une trace des modifications (journal d'audit) et diagnostiquer les pannes (journal technique).

Le code ne contient aucun usage publicitaire ou commercial, et aucune donnée n'est envoyée à un modèle d'IA pour la correction : cette fonction n'est pas active (`apps/api/src/modules/grading/jobs.ts`).

## Qui accède à quoi

### Les étudiants

Un étudiant voit ses classes, les évaluations qu'on y ouvre, ses propres réponses et, après publication, ses résultats et le retour prévu par l'enseignant. Il ne voit ni la liste de ses camarades ni leurs réponses : chaque accès est filtré sur son propre compte (`apps/api/src/modules/guards.ts`).

### Les enseignants

Un enseignant accède aux données d'un cours uniquement s'il fait partie de l'équipe de ce cours. Le contrôle est fait au moment où les données sont chargées ; sans place dans l'équipe, la réponse est la même que si le cours n'existait pas (`apps/api/src/modules/guards.ts`, prédicat `staffAccess`).

Dans une équipe, tous les membres ont les mêmes droits, sur toutes les classes du cours, années précédentes comprises. Tout membre de l'équipe peut y ajouter un collègue. Un enseignant qui ne fait pas partie de l'équipe d'un cours ne voit rien de ses étudiants.

Un enseignant qui connecte un assistant IA à la plateforme (voir [AI assistants](assistants.md)) lui donne accès aux cours, pools et évaluations, y compris aux noms et adresses des membres de l'équipe d'un cours. Aucun outil de l'assistant ne donne accès à la liste d'une classe.

### L'administrateur de l'application

Un seul compte, désigné dans la configuration du serveur, a le rôle d'administrateur (`apps/api/src/roles.ts`). Il atteint tous les cours et toutes les classes, voit la liste de tous les comptes, et peut ouvrir pendant une heure une vue en lecture seule du compte d'un étudiant pour l'aider (ADR-034). L'ouverture et la fin de cette vue sont inscrites au journal d'audit ; l'étudiant n'en est pas averti.

### L'administrateur système

La personne qui administre les machines a accès à la base de données, aux sauvegardes et aux journaux, donc à toutes les données. Ces accès passent par les outils du système (SSH, `psql`) et ne sont pas tracés par la plateforme. Qui dispose de ces accès : **À confirmer**.

### Ce qui est tracé

Le journal d'audit (`apps/api/src/audit.ts`) enregistre les actions qui modifient quelque chose : connexions, imports et modifications de listes de classe, corrections, publication des résultats, ouverture d'une vue « en tant qu'étudiant », autorisations accordées par l'administrateur. Il ne trace pas les consultations : qui a regardé quelle copie ou quelle liste n'est enregistré nulle part.

## Hébergement et localisation des données

La plateforme fonctionne chez l'hébergeur Hetzner, sur deux machines virtuelles (`docs/development/deployment.md`) :

- la machine applicative porte le serveur de l'application, la base PostgreSQL et les sauvegardes quotidiennes de la base ; elle héberge aussi deux autres services (heig-classroom et evaluation-tb), avec leurs propres fichiers inaccessibles aux autres comptes ;
- une seconde machine exécute le code soumis par les étudiants, dans des conteneurs isolés (ADR-016). Elle reçoit le programme à exécuter et ses données de test, sans nom ni identifiant d'étudiant (`packages/core/src/runner.ts`).

La spécification indique « un serveur en Europe » (`docs/spec/03-exigences-non-fonctionnelles.md`, N-DATA-01). Le pays et le centre de données de chaque machine : **À confirmer**. Une décision plus ancienne (ADR-009) mentionne un hébergement en Suisse ; elle date d'avant le passage chez Hetzner et ne décrit plus la situation.

Un environnement de recette tourne sur la même machine et reçoit une copie **non anonymisée** des données de production, pour tester dans des conditions réelles (ADR-028). Son accès est limité à une liste de comptes, et sa configuration type coupe les e-mails et les notifications Teams (`.env.staging.example`).

Services externes appelés :

| Service | Ce qu'il reçoit |
| --- | --- |
| Switch edu-ID | La connexion (c'est lui qui transmet l'identité) |
| Scaleway Transactional Email (région Paris par défaut) | Adresse du destinataire, titre de l'évaluation ou nom du pool concerné ; pas de note selon le code (`apps/api/src/modules/notifications/`) |
| Microsoft Teams | Pour un compte lié, une notification avec le titre concerné ; limité aux organisations autorisées |
| Hôte de la photo edu-ID | Le navigateur qui affiche un portrait non téléversé le charge directement depuis l'adresse fournie par edu-ID |

L'activation de l'e-mail et de Teams en production : **À confirmer**. La plateforme ne charge aucun script d'analyse d'audience, aucune police ni bibliothèque depuis un service tiers : tout est servi par le serveur lui-même.

## Durées de conservation et sort des données après le cursus

**Aucune durée de conservation n'est définie ni appliquée aujourd'hui.** Les données restent tant qu'un enseignant ne les supprime pas (`docs/spec/03-exigences-non-fonctionnelles.md`, N-DATA-03). En particulier, rien ne se passe automatiquement quand un étudiant termine ou quitte ses études.

Ce qui est supprimé, et quand :

| Action | Effet |
| --- | --- |
| Suppression d'une évaluation | Tentatives, réponses, journaux de tentative et corrections de cette évaluation sont supprimés |
| Suppression d'une classe ou d'un cours | Idem pour toutes ses évaluations, plus la liste de classe |
| Archivage d'une classe | Rien n'est supprimé : la classe est seulement masquée |
| Retrait d'un étudiant de la liste de classe | Sa place disparaît ; ses tentatives, réponses et notes restent en base |
| Sessions expirées | Supprimées automatiquement, toutes les dix minutes |

Ce qui n'est jamais supprimé automatiquement : les comptes (il n'existe pas de suppression de compte), les adresses e-mail et informations edu-ID conservées, le journal d'audit, qui garde notamment le nom et l'adresse d'un étudiant retiré d'une classe.

Après une suppression, la donnée reste dans les sauvegardes jusqu'à leur rotation : 30 jours pour les copies quotidiennes de la base, 7 jours pour les sauvegardes Hetzner de la machine (`compose.prod.yml`, `docs/development/deployment.md`). La copie de recette la garde jusqu'au prochain rafraîchissement.

La durée de conservation que l'institution souhaite après le cursus : **À confirmer**.

## Statistiques et anonymisation

Les statistiques que la plateforme affiche sont calculées **par évaluation**, au moment de l'affichage, à partir des données nominatives : moyenne, répartition des notes, taux de réussite de chaque question, répartition des réponses (`apps/api/src/modules/results/service.ts`). Seule l'équipe du cours les voit. L'export CSV des résultats est nominatif.

Il n'existe pas de base statistique séparée ni anonymisée. Conséquences :

- supprimer une évaluation supprime aussi ses statistiques ;
- tant qu'elles existent, les statistiques restent liées aux personnes ;
- aucun seuil minimal d'effectif n'est appliqué : dans une petite classe, une répartition des notes ou un taux de réussite peut permettre de reconnaître un étudiant.

Les statistiques par question sur plusieurs années et les statistiques de pool agrégées prévues par la spécification (F-STAT-01, N-DATA-06) ne sont pas implémentées. La « difficulté » d'une question est une valeur choisie par son auteur, pas un calcul sur les résultats.

Pendant une évaluation, le tableau de bord de l'enseignant peut afficher un pseudonyme (adjectif et animal) au lieu du nom, par exemple pour une projection en classe (`packages/domain/src/pseudonym.ts`). C'est un choix d'affichage : les données en base restent nominatives.

## Mesures de sécurité

Connexion et sessions :

- pas de mot de passe propre à la plateforme : la connexion passe par Switch edu-ID (OIDC avec PKCE) ;
- la session est une valeur aléatoire dont le serveur ne garde que l'empreinte ; le cookie est inaccessible au JavaScript de la page, transmis uniquement en HTTPS en production, et expire au plus tard 12 heures après la dernière activité avec la configuration type (`apps/api/src/auth/session.ts`, `.env.prod.example`) ;
- les requêtes de modification sont protégées contre la falsification intersite (`apps/api/src/auth/plugin.ts`) ;
- la connexion de développement, qui permet de choisir une identité fictive, empêche le serveur de démarrer en production (`apps/api/src/config.ts`) ;
- les jetons API et les autorisations données aux assistants IA ne sont stockés que sous forme d'empreinte (ADR-022, ADR-023).

Réseau et stockage :

- tout le trafic entre le navigateur et le serveur est chiffré (HTTPS, avec HSTS) ; le trafic vers la machine d'exécution du code aussi, et celle-ci n'accepte que la machine applicative (`Caddyfile`, `apps/runner/deploy/Caddyfile`) ;
- la base de données n'est pas exposée sur le réseau : seule l'application y accède, par un réseau interne à la machine ;
- les secrets (mots de passe, clés) sont dans des fichiers réservés au compte de service, jamais dans le dépôt ni dans la base (ADR-010) ;
- le code des étudiants s'exécute dans des conteneurs sans réseau, sans secret, sans accès aux fichiers de la machine, avec des limites de mémoire, de processus et de temps (`apps/runner/README.md`).

Ce qui n'est pas en place ou pas établi : le chiffrement des disques et des sauvegardes n'est pas décrit dans le dépôt (**À confirmer**) ; les copies quotidiennes de la base sont sur la machine même et ne sont pas chiffrées ; aucune durée de conservation des journaux techniques n'est configurée dans le dépôt (**À confirmer** sur la machine).

## Droits des étudiants et interlocuteur

Ce que la plateforme permet aujourd'hui à un étudiant :

| Besoin | Dans l'application |
| --- | --- |
| Consulter son profil | Oui : nom, adresse e-mail, rôle, dernière connexion (**Settings**) |
| Consulter ses résultats et corrections | Oui, après publication par l'enseignant, dans la mesure prévue par l'évaluation |
| Consulter son journal de tentative | Non : seul l'enseignant le voit |
| Exporter ses données | Non : aucune fonction d'export pour l'étudiant |
| Corriger son nom ou son adresse | Non dans la plateforme : ils viennent d'edu-ID et sont mis à jour à chaque connexion ; une erreur dans la liste de classe se corrige auprès de l'enseignant |
| Supprimer ses données | Seulement sa photo de profil et sa liaison Teams |

Pour toute demande (consultation, copie, rectification ou effacement), l'étudiant s'adresse d'abord à l'enseignant du cours, qui peut corriger une liste de classe ou supprimer une évaluation. Extraire toutes les données d'un étudiant ou supprimer son compte n'est possible par aucune fonction de l'application : seul un accès direct à la base le permet.

L'interlocuteur institutionnel pour ces demandes, et l'autorité de surveillance à indiquer : **À confirmer**.

## Limites connues et améliorations prévues

Les points suivants sont connus et suivis dans l'issue [#274](https://github.com/heig-tin-info/heig-quiz/issues/274). Aucun n'est corrigé à la date de cette page ; ils ne sont pas planifiés tant que l'issue ne dit pas le contraire.

Conservation et effacement :

- aucune durée de conservation, aucune purge après le départ d'un étudiant ;
- aucune suppression ni anonymisation de compte : la colonne prévue pour marquer un compte anonymisé existe, mais aucun code ne la renseigne ;
- retirer un étudiant d'une classe ne supprime pas ses tentatives ni ses notes ;
- les informations edu-ID sont conservées sans tri et sans limite de durée ;
- le journal d'audit n'est jamais purgé et contient des noms et adresses.

Statistiques :

- toutes les statistiques sont nominatives ; aucune version anonymisée ne subsiste ni n'est produite ;
- pas de seuil d'effectif : les petites classes sont réidentifiables.

Accès et traçabilité :

- les consultations ne sont pas tracées, ni celles des enseignants, ni celles de l'administrateur ;
- les accès directs à la machine et à la base ne sont pas tracés par la plateforme ;
- le journal d'audit est présenté comme non modifiable par l'application, mais la configuration de production ne l'impose pas ;
- l'étudiant n'est pas averti qu'un administrateur a ouvert une vue de son compte ;
- tout utilisateur connecté peut obtenir la photo téléversée d'un autre utilisateur s'il connaît son identifiant interne ;
- un jeton API personnel donne tous les droits de son propriétaire et peut ne jamais expirer.

Information de l'étudiant :

- il n'existe pas encore, dans l'application, de page « Données et confidentialité » (N-DATA-07) ni d'export des données (N-DATA-04) ;
- l'étudiant n'est pas informé dans l'interface que les changements d'onglet et pertes de focus sont enregistrés, et ne voit pas ce journal ;
- le réglage « Journaliser les changements d'onglet » d'une évaluation n'a pas d'effet : le journal est toujours tenu.

Hébergement et sécurité :

- les copies quotidiennes de la base sont sur la machine qu'elles protègent, non chiffrées ; la copie hors de la machine n'est pas en place ;
- la recette contient une copie non anonymisée des données réelles ;
- la politique de sécurité du contenu (CSP) du site ne restreint pas l'origine des scripts ;
- la localisation des machines, le chiffrement des disques et la conservation des journaux techniques restent à confirmer.
