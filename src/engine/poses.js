// Les poses de caméra de chaque halte, et la direction du soleil à chaque halte.
// - Haltes de la station : la caméra se place sur le vide cam_<id> du glb et regarde ancre_<id>.
//   Le « haut » est vertical (Y), comme dans les aperçus Cycles du lot A ; pour l'espace réservé, c'est
//   l'axe Y local du vide. À l'anneau habité, la pose tourne avec l'anneau : la rue reste en place et
//   le ciel défile.
// - Deux haltes sont cadrées par le site, parce que les anneaux et le soleil sont faits en code :
//   « anneaux » (caméra dans la couche de blocs, sous la station) et « lever » (contre-jour, soleil
//   au ras du bord de la géante et au-dessus du plan des anneaux, donc jamais caché par eux).
// - Soleil : il suit un grand cercle qui le fait se coucher sur le bord de la planète que regarde
//   l'observatoire, passe derrière la géante pendant le pont radio, puis ressort au lever.
import * as THREE from 'three';
import { SOLEIL } from '../config.js';

export class Pose {
  constructor() {
    this.pos = new THREE.Vector3();
    this.cible = new THREE.Vector3();
    this.haut = new THREE.Vector3(0, 1, 0);
    this.fov = 50;
  }
  copy(p) { this.pos.copy(p.pos); this.cible.copy(p.cible); this.haut.copy(p.haut); this.fov = p.fov; return this; }
}

const MODULES = { quai: 'quai', moyeu: 'moyeu', anneau: 'anneau_rotatif', serre: 'serre', forge: 'forge', observatoire: 'observatoire', antennes: 'antennes', approche: 'station' };
const DEG = Math.PI / 180;

// point du bord de la planète (vu depuis P) le plus proche de la direction v, avec L·n >= nMin
function bordVers(geo, P, v, nMin, marge) {
  const c = geo.C.clone().sub(P);
  const dist = c.length(); c.normalize();
  const rp = Math.asin(geo.R / dist) + marge;
  let t = v.clone().addScaledVector(c, -v.dot(c));
  if (t.lengthSq() < 1e-8) t = new THREE.Vector3(0, 1, 0).addScaledVector(c, -c.y);
  t.normalize();
  const u = t, w = new THREE.Vector3().crossVectors(c, u).normalize();
  const point = (psi) => c.clone().multiplyScalar(Math.cos(rp)).addScaledVector(u.clone().multiplyScalar(Math.cos(psi)).addScaledVector(w, Math.sin(psi)), Math.sin(rp));
  let L = point(0);
  if (L.dot(geo.normale) < nMin) {
    // on glisse le long du bord vers le haut jusqu'à passer au-dessus du plan des anneaux
    let best = null;
    for (let k = 1; k <= 180; k++) {
      for (const s of [1, -1]) {
        const q = point(s * k * DEG);
        if (q.dot(geo.normale) >= nMin) { best = q; break; }
      }
      if (best) break;
    }
    if (best) L = best;
  }
  return L.normalize();
}

// Point du bord le plus proche de `visee`, au-dessus du plan des anneaux, dans le champ de la caméra et
// non masqué par la station (grille d'occupation). Renvoie null si aucun ne convient.
function bordVisible(geo, P, v, visee, demiChamp, nMin, occupation) {
  const c = geo.C.clone().sub(P);
  const dist = c.length(); c.normalize();
  const rp = Math.asin(geo.R / dist);
  const u = new THREE.Vector3(0, 1, 0).addScaledVector(c, -c.y);
  if (u.lengthSq() < 1e-6) u.set(1, 0, 0).addScaledVector(c, -c.x);
  u.normalize();
  const w = new THREE.Vector3().crossVectors(c, u).normalize();
  let meilleur = null, score = Infinity;
  const L = new THREE.Vector3();
  for (let k = 0; k < 120; k++) {
    const psi = (k / 120) * Math.PI * 2;
    L.copy(c).multiplyScalar(Math.cos(rp)).addScaledVector(u, Math.cos(psi) * Math.sin(rp)).addScaledVector(w, Math.sin(psi) * Math.sin(rp)).normalize();
    if (L.dot(geo.normale) < nMin) continue;
    if (Math.acos(THREE.MathUtils.clamp(L.dot(v), -1, 1)) > demiChamp) continue;
    if (occupation && occupation.rayon(P, L, 400, 1.5) < Infinity) continue;
    const sc = Math.acos(THREE.MathUtils.clamp(L.dot(visee), -1, 1));
    if (sc < score) { score = sc; meilleur = L.clone(); }
  }
  return meilleur;
}

