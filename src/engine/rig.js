// Le rig de caméra. La caméra n'est jamais animée à la main : à chaque image, une pose idéale est
// calculée (halte posée ou point du trajet en cours), puis lissée, puis on ajoute la respiration
// à l'arrêt et une légère parallaxe au pointeur.
import * as THREE from 'three';
import { Pose } from './poses.js';

const smoother = (x) => { x = Math.min(1, Math.max(0, x)); return x * x * x * (x * (x * 6 - 15) + 10); };
const ease = (x) => { x = Math.min(1, Math.max(0, x)); return x < 0.5 ? 4 * x * x * x : 1 - Math.pow(-2 * x + 2, 3) / 2; };
// part du trajet (à chaque bout) où un couloir d'entrée peut prendre la main
const COULOIR = 0.45;
// travelling à l'arrêt : orbite (degrés, aller-retour), poussée vers la cible (part de la distance),
// grue (degrés), période en secondes. Une halte peut fixer le sien dans config.js (`travelling`).
const TRAVELLING_EXTERIEUR = { orbite: 9, pousse: 0.07, grue: 1.5, periode: 30 };
const TRAVELLING_INTERIEUR = { orbite: 4, pousse: 0.035, grue: 0.8, periode: 26 };

function bezier(a, b, c, d, t, out) {
  const u = 1 - t;
  return out.set(0, 0, 0)
    .addScaledVector(a, u * u * u).addScaledVector(b, 3 * u * u * t)
    .addScaledVector(c, 3 * u * t * t).addScaledVector(d, t * t * t);
}

// Rails (lot F) : B-spline cubique serrée. Elle passe par la première et la dernière clé, a des dérivées
// première et seconde continues partout, et chaque tronçon reste dans l'enveloppe convexe de ses quatre
// clés : pas de dépassement (un rayon ou une hauteur ne sort jamais de l'intervalle des clés voisines), et
// quatre clés alignées donnent un tronçon parfaitement droit (sortie d'une serre ou d'une coupole par
// le seul passage dégagé). `ctrl` : tableaux de même longueur ; t dans [0, 1].
function bspline(t, ctrl, out) {
  const n = ctrl.length - 1, p = 3, m = n - p + 1;
  const noeud = (i) => (i <= p ? 0 : i > n ? 1 : (i - p) / m);
  const k = t >= 1 ? n : Math.min(n, p + Math.floor(Math.max(0, t) * m));
  const c = ctrl[0].length;
  for (let j = 0; j <= p; j++) { const src = ctrl[j + k - p]; for (let q = 0; q < c; q++) _deBoor[j][q] = src[q]; }
  for (let r = 1; r <= p; r++) {
    for (let j = p; j >= r; j--) {
      const i = j + k - p, a = (t - noeud(i)) / (noeud(i + 1 + p - r) - noeud(i));
      for (let q = 0; q < c; q++) _deBoor[j][q] = (1 - a) * _deBoor[j - 1][q] + a * _deBoor[j][q];
    }
  }
  for (let q = 0; q < c; q++) out[q] = _deBoor[p][q];
  return out;
}
const _deBoor = [0, 1, 2, 3].map(() => new Float64Array(12));
// loi horaire en S : vitesse ET accélération nulles aux deux bouts (pas d'à-coup au départ ni à l'arrivée)
const sCurve = (x) => smoother(x);

// rotation sphérique de a vers b ; si les vecteurs sont opposés, tourne autour de `repli`
function slerpVec(a, b, t, repli, out) {
  const d = THREE.MathUtils.clamp(a.dot(b), -1, 1);
  const ang = Math.acos(d);
  if (ang < 1e-4) return out.copy(b);
  let ax = _ax.crossVectors(a, b);
  if (ax.lengthSq() < 1e-8) ax = _ax.copy(repli);
  ax.normalize();
  return out.copy(a).applyAxisAngle(ax, ang * t);
}
const _ax = new THREE.Vector3();

// Couloirs d'entrée des haltes intérieures (serre, forge, moyeu). Pour chacune, la direction la plus
// proche de l'arrière de la visée par laquelle la caméra peut arriver en ligne droite sur `longueur`
// mètres sans traverser de pièce opaque (le verre ne compte pas, la navette non plus) : rayon central
// et quatre rayons parallèles décalés de `marge` (plan proche, montants fins). Lancer de rayons exact ;
// seules les pièces dont la boîte est atteinte avant `longueur` sont testées.
// Le calcul (quelques centaines de ms) ne retarde pas le chargement : `avancer(ms)` le fait par
// tranches pendant les premières secondes ; `obtenir(i)` le termine aussitôt pour une halte si un
// trajet en a besoin avant (arrivée directe par l'adresse, par exemple).
export function couloirsEntree(station, haltes, poseDe, { longueur = 40, marge = 0.6 } = {}) {
  let pieces = null;
  const rc = new THREE.Raycaster();
  rc.far = longueur;
  const P = new Pose(), V = new THREE.Vector3(), o1 = new THREE.Vector3(), o2 = new THREE.Vector3(), q = new THREE.Vector3(), e = new THREE.Vector3();
  const preparer = () => {
    if (pieces) return;
    pieces = [];
    station.groupe.updateMatrixWorld(true);
    station.groupe.traverse((o) => {
      if (!o.isMesh || !o.geometry) return;
      if (o.material && o.material.name === 'verre') return;
      for (let x = o; x; x = x.parent) if (x.name && (x.name.startsWith('verre_') || x.name === 'navette' || x.name === 'effets_station')) return;
      pieces.push({ mesh: o, boite: new THREE.Box3().setFromObject(o) });
    });
  };
  const libre = (origine, dir) => {
    rc.set(origine, dir);
    const proches = [];
    for (const p of pieces) if (rc.ray.intersectBox(p.boite, e) && e.distanceTo(origine) <= longueur) proches.push(p.mesh);
    return !proches.length || !rc.intersectObjects(proches, false).length;
  };
  // une halte : générateur qui rend la main après chaque direction essayée
  function* calcul(i) {
    preparer();
    poseDe(i, P);
    V.subVectors(P.cible, P.pos).normalize();
    const pos = P.pos.clone();
    const cands = [];
    const n = 200;
    for (let k = 0; k < n; k++) {
      const y = 1 - (2 * (k + 0.5)) / n, r = Math.sqrt(1 - y * y), phi = k * Math.PI * (3 - Math.sqrt(5));
      const dir = new THREE.Vector3(Math.cos(phi) * r, y, Math.sin(phi) * r);
      const c = -dir.dot(V);
      if (c > 0.17) cands.push({ dir, c });
    }
    cands.sort((a, b) => b.c - a.c);
    for (const { dir } of cands) {
      o1.set(Math.abs(dir.x) > 0.9 ? 0 : 1, Math.abs(dir.x) > 0.9 ? 1 : 0, 0).cross(dir).normalize();
      o2.crossVectors(dir, o1).normalize();
      let ok = true;
      for (const [a, b] of [[0, 0], [1, 0], [-1, 0], [0, 1], [0, -1]]) {
        q.copy(pos).addScaledVector(o1, a * marge).addScaledVector(o2, b * marge);
        if (!libre(q, dir)) { ok = false; break; }
      }
      if (ok) return { dir: dir.clone(), longueur };
      yield;
    }
    return null;
  }
  const res = {}, encours = {};
  const aFaire = [];
  haltes.forEach((h, i) => { if (h.interieur && !h.corotation) aFaire.push(i); });
  const pas = (i) => {
    if (i in res) return true;
    if (!encours[i]) encours[i] = calcul(i);
    const r = encours[i].next();
    if (r.done) { res[i] = r.value; delete encours[i]; return true; }
    return false;
  };
  return {
    // couloir d'une halte (calcul terminé sur-le-champ si besoin), null si la halte n'en a pas
    obtenir(i) {
      if (!aFaire.includes(i)) return null;
      while (!pas(i));
      return res[i];
    },
    // avance le calcul pendant `ms` millisecondes au plus ; vrai quand tout est fait
    avancer(ms = 4) {
      const t0 = performance.now();
      for (const i of aFaire) {
        while (!(i in res)) {
          if (pas(i)) break;
          if (performance.now() - t0 > ms) return false;
        }
      }
      return true;
    },
    get haltes() { return Object.keys(res).filter((i) => res[i]).map((i) => haltes[i].id); },
  };
}

