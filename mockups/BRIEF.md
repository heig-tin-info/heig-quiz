# Brief mockups UI — Portail de quiz

Tu produis des **maquettes HTML statiques** pour valider le design d'une plateforme de quiz pour l'enseignement (HEIG-VD). Aucune logique backend, aucune bibliothèque externe, données factices en dur. Le seul JavaScript autorisé : bascule clair/sombre (`html.dark`, persistée dans localStorage) et, si utile, ouvrir/fermer un panneau ou un onglet. Un seul fichier `.html` par écran, CSS inline dans `<style>`, icônes en SVG inline (style Lucide, 1.5px de trait, 16 à 20px).

## Contexte produit (lire au besoin)
- Spec complète dans `/mnt/c/Users/canard/Dropbox/work/heig-vd/projects/quiz/docs/` : `03-exigences-non-fonctionnelles.md` §3.9 principes UX, `08-experience-deux-niveaux.md` profane/expert, `02-exigences-fonctionnelles.md` pour le détail d'un écran.
- Ligne graphique de référence : `~/heig-classroom/apps/web/DESIGN.md` (LIS-LE EN ENTIER D'ABORD) et `~/heig-classroom/apps/web/src/ui.tsx` pour les primitives existantes (Button, Badge, Segmented, Switch, Tabs, Sheet, PageHeader, Stat, EmptyState, table T).

## Ligne graphique, non négociable
- Sobre, épuré, "à la Apple" : pas de cadres autour des champs, hiérarchie par l'espace et la typographie, filets fins (`--line`) et surfaces, jamais d'ombre dans le flux de page (ombres uniquement sur popover/sheet/modal).
- **Une seule action primaire par écran** (bouton plein accent). Deux ou trois secondaires. Le reste en menu ou icône.
- Jamais de couleur brute : uniquement les variables ci-dessous. Jamais l'information par la couleur seule (icône + texte).
- Polices : Manrope (texte) et JetBrains Mono (code, nombres tabulaires). Charge-les via Google Fonts `<link>` avec repli `system-ui`.
- Chiffres en `font-variant-numeric: tabular-nums`. Nombres alignés à droite dans les tables.
- Responsive : 1440px et 390px doivent être corrects (gouttière 16px sur mobile, pas de scroll horizontal).
- Chrome de l'application : barre supérieure fine, à gauche logo (un simple glyphe SVG + "Quiz"), sections de navigation ; à droite bascule thème, aide, avatar avec initiales. Le contenu occupe l'espace.
- États : montre au moins un état vide ou un état de chargement/skeleton quelque part si l'écran s'y prête.
- Langue de l'interface : **français**. Noms d'étudiants fictifs suisses romands.

## Jetons (copie exacte de heig-classroom, à mettre tels quels dans :root et html.dark)
    :root {
      --canvas: #f6f5f2;
      --surface: #ffffff;
      --surface-2: #f3f1ed;
      --surface-3: #eae7e1;
      --line: #e7e4de;
      --line-strong: #d3cfc7;
      --fg: #1a1917;
      --fg-muted: #67635b;
      --fg-faint: #8f8a80;
      --accent: #b41f24;
      --accent-hover: #9a1b1f;
      --accent-soft: #fbebeb;
      /* Ink laid on a saturated fill (accent, danger, success button, avatar,
         checkbox tick): white here, near-black in dark mode where the fills are
         light. One token so no component needs a `dark:` variant. */
      --on-fill: #ffffff;
      --success: #1f7a4d;
      --success-soft: #e7f4ec;
      --warning: #a35810;
      --warning-soft: #fdf1e2;
      --danger: #c2242a;
      --danger-soft: #fbe9e9;
      --shadow-overlay: 0 16px 48px -16px rgb(28 25 20 / 0.28), 0 1px 3px rgb(0 0 0 / 0.06);
      --shadow-popover: 0 10px 32px -12px rgb(28 25 20 / 0.24), 0 1px 2px rgb(0 0 0 / 0.05);
      --shadow-sheet: -12px 0 48px -16px rgb(28 25 20 / 0.3);
    }
    html.dark {
      --canvas: #131211;
      --surface: #1b1a18;
      --surface-2: #232220;
      --surface-3: #2c2a27;
      --line: #2a2825;
      --line-strong: #3a3733;
      --fg: #ecebe7;
      --fg-muted: #a39e94;
      --fg-faint: #6e6961;
      --accent: #e85f64;
      --accent-hover: #f0787c;
      --accent-soft: rgb(232 95 100 / 0.10);
      --on-fill: #131211;
      --success: #4cc38a;
      --success-soft: rgb(76 195 138 / 0.14);
      --warning: #f0a04b;
      --warning-soft: rgb(240 160 75 / 0.14);
      --danger: #f26d72;
      --danger-soft: rgb(242 109 114 / 0.14);
      --shadow-overlay: 0 16px 48px -16px rgb(0 0 0 / 0.7), 0 1px 3px rgb(0 0 0 / 0.4);
      --shadow-popover: 0 10px 32px -12px rgb(0 0 0 / 0.65), 0 1px 2px rgb(0 0 0 / 0.4);
      --shadow-sheet: -12px 0 48px -16px rgb(0 0 0 / 0.7);
    }

L'accent rouge est celui de heig-classroom. Tu peux proposer UNE variante d'accent (par ex. un bleu-vert profond) dans un commentaire CSS, mais livre avec le rouge par défaut.

## Livraison
- Fichiers dans `/mnt/c/Users/canard/Dropbox/work/heig-vd/projects/quiz/mockups/`, noms imposés dans ta tâche.
- En haut de chaque fichier, un commentaire HTML de 3 lignes : écran, scénario, choix de design notables.
- Pas de lorem ipsum : contenu réaliste (cours "Programmation C", "Électronique", questions crédibles).
- Vérifie ton HTML en le relisant : balises fermées, contraste correct en clair et en sombre.
- Ne modifie rien en dehors de `mockups/`.
