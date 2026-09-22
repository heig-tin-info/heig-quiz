# Liste de classe

## Ce qu'est cette liste

La liste de la classe. Chaque ligne est une place : **en attente** tant que
l'étudiant ne s'est pas connecté avec une adresse correspondante,
**rattachée** une fois liée à son compte. Un badge *équipe* marque une place
d'enseignant — celle que **S'inscrire comme étudiant**, ou **Voir en tant
qu'étudiant** sur une évaluation, vous donne pour parcourir le vrai
parcours étudiant. Une tentative de test prise depuis une telle place porte
le même badge partout où les tentatives sont listées, et ne compte dans
aucune statistique.

## Le rattachement

Les étudiants reprennent leur place automatiquement à leur première
connexion, sans code d'invitation. L'appariement se fait sur toutes les
adresses que le fournisseur d'identité révèle, pas seulement celle utilisée
pour se connecter. Une entrée ambiguë (le même étudiant sur deux places, ou
une adresse partagée par deux comptes) est marquée **conflit** : rien n'est
rattaché au jugé.

## Temps supplémentaire

La colonne **Temps suppl.** est l'aménagement, en pourcent de la durée
nominale de chaque évaluation chronométrée. Il provient du fichier importé
lorsque la feuille porte une colonne à cet effet, et se modifie ligne par
ligne.

## Gérer les lignes

Modifiez une ligne pour corriger un nom, une adresse ou le temps
supplémentaire. Changer l'adresse annule le rattachement : la place repasse
en attente et le détenteur de la nouvelle adresse la reprend. Retirer un
étudiant l'enlève de la liste ; ses résultats passés sont conservés.
