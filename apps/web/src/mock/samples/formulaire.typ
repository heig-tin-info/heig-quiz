// The sample PDF of the mock's course library (`mock/library.ts`): a
// fictitious formula sheet, four pages, an outline from its headings and
// text a search finds. Rebuild with
//   typst compile apps/web/src/mock/samples/formulaire.typ
// and keep the result well under 100 kB (it is committed).
#set document(title: "Formulaire d'électronique")
#set page(paper: "a4", margin: (x: 2.2cm, y: 2.4cm), numbering: "1 / 1")
#set text(lang: "fr", size: 11pt)
#set heading(numbering: "1.1")

#align(center)[
  #text(size: 20pt, weight: "bold")[Formulaire d'électronique]
  #v(-4pt)
  #text(size: 10pt)[Cours fictif · document d'exemple de la maquette]
]

= Lois fondamentales

== Loi d'Ohm
La tension aux bornes d'une résistance est proportionnelle au courant qui la traverse :
$ U = R I $
La puissance dissipée dans une résistance vaut $P = U I = R I^2 = U^2 / R$.

== Lois de Kirchhoff
- *Loi des nœuds* : la somme des courants entrant dans un nœud est nulle, $sum_k I_k = 0$.
- *Loi des mailles* : la somme des tensions le long d'une maille est nulle, $sum_k U_k = 0$.

== Diviseur de tension
Deux résistances en série alimentées par $U_e$ :
$ U_s = U_e R_2 / (R_1 + R_2) $

#pagebreak()
= Résistances

== Association en série et en parallèle
En série, les résistances s'additionnent : $R = R_1 + R_2$. En parallèle, leurs conductances s'additionnent :
$ 1 / R = 1 / R_1 + 1 / R_2 $

== Code des couleurs
#table(
  columns: 3,
  [*Couleur*], [*Chiffre*], [*Multiplicateur*],
  [Noir], [0], [$10^0$],
  [Brun], [1], [$10^1$],
  [Rouge], [2], [$10^2$],
  [Orange], [3], [$10^3$],
  [Jaune], [4], [$10^4$],
  [Vert], [5], [$10^5$],
)

#pagebreak()
= Condensateurs

== Charge et énergie
Un condensateur de capacité $C$ sous la tension $U$ porte la charge $Q = C U$ et stocke l'énergie
$ W = 1/2 C U^2 $

== Circuit RC
La constante de temps d'un circuit RC vaut $tau = R C$. À la charge sous un échelon $E$ :
$ u_C (t) = E (1 - e^(-t / tau)) $
Après $5 tau$, le condensateur est chargé à plus de 99 %.

#pagebreak()
= Amplificateurs opérationnels

== Amplificateur idéal
En contre-réaction, un amplificateur idéal obéit à deux règles : aucun courant n'entre dans ses entrées, et les deux entrées sont au même potentiel.

== Montages de base
- *Suiveur* : $U_s = U_e$, gain 1.
- *Non inverseur* : $G = 1 + R_2 / R_1$.
- *Inverseur* : $G = - R_2 / R_1$.

== Unités
#table(
  columns: 2,
  [*Grandeur*], [*Unité*],
  [Tension], [volt (V)],
  [Courant], [ampère (A)],
  [Résistance], [ohm ($Omega$)],
  [Capacité], [farad (F)],
)
