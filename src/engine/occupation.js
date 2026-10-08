// Grille d'occupation de la station (voxels de quelques mètres), construite une fois au chargement.
// Elle sert à deux choses, sans rien coûter par image :
// - choisir, au départ de chaque trajet, un chemin de caméra qui ne traverse pas la structure ;
// - savoir si la station cache le soleil (pour couper l'éblouissement).
// Le verre ne compte pas (on peut passer à travers une verrière), la navette non plus (elle bouge).
// L'anneau habité tourne : il est traité à part, comme une bande analytique autour de son axe.
import * as THREE from 'three';

export function creerOccupation(station, { taille = 3 } = {}) {
  const racine = station.racine;
  racine.updateMatrixWorld(true);
  const exclu = (o) => {
    for (let x = o; x; x = x.parent) {
      if (!x.name) continue;
      if (x.name.startsWith('verre_') || x.name === 'navette' || x.name === 'anneau_rotatif' || x.name.startsWith('pivot_anneau')) return true;
    }
    return false;
  };
  const maillages = [];
  racine.traverse((o) => { if (o.isMesh && !exclu(o)) maillages.push(o); });
  const boite = new THREE.Box3();
  for (const m of maillages) boite.expandByObject(m);
  if (boite.isEmpty()) boite.set(new THREE.Vector3(-1, -1, -1), new THREE.Vector3(1, 1, 1));
  boite.expandByScalar(taille * 2);
  const min = boite.min.clone();
  const dim = boite.getSize(new THREE.Vector3());
  const nx = Math.max(1, Math.ceil(dim.x / taille)), ny = Math.max(1, Math.ceil(dim.y / taille)), nz = Math.max(1, Math.ceil(dim.z / taille));
  const grille = new Uint8Array(nx * ny * nz);
  const cellule = (x, y, z) => {
    const i = Math.floor((x - min.x) / taille), j = Math.floor((y - min.y) / taille), k = Math.floor((z - min.z) / taille);
    if (i < 0 || j < 0 || k < 0 || i >= nx || j >= ny || k >= nz) return -1;
    return i + nx * (j + ny * k);
  };
  const marque = (p) => { const c = cellule(p.x, p.y, p.z); if (c >= 0) grille[c] = 1; };

  const a = new THREE.Vector3(), b = new THREE.Vector3(), c = new THREE.Vector3(), p = new THREE.Vector3();
  const e1 = new THREE.Vector3(), e2 = new THREE.Vector3();
  const mi = new THREE.Matrix4(), mw = new THREE.Matrix4();
  let triangles = 0;
  const pas = taille * 0.6;
  const triangle = (m) => {
    a.applyMatrix4(m); b.applyMatrix4(m); c.applyMatrix4(m);
    triangles++;
    const l1 = a.distanceTo(b), l2 = a.distanceTo(c);
    const n1 = Math.max(1, Math.ceil(l1 / pas)), n2 = Math.max(1, Math.ceil(l2 / pas));
    if (n1 * n2 > 4000) return; // triangle géant (fond, coque lointaine) : ignoré plutôt que de bloquer
    e1.subVectors(b, a); e2.subVectors(c, a);
    for (let i = 0; i <= n1; i++) {
      const u = i / n1;
      for (let j = 0; j <= n2; j++) {
        const v = j / n2;
        if (u + v > 1.0001) break;
        p.copy(a).addScaledVector(e1, u).addScaledVector(e2, v);
        marque(p);
      }
    }
  };
  for (const m of maillages) {
    const g = m.geometry, pos = g.attributes.position;
    if (!pos) continue;
    const idx = g.index;
    const nTri = idx ? idx.count / 3 : pos.count / 3;
    const instances = m.isInstancedMesh ? m.count : 1;
    for (let s = 0; s < instances; s++) {
      if (m.isInstancedMesh) { m.getMatrixAt(s, mi); mw.multiplyMatrices(m.matrixWorld, mi); } else mw.copy(m.matrixWorld);
      for (let t = 0; t < nTri; t++) {
        const i0 = idx ? idx.getX(t * 3) : t * 3, i1 = idx ? idx.getX(t * 3 + 1) : t * 3 + 1, i2 = idx ? idx.getX(t * 3 + 2) : t * 3 + 2;
        a.fromBufferAttribute(pos, i0); b.fromBufferAttribute(pos, i1); c.fromBufferAttribute(pos, i2);
        triangle(mw);
      }
    }
  }

  // l'anneau habité : bande pleine autour de son axe (le rayon intérieur ignore les rayons du moyeu)
  let bande = null;
  const anneau = station.trouve('anneau_rotatif');
  if (anneau) {
    const ax = station.axeAnneau.clone().normalize();
    const rs = [], zs = [];
    const v = new THREE.Vector3();
    anneau.updateMatrixWorld(true);
    anneau.traverse((o) => {
      if (!o.isMesh || (o.name && o.name.startsWith('verre_'))) return;
      const pos = o.geometry.attributes.position;
      const pasV = Math.max(1, Math.floor(pos.count / 4000));
      for (let i = 0; i < pos.count; i += pasV) {
        v.fromBufferAttribute(pos, i).applyMatrix4(o.matrixWorld);
        const z = v.dot(ax);
        const r = v.clone().addScaledVector(ax, -z).length();
        rs.push(r); zs.push(z);
      }
    });
    if (rs.length) {
      let rMax = 0;
      for (const r of rs) if (r > rMax) rMax = r;
      const ext = rs.map((r, i) => [r, zs[i]]).filter(([r]) => r > rMax * 0.7);
      const rTri = ext.map(([r]) => r).sort((x, y) => x - y);
      const zTri = ext.map(([, z]) => z).sort((x, y) => x - y);
      const q = (arr, f) => arr[Math.min(arr.length - 1, Math.max(0, Math.floor(f * (arr.length - 1))))];
      bande = { ax, rIn: q(rTri, 0.04) - 1.5, rOut: rMax + 2, zMin: q(zTri, 0.01) - 2, zMax: q(zTri, 0.99) + 2 };
    }
  }
  const dansBande = (P) => {
    if (!bande) return false;
    const z = P.dot(bande.ax);
    if (z < bande.zMin || z > bande.zMax) return false;
    const r = Math.sqrt(Math.max(0, P.lengthSq() - z * z));
    return r > bande.rIn && r < bande.rOut;
  };

  const occupe = (P, avecBande = true) => {
    if (avecBande && dansBande(P)) return true;
    const ce = cellule(P.x, P.y, P.z);
    return ce >= 0 && grille[ce] === 1;
  };

  // distance au premier obstacle le long d'un rayon (Infinity si rien avant `max`)
  const q = new THREE.Vector3();
  const rayon = (P, dir, max, depart = 0) => {
    for (let s = depart; s <= max; s += taille * 0.7) {
      q.copy(P).addScaledVector(dir, s);
      if (occupe(q)) return s;
    }
    return Infinity;
  };

  return { occupe, dansBande, rayon, bande, taille, triangles, cellules: grille.reduce((s, x) => s + x, 0), dims: [nx, ny, nz] };
}
