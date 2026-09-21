# 6. Questions ouvertes

À trancher avant de commencer le code. Chaque ligne indique la valeur supposée dans la spec.

| # | Question | Supposé dans la spec |
|---|---|---|
| 1 | Nom du projet, nom de domaine, dépôt public ou privé | À définir |
| 2 | Attributs edu-ID disponibles pour distinguer prof et étudiant. `eduPersonAffiliation` est-il fourni par la fédération HES-SO ? Sinon les profs sont promus par l'admin. | Affiliation disponible, repli sur promotion manuelle |
| 3 | Un étudiant retardataire en mode `duration` : durée pleine ou fin commune ? | Durée pleine, le prof peut fermer manuellement |
| 4 | Arrondi de la note : au dixième le plus proche, ou au demi-point comme certains barèmes HES ? | Au dixième le plus proche, méthode configurable |
| 5 | Feedback `immediate` autorisé en mode `exam` ? | Non, réservé à `exercise` et `poll` |
| 6 | Les étudiants voient-ils le classement de la classe ? | Non, seulement leur note et la distribution anonyme |
| 7 | Langages du runner en phase 1 : C, C++, Python, JS, Rust. Rust a une compilation lente, le garder ? | Gardé avec un temps limite de compilation de 20 s |
| 8 | Les tests cachés d'une question code sont-ils révélés dans le feedback ? | Nom et verdict oui, contenu non, option par évaluation |
| 9 | Le pool public : qui peut y publier au départ ? | **Tranché (ADR-013)** : un pool `public` est LISIBLE par tous les profs ; il est écrit par son propriétaire et par les membres qu'il a nommés (`contributor`, `owner`). L'admin reste propriétaire de fait partout. |
| 10 | Format des sauvegardes hors VM : stockage objet Hetzner ou autre ? | Stockage objet Hetzner via rclone |
| 11 | Le drawing s'appuie sur Excalidraw embarqué : accepté malgré son style propre ? | Oui, barre d'outils réduite et thème aligné |
| 12 | Une évaluation `exercise` avec plusieurs tentatives : meilleure ou dernière ? | Dernière, phase 2 |
| 13 | Modèle LLM par défaut pour la correction et pour la génération, et qui paie : clé institutionnelle ou clé du prof ? | Opus pour la correction, Sonnet pour la génération, clé du prof |
| 14 | Design system : partir d'une référence visuelle précise ? La capture d'écran fournie montre le tableau de bord attendu. | Un document de design à écrire avant le premier écran |
| 15 | Sondage en direct : comment identifier un participant sans compte ? | **Tranché (ADR-014)** : un cookie `quiz_guest` (HttpOnly, `SameSite=Lax`, chemin `/app/api/p`, 12 h) dont la base ne garde que `sha256(token:evaluation)`, et une ligne `guest_participants` par (sondage, navigateur). `attempts.user_id` devient nullable, `attempts.guest_id` apparaît, et une contrainte CHECK impose exactement un propriétaire. Aucun compte fictif n'est créé. |
| 16 | Sondage en direct : la fin d'un sondage publie-t-elle des résultats (`running → released` du glossaire) ? | **Tranché (ADR-014)** : non. « Terminer » ferme le sondage (`closed`) et lance la correction déterministe, sans publication : publier écrirait une note gelée pour toute la classe, y compris les étudiants qui n'ont jamais vu le sondage, et ferait apparaître un 1.0 sur leur page de résultats. Le résultat d'un sondage, c'est la répartition projetée. |
| 17 | Question code : l'essai de l'étudiant doit-il tourner dans le navigateur (WASI) plutôt que dans un conteneur, et si oui qui corrige ? | **Tranché (ADR-015)** : le navigateur exécute, le serveur corrige. `runtime` (`backend` par défaut, `runno` pour C et Python) ne choisit que l'endroit du bouton « Exécuter » ; `grade()` passe toujours par le runner du serveur, car un résultat produit par un navigateur n'est pas une preuve — WASI n'est pas Linux (pas de `fork`, pas de signaux, `<sys/…>` partiel, horloges du navigateur). Le backend reste le repli quand le navigateur ne peut pas (D14). Les runtimes sont hébergés par la plateforme. |
