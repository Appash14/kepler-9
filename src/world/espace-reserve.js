// Espace réservé : une station Kepler-9 en primitives three.js, en attendant le glb de Blender.
// Elle respecte le même contrat de noms que station.glb (voir DA.md) : anneau_rotatif, moyeu, quai,
// serre, forge, observatoire, antennes, panneaux_solaires, forge_noyau, forge_anneau_1..3,
// observatoire_telescope, antenne_parabole_*, navette (en position arrimée), emissif_*, verre_*,
// et un Empty cam_<id> / ancre_<id> par halte. Les pièces statiques sont fusionnées par matériau
// pour tenir le budget d'appels de dessin.
import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';

const PI = Math.PI;

// Les pièces mates partagent un seul matériau à couleurs par sommet (« structure ») : un appel de
// dessin par groupe au lieu d'un par teinte. Le cuivre garde le sien (métal), le verre et les
// émissifs aussi (le site les reconnaît à leur nom).
const TEINTES = {
  coque: '#e9e4d8', gris: '#8d877c', sombre: '#1d2636', toits: '#9a4a2a',
  sol: '#ffffff', vegetal: '#ffffff', maisons: '#ffffff',
};
function materiaux() {
  const std = (o) => new THREE.MeshStandardMaterial({ roughness: 0.62, metalness: 0.05, flatShading: true, ...o });
  return {
    structure: std({ color: '#ffffff', vertexColors: true, roughness: 0.66, metalness: 0.08, name: 'structure' }),
    cuivre: std({ color: '#b87333', roughness: 0.36, metalness: 0.85, name: 'cuivre' }),
    verre: std({ color: '#cfdde3', name: 'verre' }),
    lampe: std({ color: '#ffb35c', emissive: '#ffb35c', name: 'lampe' }),
    guidage: std({ color: '#ffcf8a', emissive: '#ffcf8a', name: 'guidage' }),
    noyau: std({ color: '#ff7a2a', emissive: '#ff7a2a', name: 'noyau' }),
    moteur: std({ color: '#ff9a4a', emissive: '#ff9a4a', name: 'moteur' }),
  };
}

// Accumulateur : géométries regroupées par (nom de maillage, matériau), fusionnées à la fin.
class Atelier {
  constructor(M) { this.M = M; this.lots = new Map(); }
  ajoute(nom, mat, g, m) {
    const geo = g.index ? g.toNonIndexed() : g.clone();
    if (!geo.attributes.uv) geo.setAttribute('uv', new THREE.Float32BufferAttribute(new Float32Array(geo.attributes.position.count * 2), 2));
    if (!geo.attributes.normal) geo.computeVertexNormals();
    const n = geo.attributes.position.count;
    const c = new Float32Array(n * 3).fill(1);
    if (TEINTES[mat]) {
      const t = new THREE.Color(TEINTES[mat]);
      for (let i = 0; i < n; i++) c.set([t.r, t.g, t.b], i * 3);
    }
    geo.setAttribute('color', new THREE.Float32BufferAttribute(c, 3));
    if (m) geo.applyMatrix4(m);
    // seuls les noms porteurs de sens (émissifs, verre) restent séparés
    const [grp, sous] = nom.split(':');
    const special = sous && (sous.startsWith('emissif_') || sous.startsWith('verre_'));
    const matFinal = TEINTES[mat] ? 'structure' : mat;
    const nomFinal = special ? nom : `${grp}:${grp}_${matFinal}`;
    const cle = nomFinal + '|' + matFinal;
    if (!this.lots.has(cle)) this.lots.set(cle, []);
    this.lots.get(cle).push(geo);
    return geo;
  }
  // couleur par sommet sur la dernière géométrie ajoutée
  teinte(geo, couleur) {
    const c = geo.attributes.color;
    for (let i = 0; i < c.count; i++) c.setXYZ(i, couleur.r, couleur.g, couleur.b);
  }
  sort(parent, nomGroupe) {
    for (const [cle, geos] of this.lots) {
      const [nom, mat] = cle.split('|');
      if (!nom.startsWith(nomGroupe + ':')) continue;
      const g = mergeGeometries(geos, false);
      g.computeBoundingSphere();
      const mesh = new THREE.Mesh(g, this.M[mat]);
      mesh.name = nom.slice(nomGroupe.length + 1);
      parent.add(mesh);
      geos.forEach((x) => x.dispose());
    }
  }
}