export function creerRig(camera, ctx) {
  const { haltes, trajets, poses, centre, normale } = ctx;
  // axe de la station (celui de l'anneau, par le centre du moyeu) : les trajets proches tournent autour
  const axe = (ctx.axe || new THREE.Vector3(0, 0, 1)).clone().normalize();
  const origine = ctx.origine || new THREE.Vector3();
  const occ = ctx.occupation || null;
  const cyl = (P, out) => {
    const rel = out.rel.subVectors(P, origine);
    out.z = rel.dot(axe);
    out.rho.copy(rel).addScaledVector(axe, -out.z);
    out.r = out.rho.length();
    if (out.r > 1e-3) out.rho.divideScalar(out.r);
    return out;
  };
  const cA = { rel: new THREE.Vector3(), rho: new THREE.Vector3(), z: 0, r: 0 };
  const cB = { rel: new THREE.Vector3(), rho: new THREE.Vector3(), z: 0, r: 0 };
  const perp = (v, out) => {
    out.set(1, 0, 0).addScaledVector(axe, -axe.x);
    if (out.lengthSq() < 0.01) out.set(0, 1, 0).addScaledVector(axe, -axe.y);
    return out.normalize();
  };
  // ---------------------------------------------------------------- rails (lot F)
  // Un rail est une B-spline cubique en coordonnées cylindriques autour de l'axe de la station (rayon,
  // angle, hauteur) : elle part de la pose affichée, suit des clés dessinées pour garder de la marge avec
  // la structure, et finit sur la pose d'arrivée ; la caméra tourne autour du moyeu au lieu de le
  // traverser. La visée et le haut suivent la même spline : position, visée et haut ont des vitesses et
  // des accélérations continues. Une clé sans visée reçoit l'orientation interpolée (slerp) entre ses
  // voisines qui en ont une : la rotation se répartit sur tout le trajet au lieu d'arriver d'un coup.
  // Le rail est parcouru selon sa « longueur » (mètres + rotation comptée en mètres) avec une loi
  // horaire en S. Orientations dans le repère du monde, ou dans le repère cylindrique (`visee: 'cyl'`,
  // pour l'anneau habité dont le haut est tourné vers l'axe). Les clés `repere: 'anneau'` sont dans le
  // repère de l'anneau : elles tournent avec lui, comme la halte « L'anneau habité ». Quand l'anneau
  // est en jeu, le sens du tour autour de l'axe est choisi au départ (le moins coûteux) puis gardé.
  const e1 = perp(axe, new THREE.Vector3()), e2 = new THREE.Vector3().crossVectors(axe, e1).normalize();
  const angleAnneau = () => (ctx.angleAnneau ? ctx.angleAnneau() : 0);
  const DEG = Math.PI / 180;
  const radial = new THREE.Vector3(), tang = new THREE.Vector3(), w1 = new THREE.Vector3(), w2 = new THREE.Vector3(), w3 = new THREE.Vector3();
  const baseCyl = (a) => {
    radial.copy(e1).multiplyScalar(Math.cos(a)).addScaledVector(e2, Math.sin(a));
    tang.copy(e1).multiplyScalar(-Math.sin(a)).addScaledVector(e2, Math.cos(a));
  };
  // vecteur du monde -> composantes dans le repère choisi (cylindrique à l'angle a, ou monde)
  const versRepere = (v, a, cylindrique, out, o) => {
    if (!cylindrique) { out[o] = v.x; out[o + 1] = v.y; out[o + 2] = v.z; return; }
    baseCyl(a);
    out[o] = v.dot(radial); out[o + 1] = v.dot(tang); out[o + 2] = v.dot(axe);
  };
  const depuisRepere = (k, o, a, cylindrique, out) => {
    if (!cylindrique) return out.set(k[o], k[o + 1], k[o + 2]);
    baseCyl(a);
    return out.copy(radial).multiplyScalar(k[o]).addScaledVector(tang, k[o + 1]).addScaledVector(axe, k[o + 2]);
  };
  // clé : [r, angle, z, visée (3), haut (3), distance de visée] ; `oriente` = orientation donnée
  function cleDePose(P, cylindrique, out) {
    w1.subVectors(P.pos, origine);
    const z = w1.dot(axe), x = w1.dot(e1), y = w1.dot(e2);
    out[0] = Math.hypot(x, y); out[1] = Math.atan2(y, x); out[2] = z;
    w2.subVectors(P.cible, P.pos);
    out[9] = w2.length();
    w2.divideScalar(out[9] || 1);
    versRepere(w2, out[1], cylindrique, out, 3);
    versRepere(P.haut, out[1], cylindrique, out, 6);
    return out;
  }
  function cleDeConfig(c, cylindrique, out) {
    const a = c.a * DEG + (c.repere === 'anneau' ? angleAnneau() : 0);
    out[0] = c.r; out[1] = a; out[2] = c.z; out[9] = c.dist || 25;
    if (!c.vise) return false;
    baseCyl(a);
    w1.copy(origine).addScaledVector(axe, c.z).addScaledVector(radial, c.r);
    w2.set(c.vise[0], c.vise[1], c.vise[2]).sub(w1).normalize();
    versRepere(w2, a, cylindrique, out, 3);
    w3.set(0, 1, 0);
    versRepere(w3, a, cylindrique, out, 6);
    return true;
  }
  const qA = new THREE.Quaternion(), qB = new THREE.Quaternion(), qC = new THREE.Quaternion(), mR = new THREE.Matrix4();
  const vX = new THREE.Vector3(), vY = new THREE.Vector3(), vZ = new THREE.Vector3();
  const quatDe = (k, q) => {
    vZ.set(-k[3], -k[4], -k[5]).normalize();
    vX.set(k[6], k[7], k[8]).cross(vZ);
    // visée parallèle au haut (cas dégénéré) : un autre haut plutôt qu'un NaN
    if (vX.lengthSq() < 1e-8) vX.set(Math.abs(vZ.x) < 0.9 ? 1 : 0, Math.abs(vZ.x) < 0.9 ? 0 : 1, 0).cross(vZ);
    vX.normalize();
    vY.crossVectors(vZ, vX);
    return q.setFromRotationMatrix(mR.makeBasis(vX, vY, vZ));
  };
  const versCle = (q, k) => {
    vZ.set(0, 0, -1).applyQuaternion(q); vY.set(0, 1, 0).applyQuaternion(q);
    k[3] = vZ.x; k[4] = vZ.y; k[5] = vZ.z; k[6] = vY.x; k[7] = vY.y; k[8] = vY.z;
  };
  function railCles(tr, Pa, Pb, tours) {
    const def = tr.def, cyl = def.visee === 'cyl', liste = def.cles || [];
    const n = liste.length + 2;
    const cles = tr.railCles || (tr.railCles = []);
    while (cles.length < n) cles.push(new Float64Array(10));
    cles.length = n;
    const donne = [true];
    cleDePose(Pa, cyl, cles[0]);
    liste.forEach((c, i) => donne.push(cleDeConfig(c, cyl, cles[i + 1])));
    cleDePose(Pb, cyl, cles[n - 1]);
    donne.push(true);
    // angles déroulés : au départ, tour par tour (ou `tours` imposés) ; ensuite, chaque clé garde la
    // continuité avec l'image précédente (l'angle d'une pose qui tourne avec l'anneau repasse par ±180°)
    if (tr.railPrec && !tours) {
      for (let i = 0; i < n; i++) {
        let a = cles[i][1];
        while (a - tr.railPrec[i] > Math.PI) a -= 2 * Math.PI;
        while (a - tr.railPrec[i] < -Math.PI) a += 2 * Math.PI;
        cles[i][1] = a; tr.railPrec[i] = a;
      }
      tours = null;
    } else if (!tours) {
      tours = [0];
      for (let i = 1; i < n; i++) {
        const prev = cles[i - 1][1] + tours[i - 1] * 2 * Math.PI;
        let t = 0;
        while (cles[i][1] + t * 2 * Math.PI - prev > Math.PI) t--;
        while (cles[i][1] + t * 2 * Math.PI - prev < -Math.PI) t++;
        tours.push(t);
      }
    }
    if (tours) for (let i = 0; i < n; i++) cles[i][1] += tours[i] * 2 * Math.PI;
    // orientations manquantes : slerp entre les clés voisines qui en ont une, selon la distance parcourue
    const dist = [0];
    for (let i = 1; i < n; i++) {
      const a = cles[i - 1], b = cles[i];
      const dz = b[2] - a[2], dr = b[0] - a[0], da = (b[1] - a[1]) * (a[0] + b[0]) / 2;
      dist.push(dist[i - 1] + Math.sqrt(dz * dz + dr * dr + da * da));
    }
    for (let i = 1; i < n - 1; i++) {
      if (donne[i]) continue;
      let j = i - 1; while (!donne[j]) j--;
      let l = i + 1; while (!donne[l]) l++;
      const f = (dist[i] - dist[j]) / Math.max(1e-6, dist[l] - dist[j]);
      quatDe(cles[j], qA); quatDe(cles[l], qB);
      qC.slerpQuaternions(qA, qB, f);
      versCle(qC, cles[i]);
      cles[i][9] = cles[j][9] + (cles[l][9] - cles[j][9]) * f;
    }
    return { cles, tours };
  }
  const NTAB = 72;
  const railTab = new Float64Array(NTAB + 1), railK = new Float64Array(10);
  const rp = new THREE.Vector3(), rd = new THREE.Vector3(), rh = new THREE.Vector3();
  const qp = new THREE.Vector3(), qd = new THREE.Vector3(), qh = new THREE.Vector3();
  // une B-spline cubique demande au moins quatre clés : on double au besoin la clé du milieu
  const railPreparer = (cles) => {
    while (cles.length < 4) cles.splice(1, 0, Float64Array.from(cles[cles.length > 2 ? 1 : 0]).map((v, q) => (cles.length > 1 ? (cles[0][q] + cles[cles.length - 1][q]) / 2 : v)));
  };
  function railPoint(cles, cyl, t, pos, dir, haut) {
    bspline(t, cles, railK);
    const a = railK[1];
    baseCyl(a);
    pos.copy(origine).addScaledVector(axe, railK[2]).addScaledVector(radial, railK[0]);
    depuisRepere(railK, 3, a, cyl, dir).normalize();
    depuisRepere(railK, 6, a, cyl, haut);
    haut.addScaledVector(dir, -haut.dot(dir));
    if (haut.lengthSq() < 1e-8) haut.copy(axe).addScaledVector(dir, -axe.dot(dir));
    haut.normalize();
    return railK[9];
  }
  // « longueur » du rail : mètres + 14 m par radian de visée + 8 m par radian de haut
  function railMesurer(cles, cyl) {
    railTab[0] = 0;
    railPoint(cles, cyl, 0, qp, qd, qh);
    for (let i = 1; i <= NTAB; i++) {
      railPoint(cles, cyl, i / NTAB, rp, rd, rh);
      const ang = Math.acos(THREE.MathUtils.clamp(rd.dot(qd), -1, 1)), angH = Math.acos(THREE.MathUtils.clamp(rh.dot(qh), -1, 1));
      railTab[i] = railTab[i - 1] + rp.distanceTo(qp) + 14 * ang + 8 * angH;
      qp.copy(rp); qd.copy(rd); qh.copy(rh);
    }
    return railTab[NTAB];
  }
  function railChemin(tr, uDef, Pa, Pb, out) {
    const cyl = tr.def.visee === 'cyl';
    if (!tr.railTours) {
      // premier appel : sens du tour le moins coûteux quand des clés tournent avec l'anneau ou partent
      // d'une halte qui tourne (sinon le plus court, clé à clé)
      const base = railCles(tr, Pa, Pb, null).tours.slice();
      railPreparer(tr.railCles);
      let meilleur = base, cout = railMesurer(tr.railCles, cyl);
      const liste = tr.def.cles || [];
      const tourne = (i) => (i === 0 ? !!haltes[tr.bas].corotation : i === liste.length + 1 ? !!haltes[tr.haut].corotation : liste[i - 1].repere === 'anneau');
      const k0 = base.findIndex((_, i) => i > 0 && tourne(i) !== tourne(i - 1));
      if (k0 > 0) {
        for (const extra of [1, -1]) {
          const t2 = base.map((t, i) => (i >= k0 ? t + extra : t));
          railCles(tr, Pa, Pb, t2);
          railPreparer(tr.railCles);
          const c2 = railMesurer(tr.railCles, cyl);
          if (c2 < cout) { cout = c2; meilleur = t2; }
        }
      }
      tr.railTours = meilleur;
      railCles(tr, Pa, Pb, meilleur);
      tr.railPrec = tr.railCles.map((k) => k[1]);
    }
    const { cles } = railCles(tr, Pa, Pb, null);
    railPreparer(cles);
    const L = railMesurer(cles, cyl);
    const cible = sCurve(uDef) * L;
    let i = 1;
    while (i < NTAB && railTab[i] < cible) i++;
    const f = (cible - railTab[i - 1]) / Math.max(1e-9, railTab[i] - railTab[i - 1]);
    const t = (i - 1 + THREE.MathUtils.clamp(f, 0, 1)) / NTAB;
    const dv = railPoint(cles, cyl, t, out.pos, rd, out.haut);
    out.cible.copy(out.pos).addScaledVector(rd, Math.max(dv, 4));
    tr.railLongueur = L;
    return t;
  }

  // ---------------------------------------------------------------- tour (lot H)
  // Trajet entre l'anneau habité (qui tourne) et un module fixe, sans roulis. Le trajet est dessiné dans un
  // repère « plan » : B-spline cubique cartésienne (quatre clés alignées = tronçon droit), orientation
  // donnée clé par clé (visée et haut). Les premières clés sont dans le repère de l'anneau à l'angle 0 (on
  // y monte par la verrière) ; les dernières (`monde: true`, le couloir d'entrée du module) sont données dans
  // le repère fixe et ramenées dans le repère plan par une rotation de -δ autour de l'axe, δ étant l'écart
  // d'angle entre la dernière clé de l'anneau et la première clé fixe : entre les deux, la caméra ne tourne
  // pas autour de l'axe dans le repère plan. La pose plane est tournée autour de l'axe de la station de
  //   β(s) = (1 - L(s)) · (θ - 360° k) + L(s) · δ
  // où θ est l'angle courant de l'anneau et L(s) la libération (fonction lisse de l'abscisse s du rail, 0
  // dans l'anneau, 1 dans le repère fixe) : solidaire de l'anneau au départ (même vitesse), la caméra orbite
  // ensuite autour de la tour d'un angle choisi au départ (k) pour ne jamais dépasser 180°. Pendant la
  // libération, les clés regardent l'axe avec le haut le long de l'axe : cette orbite est un lacet, jamais
  // un roulis. La durée s'allonge avec l'angle de l'orbite.
  const qZ = new THREE.Quaternion();
  const tourK = new Float64Array(10);
  const tp = new THREE.Vector3(), tv = new THREE.Vector3(), tu = new THREE.Vector3();
  const lib = (s, a, b) => smoother((s - a) / Math.max(1e-6, b - a));
  // pose (pos, visée, haut) -> clé du repère plan (rotation de -ang autour de l'axe)
  function cleTour(pos, vis, haut, dist, ang, out) {
    qZ.setFromAxisAngle(axe, -ang);
    tp.copy(pos).sub(origine).applyQuaternion(qZ);
    tv.copy(vis).normalize();
    tu.copy(haut).addScaledVector(tv, -haut.dot(tv)).normalize().applyQuaternion(qZ);
    tv.applyQuaternion(qZ);
    out[0] = tp.x; out[1] = tp.y; out[2] = tp.z; out[3] = tv.x; out[4] = tv.y; out[5] = tv.z;
    out[6] = tu.x; out[7] = tu.y; out[8] = tu.z; out[9] = dist;
    return out;
  }
  // anneau du côté d'arrivée (`anneau: 'haut'`, moyeu vers anneau) : la libération se lit à l'envers
  const libTour = (tr, s) => {
    const l = lib(s, tr.def.liberation[0], tr.def.liberation[1]);
    return tr.def.anneau === 'haut' ? 1 - l : l;
  };
  function tourBeta(tr, s, theta) {
    const L = libTour(tr, s);
    return (1 - L) * (theta - tr.tourTours * 2 * Math.PI) + L * tr.tourDelta;
  }
  // point du rail au paramètre s : pos, visée (unitaire), haut (unitaire) ; rend la distance de visée
  function tourPoint(tr, s, theta, pos, dir, haut) {
    bspline(s, tr.tourCles, tourK);
    qZ.setFromAxisAngle(axe, tourBeta(tr, s, theta));
    pos.set(tourK[0], tourK[1], tourK[2]).applyQuaternion(qZ).add(origine);
    dir.set(tourK[3], tourK[4], tourK[5]).normalize().applyQuaternion(qZ);
    haut.set(tourK[6], tourK[7], tourK[8]).applyQuaternion(qZ);
    haut.addScaledVector(dir, -haut.dot(dir));
    if (haut.lengthSq() < 1e-8) haut.copy(axe).addScaledVector(dir, -axe.dot(dir));
    haut.normalize();
    return tourK[9];
  }
  // clés du repère plan : départ (côté anneau, ramené à l'angle 0), clés de config.js, arrivée (module fixe,
  // ramenée de -δ comme les clés `monde`)
  function tourCles(tr, Pa, Pb, theta) {
    const liste = tr.def.cles;
    const n = liste.length + 2;
    const cles = tr.tourCles || (tr.tourCles = Array.from({ length: n }, () => new Float64Array(10)));
    if (!tr.tourFixes) {
      // δ : de la dernière clé de l'anneau à la première clé fixe (angles autour de l'axe)
      // frontière entre clés fixes et clés de l'anneau (dans un sens ou dans l'autre)
      const iF = liste.findIndex((c, i) => i + 1 < liste.length && !!c.monde !== !!liste[i + 1].monde);
      const cF = iF >= 0 ? (liste[iF].monde ? liste[iF] : liste[iF + 1]) : null;
      const cA = iF >= 0 ? (liste[iF].monde ? liste[iF + 1] : liste[iF]) : null;
      const avant = cA ? cA.p : [1, 0, 0], apres = cF ? cF.p : [1, 0, 0];
      let d = Math.atan2(apres[1], apres[0]) - Math.atan2(avant[1], avant[0]);
      while (d > Math.PI) d -= 2 * Math.PI;
      while (d < -Math.PI) d += 2 * Math.PI;
      tr.tourDelta = d;
      const donne = [true];
      liste.forEach((c, i) => {
        const k = cles[i + 1];
        w3.set(c.p[0], c.p[1], c.p[2]);
        let ok = false;
        if (c.vue) { w1.set(c.vue[0], c.vue[1], c.vue[2]).normalize(); ok = true; }
        else if (c.vise === 'axe') { w1.set(-c.p[0], -c.p[1], 0).normalize(); ok = true; }
        else if (c.vise) { w1.set(c.vise[0] - c.p[0], c.vise[1] - c.p[1], c.vise[2] - c.p[2]).normalize(); ok = true; }
        if (ok && c.haut) w2.set(c.haut[0], c.haut[1], c.haut[2]);
        else { ok = false; w1.set(1, 0, 0); w2.set(0, 1, 0); }
        cleTour(w3, w1, w2, c.dist || 20, c.monde ? d : 0, k);
        donne.push(ok);
      });
      donne.push(true);
      tr.tourDonne = donne;
      tr.tourFixes = true;
    }
    const enHaut = tr.def.anneau === 'haut';
    w1.subVectors(Pa.cible, Pa.pos);
    cleTour(Pa.pos, w1, Pa.haut, w1.length(), enHaut ? tr.tourDelta : theta, cles[0]);
    w2.subVectors(Pb.cible, Pb.pos);
    cleTour(Pb.pos, w2, Pb.haut, w2.length(), enHaut ? theta : tr.tourDelta, cles[n - 1]);
    // orientations manquantes : slerp entre voisines, selon la distance parcourue
    const donne = tr.tourDonne;
    for (let i = 1; i < n - 1; i++) {
      if (donne[i]) continue;
      let j = i - 1; while (!donne[j]) j--;
      let l = i + 1; while (!donne[l]) l++;
      const dij = Math.hypot(cles[i][0] - cles[j][0], cles[i][1] - cles[j][1], cles[i][2] - cles[j][2]);
      const dil = Math.hypot(cles[l][0] - cles[i][0], cles[l][1] - cles[i][1], cles[l][2] - cles[i][2]);
      const f = dij / Math.max(1e-6, dij + dil);
      quatDe(cles[j], qA); quatDe(cles[l], qB);
      qC.slerpQuaternions(qA, qB, f);
      versCle(qC, cles[i]);
      cles[i][9] = cles[j][9] + (cles[l][9] - cles[j][9]) * f;
    }
    return cles;
  }
  // au départ : tour entier k (orbite de 180° au plus), durée, et table de « longueur » (mètres + rotation de
  // la visée, orbite comprise) pour la loi horaire
  const TOUR_N = 160;
  function tourPreparer(tr, Pa, Pb) {
    const theta0 = angleAnneau();
    const om = ctx.vitesseAnneau ? ctx.vitesseAnneau() : 0;
    tourCles(tr, Pa, Pb, theta0);
    // angle de l'anneau quand la libération est à moitié faite (estimé au milieu du trajet)
    const thetaMil = theta0 + om * tr.def.duree * 0.5;
    let best = null;
    const k0 = Math.round((thetaMil - tr.tourDelta) / (2 * Math.PI));
    for (const kk of [k0 - 1, k0, k0 + 1]) {
      const tot = tr.tourDelta - (thetaMil - kk * 2 * Math.PI);
      if (!best || Math.abs(tot) < Math.abs(best.tot)) best = { kk, tot };
    }
    tr.tourTours = best.kk;
    tr.tourTotal = best.tot;
    tr.duree = (tr.def.duree + (tr.def.dureeTour || 0) * Math.min(1, Math.abs(best.tot) / Math.PI)) * (tr.vitesse || 1);
    const NT = TOUR_N;
    const tab = tr.tourTab || (tr.tourTab = new Float64Array(NT + 1));
    tab[0] = 0;
    tourPoint(tr, 0, thetaMil, qp, qd, qh);
    // poids de la « longueur » (mètres, par radian de visée, par radian de haut) ; moyeu vers anneau compte
    // surtout les rotations (demi-tour sur place, orbite à 35 m de l'axe) : même vitesse de rotation partout
    const pd = tr.def.poids || { position: 1, visee: 27, haut: 12 };
    for (let i = 1; i <= NT; i++) {
      tourPoint(tr, i / NT, thetaMil, rp, rd, rh);
      const ang = Math.acos(THREE.MathUtils.clamp(rd.dot(qd), -1, 1)), angH = Math.acos(THREE.MathUtils.clamp(rh.dot(qh), -1, 1));
      // la rotation compte plus que sur les rails : une orbite ou un regard qui tourne prennent leur temps
      tab[i] = tab[i - 1] + pd.position * rp.distanceTo(qp) + pd.visee * ang + pd.haut * angH;
      qp.copy(rp); qd.copy(rd); qh.copy(rh);
    }
    tr.tourLongueur = tab[NT];
  }
  // loi horaire des tours : vitesse en plateau, rampes en S (smootherstep) sur 28 % du temps à chaque bout ;
  // le pic de vitesse vaut 1,39 fois la moyenne (1,875 avec une seule courbe en S) : même trajet, pointes plus
  // douces. Position et vitesse continues, accélération continue (rampes C2).
  const RAMPE = 0.28;
  const primS = (y) => y * y * y * y * (y * (y - 3) + 2.5); // intégrale de smootherstep sur [0, y]
  function loiTour(u) {
    const a = RAMPE;
    if (u <= 0) return 0;
    if (u >= 1) return 1;
    let x;
    if (u < a) x = a * primS(u / a);
    else if (u <= 1 - a) x = a * 0.5 + (u - a);
    else x = (1 - a) - a * primS((1 - u) / a);
    return x / (1 - a);
  }
  function tourChemin(tr, uDef, Pa, Pb, out) {
    const theta = angleAnneau();
    if (!tr.tourTab) tourPreparer(tr, Pa, Pb);
    tourCles(tr, Pa, Pb, theta);
    const tab = tr.tourTab, NT = TOUR_N;
    const cible = loiTour(uDef) * tr.tourLongueur;
    let i = 1;
    while (i < NT && tab[i] < cible) i++;
    const f = (cible - tab[i - 1]) / Math.max(1e-9, tab[i] - tab[i - 1]);
    const s = (i - 1 + THREE.MathUtils.clamp(f, 0, 1)) / NT;
    const dv = tourPoint(tr, s, theta, out.pos, rd, out.haut);
    out.cible.copy(out.pos).addScaledVector(rd, Math.max(dv, 4));
    out.fov = THREE.MathUtils.lerp(Pa.fov, Pb.fov, sCurve(uDef));
    return s;
  }

  const ideal = new Pose(), lisse = new Pose(), A = new Pose(), B = new Pose(), tmp = new Pose();
  const v1 = new THREE.Vector3(), v2 = new THREE.Vector3(), v3 = new THREE.Vector3(), v4 = new THREE.Vector3(), v5 = new THREE.Vector3();
  const p1 = new THREE.Vector3(), p2 = new THREE.Vector3();
  const etat = { trajet: null, amorce: false, respiration: 0, tArrivee: 0, pointeur: new THREE.Vector2(), pointeurL: new THREE.Vector2() };
  // dernière pose réellement affichée (travelling compris) : un départ part de là, sans à-coup
  const affiche = new Pose();
  let afficheValide = false;

  const poseDe = (i, out) => poses.f[haltes[i].id](out);

  // trajet : de, vers, t0, duree, type, réglages ; `instantane` = la pose de départ figée
  function demarrer(de, vers, t, options = {}) {
    const bas = Math.min(de, vers), haut = Math.max(de, vers);
    const cle = `${haltes[bas].id}>${haltes[haut].id}`;
    const def = options.def || trajets[cle] || { type: 'travelling', duree: 5.5, bombe: 0.15 };
    const depart = new Pose().copy(options.depuis || (afficheValide ? affiche : lisse));
    etat.respiration = 0;
    etat.trajet = {
      de, vers, t0: t, duree: def.duree * (options.vitesse || 1), def, sens: vers > de ? 1 : -1, bas, haut,
      depart, u: options.u0 || 0, roulisRepli: new THREE.Vector3().subVectors(depart.cible, depart.pos).normalize(), vitesse: options.vitesse || 1,
    };
    etat.trajet.t0Demande = t;
    if (options.u0) etat.trajet.t0 = t - options.u0 * etat.trajet.duree;
    // départ d'une halte qui tourne avec l'anneau : la pose de départ est gardée dans le repère de
    // l'anneau (elle continue de tourner), sinon la caméra s'arrêtait net au départ
    if (haltes[de].corotation && ctx.angleAnneau) etat.trajet.angleDepart = ctx.angleAnneau();
    choisirChemin(etat.trajet);
  }

  // Au départ d'un trajet proche de la station : on essaie plusieurs écarts et les deux sens de
  // rotation autour de l'axe, et on garde le premier chemin qui ne traverse pas la structure.
  const Pa0 = new Pose(), Pb0 = new Pose(), essai = new Pose();
  // Bout de trajet près d'une halte intérieure : si le chemin retenu traverse encore la structure dans
  // la part de trajet voisine de cette halte (COULOIR), on y arrive (ou on en part) par son couloir.
  function deciderCouloirs(tr) {
    tr.couloirA = null; tr.couloirB = null;
    const cs = ctx.couloirs;
    const cBas = cs ? cs.obtenir(tr.bas) : null, cHaut = cs ? cs.obtenir(tr.haut) : null;
    if (!occ || (!cBas && !cHaut)) return;
    let nA = 0, nB = 0;
    for (let i = 2; i <= 38; i++) {
      const u = i / 40;
      chemin(tr, u, Pa0, Pb0, essai);
      if (!occ.occupe(essai.pos, false)) continue;
      if (u < COULOIR) nA++;
      if (u > 1 - COULOIR) nB++;
    }
    if (cBas && nA) tr.couloirA = cBas;
    if (cHaut && nB) tr.couloirB = cHaut;
  }
  function choisirChemin(tr) {
    if (tr.def.type === 'tour') {
      // lot H : tour entier, durée et loi horaire décidés dès le départ (la durée dépend de l'angle à parcourir)
      const dep = tr.angleDepart != null ? tournerDepart(tr) : tr.depart;
      if (tr.sens > 0) { Pa0.copy(dep); poseDe(tr.haut, Pb0); } else { poseDe(tr.bas, Pa0); Pb0.copy(dep); }
      const uDeja = tr.u || 0;
      tourPreparer(tr, Pa0, Pb0);
      if (uDeja) tr.t0 = tr.t0Demande - uDeja * tr.duree;
      return;
    }
    choisirSansCouloir(tr);
    if (occ && (tr.def.type === 'travelling' || tr.def.type === 'orbite')) deciderCouloirs(tr);
  }
  function choisirSansCouloir(tr) {
    const type = tr.def.type;
    tr.couloirA = null; tr.couloirB = null;
    tr.choix = { bosse: tr.def.type === 'orbite' ? (tr.def.leve ?? 0.25) : (tr.def.bombe ?? 0.15), sens: 1, collisions: 0 };
    if (!occ || (type !== 'travelling' && type !== 'orbite')) return;
    if (tr.sens > 0) { Pa0.copy(tr.depart); poseDe(tr.haut, Pb0); } else { poseDe(tr.bas, Pa0); Pb0.copy(tr.depart); }
    const base = tr.choix.bosse;
    // les extrémités peuvent être dans un intérieur (serre, anneau) : on ne juge que le milieu
    const bandeA = occ.dansBande(Pa0.pos), bandeB = occ.dansBande(Pb0.pos);
    let meilleur = null;
    for (const bosse of [base, base + 0.15, base + 0.3, base + 0.5, base + 0.8]) {
      for (const sens of [1, -1]) {
        tr.choix = { bosse, sens, collisions: 0 };
        let n = 0;
        for (let i = 2; i <= 38; i++) {
          const u = i / 40;
          chemin(tr, u, Pa0, Pb0, essai);
          const pres = (bandeA && u < 0.3) || (bandeB && u > 0.7);
          if (occ.occupe(essai.pos, !pres)) n++;
        }
        tr.choix.collisions = n;
        if (!meilleur || n < meilleur.collisions) meilleur = { ...tr.choix };
        if (n === 0) return;
      }
    }
    tr.choix = meilleur;
  }

  // s = 0 sur la halte, 1 à l'entrée de la fenêtre du couloir. La position glisse le long du couloir
  // (vitesse nulle sur la halte) ; le chemin normal se fond dans le couloir sur la moitié éloignée de
  // la fenêtre, la moitié proche est en ligne droite.
  const enCouloir = new THREE.Vector3();
  function versCouloir(pos, P0, c, s) {
    const g = s * s * (3 - 2 * s);
    enCouloir.copy(P0).addScaledVector(c.dir, c.longueur * g);
    pos.lerp(enCouloir, smoother((1 - s) / 0.5));
  }

  // point du trajet défini de « bas » vers « haut » (le sens inverse rejoue la courbe à l'envers)
  function chemin(tr, uDef, Pa, Pb, out) {
    const def = tr.def;
    const e = smoother(uDef);
    const L = Pa.pos.distanceTo(Pb.pos);
    const bosse = Math.sin(Math.PI * uDef);
    switch (def.type) {
      case 'tour': {
        tourChemin(tr, uDef, Pa, Pb, out);
        return;
      }
      case 'rail': {
        railChemin(tr, uDef, Pa, Pb, out);
        out.fov = THREE.MathUtils.lerp(Pa.fov, Pb.fov, sCurve(uDef));
        return;
      }
      case 'plongee': {
        v1.subVectors(Pa.cible, Pa.pos).normalize();
        v2.subVectors(Pb.cible, Pb.pos).normalize();
        p1.copy(Pa.pos).addScaledVector(v1, L * 0.16).addScaledVector(normale, -L * 0.04);
        p2.copy(Pb.pos).addScaledVector(normale, L * 0.4).addScaledVector(v2, -L * 0.1);
        bezier(Pa.pos, p1, p2, Pb.pos, smoother(uDef), out.pos);
        out.cible.lerpVectors(Pa.cible, Pb.cible, smoother(uDef * 1.1 - 0.05));
        out.cible.addScaledVector(normale, -L * 0.32 * Math.pow(bosse, 1.4));
        break;
      }
      case 'remontee': {
        v1.subVectors(Pa.cible, Pa.pos).normalize();
        v2.subVectors(Pb.pos, Pb.cible).normalize();
        p1.copy(Pa.pos).addScaledVector(normale, L * 0.32).addScaledVector(v1, L * 0.08);
        p2.copy(Pb.pos).addScaledVector(v2, L * 0.28).addScaledVector(normale, L * 0.06);
        bezier(Pa.pos, p1, p2, Pb.pos, smoother(uDef), out.pos);
        out.cible.lerpVectors(Pa.cible, Pb.cible, smoother(uDef * 1.15 - 0.1));
        out.cible.addScaledVector(normale, L * 0.15 * bosse);
        break;
      }
      case 'orbite':
      case 'travelling': {
        // coordonnées cylindriques autour de l'axe de la station : on tourne autour de la structure
        // au lieu de la traverser, avec un écart radial au milieu du trajet
        cyl(Pa.pos, cA); cyl(Pb.pos, cB);
        if (cA.r < 1e-3) cA.rho.copy(cB.r > 1e-3 ? cB.rho : perp(axe, cA.rho));
        if (cB.r < 1e-3) cB.rho.copy(cA.rho);
        let ang = Math.atan2(v1.crossVectors(cA.rho, cB.rho).dot(axe), cA.rho.dot(cB.rho));
        const choix = tr.choix || { bosse: def.leve ?? def.bombe ?? 0.2, sens: 1 };
        if (choix.sens < 0) ang = ang - Math.sign(ang || 1) * Math.PI * 2;
        const ea = def.type === 'orbite' ? e : smoother(uDef * 1.05 - 0.025);
        const z = THREE.MathUtils.lerp(cA.z, cB.z, e);
        const r = THREE.MathUtils.lerp(cA.r, cB.r, e) + choix.bosse * Math.max(L, 20) * bosse;
        v3.copy(cA.rho).applyAxisAngle(axe, ang * ea);
        out.pos.copy(origine).addScaledVector(axe, z).addScaledVector(v3, r);
        out.cible.lerpVectors(Pa.cible, Pb.cible, smoother(uDef * 1.1 - 0.05));
        break;
      }
      case 'recul': {
        v1.subVectors(Pa.pos, centre); v2.subVectors(Pb.pos, centre);
        const ra = Math.max(1, v1.length()), rb = Math.max(1, v2.length());
        v1.normalize(); v2.normalize();
        const ed = smoother(uDef);
        slerpVec(v1, v2, smoother(uDef * 1.2 - 0.1), normale, v3);
        const r = Math.exp(THREE.MathUtils.lerp(Math.log(ra), Math.log(rb), ed));
        out.pos.copy(centre).addScaledVector(v3, r);
        out.cible.lerpVectors(Pa.cible, Pb.cible, smoother(uDef * 1.25 - 0.12));
        break;
      }
      default: { // ligne droite adoucie (repli)
        bezier(Pa.pos, p1.lerpVectors(Pa.pos, Pb.pos, 0.33), p2.lerpVectors(Pa.pos, Pb.pos, 0.67), Pb.pos, e, out.pos);
        out.cible.lerpVectors(Pa.cible, Pb.cible, smoother(uDef * 1.12 - 0.06));
      }
    }
    // couloirs d'entrée (voir deciderCouloirs) : arrivée et départ en ligne droite par le couloir
    if (tr.couloirB && uDef > 1 - COULOIR) versCouloir(out.pos, Pb.pos, tr.couloirB, (1 - uDef) / COULOIR);
    if (tr.couloirA && uDef < COULOIR) versCouloir(out.pos, Pa.pos, tr.couloirA, uDef / COULOIR);
    out.fov = THREE.MathUtils.lerp(Pa.fov, Pb.fov, e) + (def.fovMilieu || 0) * bosse;
    v5.subVectors(out.cible, out.pos).normalize();
    slerpVec(Pa.haut, Pb.haut, e, v5, out.haut);
    // garde : la cible jamais collée à la caméra
    v4.subVectors(out.cible, out.pos);
    if (v4.length() < 4) out.cible.copy(out.pos).addScaledVector(v4.normalize(), 4);
  }

  const depTourne = new Pose(), qTour = new THREE.Quaternion();
  function tournerDepart(tr) {
    qTour.setFromAxisAngle(axe, ctx.angleAnneau() - tr.angleDepart);
    depTourne.copy(tr.depart);
    depTourne.pos.sub(origine).applyQuaternion(qTour).add(origine);
    depTourne.cible.sub(origine).applyQuaternion(qTour).add(origine);
    depTourne.haut.applyQuaternion(qTour);
    return depTourne;
  }
  function calculerIdeal(t) {
    const tr = etat.trajet;
    if (!tr) { poseDe(ctx.courant(), ideal); return 1; }
    const u = Math.min(1, Math.max(0, (t - tr.t0) / tr.duree));
    tr.u = u;
    // pose de départ figée du côté d'où l'on part, pose vivante du côté où l'on va
    const Pa = A, Pb = B;
    const dep = tr.angleDepart != null ? tournerDepart(tr) : tr.depart;
    if (tr.sens > 0) { Pa.copy(dep); poseDe(tr.haut, Pb); chemin(tr, u, Pa, Pb, ideal); }
    else { poseDe(tr.bas, Pa); Pb.copy(dep); chemin(tr, 1 - u, Pa, Pb, ideal); }
    return u;
  }

  const k = (dt, tau) => 1 - Math.exp(-dt / tau);
  const right = new THREE.Vector3(), up = new THREE.Vector3(), off = new THREE.Vector3();
  // Visée à vitesse angulaire bornée. Dans quelques trajets serrés (entrée de la serre, sortie de la
  // serre, arrivée à l'observatoire), la cible passe tout près de la caméra et la visée fouettait
  // jusqu'à 250°/s : on l'étale à 100°/s au plus. Tout mouvement plus lent passe sans changement.
  const VISEE_MAX = (70 * Math.PI) / 180;
  const visee = new THREE.Vector3(), voulue = new THREE.Vector3(), ciblePosee = new THREE.Vector3();
  let viseeAmorcee = false;

  function maj(t, dt, opts) {
    const u = calculerIdeal(t);
    const fini = etat.trajet;
    if (fini && u >= 1) { etat.trajet = null; etat.tArrivee = t; ctx.arrivee(fini.vers); }
    if (opts.instantane || !etat.amorce) {
      lisse.copy(ideal); etat.amorce = true; viseeAmorcee = false;
    } else {
      const enRoute = !!etat.trajet;
      lisse.pos.lerp(ideal.pos, k(dt, enRoute ? 0.14 : 0.35));
      lisse.cible.lerp(ideal.cible, k(dt, enRoute ? 0.1 : 0.3));
      lisse.haut.lerp(ideal.haut, k(dt, 0.25)).normalize();
      lisse.fov += (ideal.fov - lisse.fov) * k(dt, 0.3);
    }
    // respiration et parallaxe, seulement à l'arrêt
    const cible = etat.trajet ? 0 : 1;
    if (!etat.trajet) etat.respiration += (cible - etat.respiration) * k(dt, 1.6);
    etat.pointeurL.lerp(etat.pointeur, k(dt, 0.5));
    const amp = opts.reduit ? 0 : etat.respiration;
    tmp.copy(lisse);
    // visée bornée (voir VISEE_MAX) : la cible posée garde sa distance, seule sa direction est retenue
    voulue.subVectors(lisse.cible, lisse.pos);
    const distCible = voulue.length();
    if (distCible > 1e-6) {
      voulue.divideScalar(distCible);
      if (!viseeAmorcee || dt <= 0) { visee.copy(voulue); viseeAmorcee = true; }
      else {
        const ecart = visee.angleTo(voulue), pas = VISEE_MAX * dt;
        if (ecart > pas) slerpVec(visee, voulue, pas / ecart, lisse.haut, visee).normalize();
        else visee.copy(voulue);
      }
      tmp.cible.copy(ciblePosee.copy(lisse.pos).addScaledVector(visee, distCible));
    }
    if (amp > 0.001) {
      off.subVectors(tmp.pos, tmp.cible);
      const dist = off.length();
      right.crossVectors(off, tmp.haut).normalize();
      up.copy(tmp.haut);
      const yaw = (Math.sin(t * 0.21) * 0.9 + Math.sin(t * 0.13 + 1.3) * 0.5) * (Math.PI / 180) * amp + etat.pointeurL.x * 0.028 * amp;
      const pitch = (Math.sin(t * 0.17 + 0.6) * 0.6) * (Math.PI / 180) * amp - etat.pointeurL.y * 0.018 * amp;
      // travelling lent à la halte (demande de Tom : jamais de plan figé). Il part de zéro avec une vitesse
      // nulle (1 - cos), glisse en orbite autour de la cible et pousse doucement vers elle, puis revient.
      const h = haltes[ctx.courant()] || {};
      const tv = h.travelling || (h.interieur ? TRAVELLING_INTERIEUR : TRAVELLING_EXTERIEUR);
      const ta = Math.max(0, t - etat.tArrivee);
      const orbite = tv.orbite * (Math.PI / 180) * (1 - Math.cos(ta * 2 * Math.PI / tv.periode)) * 0.5 * (tv.sens || 1);
      const pousse = tv.pousse * (1 - Math.cos(ta * 2 * Math.PI / (tv.periode * 0.73))) * 0.5;
      const grue = (tv.grue || 0) * (Math.PI / 180) * Math.sin(ta * 2 * Math.PI / (tv.periode * 1.31));
      off.applyAxisAngle(up, yaw + orbite * amp).applyAxisAngle(right, pitch + grue * amp);
      off.setLength(dist * (1 + 0.006 * Math.sin(t * 0.29) * amp - pousse * amp));
      tmp.pos.copy(tmp.cible).add(off);
    }
    affiche.copy(tmp); afficheValide = true;
    camera.position.copy(tmp.pos);
    camera.up.copy(tmp.haut);
    camera.lookAt(tmp.cible);
    return u;
  }

  return {
    etat, maj, demarrer, poseDe, lisse, ideal,
    get enRoute() { return !!etat.trajet; },
    get u() { return etat.trajet ? etat.trajet.u : 1; },
    get trajet() { return etat.trajet; },
    get choix() { return etat.trajet ? etat.trajet.choix : null; },
    annuler() { etat.trajet = null; },
    reamorcer() { etat.amorce = false; },
  };
}
