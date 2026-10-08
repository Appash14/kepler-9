// Configuration de la démo « Kepler-9 » : une seule source pour la planète, les haltes,
// leurs ambiances et les trajets entre elles. Tout le reste du code lit ce fichier.

// La géante gazeuse, ses anneaux et le soleil sont faits en code (voir world/).
// Repère three.js : Y en haut, unités en mètres, centre du moyeu à l'origine.
export const PLANETE = {
  centre: [0, -2600, -3000],
  rayon: 2000,
  anneauInt: 1.32, // rayon intérieur des anneaux, en rayons de planète (2 640 m, comme l'aperçu du lot A)
  anneauExt: 2.2, // rayon extérieur (4 400 m)
  // Orientation du plan des anneaux (identique à l'aperçu Cycles du lot A) :
  // inclinaison du pôle dans le plan Y-Z, puis roulis autour de l'axe centre-station (degrés).
  pole: 38.7,
  roulis: 15,
  // vitesse de rotation des bandes (radians par seconde à l'équateur)
  rotation: 0.0016,
};

export const SOLEIL = {
  rayonDeg: 0.8, // rayon apparent du disque, volontairement plus grand que nature
  // fraction du disque déjà sortie derrière le bord de la planète, à l'arrivée au lever
  leverSortie: 0.45,
  // fraction encore visible à l'observatoire (coucher)
  coucherReste: 0.55,
};

export const ANNEAU_HABITE = {
  periode: 45, // secondes pour un tour complet
};

