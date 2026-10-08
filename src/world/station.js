// La station : chargement du glb produit par Blender (ou de l'espace réservé), matériaux selon les
// préfixes du contrat (emissif_, verre_), animations (anneau, navette, forge, télescope, paraboles,
// clignotants) et petits effets ajoutés en code (halo du réacteur, signal radio, pollen de la serre).
import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { MeshoptDecoder } from 'three/addons/libs/meshopt_decoder.module.js';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { construireEspaceReserve } from './espace-reserve.js';
import { enrichir } from './materiaux.js';
import { ANNEAU_HABITE } from '../config.js';

// ------------------------------------------------------------------ chargement
export async function chargerGlb(url, surProgres) {
  let res;
  try { res = await fetch(url, { cache: 'no-cache' }); } catch { return null; }
  if (!res.ok) return null;
  if ((res.headers.get('content-type') || '').includes('text/html')) return null;
  const total = +res.headers.get('content-length') || 0;
  let buf;
  if (res.body && total > 0) {
    const lecteur = res.body.getReader();
    const morceaux = [];
    let recu = 0;
    for (;;) {
      const { done, value } = await lecteur.read();
      if (done) break;
      morceaux.push(value);
      recu += value.length;
      surProgres(Math.min(1, recu / total));
    }
    buf = await new Blob(morceaux).arrayBuffer();
  } else {
    buf = await res.arrayBuffer();
  }
  if (buf.byteLength < 20 || new DataView(buf).getUint32(0, true) !== 0x46546c67) return null; // « glTF »
  const loader = new GLTFLoader();
  loader.setMeshoptDecoder(MeshoptDecoder);
  const gltf = await loader.parseAsync(buf, './');
  return gltf.scene;
}

// ------------------------------------------------------------------ matériaux
const herite = (o, prefixe) => { for (let x = o; x; x = x.parent) if (x.name && x.name.startsWith(prefixe)) return x.name; return null; };
const dans = (o, nom) => { for (let x = o; x; x = x.parent) if (x.name === nom) return true; return false; };

// Verre transparent à reflet rasant. Lot F : il s'efface à moins de quelques mètres de l'objectif (un
// rail qui traverse une verrière ne montre plus un pan de verre plaqué sur l'écran), et la voûte de
// l'anneau habité, vue de l'intérieur presque toujours en rasant, a son propre réglage : reflet rasant
// plafonné plus bas, reflets plus doux et normales lisses (avant : une bande blanche délavée en haut de
// l'image de la rue).
function materiauVerre({ voute = false } = {}) {
  const m = new THREE.MeshStandardMaterial({
    color: '#d6e4ea', transparent: true, opacity: voute ? 0.07 : 0.12, roughness: voute ? 0.18 : 0.05, metalness: 0.0,
    envMapIntensity: voute ? 0.7 : 1.8, depthWrite: false, side: THREE.DoubleSide, flatShading: !voute, name: 'verre',
  });
  m.forceSinglePass = true;
  const rasant = voute ? '0.26' : '0.62';
  m.onBeforeCompile = (sh) => {
    sh.fragmentShader = sh.fragmentShader.replace('#include <normal_fragment_maps>', `#include <normal_fragment_maps>
      float frV = pow(clamp(1.0 - abs(dot(normalize(vViewPosition), normal)), 0.0, 1.0), 2.5);
      diffuseColor.a = mix(diffuseColor.a, ${rasant}, frV);
      diffuseColor.a *= smoothstep(1.5, 6.0, length(vViewPosition));`);
  };
  m.customProgramCacheKey = () => (voute ? 'verre-voute-v2' : 'verre-v2');
  return m;
}

function forceEmissif(nom) {
  if (/noyau/.test(nom)) return 3.6;
  if (/guidage/.test(nom)) return 7;
  if (/balise|feu/.test(nom)) return 5;
  if (/moteur|reacteur|propuls/.test(nom) && !/forge/.test(nom)) return 6;
  if (/forge/.test(nom)) return 5;
  // lot H : cornets des paraboles, petits feux chauds sous le bloom
  if (/parabole|cornet/.test(nom)) return 5.5;
  return 3.2;
}

