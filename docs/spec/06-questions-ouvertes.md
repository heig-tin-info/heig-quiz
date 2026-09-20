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
| 9 | Le pool public : qui peut y publier au départ ? | L'admin seulement, phase 2 |
| 10 | Format des sauvegardes hors VM : stockage objet Hetzner ou autre ? | Stockage objet Hetzner via rclone |
| 11 | Le drawing s'appuie sur Excalidraw embarqué : accepté malgré son style propre ? | Oui, barre d'outils réduite et thème aligné |
| 12 | Une évaluation `exercise` avec plusieurs tentatives : meilleure ou dernière ? | Dernière, phase 2 |
| 13 | Modèle LLM par défaut pour la correction et pour la génération, et qui paie : clé institutionnelle ou clé du prof ? | Opus pour la correction, Sonnet pour la génération, clé du prof |
| 14 | Design system : partir d'une référence visuelle précise ? La capture d'écran fournie montre le tableau de bord attendu. | Un document de design à écrire avant le premier écran |
