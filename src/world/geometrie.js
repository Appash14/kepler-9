// Géométrie commune du monde : planète, plan des anneaux, course du soleil.
// Tout est calculé une fois au démarrage à partir de config.js, puis partagé par les modules.
import * as THREE from 'three';
import { PLANETE, SOLEIL } from '../config.js';

const DEG = Math.PI / 180;

export function creerGeometrie() {
  const C = new THREE.Vector3().fromArray(PLANETE.centre);
  const R = PLANETE.rayon;
  // d : du centre de la planète vers la station (origine)
  const d = C.clone().negate().normalize();
  // Plan des anneaux : même construction que l'aperçu Cycles du lot A (blender/scripts/rendu_haltes.py),
  // pour que les vues cadrées dans Blender retrouvent ici la même géante : pôle incliné de `pole`
  // degrés dans le plan Y-Z, puis roulis autour de d. La station passe environ 150 m au-dessus du plan.
  const pole = PLANETE.pole * DEG;
  const n0 = new THREE.Vector3(0, Math.cos(pole), -Math.sin(pole));
  const normale = n0.clone().applyAxisAngle(d, PLANETE.roulis * DEG).normalize();
  const Y = new THREE.Vector3(0, 1, 0);

  const geo = {
    C, R, d, normale,
    rInt: PLANETE.anneauInt * R,
    rExt: PLANETE.anneauExt * R,
    // axe de la course du soleil : L(phi) = -d cos(phi) + e sin(phi). Fixé plus tard par l'observatoire.
    e: new THREE.Vector3(-1, 0.35, 0).addScaledVector(d, -new THREE.Vector3(-1, 0.35, 0).dot(d)).normalize(),
    rayonSoleil: SOLEIL.rayonDeg * DEG,
    // angle de soleil résolu pour les haltes qui en ont besoin
    phiResolu: {},
  };

  geo.soleil = (phi, out = new THREE.Vector3()) =>
    out.copy(geo.d).multiplyScalar(-Math.cos(phi)).addScaledVector(geo.e, Math.sin(phi)).normalize();

  // Distance (en m) d'un point au plan des anneaux, positive du côté de la station.
  geo.hauteurPlan = (P) => _v.copy(P).sub(geo.C).dot(geo.normale);
  // Projeté d'un point sur le plan des anneaux.
  geo.projettePlan = (P, out = new THREE.Vector3()) => out.copy(P).addScaledVector(geo.normale, -geo.hauteurPlan(P));

  // Fraction visible du soleil depuis un point (occultation par la planète), 0 à 1.
  geo.visibiliteSoleil = (P, L) => {
    _v.copy(geo.C).sub(P);
    const dist = _v.length();
    const ang = Math.acos(THREE.MathUtils.clamp(_v.dot(L) / dist, -1, 1));
    const rp = Math.asin(Math.min(1, R / dist));
    const rs = geo.rayonSoleil;
    return THREE.MathUtils.clamp((ang - (rp - rs)) / (2 * rs), 0, 1);
  };

  // Angle phi pour lequel la fraction visible du soleil vaut f, vu depuis P,
  // en cherchant du côté où phi est de même signe que `signe`.
  geo.resoudrePhi = (P, f, signe) => {
    let a = 0, b = Math.PI * 0.75 * signe;
    const L = new THREE.Vector3();
    const g = (phi) => geo.visibiliteSoleil(P, geo.soleil(phi, L)) - f;
    for (let i = 0; i < 48; i++) {
      const m = (a + b) / 2;
      if (g(m) > 0) b = m; else a = m;
    }
    return (a + b) / 2;
  };

  // Lumière de la planète vue de la station : fraction éclairée du disque.
  geo.phase = (L) => 0.5 * (1 + L.dot(geo.d));

  return geo;
}

const _v = new THREE.Vector3();
