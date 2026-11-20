# Résultats

## Étudiants

Les chiffres d'abord : moyenne, médiane, écart type, taux de réussite, et la
répartition des notes. Puis une ligne par étudiant — points, note au
dixième, temps utilisé, et l'état de sa tentative : absent, non commencée,
en cours, rendue, ou expirée à l'échéance.

La note vaut 1 + 5 × points / total sur l'échelle suisse de 1 à 6, plafonnée
à 6 et arrondie au dixième. Le total laisse de côté les questions bonus, dont
les points ne peuvent que monter un étudiant. Elle est calculée à partir des
corrections validées : modifier l'une d'elles dans le panneau de correction
la déplace.

## Questions

Un bloc par question, dans l'ordre du quiz : l'énoncé, la réponse attendue,
l'explication, la répartition des réponses et le taux de réussite — par
choix pour un choix multiple, par cas de test pour une question code. C'est
fait pour être déroulé pendant la correction en classe.

Pour l'équipe enseignante seulement, jamais projeté : à côté du taux de
réussite, les propositions de l'IA gardées telles quelles et les réponses
contestées. Sous le résumé, la même chose pour toute l'évaluation, les
contestations comptées sur les réponses corrigées.

## Export

**Exporter en CSV** donne une ligne par étudiant avec les points de chaque
question, le total et la note ; la colonne d'une question bonus est marquée
`(bonus)`. Point-virgule et marque d'ordre des octets en
UTF-8, pour qu'Excel l'ouvre sans poser de question.

## Publication

**Publier les résultats** montre à chaque étudiant sa note, et ce que la
politique de retour de cette évaluation autorise — sa réponse, la clé,
l'explication, votre commentaire. Si une correction change ensuite, la page
le signale et vous demande de publier à nouveau. **Retirer la publication**
soustrait les notes à leur vue jusque-là.

## Contestations

Sur un examen publié, une ligne compte les contestations ouvertes et mène
au panneau de correction filtré sur elles, et dit jusqu'à quand une
question peut être contestée. Le rôle Enseignant du cours permet de
**Clore maintenant** ou de **Prolonger** le délai, ou d'**Ouvrir un délai**
là où il n'y en a pas. Prolonger rouvre un délai clos.
