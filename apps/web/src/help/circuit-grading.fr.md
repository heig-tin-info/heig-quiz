# Correction d'un circuit

Une question de type circuit se corrige de trois manières. Le choix ne
concerne pas votre sévérité, mais ce que la question demande.

## Vous

Vous ouvrez la réponse et attribuez les points vous-même. L'écran montre tout
de même ce que la netlist a lu — ce qui est resté en l'air, quelle valeur n'a
pas pu être interprétée — ainsi que les signaux, si la question a des stimuli
et qu'un simulateur était disponible. C'est le bon mode pour une question qui
porte sur une topologie, une convention de dessin ou une explication, et le
seul qui ne coûte rien à publier.

## Simulation

Chaque stimulus est simulé deux fois, une fois sur le circuit de l'étudiant et
une fois sur votre référence, puis les deux signaux de sortie sont comparés.
Un stimulus est réussi quand l'écart reste sous la **tolérance**, exprimée en
fraction de l'amplitude crête à crête de la référence : 5 % est indulgent, 1 %
exige les valeurs exactes.

Ce mode exige un circuit de référence et au moins un stimulus, sans quoi la
question ne se publie pas. Un étudiant dont le circuit ne peut pas être
transformé en netlist — broche en l'air, valeur hors plage — n'obtient rien
sur ce stimulus, et la raison lui est indiquée.

## Assistant

Phase 2 : la netlist et vos critères sont transmis au modèle de langage. Le
mode est listé pour que le choix soit visible, mais il ne fonctionne pas
encore.

## Stimuli cachés

Un stimulus caché est corrigé comme les autres, mais l'étudiant n'en voit
jamais le nom, les paramètres ni le signal — ni avant, ni après les
résultats. Il sait seulement combien il y en a et ce qu'ils valent, comme
pour les cas de test cachés d'une question de code.