// Les dix haltes. `pose: 'auto'` = cadrage calculé par le site (planète et soleil sont en code) ;
// sinon la caméra se place sur l'Empty cam_<id> et regarde ancre_<id> du glb.
// soleil : angle (degrés) du soleil sur sa course ; au-dessous d'environ 30°, il est caché par la géante.
// 'obs' et 'lever' : angle résolu au chargement pour que le soleil touche le bord de la planète.
// Lot G : depuis la lumière précalculée, les intérieurs (moyeu, anneau, serre, réacteur) ont moins de
// brume et de lumière d'ambiance ; contreJour = lumière chaude venue de derrière la station (vues
// extérieures, voir app.js).
export const HALTES = [
  {
    id: 'approche', carte: 'gauche', fov: 38, contreJour: 2.2,
    soleil: 140, expo: 1.0, soleilForce: 1.0, ciel: 0.35, brume: ['#0b1222', 0],
    bloom: 0.75, teinte: [1.0, 0.99, 0.97], sat: 1.1,
  },
  {
    id: 'anneaux', pose: 'auto', carte: 'droite', fov: 56, contreJour: 1.8,
    soleil: 134, expo: 1.05, soleilForce: 1.0, ciel: 0.85, brume: ['#18140f', 0],
    bloom: 0.9, teinte: [1.0, 0.98, 0.95], sat: 1.05,
  },
  {
    id: 'quai', carte: 'gauche', fov: 42, contreJour: 2.0,
    soleil: 126, expo: 1.0, soleilForce: 0.95, ciel: 0.4, brume: ['#121826', 0],
    bloom: 0.95, teinte: [1.0, 0.98, 0.96], sat: 1.0,
    lampes: [{ ou: 'ancre', decal: [0, 6, -10], couleur: '#ffb35c', force: 160, portee: 45 }],
  },
  {
    id: 'moyeu', carte: 'droite', fov: 66, interieur: true,
    soleil: 120, expo: 1.1, soleilForce: 0.6, ciel: 0.58, brume: ['#1a2233', 0.0026],
    bloom: 1.0, teinte: [0.96, 0.99, 1.04], sat: 0.95,
    lampes: [{ ou: 'ancre', decal: [0, 0, 0], couleur: '#ffd9a8', force: 160, portee: 40 }],
  },
  {
    id: 'anneau', carte: 'gauche', fov: 60, corotation: true,
    // lot F : travelling resserré (sur la grille de 1 m, l'orbite de 9° faisait entrer l'objectif dans les façades)
    travelling: { orbite: 3.5, pousse: 0.04, grue: 1.0, periode: 30 },
    soleil: 114, expo: 1.02, soleilForce: 0.9, ciel: 0.3, brume: ['#2a2a2c', 0.002],
    bloom: 0.95, teinte: [1.02, 1.0, 0.97], sat: 1.02,
    lampes: [{ ou: 'ancre', decal: [0, 0, 0], couleur: '#ffcf96', force: 170, portee: 60 }],
  },
  {
    id: 'serre', carte: 'droite', fov: 62, interieur: true,
    soleil: 106, expo: 1.02, soleilForce: 0.85, ciel: 0.32, brume: ['#3b2a18', 0.006],
    bloom: 0.9, teinte: [1.05, 1.0, 0.92], sat: 1.06,
    lampes: [{ ou: 'ancre', decal: [0, 0, 0], couleur: '#ffbe7a', force: 150, portee: 40 }],
  },
  {
    id: 'forge', carte: 'gauche', fov: 50, interieur: true,
    soleil: 74, expo: 0.98, soleilForce: 0.35, ciel: 0.3, brume: ['#2a140a', 0.015],
    bloom: 1.25, teinte: [1.06, 0.97, 0.9], sat: 1.08,
    lampes: [{ ou: 'noyau', decal: [0, 0, 0], couleur: '#ff7a2a', force: 700, portee: 60 }],
  },
  {
    id: 'observatoire', carte: 'gauche', fov: 54,
    // lot F : dans la coupole, travelling d'intérieur (l'orbite de 9° frôlait la monture du télescope)
    travelling: { orbite: 2.5, pousse: 0.03, grue: 0.6, periode: 26 },
    soleil: 'obs', expo: 1.0, soleilForce: 1.0, ciel: 0.35, brume: ['#120f12', 0],
    bloom: 1.0, teinte: [1.04, 0.99, 0.94], sat: 1.04,
    lampes: [{ ou: 'ancre', decal: [0, -6, 0], couleur: '#ffb35c', force: 160, portee: 30 }],
  },
  {
    id: 'antennes', carte: 'gauche', fov: 46, contreJour: 0.7,
    // travelling dans l'autre sens : dans le sens par défaut, la caméra frôle une parabole vers 48 s
    travelling: { orbite: 9, pousse: 0.07, grue: 1.5, periode: 30, sens: -1 },
    // lot H : la halte de nuit (le lot G l'avait éclaircie) : ciel et contre-jour bas, lumière chaude localisée
    // (cornets des paraboles, cuits dans l'atlas, et la lampe de la halte), étalonnage froid autour
    soleil: 9, expo: 0.92, soleilForce: 0.0, ciel: 0.12, brume: ['#070b16', 0],
    bloom: 1.3, teinte: [0.93, 0.98, 1.08], sat: 1.03,
    lampes: [{ ou: 'ancre', decal: [0, 6, 0], couleur: '#ffb35c', force: 250, portee: 26 }],
  },
  {
    id: 'lever', pose: 'auto', carte: 'droite', fov: 34, contreJour: 1.0,
    soleil: 'lever', expo: 0.95, soleilForce: 1.0, ciel: 0.3, brume: ['#070b16', 0],
    bloom: 1.15, teinte: [1.03, 0.99, 0.95], sat: 1.05,
  },
];

export const INDEX = Object.fromEntries(HALTES.map((h, i) => [h.id, i]));