function preparerMateriaux(racine, env, anisotropie = 1) {
  const verre = materiauVerre();
  const verreVoute = materiauVerre({ voute: true });
  const anneauR = racine.getObjectByName('anneau_rotatif');
  const emissifs = [];
  const clignotants = [];
  // le noyau de la forge est lumineux même sans préfixe, sauf s'il contient déjà ses pièces émissives
  const noyau = racine.getObjectByName('forge_noyau');
  let noyauNomme = false;
  if (noyau) noyau.traverse((x) => { if (x !== noyau && x.name && x.name.startsWith('emissif_')) noyauNomme = true; });
  racine.traverse((o) => {
    if (!o.isMesh) return;
    const nv = herite(o, 'verre_');
    if (nv) { o.material = anneauR && dans(o, 'anneau_rotatif') ? verreVoute : verre; o.renderOrder = 5; return; }
    const ne = herite(o, 'emissif_') || (!noyauNomme && dans(o, 'forge_noyau') ? 'emissif_noyau' : null);
    if (ne) {
      const src = Array.isArray(o.material) ? o.material[0] : o.material;
      const m = (src && src.isMeshStandardMaterial ? src.clone() : new THREE.MeshStandardMaterial());
      const base = m.emissive && (m.emissive.r + m.emissive.g + m.emissive.b) > 0.05 ? m.emissive.clone() : m.color.clone();
      m.emissive = base;
      m.color.copy(base).multiplyScalar(0.25);
      m.emissiveIntensity = forceEmissif(ne);
      m.toneMapped = true;
      m.envMapIntensity = 0;
      o.material = m;
      const e = { mesh: o, mat: m, base: m.emissiveIntensity, nom: ne };
      emissifs.push(e);
      if (/guidage|balise|feu|clignot/.test(ne)) {
        const k = ne.match(/(\d+)\s*$/);
        e.phase = k ? (+k[1]) * 0.18 : Math.random();
        e.chasse = /guidage/.test(ne);
        clignotants.push(e);
      }
      return;
    }
    const mats = Array.isArray(o.material) ? o.material : [o.material];
    for (const m of mats) {
      if (!m || !m.isMeshStandardMaterial) continue;
      // textures du glb (navette) : mipmaps par défaut du chargeur, plus un filtrage anisotrope pour les
      // vues rasantes
      for (const t of [m.map, m.metalnessMap, m.roughnessMap, m.normalMap, m.emissiveMap]) {
        if (t && t.anisotropy < anisotropie) { t.anisotropy = anisotropie; t.needsUpdate = true; }
      }
      // lot G : reflets de la carte d'environnement de la scène (scene.environment, refaite à chaque halte)
      m.envMap = null;
      m.envMapIntensity = /cuivre|copper|metal/i.test(m.name) ? 1.0 : /sombre/.test(m.name) ? 0.8 : /navette/.test(m.name) ? 0.8 : 0.45;
      if (/cuivre|copper/i.test(m.name) && m.metalness < 0.5) { m.metalness = 0.85; m.roughness = Math.min(m.roughness, 0.4); }
    }
  });
  return { emissifs, clignotants, verre };
}

// ------------------------------------------------------------------ fusion des pièces fixes
// Le glb peut arriver avec des centaines de nœuds (une maison, un arbre, une nervure par nœud) :
// sans fusion, autant d'appels de dessin. On regroupe par zone du contrat et par matériau, sans
// toucher aux pièces animées, aux clignotants ni aux maillages instanciés.
const ANIMES = /^(forge_anneau|forge_noyau|observatoire_telescope|antenne_parabole|navette)/;
const ZONES = ['anneau_rotatif', 'moyeu', 'quai', 'serre', 'forge', 'observatoire', 'antennes', 'panneaux_solaires'];
const CLIGNE = /guidage|balise|feu|clignot/;

function versFloat32(g) {
  const out = new THREE.BufferGeometry();
  for (const [nom, att] of Object.entries(g.attributes)) {
    const n = att.count, k = att.itemSize, arr = new Float32Array(n * k);
    for (let i = 0; i < n; i++) for (let j = 0; j < k; j++) arr[i * k + j] = att.getComponent(i, j);
    out.setAttribute(nom, new THREE.BufferAttribute(arr, k));
  }
  if (g.index) out.setIndex(Array.from(g.index.array));
  return out;
}

function fusionnerFixes(racine) {
  racine.updateMatrixWorld(true);
  const lots = new Map();
  racine.traverse((o) => {
    if (!o.isMesh || o.isSkinnedMesh || Array.isArray(o.material)) return;
    if (o.isInstancedMesh && o.instanceColor) return; // couleurs par instance : on garde l'instanciation
    for (let x = o; x && x !== racine; x = x.parent) if (ANIMES.test(x.name)) return;
    const em = herite(o, 'emissif_'), ve = herite(o, 'verre_');
    if (em && (CLIGNE.test(em) || /signal/.test(em))) return;
    const g = o.geometry;
    if (g.morphAttributes && Object.keys(g.morphAttributes).length) return;
    let zone = racine;
    for (let x = o.parent; x && x !== racine; x = x.parent) if (ZONES.includes(x.name)) { zone = x; break; }
    const sig = Object.keys(g.attributes).sort().join(',') + (g.index ? '|i' : '|n');
    const cle = `${zone.uuid}|${o.material.uuid}|${em ? 'e' : ''}${ve ? 'v' : ''}|${sig}`;
    if (!lots.has(cle)) lots.set(cle, { zone, mat: o.material, em, ve, meshes: [] });
    lots.get(cle).meshes.push(o);
  });
  let avant = 0, apres = 0;
  const inv = new THREE.Matrix4(), m = new THREE.Matrix4(), mi = new THREE.Matrix4();
  for (const lot of lots.values()) {
    avant += lot.meshes.length;
    if (lot.meshes.length < 2) { apres += lot.meshes.length; continue; }
    inv.copy(lot.zone.matrixWorld).invert();
    // les maillages instanciés sont cuits instance par instance dans le maillage fusionné
    const geos = [];
    for (const o of lot.meshes) {
      const base = versFloat32(o.geometry);
      if (o.isInstancedMesh) {
        for (let k = 0; k < o.count; k++) {
          o.getMatrixAt(k, mi);
          m.multiplyMatrices(inv, o.matrixWorld).multiply(mi);
          geos.push(base.clone().applyMatrix4(m));
        }
      } else {
        m.multiplyMatrices(inv, o.matrixWorld);
        geos.push(base.applyMatrix4(m));
      }
    }
    let fusion = null;
    try { fusion = mergeGeometries(geos, false); } catch (e) { fusion = null; }
    if (!fusion) { apres += lot.meshes.length; continue; }
    fusion.computeBoundingSphere();
    const nomZone = lot.zone === racine ? 'station' : lot.zone.name;
    const mesh = new THREE.Mesh(fusion, lot.mat);
    mesh.name = lot.em ? `emissif_${nomZone}_${lot.mat.name || 'lum'}` : lot.ve ? `verre_${nomZone}` : `${nomZone}_${lot.mat.name || 'mat'}`;
    lot.zone.add(mesh);
    for (const o of lot.meshes) o.parent.remove(o);
    apres += 1;
  }
  return { avant, apres };
}

