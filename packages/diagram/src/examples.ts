/**
 * One example scene per kind, the ones of `mockups/uml.html`: the round-trip
 * tests run on them, the seed and the gallery show them.
 */
import type { DiagramKind } from "./kinds.js";
import type { DiagramLink, DiagramNode, Scene } from "./scene.js";

type NodeInit = Omit<DiagramNode, "id" | "t" | "x" | "y">;
type LinkInit = Omit<DiagramLink, "id" | "type" | "a" | "b">;

/** A small builder: ids are `n001`, `n002`… and `l001`, `l002`…, opaque enough for an example. */
function build(fill: (node: (t: DiagramNode["t"], x: number, y: number, o?: NodeInit) => string, link: (type: DiagramLink["type"], a: string, b: string, o?: LinkInit) => void) => void): Scene {
  const scene: Scene = { nodes: [], links: [] };
  fill(
    (t, x, y, o = {}) => {
      const id = `n${String(scene.nodes.length + 1).padStart(3, "0")}`;
      scene.nodes.push({ id, t, x, y, ...o });
      return id;
    },
    (type, a, b, o = {}) => {
      scene.links.push({ id: `l${String(scene.links.length + 1).padStart(3, "0")}`, type, a, b, ...o });
    },
  );
  return scene;
}

export const EXAMPLES: Readonly<Record<DiagramKind, Scene>> = {
  class: build((node, link) => {
    const forme = node("class", 380, 20, { name: "Forme", stereo: "interface", body: ["+ aire() : double", "+ perimetre() : double"] });
    const figure = node("class", 320, 220, {
      name: "Figure",
      abstract: true,
      body: ["# couleur : Couleur", "# origine : Point", "---", "+ deplacer(dx : double, dy : double) : void", "+ aire() : double {abstract}"],
    });
    const cercle = node("class", 180, 460, { name: "Cercle", body: ["- rayon : double", "---", "+ aire() : double", "+ perimetre() : double"] });
    const rect = node("class", 520, 460, {
      name: "Rectangle",
      body: ["- largeur : double", "- hauteur : double", "---", "+ aire() : double", "+ perimetre() : double"],
    });
    const couleur = node("class", 820, 240, { name: "Couleur", stereo: "enumeration", body: ["ROUGE", "VERT", "BLEU"] });
    const dessin = node("class", -60, 200, {
      name: "Dessin",
      body: ["- titre : String", "---", "+ ajouter(f : Forme) : void", "+ vide() : Dessin {static}"],
    });
    link("impl", figure, forme);
    link("inh", cercle, figure);
    link("inh", rect, figure);
    link("nav", figure, couleur, { mb: "1" });
    link("comp", forme, dessin, { ma: "0..*", mb: "1", name: "contient" });
  }),
  usecase: build((node, link) => {
    node("system", 240, 20, { name: "Boutique en ligne", w: 480, h: 440 });
    const client = node("actor", 100, 120, { name: "Client" });
    const membre = node("actor", 100, 320, { name: "Membre" });
    const gestion = node("actor", 820, 60, { name: "Gestionnaire" });
    const catalogue = node("usecase", 280, 60, { name: "Consulter le catalogue" });
    const commande = node("usecase", 280, 200, { name: "Passer une commande" });
    const identifier = node("usecase", 520, 320, { name: "S'identifier" });
    const promo = node("usecase", 280, 360, { name: "Appliquer un code promo" });
    const produits = node("usecase", 520, 60, { name: "Gérer les produits" });
    link("assoc", client, catalogue);
    link("assoc", client, commande);
    link("inh", membre, client);
    link("assoc", gestion, produits);
    link("incl", commande, identifier);
    link("incl", produits, identifier);
    link("ext", promo, commande);
  }),
  state: build((node, link) => {
    const initial = node("initial", 60, 120);
    const fermee = node("state", 180, 120, { name: "Fermée" });
    const ouverte = node("state", 480, 0, { name: "Ouverte", body: ["entry / allumer la lampe", "exit / éteindre la lampe"] });
    const verrouillee = node("state", 480, 220, { name: "Verrouillée" });
    const final = node("final", 760, 220);
    link("strans", initial, fermee);
    link("strans", fermee, ouverte, { name: "ouvrir" });
    link("strans", ouverte, fermee, { name: "fermer" });
    link("strans", fermee, verrouillee, { name: "verrouiller [code ok]" });
    link("strans", verrouillee, fermee, { name: "déverrouiller [code ok]" });
    link("strans", verrouillee, final, { name: "mise hors service" });
  }),
  er: build((node, link) => {
    const client = node("entity", 20, 40, { name: "Client", body: ["id : int PK", "nom : string", "email : string"] });
    const commande = node("entity", 360, 40, { name: "Commande", body: ["numero : int PK", "date : date", "client_id : int FK"] });
    const ligne = node("entity", 360, 280, {
      name: "LigneCommande",
      body: ["commande_id : int PK FK", "produit_ref : string PK FK", "quantite : int"],
    });
    const produit = node("entity", 760, 280, { name: "Produit", body: ["ref : string PK", "libelle : string", "prix : decimal"] });
    link("erel", client, commande, { ma: "1", mb: "0..*", name: "passe" });
    link("erel", commande, ligne, { ma: "1", mb: "1..*", name: "contient" });
    link("erel", produit, ligne, { ma: "1", mb: "0..*", name: "figure dans" });
  }),
  flow: build((node, link) => {
    const debut = node("terminal", 340, 20, { name: "Début" });
    const lire = node("action", 340, 100, { name: "Lire n" });
    const init = node("action", 340, 180, { name: "f ← 1 ; i ← 1" });
    const test = node("decision", 340, 260, { name: "i ≤ n ?" });
    const mul = node("action", 340, 400, { name: "f ← f × i" });
    const inc = node("action", 340, 480, { name: "i ← i + 1" });
    const affiche = node("action", 540, 280, { name: "Afficher f" });
    const fin = node("terminal", 540, 380, { name: "Fin" });
    link("flow", debut, lire);
    link("flow", lire, init);
    link("flow", init, test);
    link("flow", test, mul, { name: "oui" });
    link("flow", mul, inc);
    link("flow", inc, test, { via: [{ x: 260, y: 500 }, { x: 260, y: 300 }] });
    link("flow", test, affiche, { name: "non" });
    link("flow", affiche, fin);
  }),
  automaton: build((node, link) => {
    /* the words over {a, b} that end with ab */
    const q0 = node("astate", 120, 160, { name: "q0", initial: true });
    const q1 = node("astate", 320, 160, { name: "q1" });
    const q2 = node("astate", 520, 160, { name: "q2", accept: true });
    link("trans", q0, q0, { name: "b" });
    link("trans", q0, q1, { name: "a" });
    link("trans", q1, q1, { name: "a" });
    link("trans", q1, q2, { name: "b" });
    link("trans", q2, q1, { name: "a" });
    link("trans", q2, q0, { name: "b", via: [{ x: 340, y: 300 }] });
  }),
  graph: build((node, link) => {
    const [a, b, c, d, e, f] = (
      [
        ["A", 100, 160],
        ["B", 300, 60],
        ["C", 300, 280],
        ["D", 500, 60],
        ["E", 500, 280],
        ["F", 700, 160],
      ] as const
    ).map(([name, x, y]) => node("vertex", x, y, { name }));
    for (const [p, q, w] of [
      [a, b, "4"],
      [a, c, "2"],
      [b, c, "1"],
      [b, d, "5"],
      [c, d, "8"],
      [c, e, "10"],
      [d, e, "2"],
      [d, f, "6"],
      [e, f, "3"],
    ] as const)
      link("edge", p ?? "", q ?? "", { name: w });
  }),
  free: build((node) => {
    node("triangle", 200, 80, { w: 200, h: 100 });
    node("rect", 220, 180, { w: 160, h: 140, name: "Maison" });
    node("square", 230, 200, { w: 40, h: 40 });
    node("rect", 320, 260, { w: 40, h: 60 });
    node("circle", 520, 60, { w: 60, h: 60 });
    node("line", 100, 320, { w: 540, h: 1, pts: [[0, 0], [540, 0]] });
    node("stroke", 350, 40, { w: 16, h: 70, pts: [[0, 70], [8, 56], [2, 42], [12, 28], [6, 14], [16, 0]] });
  }),
};