const mat4 = (p = [0, 0, 0], r = [0, 0, 0], s = [1, 1, 1]) => {
  const m = new THREE.Matrix4();
  m.compose(new THREE.Vector3(...p), new THREE.Quaternion().setFromEuler(new THREE.Euler(...r)), new THREE.Vector3(...s));
  return m;
};
// cylindre le long de Z
const cylZ = (r1, r2, h, seg = 8, open = false) => new THREE.CylinderGeometry(r1, r2, h, seg, 1, open).rotateX(PI / 2);
const tore = (R, r, rs = 6, ts = 24, arc = PI * 2) => new THREE.TorusGeometry(R, r, rs, ts, arc);
// poutre entre deux points
function poutre(a, b, r, seg = 6) {
  const A = new THREE.Vector3(...a), B = new THREE.Vector3(...b);
  const L = A.distanceTo(B);
  const g = new THREE.CylinderGeometry(r, r, L, seg, 1);
  const q = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), B.clone().sub(A).normalize());
  const m = new THREE.Matrix4().compose(A.clone().add(B).multiplyScalar(0.5), q, new THREE.Vector3(1, 1, 1));
  return g.applyMatrix4(m);
}

export function construireEspaceReserve(geoMonde) {
  const M = materiaux();
  const A = new Atelier(M);
  const station = new THREE.Group();
  station.name = 'station_espace_reserve';
  let seed = 31;
  const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
  const C = (h) => new THREE.Color(h);

  // ---------------------------------------------------------------- moyeu (fixe)
  const moyeu = new THREE.Group(); moyeu.name = 'moyeu'; station.add(moyeu);
  A.ajoute('moyeu:moyeu_noyau', 'gris', cylZ(2.4, 2.4, 24, 8));
  for (const z of [-11, -4.2, 4.2, 11]) A.ajoute('moyeu:moyeu_cerclage', 'cuivre', tore(9.6, 0.45, 4, 8), mat4([0, 0, z], [0, 0, PI / 8]));
  for (let k = 0; k < 8; k++) {
    const a = (k / 8) * PI * 2 + PI / 8, x = Math.cos(a) * 9.6, y = Math.sin(a) * 9.6;
    A.ajoute('moyeu:moyeu_cage', 'gris', poutre([x, y, 1.8], [x, y, 11], 0.32, 4));
    A.ajoute('moyeu:moyeu_cage', 'gris', poutre([x, y, -1.8], [x, y, -11], 0.32, 4));
    // câbles du noyau vers la cage
    A.ajoute('moyeu:moyeu_cables', 'cuivre', poutre([Math.cos(a) * 2.4, Math.sin(a) * 2.4, 6 + (k % 2) * 3], [x * 0.98, y * 0.98, 4.2], 0.09, 3));
    A.ajoute('moyeu:moyeu_cables', 'cuivre', poutre([Math.cos(a) * 2.4, Math.sin(a) * 2.4, -6 - (k % 2) * 3], [x * 0.98, y * 0.98, -4.2], 0.09, 3));
  }
  // sas sur le noyau
  for (const z of [-7, 7]) {
    for (let k = 0; k < 4; k++) {
      const a = (k / 4) * PI * 2;
      A.ajoute('moyeu:moyeu_sas', 'coque', new THREE.BoxGeometry(1.8, 2.2, 2.6), mat4([Math.cos(a) * 3.1, Math.sin(a) * 3.1, z], [0, 0, a]));
      A.ajoute('moyeu:emissif_moyeu', 'lampe', new THREE.BoxGeometry(0.15, 1.6, 0.25), mat4([Math.cos(a) * 4.05, Math.sin(a) * 4.05, z + 0.9], [0, 0, a]));
    }
  }
  // échine vers le quai (+Z) et vers la forge (-Z)
  A.ajoute('moyeu:echine', 'gris', cylZ(3, 3, 30, 8), mat4([0, 0, 27]));
  A.ajoute('moyeu:echine', 'gris', cylZ(3, 3, 30, 8), mat4([0, 0, -27]));
  A.ajoute('moyeu:modules', 'coque', cylZ(5.4, 5.4, 9, 10), mat4([0, 0, 28]));
  A.ajoute('moyeu:modules', 'coque', cylZ(4.8, 4.8, 7, 10), mat4([0, 0, -24]));
  for (const z of [23.5, 32.5]) A.ajoute('moyeu:cerclages_modules', 'cuivre', tore(5.5, 0.35, 4, 10), mat4([0, 0, z]));
  for (const z of [-20.5, -27.5]) A.ajoute('moyeu:cerclages_modules', 'cuivre', tore(4.9, 0.32, 4, 10), mat4([0, 0, z]));
  for (let k = 0; k < 10; k++) {
    const a = (k / 10) * PI * 2;
    A.ajoute('moyeu:emissif_moyeu', 'lampe', new THREE.BoxGeometry(0.7, 0.5, 0.12), mat4([Math.cos(a) * 5.45, Math.sin(a) * 5.45, 28 + (k % 2 ? 2 : -2)], [0, PI / 2, a], [1, 1, 1]));
  }
  A.sort(moyeu, 'moyeu');

  // ---------------------------------------------------------------- anneau habité (tourne autour de Z)
  const anneau = new THREE.Group(); anneau.name = 'anneau_rotatif'; station.add(anneau);
  const RA = 60, LA = 16;
  A.ajoute('anneau:anneau_collier', 'gris', cylZ(3.5, 3.5, 2.8, 10));
  for (let k = 0; k < 4; k++) {
    const a = (k / 4) * PI * 2 + PI / 4, cx = Math.cos(a), sy = Math.sin(a);
    A.ajoute('anneau:anneau_rayons', 'coque', poutre([cx * 3.4, sy * 3.4, 0], [cx * 51.5, sy * 51.5, 0], 1.15, 6));
    const px = -sy, py = cx;
    for (const o of [-1.9, 1.9]) A.ajoute('anneau:anneau_cables', 'cuivre', poutre([cx * 3.4 + px * o * 0.4, sy * 3.4 + py * o * 0.4, o * 0.3], [cx * 51.5 + px * o, sy * 51.5 + py * o, o * 0.6], 0.12, 3));
    for (const r of [18, 34]) A.ajoute('anneau:anneau_cabines', 'coque', new THREE.BoxGeometry(2.6, 3.2, 2.6), mat4([cx * r, sy * r, 0], [0, 0, a]));
  }
  // coque extérieure
  A.ajoute('anneau:anneau_coque', 'coque', cylZ(61.6, 61.6, LA, 48, true));
  // sol intérieur (normales vers l'axe), parcs et allées
  {
    const g = cylZ(RA, RA, LA - 0.4, 96, true);
    const geo = A.ajoute('anneau:anneau_sol', 'sol', g);
    const p = geo.attributes.position, col = geo.attributes.color;
    // retourne les faces vers l'intérieur
    for (let i = 0; i < p.count; i += 3) {
      for (const att of [p, col]) { const t = [att.getX(i + 1), att.getY(i + 1), att.getZ(i + 1)]; att.setXYZ(i + 1, att.getX(i + 2), att.getY(i + 2), att.getZ(i + 2)); att.setXYZ(i + 2, ...t); }
    }
    const herbe = C('#6f8a4e'), herbe2 = C('#8fa66b'), allee = C('#c9b99a');
    for (let i = 0; i < p.count; i++) {
      const a = Math.atan2(p.getY(i), p.getX(i)), z = p.getZ(i);
      const s = Math.sin(a * 7.0) * Math.cos(a * 3.0);
      const c = Math.abs(z) < 1.4 ? allee : s > 0.2 ? herbe : herbe2;
      col.setXYZ(i, c.r, c.g, c.b);
    }
  }
  // murs latéraux et verrière
  for (const z of [-LA / 2, LA / 2]) {
    A.ajoute('anneau:anneau_murs', 'coque', new THREE.RingGeometry(51, 61.6, 48, 1), mat4([0, 0, z + (z < 0 ? -0.04 : 0.04)], [z < 0 ? PI : 0, 0, 0]));
    A.ajoute('anneau:anneau_murs', 'coque', new THREE.RingGeometry(51, 61.6, 48, 1), mat4([0, 0, z], [z < 0 ? 0 : PI, 0, 0]));
  }
  A.ajoute('anneau:verre_anneau', 'verre', cylZ(51.2, 51.2, LA, 40, true));
  for (let k = 0; k < 12; k++) {
    const a = (k / 12) * PI * 2;
    A.ajoute('anneau:anneau_cerclage', 'cuivre', new THREE.BoxGeometry(1.1, 1.6, LA + 0.8), mat4([Math.cos(a) * 62.1, Math.sin(a) * 62.1, 0], [0, 0, a]));
    for (const z of [-LA / 2 - 0.3, LA / 2 + 0.3]) A.ajoute('anneau:anneau_cerclage', 'cuivre', new THREE.BoxGeometry(10.6, 1.6, 0.4), mat4([Math.cos(a) * 56.6, Math.sin(a) * 56.6, z], [0, 0, a]));
    A.ajoute('anneau:anneau_arceaux', 'gris', new THREE.BoxGeometry(0.35, 0.35, LA), mat4([Math.cos(a + 0.13) * 51.3, Math.sin(a + 0.13) * 51.3, 0], [0, 0, a]));
  }
  // fenêtres sur les flancs
  for (let k = 0; k < 120; k++) {
    const a = (k / 120) * PI * 2;
    if (k % 10 === 0) continue;
    for (const z of [-LA / 2 - 0.08, LA / 2 + 0.08]) {
      A.ajoute('anneau:emissif_fenetres_anneau', 'lampe', new THREE.BoxGeometry(0.9, 1.1, 0.1), mat4([Math.cos(a) * 58.4, Math.sin(a) * 58.4, z], [0, 0, a]));
    }
  }
  // maisons sur la face intérieure
  const blanc = [C('#efe9dc'), C('#e7dcc6'), C('#f3eee3'), C('#dcd2bf')];
  for (let k = 0; k < 150; k++) {
    const a = rnd() * PI * 2;
    const z = (rnd() < 0.5 ? -1 : 1) * (2.2 + rnd() * 4.6);
    const w = 2.4 + rnd() * 2.6, h = 2.2 + rnd() * 2.2, dd = 2.4 + rnd() * 2.2;
    const r = RA - h / 2;
    const m = mat4([Math.cos(a) * r, Math.sin(a) * r, z], [0, 0, a + PI / 2]);
    const gm = A.ajoute('anneau:anneau_maisons', 'maisons', new THREE.BoxGeometry(w, h, dd), m);
    A.teinte(gm, blanc[k % 4]);
    const toit = new THREE.CylinderGeometry(0.01, w * 0.62, 1.4, 4, 1).rotateY(PI / 4);
    A.ajoute('anneau:anneau_toits', 'toits', toit, mat4([Math.cos(a) * (RA - h - 0.7), Math.sin(a) * (RA - h - 0.7), z], [0, 0, a + PI / 2], [1, 1, dd / w]));
    if (k % 2 === 0) {
      const rf = RA - h * 0.55;
      A.ajoute('anneau:emissif_fenetres_anneau', 'lampe', new THREE.BoxGeometry(0.7, 0.6, 0.08), mat4([Math.cos(a) * rf, Math.sin(a) * rf, z + (z > 0 ? -dd / 2 - 0.05 : dd / 2 + 0.05)], [0, 0, a + PI / 2]));
    }
  }
  // arbres
  for (let k = 0; k < 90; k++) {
    const a = rnd() * PI * 2, z = (rnd() - 0.5) * 12;
    if (Math.abs(z) < 1.8) continue;
    const t = 1.2 + rnd() * 1.6;
    const g = new THREE.IcosahedronGeometry(t, 0);
    const gm = A.ajoute('anneau:anneau_arbres', 'vegetal', g, mat4([Math.cos(a) * (RA - t - 0.6), Math.sin(a) * (RA - t - 0.6), z]));
    A.teinte(gm, rnd() < 0.5 ? C('#5f7d4a') : C('#7c9658'));
  }
  A.sort(anneau, 'anneau');

  // ---------------------------------------------------------------- quai (+Z)
  const quai = new THREE.Group(); quai.name = 'quai'; station.add(quai);
  A.ajoute('quai:quai_module', 'coque', cylZ(6, 6, 9, 12), mat4([0, 0, 47]));
  A.ajoute('quai:quai_collier', 'cuivre', tore(5.1, 0.75, 6, 16), mat4([0, 0, 51.6]));
  A.ajoute('quai:quai_port', 'gris', cylZ(2.7, 2.7, 2.4, 10), mat4([0, 0, 52.6]));
  for (let k = 0; k < 4; k++) {
    const a = (k / 4) * PI * 2 + PI / 4, c = Math.cos(a), s = Math.sin(a);
    const base = [c * 5.6, s * 5.6, 48], bout = [c * 13, s * 13, 58.5];
    A.ajoute('quai:quai_bras', 'gris', poutre(base, bout, 0.55, 5));
    A.ajoute('quai:quai_bras_cuivre', 'cuivre', poutre([c * 5.8, s * 5.8, 46], [c * 9.5, s * 9.5, 46], 0.4, 5));
    for (let j = 1; j <= 4; j++) {
      const t = j / 4;
      A.ajoute(`quai:emissif_guidage_${j}`, 'guidage', new THREE.IcosahedronGeometry(j === 4 ? 0.55 : 0.32, 0), mat4([base[0] + (bout[0] - base[0]) * t, base[1] + (bout[1] - base[1]) * t, base[2] + (bout[2] - base[2]) * t]));
    }
  }
  for (let k = 0; k < 12; k++) {
    const a = (k / 12) * PI * 2;
    A.ajoute('quai:emissif_quai_hublots', 'lampe', new THREE.BoxGeometry(0.6, 0.6, 0.1), mat4([Math.cos(a) * 6.02, Math.sin(a) * 6.02, 45], [0, PI / 2, a]));
  }
  A.sort(quai, 'quai');

  // ---------------------------------------------------------------- navette (arrimée)
  const navette = new THREE.Group(); navette.name = 'navette'; navette.position.set(0, 0, 61.2); station.add(navette);
  A.ajoute('navette:navette_fuselage', 'coque', cylZ(2.5, 2.0, 9, 6), mat4([0, 0, 0.5]));
  A.ajoute('navette:navette_fuselage', 'coque', new THREE.ConeGeometry(2.0, 3.6, 6).rotateX(-PI / 2), mat4([0, 0, -5.8]));
  A.ajoute('navette:navette_vitre', 'sombre', new THREE.BoxGeometry(2.2, 0.8, 1.6), mat4([0, 1.25, -4.4], [0.35, 0, 0]));
  A.ajoute('navette:navette_bande', 'cuivre', new THREE.BoxGeometry(0.5, 0.16, 8.6), mat4([0, 2.05, 0.6]));
  for (const x of [-3.1, 3.1]) {
    A.ajoute('navette:navette_nacelles', 'gris', cylZ(0.95, 0.95, 5.2, 6), mat4([x, -0.4, 3.2]));
    A.ajoute('navette:navette_tuyeres', 'cuivre', cylZ(1.05, 0.75, 1.2, 6), mat4([x, -0.4, 6.3]));
    A.ajoute('navette:emissif_navette_moteurs', 'moteur', cylZ(0.62, 0.62, 0.12, 6), mat4([x, -0.4, 6.95]));
    A.ajoute('navette:navette_ailes', 'coque', new THREE.BoxGeometry(2.4, 0.22, 3.4), mat4([x * 0.62, -0.5, 2.6], [0, 0, x > 0 ? -0.12 : 0.12]));
    A.ajoute('navette:emissif_navette_feux', 'guidage', new THREE.IcosahedronGeometry(0.22, 0), mat4([x * 1.32, -0.25, 2.2]));
  }
  A.ajoute('navette:navette_aileron', 'coque', new THREE.BoxGeometry(0.25, 2.2, 2.4), mat4([0, 2.6, 3.8], [-0.35, 0, 0]));
  A.sort(navette, 'navette');

  // ---------------------------------------------------------------- forge (-Z)
  const forge = new THREE.Group(); forge.name = 'forge'; station.add(forge);
  const zf = -53;
  for (const z of [-42, -64]) A.ajoute('forge:forge_cerclage', 'cuivre', tore(12, 0.6, 4, 8), mat4([0, 0, z], [0, 0, PI / 8]));
  for (let k = 0; k < 8; k++) {
    const a = (k / 8) * PI * 2 + PI / 8;
    A.ajoute('forge:forge_cage', 'gris', poutre([Math.cos(a) * 12, Math.sin(a) * 12, -42], [Math.cos(a) * 12, Math.sin(a) * 12, -64], 0.42, 4));
  }
  for (const a of [0.3, 2.4, 4.4]) {
    A.ajoute('forge:forge_blindage', 'coque', new THREE.CylinderGeometry(12.6, 12.6, 18, 6, 1, true, a, 1.05).rotateX(PI / 2), mat4([0, 0, zf]));
  }
  for (const y of [-1, 1]) {
    A.ajoute('forge:forge_radiateurs', 'gris', new THREE.BoxGeometry(0.5, 16, 13), mat4([0, y * 21, -57]));
    for (let j = 0; j < 6; j++) A.ajoute('forge:forge_ailettes', 'cuivre', new THREE.BoxGeometry(2.2, 15, 0.25), mat4([0, y * 21, -62 + j * 2]));
  }
  A.ajoute('forge:forge_support', 'gris', cylZ(3.2, 3.2, 3, 8), mat4([0, 0, -41]));
  A.sort(forge, 'forge');
  const noyau = new THREE.Group(); noyau.name = 'forge_noyau'; noyau.position.set(0, 0, zf); forge.add(noyau);
  A.ajoute('noyau:emissif_noyau', 'noyau', new THREE.IcosahedronGeometry(3.3, 2));
  A.sort(noyau, 'noyau');
  const anneauxForge = [[6.2, [0, 0, 0]], [7.7, [PI / 2, 0, 0]], [9.2, [0, PI / 2, 0.4]]];
  anneauxForge.forEach(([R, rot], i) => {
    const g = new THREE.Group(); g.name = `forge_anneau_${i + 1}`; g.position.set(0, 0, zf); g.rotation.set(...rot); forge.add(g);
    A.ajoute(`fa${i}:forge_anneau_${i + 1}_maillage`, 'cuivre', tore(R, 0.5, 5, 30));
    for (let k = 0; k < 6; k++) {
      const a = (k / 6) * PI * 2;
      A.ajoute(`fa${i}:emissif_forge_anneau_${i + 1}`, 'noyau', new THREE.BoxGeometry(0.5, 0.5, 0.9), mat4([Math.cos(a) * R, Math.sin(a) * R, 0], [0, 0, a]));
    }
    A.sort(g, `fa${i}`);
  });

  // ---------------------------------------------------------------- serre (sous l'échine, dôme vers la planète)
  const serre = new THREE.Group(); serre.name = 'serre'; station.add(serre);
  const sc = new THREE.Vector3(0, -11.5, 20);
  A.ajoute('serre:serre_pylone', 'gris', poutre([0, -2.5, 20], [0, -10.5, 20], 1.2, 6));
  A.ajoute('serre:serre_socle', 'coque', new THREE.CylinderGeometry(10.8, 10.8, 1.2, 12), mat4([sc.x, sc.y + 0.6, sc.z]));
  A.ajoute('serre:serre_cerclage', 'cuivre', tore(10.8, 0.35, 4, 12), mat4([sc.x, sc.y, sc.z], [PI / 2, 0, 0]));
  {
    // dôme géodésique : moitié basse d'un icosaèdre subdivisé, avec ses montants
    const ico = new THREE.IcosahedronGeometry(10.6, 1);
    const p = ico.attributes.position;
    const tris = [];
    const aretes = new Map();
    const v = [new THREE.Vector3(), new THREE.Vector3(), new THREE.Vector3()];
    for (let i = 0; i < p.count; i += 3) {
      for (let j = 0; j < 3; j++) v[j].fromBufferAttribute(p, i + j);
      if ((v[0].y + v[1].y + v[2].y) / 3 > 0.8) continue;
      for (let j = 0; j < 3; j++) { const w = v[j].clone(); w.y = Math.min(w.y, 0); tris.push(w.x, w.y, w.z); }
      for (let j = 0; j < 3; j++) {
        const a = v[j], b = v[(j + 1) % 3];
        if (a.y > 0.01 && b.y > 0.01) continue;
        const k = [a, b].map((x) => `${x.x.toFixed(2)},${Math.min(x.y, 0).toFixed(2)},${x.z.toFixed(2)}`).sort().join('|');
        if (!aretes.has(k)) aretes.set(k, [a.clone().setY(Math.min(a.y, 0)), b.clone().setY(Math.min(b.y, 0))]);
      }
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(tris, 3));
    g.computeVertexNormals();
    A.ajoute('serre:verre_dome_serre', 'verre', g, mat4([sc.x, sc.y, sc.z]));
    for (const [a, b] of aretes.values()) {
      A.ajoute('serre:serre_montants', 'coque', poutre([a.x + sc.x, a.y + sc.y, a.z + sc.z], [b.x + sc.x, b.y + sc.y, b.z + sc.z], 0.16, 4));
    }
  }
  // bacs, plantes et passerelle sur le plancher (le « haut » de la serre pointe vers -Y)
  const yPlancher = sc.y - 0.05;
  A.ajoute('serre:serre_passerelle', 'gris', new THREE.BoxGeometry(2.2, 0.25, 17), mat4([0, yPlancher - 0.12, sc.z]));
  for (const x of [-5.4, -2.8, 2.8, 5.4]) {
    const L = Math.abs(x) > 4 ? 10 : 15;
    A.ajoute('serre:serre_bacs', 'coque', new THREE.BoxGeometry(1.8, 0.9, L), mat4([x, yPlancher - 0.45, sc.z]));
    A.ajoute('serre:emissif_serre_rampes', 'lampe', new THREE.BoxGeometry(0.08, 0.08, L * 0.9), mat4([x + (x > 0 ? -0.95 : 0.95), yPlancher - 0.86, sc.z]));
    for (let j = 0; j < Math.floor(L / 1.1); j++) {
      const t = 0.28 + rnd() * 0.36;
      const plante = rnd() < 0.5 ? new THREE.ConeGeometry(t * 0.7, t * 1.9, 5).rotateX(PI) : new THREE.IcosahedronGeometry(t * 0.75, 0);
      const gm = A.ajoute('serre:serre_plantes', 'vegetal', plante, mat4([x + (rnd() - 0.5) * 0.8, yPlancher - 0.9 - t * 0.8, sc.z - L / 2 + 0.6 + j * 1.1]));
      A.teinte(gm, rnd() < 0.5 ? C('#5f7d4a') : C('#8fa66b'));
    }
  }
  A.sort(serre, 'serre');

  // ---------------------------------------------------------------- observatoire (plateforme sous l'échine, côté planète)
  const obs = new THREE.Group(); obs.name = 'observatoire'; station.add(obs);
  const oc = new THREE.Vector3(0, -34, -31);
  A.ajoute('obs:observatoire_pylone', 'gris', poutre([0, -2.6, -31], [0, -32.6, -31], 1.1, 6));
  A.ajoute('obs:observatoire_plateforme', 'coque', new THREE.CylinderGeometry(7.4, 6.6, 1.4, 12), mat4([oc.x, oc.y + 0.7, oc.z]));
  A.ajoute('obs:observatoire_rambarde', 'cuivre', tore(7.0, 0.09, 3, 24), mat4([oc.x, oc.y + 2.1, oc.z], [PI / 2, 0, 0]));
  for (let k = 0; k < 12; k++) {
    const a = (k / 12) * PI * 2;
    A.ajoute('obs:observatoire_poteaux', 'cuivre', poutre([oc.x + Math.cos(a) * 7, oc.y + 1.4, oc.z + Math.sin(a) * 7], [oc.x + Math.cos(a) * 7, oc.y + 2.1, oc.z + Math.sin(a) * 7], 0.07, 3));
  }
  // coupole ouverte : arceaux qui se rejoignent au sommet (côté échine)
  for (let k = 0; k < 6; k++) {
    const a = (k / 6) * PI * 2 + 0.3;
    const arc = new THREE.TorusGeometry(7.2, 0.28, 4, 12, PI / 2);
    A.ajoute('obs:observatoire_arceaux', 'coque', arc, mat4([oc.x, oc.y + 1.4, oc.z], [0, -a, 0]));
  }
  A.ajoute('obs:verre_coupole', 'verre', new THREE.SphereGeometry(7.15, 14, 5, 0.9, 2.6, 0.12, PI / 2 - 0.12), mat4([oc.x, oc.y + 1.4, oc.z]));
  for (let k = 0; k < 16; k++) {
    const a = (k / 16) * PI * 2;
    A.ajoute('obs:emissif_observatoire_sol', 'lampe', new THREE.BoxGeometry(0.5, 0.06, 0.12), mat4([oc.x + Math.cos(a) * 6.3, oc.y + 1.43, oc.z + Math.sin(a) * 6.3], [0, -a, 0]));
  }
  A.sort(obs, 'obs');
  const tel = new THREE.Group(); tel.name = 'observatoire_telescope'; tel.position.set(oc.x - 1.6, oc.y + 1.4, oc.z + 1.2); obs.add(tel);
  A.ajoute('tel:telescope_pied', 'gris', new THREE.CylinderGeometry(0.7, 1.1, 2.2, 8), mat4([0, 1.1, 0]));
  A.ajoute('tel:telescope_fourche', 'cuivre', new THREE.BoxGeometry(1.8, 1.0, 0.6), mat4([0, 2.5, 0]));
  A.ajoute('tel:telescope_tube', 'coque', new THREE.CylinderGeometry(0.62, 0.78, 6.4, 10), mat4([0.4, 3.6, -1.6], [-1.0, 0, -0.25]));
  A.ajoute('tel:telescope_bagues', 'cuivre', new THREE.CylinderGeometry(0.84, 0.84, 0.35, 10), mat4([0.55, 4.6, -2.9], [-1.0, 0, -0.25]));
  A.ajoute('tel:telescope_bagues', 'cuivre', new THREE.CylinderGeometry(0.8, 0.8, 0.3, 10), mat4([0.15, 2.9, -0.6], [-1.0, 0, -0.25]));
  A.sort(tel, 'tel');

  // ---------------------------------------------------------------- antennes (au-dessus de l'échine, côté quai)
  const ant = new THREE.Group(); ant.name = 'antennes'; station.add(ant);
  const ac = new THREE.Vector3(0, 9.5, 34);
  A.ajoute('ant:antennes_pylone', 'gris', poutre([0, 2.6, 34], [0, 9, 34], 1.1, 6));
  A.ajoute('ant:antennes_plateforme', 'coque', new THREE.BoxGeometry(24, 0.9, 15), mat4([ac.x, ac.y, ac.z]));
  for (const [w, d, x, z] of [[24.4, 0.4, 0, -7.5], [24.4, 0.4, 0, 7.5], [0.4, 15.4, -12, 0], [0.4, 15.4, 12, 0]]) {
    A.ajoute('ant:antennes_bord', 'cuivre', new THREE.BoxGeometry(w, 0.35, d), mat4([ac.x + x, ac.y + 0.6, ac.z + z]));
  }
  for (const [x, z, h] of [[-10.5, 29, 9], [10.8, 39.5, 7], [11, 28.5, 5.5]]) {
    A.ajoute('ant:antennes_mats', 'gris', poutre([x, ac.y, z], [x, ac.y + h, z], 0.12, 4));
    A.ajoute('ant:emissif_balise', 'guidage', new THREE.IcosahedronGeometry(0.3, 0), mat4([x, ac.y + h + 0.2, z]));
  }
  A.sort(ant, 'ant');
  const paraboles = [[-5.5, 31, 3.3], [5, 37.5, 3.6], [6.5, 29.5, 1.9]];
  const profil = [];
  for (let i = 0; i <= 8; i++) { const r = i / 8; profil.push(new THREE.Vector2(r, r * r * 0.45)); }
  paraboles.forEach(([x, z, R], i) => {
    const g = new THREE.Group(); g.name = `antenne_parabole_${i + 1}`; g.position.set(x, ac.y + 0.45, z); ant.add(g);
    A.ajoute(`par${i}:parabole_pied`, 'gris', new THREE.CylinderGeometry(0.22 * R, 0.32 * R, 1.3 * R, 6), mat4([0, 0.65 * R, 0]));
    const coupe = new THREE.LatheGeometry(profil, 12).scale(R, R, R);
    coupe.translate(0, -0.1 * R, 0);
    A.ajoute(`par${i}:parabole_coupe`, 'coque', coupe, mat4([0, 1.45 * R, 0], [-0.55, 0, 0.2]));
    A.ajoute(`par${i}:parabole_source`, 'gris', poutre([0, 1.45 * R, 0], [0, 2.05 * R, -0.33 * R], 0.05 * R, 3));
    A.sort(g, `par${i}`);
  });

  // ---------------------------------------------------------------- panneaux solaires
  const pan = new THREE.Group(); pan.name = 'panneaux_solaires'; station.add(pan);
  A.ajoute('pan:panneaux_poutre', 'gris', poutre([-104, 0, -18], [104, 0, -18], 0.6, 6));
  A.ajoute('pan:panneaux_collier', 'cuivre', cylZ(3.6, 3.6, 2.4, 10), mat4([0, 0, -18]));
  for (const s of [-1, 1]) {
    for (const x of [72, 84, 96]) {
      A.ajoute('pan:panneaux_cellules', 'sombre', new THREE.BoxGeometry(10.6, 26, 0.22), mat4([s * x, 0, -18]));
      A.ajoute('pan:panneaux_cadres', 'cuivre', new THREE.BoxGeometry(11.2, 0.35, 0.36), mat4([s * x, 13.1, -18]));
      A.ajoute('pan:panneaux_cadres', 'cuivre', new THREE.BoxGeometry(11.2, 0.35, 0.36), mat4([s * x, -13.1, -18]));
      A.ajoute('pan:panneaux_cadres', 'cuivre', new THREE.BoxGeometry(0.3, 26, 0.3), mat4([s * x, 0, -18.05]));
    }
  }
  A.sort(pan, 'pan');

  // ---------------------------------------------------------------- caméras et ancres des haltes
  const vide = (nom, p, parent = station) => { const o = new THREE.Object3D(); o.name = nom; o.position.set(...p); parent.add(o); return o; };
  vide('ancre_quai', [0, 0, 64]);
  vide('cam_quai', [56, 15, 20]);
  vide('ancre_moyeu', [0, 0, -3]);
  vide('cam_moyeu', [3.2, 6.6, 9.8]);
  // l'anneau habité : les vides sont enfants de l'anneau et tournent avec lui
  const ra = 56.4, a0 = -0.42;
  vide('cam_anneau', [Math.cos(a0) * ra, Math.sin(a0) * ra, 2.4], anneau);
  vide('ancre_anneau', [Math.cos(a0 + 0.62) * 57.5, Math.sin(a0 + 0.62) * 57.5, -0.8], anneau);
  const camAnneau = anneau.getObjectByName('cam_anneau');
  // « haut » de la caméra = vers l'axe : axe local Y du vide orienté vers le centre
  camAnneau.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), new THREE.Vector3(-Math.cos(a0), -Math.sin(a0), 0));
  vide('ancre_serre', [-2.0, -19.5, 11.5]);
  const camSerre = vide('cam_serre', [3.4, -14.2, 27.8]);
  camSerre.rotation.set(0, 0, PI); // dans la serre, le haut pointe vers -Y
  vide('ancre_forge', [0, 0, zf]);
  vide('cam_forge', [15, 9, -31]);
  vide('ancre_antennes', [-2, 6, 22]);
  vide('cam_antennes', [12, 25, 52]);
  // observatoire : la caméra regarde vers le bord de la planète, à travers les arceaux
  const camObs = new THREE.Vector3(oc.x + 1.8, oc.y + 3.2, oc.z - 4.9);
  vide('cam_observatoire', camObs.toArray());
  {
    const C0 = geoMonde.C, R = geoMonde.R;
    const versC = C0.clone().sub(camObs);
    const dist = versC.length(); versC.normalize();
    const rp = Math.asin(R / dist);
    // bord de la planète du côté -X (gauche vu depuis +Z), un peu au-dessus
    const lat = new THREE.Vector3(-1, 0.25, 0.1).addScaledVector(versC, -new THREE.Vector3(-1, 0.25, 0.1).dot(versC)).normalize();
    const bord = versC.clone().multiplyScalar(Math.cos(rp * 0.62)).addScaledVector(lat, Math.sin(rp * 0.62)).normalize();
    vide('ancre_observatoire', camObs.clone().addScaledVector(bord, 60).toArray());
  }
  // haltes cosmiques : calculées par le site, mais présentes pour respecter le contrat
  vide('ancre_approche', [0, -40, -34]); vide('cam_approche', [-329.7, 357.4, 786.1]);
  vide('ancre_anneaux', [0, -700, 0]); vide('cam_anneaux', [-200, -800, 400]);
  vide('ancre_lever', [0, 0, 0]); vide('cam_lever', [-400, 300, 600]);

  station.updateMatrixWorld(true);
  return station;
}