// ------------------------------------------------------------------ fusions animées dans le shader
// Les paraboles (lacet lent autour de leur pied) et les feux qui clignotent sont regroupés en un
// maillage par matériau ; le mouvement et le rythme sont calculés sur le GPU à partir d'attributs
// par sommet (pivot, phase), ce qui économise un appel de dessin par pièce.
function fusionAnimee(morceaux, racine, nom, injecter) {
  // morceaux : [{ mesh, attrs: { aPivot: [x,y,z], aPhase: p, aMode: m } }]
  const parMat = new Map();
  racine.updateMatrixWorld(true);
  const inv = new THREE.Matrix4().copy(racine.matrixWorld).invert();
  const m = new THREE.Matrix4();
  const reps = new Map();
  const signature = (x) => [x.type, x.name, x.color && x.color.getHexString(), x.emissive && x.emissive.getHexString(), x.emissiveIntensity, x.transparent, x.vertexColors].join('|');
  for (const mo of morceaux) {
    const k = signature(mo.mesh.material);
    if (!reps.has(k)) reps.set(k, mo.mesh.material);
    const mat = reps.get(k);
    if (!parMat.has(mat)) parMat.set(mat, []);
    const g = versFloat32(mo.mesh.geometry);
    m.multiplyMatrices(inv, mo.mesh.matrixWorld);
    g.applyMatrix4(m);
    const n = g.attributes.position.count;
    for (const [cle, v] of Object.entries(mo.attrs)) {
      const k = Array.isArray(v) ? v.length : 1;
      const arr = new Float32Array(n * k);
      for (let i = 0; i < n; i++) { if (k === 1) arr[i] = v; else arr.set(v, i * k); }
      g.setAttribute(cle, new THREE.BufferAttribute(arr, k));
    }
    parMat.get(mat).push({ g, mesh: mo.mesh });
  }
  const sorties = [];
  for (const [mat, liste] of parMat) {
    const sig = (x) => Object.keys(x.attributes).sort().join(',') + (x.index ? 'i' : 'n');
    const groupes = new Map();
    for (const it of liste) { const k = sig(it.g); if (!groupes.has(k)) groupes.set(k, []); groupes.get(k).push(it); }
    for (const items of groupes.values()) {
      let fusion = null;
      try { fusion = mergeGeometries(items.map((x) => x.g), false); } catch (e) { fusion = null; }
      if (!fusion) continue;
      fusion.computeBoundingSphere();
      const mc = mat.clone();
      injecter(mc);
      const mesh = new THREE.Mesh(fusion, mc);
      mesh.name = `${nom}_${mat.name || 'mat'}`;
      racine.add(mesh);
      for (const x of items) x.mesh.parent.remove(x.mesh);
      sorties.push(mesh);
    }
  }
  return sorties;
}

// ------------------------------------------------------------------ outils
function boite(o) { return new THREE.Box3().setFromObject(o); }
function axeMin(b) {
  const s = b.getSize(new THREE.Vector3());
  if (s.x <= s.y && s.x <= s.z) return new THREE.Vector3(1, 0, 0);
  if (s.y <= s.x && s.y <= s.z) return new THREE.Vector3(0, 1, 0);
  return new THREE.Vector3(0, 0, 1);
}
function pivotAutour(objet, centreMonde) {
  const pivot = new THREE.Object3D();
  pivot.name = `pivot_${objet.name}`;
  const parent = objet.parent;
  parent.updateMatrixWorld(true);
  pivot.position.copy(parent.worldToLocal(centreMonde.clone()));
  parent.add(pivot);
  pivot.updateMatrixWorld(true);
  pivot.attach(objet);
  return pivot;
}
const easeOut = (x) => 1 - Math.pow(1 - x, 3);
const smoother = (x) => { x = Math.min(1, Math.max(0, x)); return x * x * x * (x * (x * 6 - 15) + 10); };