export function calculerPoses(station, geo, haltes, { hautDuVide, occupation }) {
  const S0 = station.centre;
  const n = geo.normale;
  const f = {};
  const q = new THREE.Quaternion(), qr = new THREE.Quaternion();
  const Y = new THREE.Vector3(0, 1, 0);
  const sources = {};

  for (const h of haltes) {
    if (h.pose === 'auto') continue;
    const cam = station.trouve('cam_' + h.id), ancre = station.trouve('ancre_' + h.id);
    if (cam && ancre) {
      const tourne = h.corotation && !station.dansAnneau(cam);
      // champ vertical suggéré par Blender (extras du vide), sinon celui de config.js
      const fovVide = cam.userData && Number(cam.userData.fov);
      const fov = fovVide > 10 && fovVide < 120 ? fovVide : h.fov;
      sources[h.id] = tourne ? 'glb, tourne avec l’anneau' : 'glb';
      f[h.id] = (out) => {
        cam.getWorldPosition(out.pos);
        ancre.getWorldPosition(out.cible);
        if (hautDuVide) { cam.getWorldQuaternion(q); out.haut.set(0, 1, 0).applyQuaternion(q); } else out.haut.copy(Y);
        if (tourne) {
          qr.setFromAxisAngle(station.axeAnneau, station.angleAnneau);
          out.pos.applyQuaternion(qr); out.cible.applyQuaternion(qr); out.haut.applyQuaternion(qr);
        }
        out.fov = fov;
        return out;
      };
    } else {
      const grp = station.trouve(MODULES[h.id] || h.id);
      const b = grp ? new THREE.Box3().setFromObject(grp) : null;
      const c = b && !b.isEmpty() ? b.getCenter(new THREE.Vector3()) : S0.clone();
      const r = b && !b.isEmpty() ? b.getSize(new THREE.Vector3()).length() / 2 : 40;
      const dir = c.clone().sub(S0).add(new THREE.Vector3(0.4, 0.5, 0.7).multiplyScalar(r)).normalize();
      const p = c.clone().addScaledVector(dir, Math.max(12, r * (h.id === 'approche' ? 6 : 2.1)));
      sources[h.id] = 'repli (module)';
      f[h.id] = (out) => { out.pos.copy(p); out.cible.copy(c); out.haut.copy(Y); out.fov = h.fov; return out; };
    }
  }

  // ---- les anneaux : dans la couche de blocs, sous la station, face à la géante
  const hR = haltes.find((x) => x.id === 'anneaux');
  const pied = geo.projettePlan(S0);
  const radial = pied.clone().sub(geo.C).normalize();
  const tang = new THREE.Vector3().crossVectors(n, radial).normalize();
  const centreDebris = pied.clone().addScaledVector(radial, 120).addScaledVector(tang, 210);
  {
    const p = centreDebris.clone().addScaledVector(n, 7);
    const vs = S0.clone().sub(p).normalize();
    const vc = geo.C.clone().sub(p).normalize();
    const c = p.clone().addScaledVector(vs.clone().lerp(vc, 0.45).normalize(), 900);
    sources.anneaux = 'site (dans le plan des anneaux)';
    f.anneaux = (out) => { out.pos.copy(p); out.cible.copy(c); out.haut.copy(n); out.fov = hR.fov; return out; };
  }

  // ---- soleil : coucher sur le bord que regarde l'observatoire, au-dessus du plan des anneaux
  const po = new Pose();
  let Lobs;
  if (f.observatoire) {
    f.observatoire(po);
    const v = po.cible.clone().sub(po.pos).normalize();
    const hObs = haltes.find((x) => x.id === 'observatoire');
    const droite = new THREE.Vector3().crossVectors(v, Y).normalize();
    const cote = hObs && hObs.carte === 'droite' ? -1 : 1;
    const visee = v.clone().addScaledVector(droite, cote * 0.24).addScaledVector(Y, 0.06).normalize();
    const demiChamp = ((hObs ? hObs.fov : 50) * Math.PI / 360) * 0.85;
    Lobs = bordVisible(geo, po.pos, v, visee, demiChamp, 0.04, occupation)
      || bordVisible(geo, po.pos, v, visee, demiChamp * 1.6, 0.0, occupation)
      || bordVers(geo, po.pos, visee, 0.04, 0);
  } else {
    Lobs = geo.soleil(31 * DEG);
  }
  const md = geo.d.clone().negate();
  const e = Lobs.clone().addScaledVector(md, -Lobs.dot(md));
  if (e.lengthSq() > 1e-8) geo.e.copy(e.normalize());
  const phiObs = f.observatoire ? geo.resoudrePhi(po.pos, SOLEIL.coucherReste, 1) : 31 * DEG;

  // ---- le lever : contre-jour, soleil sur le bord opposé, au-dessus du plan des anneaux
  const hL = haltes.find((x) => x.id === 'lever');
  let Llev = geo.soleil(-34 * DEG);
  const P = new THREE.Vector3();
  const D = Math.max(700, station.rayon * 5.6);
  const hS = geo.hauteurPlan(S0);
  // direction caméra : à l'opposé du soleil, à environ 70 m au-dessus du plan des anneaux
  const versCam = (L) => {
    const w = L.clone().negate();
    w.addScaledVector(n, -w.dot(n));
    return w.normalize().multiplyScalar(Math.sqrt(Math.max(0.01, 1 - Math.pow((70 - hS) / D, 2)))).addScaledVector(n, (70 - hS) / D).normalize();
  };
  {
    const oppose = geo.e.clone().negate();
    for (let i = 0; i < 5; i++) {
      P.copy(S0).addScaledVector(versCam(Llev), D);
      const c = geo.C.clone().sub(P).normalize();
      const visee = c.clone().add(oppose.clone().multiplyScalar(0.7)).normalize();
      // une partie du disque déjà sortie, soleil juste au-dessus de la ligne des anneaux
      Llev = bordVers(geo, P, visee, 0.085, geo.rayonSoleil * (SOLEIL.leverSortie * 2 - 1));
    }
  }
  {
    P.copy(S0).addScaledVector(versCam(Llev), D);
    const cote = new THREE.Vector3().crossVectors(Llev, Y).normalize();
    const c = S0.clone().addScaledVector(Llev, 90).addScaledVector(cote, station.rayon * 0.25);
    const pL = P.clone();
    sources.lever = 'site (contre-jour)';
    f.lever = (out) => { out.pos.copy(pL); out.cible.copy(c); out.haut.copy(Y); out.fov = hL.fov; return out; };
  }
  // un peu plus loin sur sa course : le soleil continue de monter après l'arrivée
  const Lplus = Llev.clone().applyAxisAngle(new THREE.Vector3().crossVectors(md, Llev).normalize(), 3.5 * DEG);

  // direction du soleil de chaque halte
  const soleils = haltes.map((h) => {
    if (h.soleil === 'obs') return geo.soleil(phiObs);
    if (h.soleil === 'lever') return Llev.clone();
    return geo.soleil(h.soleil * DEG);
  });

  const pa = new Pose();
  const visee = f.antennes ? f.antennes(pa).cible.clone().sub(pa.pos).normalize() : null;
  return { f, soleils, Lplus, centreDebris, sources, viseeAntennes: visee };
}