// Trajets entre haltes voisines (le sens inverse rejoue la même courbe à l'envers).
// type : plongee | remontee | recul (trajets au large) | rail (près de la station) ; duree en secondes.
// Rails (lot F) : clés en coordonnées cylindriques autour de l'axe de la station (r et z en mètres,
// a en degrés ; repere 'anneau' = dans le repère de l'anneau habité, qui tourne). Les clés sans visée
// prennent une orientation interpolée entre leurs voisines. Tracées sur les plans de la station pour
// garder plusieurs mètres de marge (tests/marge.py, tests/camera.py) ; voir engine/rig.js.
export const TRAJETS = {
  'approche>anneaux': { type: 'plongee', duree: 7.6, fovMilieu: 14 },
  'anneaux>quai': { type: 'remontee', duree: 7.2, fovMilieu: 10 },
  // du large vers le moyeu : au-dessus de la poutre des panneaux, puis entre les panneaux et l'anneau
  'quai>moyeu': { type: 'rail', duree: 7.2, cles: [
    { r: 24, a: 26, z: 72 }, { r: 34, a: 20, z: 32 }, { r: 32.5, a: 11, z: 17 },
  ] },
  // moyeu vers rue de l'anneau (lot H, Tom : « le demi-tour ») : type « tour », l'anneau du côté d'arrivée.
  // Au moyeu, la caméra a l'axe de la station sur sa gauche ; dans la rue, sur sa droite : un demi-tour est
  // inévitable, il se fait en lacet pur (sans roulis), sur place, avant tout le reste : la caméra se détourne du
  // moyeu en regardant le long de l'épine, puis vers l'anneau. Puis elle se cale sur la rotation de l'anneau
  // en regardant la verrière (cette orbite est un tangage, le haut le long de l'anneau), et plonge dans la
  // rue par un passage dégagé de la verrière, côté moyeu (quatre clés alignées, tube libre de 0,6 m), en se
  // redressant le long de la rue.
  'moyeu>anneau': { type: 'tour', anneau: 'haut', duree: 14, dureeTour: 7.5, liberation: [0.2, 0.55],
    poids: { position: 0.4, visee: 30, haut: 12 }, cles: [
    { p: [32.6, 3.1, 8.2], vue: [0.235, 0.0, -0.972], haut: [-0.061, 0.998, -0.015], monde: true },
    { p: [34.2, 3.25, 9.0], vue: [0.996, 0.095, 0], haut: [-0.095, 0.996, 0], monde: true },
    { p: [-7.59, -34.85, 9.93], vue: [-0.213, -0.977, 0.0], haut: [0.977, -0.213, 0.0] },
    { p: [-5.28, -40.8, 7.06], vue: [0.385, -0.923, 0.0], haut: [0.923, 0.385, 0.0] },
    { p: [-2.97, -46.75, 4.19], vue: [0.833, -0.554, 0.0], haut: [0.554, 0.833, 0.0] },
    { p: [-0.99, -51.85, 1.73], vue: [0.994, -0.106, 0.0], haut: [0.106, 0.994, 0.0] },
  ] },
  // rue de l'anneau vers serre (lot H, Tom : « la caméra bouge n'importe comment ») : type « tour », voir
  // engine/rig.js. Tracé dans le repère plan (anneau à l'angle 0), solidaire de l'anneau au départ :
  // on monte par la verrière dans l'axe du seul passage dégagé (quatre clés alignées) en tournant le regard
  // vers la droite puis vers le moyeu (lacet puis tangage, sans roulis) ; libérée de l'anneau, la caméra
  // orbite autour de la tour (le haut le long de l'axe : la rotation autour de l'axe est un lacet) en
  // montant derrière le plan des rayons ; puis elle plonge dans la serre par son couloir dégagé de 40 m
  // (lancer de rayons, tube de 0,6 m), en travelling avant, dans l'axe de sa visée à 20° près.
  'anneau>serre': { type: 'tour', duree: 13, dureeTour: 6, liberation: [0.52, 0.75], cles: [
    { p: [-0.83, -52.27, -0.52], vue: [0.859, 0.205, 0.469], haut: [-0.237, 0.972, 0.009] },
    { p: [-1.82, -49.73, -1.75], vue: [0.488, 0.111, 0.866], haut: [-0.237, 0.972, 0.009] },
    { p: [-2.81, -47.17, -2.98], vue: [0.121, 0.02, 0.992], haut: [-0.237, 0.972, 0.009] },
    { p: [-3.8, -44.62, -4.21], vue: [-0.039, 0.3, 0.953], haut: [-0.236, 0.924, -0.3] },
    { p: [-4.95, -41.65, -5.65], vue: [-0.142, 0.687, 0.713], haut: [-0.193, 0.687, -0.7] },
    { p: [-6.27, -38.25, -7.29], vue: [-0.214, 0.924, 0.317], haut: [-0.108, 0.301, -0.948] },
    { p: [-7.59, -34.85, -8.93], vise: 'axe', haut: [0, 0, -1] },
    { p: [-6.49, -29.8, -14], vise: 'axe', haut: [0, 0, -1] },
    { p: [-5.96, -27.36, -19.5], vise: 'axe', haut: [0, 0, -1] },
    { p: [-5.7, -26.19, -24.5], vise: 'axe', haut: [0, 0, -1] },
    { p: [-16.95, 20.28, -28.62], monde: true },
    { p: [-15.41, 15.65, -32.11], vue: [-0.081, -0.854, -0.513], haut: [-0.134, 0.519, -0.844], monde: true },
    { p: [-12.32, 6.4, -39.1], vue: [-0.081, -0.854, -0.513], haut: [-0.134, 0.519, -0.844], monde: true },
    { p: [-9.24, -2.85, -46.08], vue: [-0.081, -0.854, -0.513], haut: [-0.134, 0.519, -0.844], monde: true },
  ] },
  // serre vers réacteur : sortie par le côté gauche de la serre (le passage le plus dégagé, quatre clés
  // alignées), on contourne le moyeu par la gauche et on descend sur le réacteur par le haut, dans un
  // axe dégagé (quatre clés alignées)
  'serre>forge': { type: 'rail', duree: 9.0, cles: [
    { r: 15.38, a: -138.91, z: -52.65 }, { r: 20.77, a: -152.85, z: -53.7 }, { r: 29.6, a: -163.15, z: -55.19 },
    { r: 31, a: 180, z: -72 }, { r: 32, a: 140, z: -82 },
    { r: 30.62, a: 113.93, z: -87.81 }, { r: 25.15, a: 114.2, z: -92.16 }, { r: 20.46, a: 114.55, z: -95.89 },
  ] },
  // réacteur vers observatoire : on monte au-dessus du réacteur, on passe par-dessus les radiateurs,
  // puis on descend dans la coupole à reculons, dans l'axe de la visée (quatre clés alignées)
  'forge>observatoire': { type: 'rail', duree: 8.5, cles: [
    { r: 25.3, a: 99.1, z: -95 }, { r: 29.5, a: 61.7, z: -85 },
    { r: 33.58, a: 21.85, z: -67.44 }, { r: 29.61, a: 13.22, z: -70.72 }, { r: 26.88, a: 3.97, z: -73.52 },
  ] },
  // observatoire vers pont radio : on sort de la coupole à reculons dans l'axe de la visée, puis on se
  // retourne vers les paraboles
  'observatoire>antennes': { type: 'rail', duree: 8.0, cles: [
    { r: 26.88, a: 3.97, z: -73.52 }, { r: 29.61, a: 13.22, z: -70.72 }, { r: 33.58, a: 21.85, z: -67.44 },
    { r: 26, a: 30, z: -62 },
  ] },
  'antennes>lever': { type: 'recul', duree: 8.4, fovMilieu: -4 },
};

// Niveaux de qualité (choisis au démarrage, puis résolution dynamique).
// msaa : échantillons demandés pour le tampon de scène (ramenés à ce que le GPU accepte, 0 sinon) ;
// le SMAA reste actif partout, téléphones compris : sans lui, les arêtes fines scintillaient.
export const NIVEAUX = {
  high: { detailPlanete: 1, dpr: 1.75, cube: 1536, ciel: 256, debris: 2600, poussiere: 6000, etoiles: 5200, bloomNiveaux: 5, smaa: true, msaa: 4, grain: true, sphere: [192, 128] },
  mid: { detailPlanete: 0.8, dpr: 1.5, cube: 1024, ciel: 192, debris: 1500, poussiere: 3500, etoiles: 3800, bloomNiveaux: 5, smaa: true, msaa: 4, grain: true, sphere: [160, 112] },
  low: { detailPlanete: 0, dpr: 1.25, cube: 640, ciel: 128, debris: 800, poussiere: 1800, etoiles: 2600, bloomNiveaux: 5, smaa: true, msaa: 4, grain: false, sphere: [128, 96] },
};