// ------------------------------------------------------------------ station
export function creerStation(racine, geo, env, { estGlb, tempsReduit, anisotropie = 1 }) {
  const groupe = new THREE.Group();
  groupe.name = 'kepler9';
  groupe.add(racine);
  groupe.updateMatrixWorld(true);
  const nom = (n) => racine.getObjectByName(n);
  const tous = (re) => { const r = []; racine.traverse((o) => { if (re.test(o.name)) r.push(o); }); return r; };

  const fusion = estGlb ? fusionnerFixes(racine) : null;
  const { emissifs, clignotants } = preparerMateriaux(racine, env, anisotropie);

  // boîte et sphère englobantes (sans les vides)
  const bb = boite(racine);
  const centre = bb.getCenter(new THREE.Vector3());
  const rayon = bb.getSize(new THREE.Vector3()).length() / 2;

  // --- anneau habité : pivot à l'origine, axe = plus petite dimension (Z selon le contrat)
  const anneau = nom('anneau_rotatif');
  let pivotAnneau = null, axeAnneau = new THREE.Vector3(0, 0, 1);
  if (anneau) {
    axeAnneau = axeMin(boite(anneau));
    pivotAnneau = pivotAutour(anneau, new THREE.Vector3(0, 0, 0));
  }
  const omega = (Math.PI * 2) / ANNEAU_HABITE.periode;

  // --- forge
  const noyau = nom('forge_noyau');
  const posNoyau = noyau ? boite(noyau).getCenter(new THREE.Vector3()) : centre.clone();
  const anneauxForge = tous(/^forge_anneau_?\d/).sort((a, b) => a.name.localeCompare(b.name)).map((o, i) => {
    const c = boite(o).getCenter(new THREE.Vector3());
    const p = pivotAutour(o, c);
    const n = axeMin(boite(o));
    const ref = [new THREE.Vector3(1, 0, 0), new THREE.Vector3(0, 1, 0), new THREE.Vector3(0.6, 0.6, 0.5).normalize()][i % 3];
    let ax = new THREE.Vector3().crossVectors(n, ref);
    if (ax.lengthSq() < 1e-4) ax = new THREE.Vector3().crossVectors(n, new THREE.Vector3(0, 0, 1));
    ax.normalize();
    return { pivot: p, ax, vitesse: [0.55, -0.42, 0.3][i % 3], q0: p.quaternion.clone() };
  });

  // --- télescope : lacet autour de Y monde, autour de son origine
  const tel = nom('observatoire_telescope');
  const telQ0 = tel ? tel.quaternion.clone() : null;
  // --- paraboles : relevées avant fusion (pivot, taille) pour le signal radio
  const paraboles = tous(/^antenne_parabole/).filter((o) => { for (let x = o.parent; x; x = x.parent) if (/^antenne_parabole/.test(x.name)) return false; return true; })
    .map((o, i) => ({ o, ph: i * 1.7, pivot: o.getWorldPosition(new THREE.Vector3()), boite: boite(o) }))
    .filter((p) => !p.boite.isEmpty());
  const U_ANIM = { uTempsA: { value: 0 }, uAmp: { value: 0.22 } };

  // --- navette : approche et arrimage
  // Arrivée en courbe depuis le large, en descendant, du côté opposé à la caméra du quai ; alignement sur
  // l'axe d'arrimage avant que le nez n'atteigne le premier portique ; ligne droite dans l'axe à travers
  // les portiques. Le temps est réparti sur la longueur du chemin : la vitesse décroît sans à-coup
  // jusqu'à zéro au contact. Le nez suit la tangente et la navette s'incline dans les virages.
  const navette = nom('navette');
  const nav = { etat: 'attente', t: 0, p: 0, duree: 15 };
  let navMat = null, chemin = null;
  if (navette) {
    navette.updateMatrixWorld(true);
    navMat = navette.matrix.clone(); // repère local du parent
    const posArr = navette.position.clone();
    const posMonde = navette.getWorldPosition(new THREE.Vector3());
    const dirMonde = posMonde.clone().sub(centre);
    if (dirMonde.lengthSq() < 1) dirMonde.set(0, 0, 1);
    dirMonde.normalize();
    const parentInv = new THREE.Matrix4().copy(navette.parent.matrixWorld).invert();
    const dirLocal = dirMonde.clone().transformDirection(parentInv);
    const lat = new THREE.Vector3().crossVectors(dirLocal, new THREE.Vector3(0, 1, 0));
    if (lat.lengthSq() < 1e-3) lat.set(1, 0, 0);
    lat.normalize();
    const haut = new THREE.Vector3().crossVectors(lat, dirLocal).normalize();
    // longueur du couloir de portiques (boîte du quai le long de l'axe) et avancée du nez devant le vide
    const avancee = (b, d) => {
      let m = 0;
      for (let i = 0; i < 8; i++) {
        const c = new THREE.Vector3(i & 1 ? b.max.x : b.min.x, i & 2 ? b.max.y : b.min.y, i & 4 ? b.max.z : b.min.z);
        m = Math.max(m, c.sub(posMonde).dot(d));
      }
      return m;
    };
    const quai = nom('quai');
    const bq = quai ? boite(quai) : null;
    const couloir = bq && !bq.isEmpty() ? avancee(bq, dirMonde) : 30;
    const nez = avancee(boite(navette), dirMonde.clone().negate()) || 7;
    // l'alignement est acquis 8 m avant que le nez n'entre dans le couloir
    const dAxe = couloir + nez + 8;
    const point = (le, cote, ht) => posArr.clone().addScaledVector(dirLocal, le).addScaledVector(lat, cote).addScaledVector(haut, ht);
    const construire = (cote, ecart) => {
      const c = new THREE.CurvePath();
      c.add(new THREE.CubicBezierCurve3(
        point(dAxe + 230, cote * 150 * ecart, 60 * ecart),
        point(dAxe + 120, cote * 80 * ecart, 22 * ecart),
        point(dAxe + 40, 0, 0),
        point(dAxe, 0, 0)));
      c.add(new THREE.LineCurve3(point(dAxe, 0, 0), posArr.clone()));
      return c;
    };
    const courbe = construire(1, 1);
    chemin = { courbe, longueur: courbe.getLength(), construire, posArr, dAxe, q0: navette.quaternion.clone(), lat, haut, dirLocal, parentInv };
  }
  const moteurs = emissifs.filter((e) => dans(e.mesh, 'navette') && /moteur|reacteur|propuls/.test(e.nom));

  // --- effets ajoutés en code
  const effets = new THREE.Group();
  effets.name = 'effets_station';
  groupe.add(effets);
  // halo du réacteur
  const haloTex = (() => {
    const c = document.createElement('canvas'); c.width = c.height = 128;
    const g = c.getContext('2d');
    const r = g.createRadialGradient(64, 64, 0, 64, 64, 64);
    r.addColorStop(0, 'rgba(255,255,255,1)'); r.addColorStop(0.18, 'rgba(255,220,180,0.75)');
    r.addColorStop(0.45, 'rgba(255,140,60,0.22)'); r.addColorStop(1, 'rgba(255,90,20,0)');
    g.fillStyle = r; g.fillRect(0, 0, 128, 128);
    const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace; return t;
  })();
  const haloMat = new THREE.SpriteMaterial({ map: haloTex, color: new THREE.Color(1.8, 0.85, 0.35), blending: THREE.AdditiveBlending, depthWrite: false, transparent: true });
  const halo = new THREE.Sprite(haloMat);
  halo.position.copy(posNoyau);
  const rNoyau = noyau ? boite(noyau).getSize(new THREE.Vector3()).length() / 2 : 4;
  halo.scale.setScalar(rNoyau * 4.2);
  halo.renderOrder = 6;
  if (noyau) effets.add(halo);

  // signal radio : si le glb fournit son faisceau (emissif_signal), on lui donne un matériau additif
  // pulsé ; sinon on en crée un qui part de la plus grande parabole vers les étoiles
  let signal = null;
  const signauxGlb = [];
  racine.traverse((o) => { if (o.isMesh && /^emissif_signal/.test(herite(o, 'emissif_') || '')) signauxGlb.push(o); });
  const U_SIGNAL = { uTemps: { value: 0 }, uForce: { value: 0 } };
  const FRAG_SIGNAL = /* glsl */ `
    uniform float uTemps; uniform float uForce; varying float vT; varying float vBord;
    void main(){
      float pulse = 0.0;
      for (int i = 0; i < 3; i++) { float c = fract(uTemps * 0.22 - float(i) * 0.333); float e = (vT - c) * 18.0; pulse += exp(-e * e) * (1.0 - c); }
      float base = 0.35 * exp(-vT * 6.0) + 0.05 * (1.0 - vT);
      vec3 col = vec3(1.0, 0.72, 0.42) * (base + pulse * 1.6) * vBord * uForce;
      gl_FragColor = vec4(col, 1.0);
    }`;
  for (const o of signauxGlb) {
    o.geometry.computeBoundingBox();
    const bb2 = o.geometry.boundingBox, t = bb2.getSize(new THREE.Vector3());
    const axe2 = t.x >= t.y && t.x >= t.z ? new THREE.Vector3(1, 0, 0) : t.y >= t.z ? new THREE.Vector3(0, 1, 0) : new THREE.Vector3(0, 0, 1);
    const c2 = bb2.getCenter(new THREE.Vector3());
    const demi = axe2.clone().multiplyScalar(axe2.dot(t) / 2);
    let A2 = c2.clone().sub(demi), B2 = c2.clone().add(demi);
    // le départ est l'extrémité la plus proche des paraboles
    const ref = paraboles.length ? paraboles[0].pivot.clone() : centre.clone();
    const aW = A2.clone().applyMatrix4(o.matrixWorld), bW = B2.clone().applyMatrix4(o.matrixWorld);
    if (bW.distanceTo(ref) < aW.distanceTo(ref)) [A2, B2] = [B2, A2];
    o.material = new THREE.ShaderMaterial({
      uniforms: { ...U_SIGNAL, uA: { value: A2 }, uB: { value: B2 }, uAxe: { value: axe2 } },
      vertexShader: /* glsl */ `
        uniform vec3 uA; uniform vec3 uB; uniform vec3 uAxe; varying float vT; varying float vBord;
        void main(){
          vec3 ab = uB - uA;
          vT = clamp(dot(position - uA, ab) / dot(ab, ab), 0.0, 1.0);
          vec3 rel = position - uA - ab * vT;
          vBord = 1.0;
          gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
        }`,
      fragmentShader: FRAG_SIGNAL,
      transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, side: THREE.DoubleSide,
    });
    o.renderOrder = 7;
  }
  if (paraboles.length && !signauxGlb.length) {
    const plusGrande = paraboles.map((p) => ({ p, s: p.boite.getSize(new THREE.Vector3()).length() })).sort((a, b) => b.s - a.s)[0].p;
    const depart = plusGrande.boite.getCenter(new THREE.Vector3());
    const dir = geo.d.clone().multiplyScalar(0.55).add(new THREE.Vector3(0, 1, 0)).add(new THREE.Vector3(-0.25, 0, 0.2)).normalize();
    const L = 2400;
    const g = new THREE.CylinderGeometry(0.6, 6, L, 12, 1, true).translate(0, L / 2, 0);
    const U = { uTemps: { value: 0 }, uForce: { value: 0 } };
    const m = new THREE.ShaderMaterial({
      uniforms: U,
      vertexShader: 'varying vec2 vUv; void main(){ vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.0); }',
      fragmentShader: /* glsl */ `
        uniform float uTemps; uniform float uForce; varying vec2 vUv;
        void main(){
          float y = vUv.y;
          float pulse = 0.0;
          for (int i = 0; i < 3; i++) { float c = fract(uTemps * 0.22 - float(i) * 0.333); float e = (y - c) * 38.0; pulse += exp(-e * e) * (1.0 - c); }
          float base = 0.45 * exp(-y * 30.0) + 0.07 * (1.0 - y);
          float bord = sqrt(max(sin(vUv.x * 3.14159), 0.0));
          vec3 col = vec3(1.0, 0.72, 0.42) * (base + pulse * 2.2) * bord * uForce;
          gl_FragColor = vec4(col, 1.0);
        }`,
      transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, side: THREE.DoubleSide,
    });
    signal = new THREE.Mesh(g, m);
    signal.position.copy(depart);
    signal.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), dir);
    signal.userData.dir0 = dir.clone();
    signal.renderOrder = 7;
    signal.frustumCulled = false;
    signal.userData.U = U;
    effets.add(signal);
  }

  // pollen et poussière lumineuse dans la serre
  let pollen = null;
  const serre = nom('serre');
  if (serre) {
    const b = boite(serre);
    const c = b.getCenter(new THREE.Vector3()), s = b.getSize(new THREE.Vector3());
    const n = 320;
    const pos = new Float32Array(n * 3);
    let sd = 5;
    const rnd = () => ((sd = (sd * 16807) % 2147483647) / 2147483647);
    for (let i = 0; i < n; i++) pos.set([(rnd() - 0.5) * s.x * 0.8, (rnd() - 0.5) * s.y * 0.8, (rnd() - 0.5) * s.z * 0.8], i * 3);
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    const U = { uTemps: { value: 0 }, uPixel: { value: 1 } };
    pollen = new THREE.Points(g, new THREE.ShaderMaterial({
      uniforms: U,
      vertexShader: /* glsl */ `
        uniform float uTemps; uniform float uPixel; varying float vA;
        void main(){
          vec3 p = position + vec3(sin(uTemps * 0.3 + position.y), cos(uTemps * 0.23 + position.x), sin(uTemps * 0.17 + position.z)) * 0.6;
          vec4 mv = modelViewMatrix * vec4(p, 1.0);
          gl_Position = projectionMatrix * mv;
          gl_PointSize = clamp(14.0 / -mv.z, 1.0, 4.0) * uPixel;
          vA = 0.5 + 0.5 * sin(uTemps * 1.3 + position.x * 7.0);
        }`,
      fragmentShader: 'varying float vA; void main(){ float a = smoothstep(0.5, 0.0, length(gl_PointCoord - 0.5)); gl_FragColor = vec4(vec3(1.0, 0.8, 0.5) * a * vA * 0.9, 1.0); }',
      transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
    }));
    pollen.position.copy(c);
    pollen.frustumCulled = false;
    pollen.userData.U = U;
    effets.add(pollen);
  }

  // paraboles fusionnées, lacet calculé dans le shader
  const morceauxP = [];
  paraboles.forEach((p) => p.o.traverse((x) => { if (x.isMesh) morceauxP.push({ mesh: x, attrs: { aPivot: p.pivot.toArray(), aPhase: p.ph } }); }));
  const injecterP = (mat) => {
    mat.onBeforeCompile = (sh) => {
      Object.assign(sh.uniforms, U_ANIM);
      sh.vertexShader = sh.vertexShader
        .replace('#include <common>', '#include <common>\nattribute vec3 aPivot;\nattribute float aPhase;\nuniform float uTempsA;\nuniform float uAmp;')
        .replace('#include <beginnormal_vertex>', `float angP = sin(uTempsA * 0.11 + aPhase) * uAmp;
float cP = cos(angP), sP = sin(angP);
vec3 objectNormal = vec3(cP * normal.x + sP * normal.z, normal.y, -sP * normal.x + cP * normal.z);
#ifdef USE_TANGENT
vec3 objectTangent = vec3(tangent.xyz);
#endif`)
        .replace('#include <begin_vertex>', `vec3 relP = position - aPivot;
vec3 transformed = aPivot + vec3(cP * relP.x + sP * relP.z, relP.y, -sP * relP.x + cP * relP.z);`);
    };
    mat.customProgramCacheKey = () => 'parabole-v1';
  };
  const parabolesFusion = morceauxP.length ? fusionAnimee(morceauxP, racine, 'paraboles', injecterP) : [];

  // feux qui clignotent (hors navette, qui bouge) : un maillage par matériau, rythme dans le shader
  const morceauxC = [];
  for (const e of clignotants) {
    if (dans(e.mesh, 'navette') || dans(e.mesh, 'anneau_rotatif')) continue;
    morceauxC.push({ mesh: e.mesh, attrs: { aPhase: e.phase, aMode: e.chasse ? 1 : 0 } });
  }
  const injecterC = (mat) => {
    mat.onBeforeCompile = (sh) => {
      Object.assign(sh.uniforms, U_ANIM);
      sh.vertexShader = sh.vertexShader
        .replace('#include <common>', '#include <common>\nattribute float aPhase;\nattribute float aMode;\nuniform float uTempsA;\nvarying float vRythme;')
        .replace('#include <begin_vertex>', `#include <begin_vertex>
float cC = fract(uTempsA * 0.9 - aPhase);
float chasse = 0.08 + 0.92 * exp(-(cC * 7.0) * (cC * 7.0));
float cB = fract(uTempsA * 0.72 + aPhase);
float bat = 0.04 + 0.96 * (exp(-cB * 30.0) + 0.6 * step(0.17, cB) * exp(-(cB - 0.17) * 30.0));
vRythme = mix(bat, chasse, aMode);`);
      sh.fragmentShader = sh.fragmentShader
        .replace('#include <common>', '#include <common>\nvarying float vRythme;')
        .replace('#include <emissivemap_fragment>', '#include <emissivemap_fragment>\ntotalEmissiveRadiance *= vRythme;');
    };
    mat.customProgramCacheKey = () => 'rythme-v1';
  };
  const clignotantsFusion = morceauxC.length ? fusionAnimee(morceauxC, racine, 'emissif_rythme', injecterC) : [];
  const clignotantsJs = clignotants.filter((e) => e.mesh.parent && (dans(e.mesh, 'navette') || dans(e.mesh, 'anneau_rotatif') || !clignotantsFusion.length));

  groupe.updateMatrixWorld(true);

  // lot G : matériaux soignés (cuivre poli, métaux satinés, coque mate) et lumière précalculée (atlas cuit
  // par Cycles, coordonnées « uv » du glb), après toutes les fusions (les clones des fusions animées aussi)
  racine.traverse((o) => {
    if (!o.isMesh || !o.material || Array.isArray(o.material)) return;
    const m = o.material;
    if (!m.isMeshStandardMaterial || herite(o, 'emissif_') || herite(o, 'verre_') || m.transparent) return;
    // lot H : les cornets émissifs des paraboles sont fusionnés avec elles (paraboles_emissif_*) : pas de cuivre
    if (/^emissif_/.test(m.name) || /^paraboles_emissif/.test(o.name)) return;
    const surNavette = dans(o, 'navette');
    // couleurs par sommet (glb) ou couleur de base (espace réservé, navette) : le cuivre est reconnu dans l'une ou l'autre
    const vc = !!m.vertexColors;
    const genre = /^paraboles_/.test(o.name) ? 'cuivre' : surNavette ? 'texture' : /metal|cuivre/i.test(m.name) ? (vc ? 'metal' : 'texture') : /coque/.test(m.name) && vc ? 'coque' : null;
    enrichir(m, { genre, lumiere: estGlb && !surNavette && !!o.geometry.attributes.uv && !!o.geometry.attributes.color });
  });

  // ------------------------------------------------------------------ animation
  let angleAnneau = 0;
  const qa = new THREE.Quaternion(), qb = new THREE.Quaternion(), qc = new THREE.Quaternion(), Y = new THREE.Vector3(0, 1, 0);
  const tangente = new THREE.Vector3(), tA = new THREE.Vector3(), tB = new THREE.Vector3(), tC = new THREE.Vector3();
  const mOr = new THREE.Matrix4(), ORIGINE = new THREE.Vector3(), Z_LOCAL = new THREE.Vector3(0, 0, 1);
  const vit = tempsReduit ? 0.25 : 1;
  // cap de la navette à l'abscisse s (m) : vers le point du chemin AV mètres plus loin ; tout au bout, l'axe
  // de la ligne droite d'arrimage
  const AV = 14, pN1 = new THREE.Vector3(), pN2 = new THREE.Vector3();
  const visNez = (sAbs, out) => {
    const L = chemin.longueur, sb = Math.min(L, Math.max(0, sAbs));
    chemin.courbe.getPoint(sb / L, pN1);
    chemin.courbe.getPoint(Math.min(L, sb + AV) / L, pN2);
    out.subVectors(pN2, pN1);
    const d = out.length();
    if (d < 1) return out.copy(chemin.dirLocal).negate();
    return out.divideScalar(d);
  };

  function animer(t, dt, info) {
    angleAnneau += omega * dt * (tempsReduit ? 0.35 : 1);
    if (pivotAnneau) pivotAnneau.quaternion.setFromAxisAngle(axeAnneau, angleAnneau);
    for (const a of anneauxForge) {
      qa.setFromAxisAngle(a.ax, t * a.vitesse * vit);
      a.pivot.quaternion.copy(a.q0).premultiply(qa);
    }
    if (tel) {
      // lacet autour de l'axe de sa monture (axe Y local), pas de l'axe du monde
      qa.setFromAxisAngle(Y, Math.sin(t * 0.16) * 0.42 * vit + Math.sin(t * 0.05) * 0.2);
      tel.quaternion.copy(telQ0).multiply(qa);
    }
    U_ANIM.uTempsA.value = t;
    U_ANIM.uAmp.value = 0.22 * vit;
    // navette
    if (navette && chemin) {
      if (nav.etat === 'approche') {
        nav.t += dt;
        nav.p = Math.min(1, nav.t / nav.duree);
        if (nav.p >= 1) nav.etat = 'arrimee';
      }
      if (nav.etat === 'attente') nav.p = 0;
      if (nav.etat === 'arrimee') nav.p = 1;
      // u = part de la longueur parcourue (CurvePath.getPoint est paramétré par la longueur) : la vitesse
      // décroît continûment jusqu'à zéro au contact, la fin de l'approche se fait au ralenti
      const u = nav.p >= 1 ? 1 : 1 - Math.pow(1 - nav.p, 2.6);
      const reste = (1 - u) * chemin.longueur;
      chemin.courbe.getPoint(Math.min(u, 1), navette.position);
      if (nav.etat === 'attente') navette.position.addScaledVector(chemin.haut, Math.sin(t * 0.4) * 1.5);
      // Orientation (lot F). Le nez vise un point situé AV mètres plus loin sur le chemin (poursuite) : le
      // cap converge en douceur vers l'axe d'arrimage bien avant la ligne droite, au lieu de suivre la
      // tangente, dont la vitesse de rotation sautait à la jonction courbe/droite (« elle se remet d'un
      // coup tout droit »). L'inclinaison suit le taux de lacet de ce cap, lissé sur 12 m, saturée en
      // douceur (tanh, 20° au plus), et s'efface entièrement sur les 45 m qui précèdent la ligne droite.
      const L = chemin.longueur, sNav = u * L;
      visNez(sNav, tangente);
      mOr.lookAt(tangente, ORIGINE, chemin.haut);
      qc.setFromRotationMatrix(mOr);
      visNez(sNav - 6, tA); visNez(sNav + 6, tB);
      const lacet = tC.crossVectors(tA, tB).dot(chemin.haut) / 12;
      const effacement = smoother((reste - chemin.dAxe) / 45);
      qb.setFromAxisAngle(Z_LOCAL, -0.35 * Math.tanh((lacet * 30) / 0.35) * effacement);
      qc.multiply(qb);
      // sur la ligne droite, la pose rejoint exactement la pose arrimée du glb
      navette.quaternion.copy(qc).slerp(chemin.q0, smoother(1 - reste / chemin.dAxe));
      const pousse = nav.etat === 'approche' ? (reste > chemin.dAxe ? 1 : 0.4 + 0.6 * Math.sin(t * 9) ** 2) : nav.etat === 'attente' ? 0.6 : 0.05;
      for (const e of moteurs) e.mat.emissiveIntensity = e.base * pousse;
    }
    // clignotants
    for (const e of clignotantsJs) {
      if (e.chasse) {
        const c = (t * 0.9 - e.phase) % 1;
        e.mat.emissiveIntensity = e.base * (0.08 + 0.92 * Math.exp(-Math.pow(((c + 1) % 1) * 7, 2)));
      } else {
        const cB = (((t * 0.72 + e.phase) % 1) + 1) % 1;
        e.mat.emissiveIntensity = e.base * (0.04 + 0.96 * (Math.exp(-cB * 30) + (cB >= 0.17 ? 0.6 * Math.exp(-(cB - 0.17) * 30) : 0)));
      }
    }
    // réacteur
    const respir = 0.82 + 0.18 * Math.sin(t * 1.7) + 0.06 * Math.sin(t * 7.3);
    haloMat.opacity = 0.75 * respir;
    halo.scale.setScalar(rNoyau * (3.9 + 0.4 * respir));
    for (const e of emissifs) if (/noyau/.test(e.nom)) e.mat.emissiveIntensity = e.base * respir;
    if (signal) {
      const loin = info.camera ? info.camera.distanceTo(signal.position) : 0;
      const f = info.signal * (1 - smoother((loin - 250) / 700));
      signal.visible = f > 0.01;
      signal.userData.U.uTemps.value = t;
      signal.userData.U.uForce.value = f;
    }
    if (signauxGlb.length) {
      U_SIGNAL.uTemps.value = t;
      U_SIGNAL.uForce.value = 0.25 + 0.75 * info.signal;
    }
    if (pollen) { pollen.userData.U.uTemps.value = t; pollen.userData.U.uPixel.value = info.pixel; }
  }

  return {
    groupe, racine, centre, rayon, estGlb, animer, fusion,
    axeAnneau, get angleAnneau() { return angleAnneau; }, pivotAnneau,
    // lot H : vitesse angulaire de l'anneau (rad/s), pour prévoir où il sera pendant un trajet
    get vitesseAnneau() { return omega * (tempsReduit ? 0.35 : 1); },
    // captures comparables (lot G) : angle de l'anneau déterminé par l'horloge figée
    fixerAngle(t) {
      angleAnneau = omega * t * (tempsReduit ? 0.35 : 1);
      if (pivotAnneau) { pivotAnneau.quaternion.setFromAxisAngle(axeAnneau, angleAnneau); pivotAnneau.updateMatrixWorld(true); }
    },
    posNoyau, navette: {
      existe: !!navette,
      demarrer() { if (nav.etat === 'attente') { nav.etat = 'approche'; nav.t = 0; } },
      attendre() { nav.etat = 'attente'; nav.t = 0; nav.p = 0; },
      arrimer() { nav.etat = 'arrimee'; nav.p = 1; },
      avancer(s) { if (nav.etat === 'approche') nav.t = Math.min(nav.duree, nav.t + s); },
      get etat() { return nav.etat; },
    },
    trouve: nom,
    // adapte l'approche à la caméra du quai : arrivée du côté opposé, au moins 18 m entre la navette et
    // l'objectif sur tout le chemin (sinon les écarts latéral et vertical de la courbe grandissent)
    cadrerNavette(camMonde) {
      if (!chemin || !camMonde) return null;
      const cam = camMonde.clone().applyMatrix4(chemin.parentInv);
      const cote = cam.clone().sub(chemin.posArr).dot(chemin.lat) > 0 ? -1 : 1;
      const p = new THREE.Vector3();
      let ecart = 1, dmin = 0;
      for (let essai = 0; essai < 8; essai++) {
        const c = chemin.construire(cote, ecart);
        dmin = Infinity;
        for (let i = 0; i <= 240; i++) { c.getPoint(i / 240, p); dmin = Math.min(dmin, p.distanceTo(cam)); }
        chemin.courbe = c;
        chemin.longueur = c.getLength();
        if (dmin >= 18) break;
        ecart *= 1.3;
      }
      return { cote, ecart: +ecart.toFixed(2), distanceMin: Math.round(dmin), alignement: Math.round(chemin.dAxe) };
    },
    // le faisceau part vers le ciel, dans l'axe de la vue du pont radio pour qu'on le voie filer
    orienterSignal(visee) {
      if (!signal || !visee) return;
      const d2 = visee.clone().multiplyScalar(0.8).add(new THREE.Vector3(0, 0.55, 0)).addScaledVector(geo.d, 0.2).normalize();
      signal.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), d2);
    },
    dansAnneau: (o) => !!(anneau && o && (() => { for (let x = o; x; x = x.parent) if (x === anneau) return true; return false; })()),
  };
}

export function stationParDefaut(geo) {
  return construireEspaceReserve(geo);
}
