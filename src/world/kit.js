// Objets du kit IA (lot G). Le glb de la station porte des vides `kit_<objet>_<nn>` (contrat de DA.md) ;
// ce module charge `assets/kit/<objet>.glb` ou `<objet>-bas.glb`, instancie les répétitions (une
// InstancedMesh par objet et par parent : celles posées sur l'anneau tournent avec lui), anime
// l'astronaute, le robot et les drones (on anime leur VIDE, jamais le maillage quantifié), n'affiche
// plus les petits objets quand ils ne font que quelques pixels, et passe aux versions -bas sur téléphone
// ou quand la qualité automatique baisse.
import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { MeshoptDecoder } from 'three/addons/libs/meshopt_decoder.module.js';
import { enrichir } from './materiaux.js';

// objets vus de près : version normale sur ordinateur. Les autres (coque de l'anneau, plateforme de
// fret) ne sont jamais vus à moins de 25 m : leur version -bas (texture 256 px) suffit partout.
const PROCHES = new Set(['astronaute', 'robot-jardinier', 'plante-a', 'plante-b', 'statue-fontaine',
  'banc-lampadaire', 'drone-maintenance', 'console-controle']);
// au-delà de cette distance (m, au bord de la sphère englobante du groupe), le groupe n'est plus dessiné
// (quelques pixels, ou caché par la structure : serre, coupole) ; un appel de dessin de moins par groupe
const LOIN = {
  'drone-maintenance': 100, 'astronaute': 120, 'robot-jardinier': 40, 'console-controle': 40, 'plante-a': 45,
  'plante-b': 45, 'banc-lampadaire': 120, 'statue-fontaine': 120, 'caisse-ravitaillement': 400,
};
// objets de la rue de l'anneau habité : visibles seulement depuis l'intérieur de l'anneau (axe = Z,
// sol à 60 m de l'axe, toit vitré à 48 m)
const DANS_ANNEAU = new Set(['banc-lampadaire', 'statue-fontaine']);
const dansAnneau = (p) => { const r = Math.hypot(p.x, p.y); return r > 38 && r < 63 && Math.abs(p.z) < 14; };
// objets de la coque extérieure de l'anneau : invisibles depuis l'intérieur de l'anneau (6 appels de moins)
const COQUE = new Set(['module-habitation', 'antenne-mat', 'reservoir', 'radiateur-pliable', 'conteneur-cargo', 'propulseurs']);
const LOIN_DEFAUT = 3000;
// objets dont les pièces orangées sont du cuivre (pas les plantes, ni le bois du banc) : cuivre poli
const CUIVRE = new Set(['astronaute', 'robot-jardinier', 'reservoir', 'module-habitation', 'propulseurs', 'antenne-mat',
  'conteneur-cargo', 'radiateur-pliable', 'drone-maintenance', 'console-controle', 'caisse-ravitaillement', 'statue-fontaine']);
const TAU = Math.PI * 2;

function textureHalo() {
  const c = document.createElement('canvas');
  c.width = c.height = 64;
  const g = c.getContext('2d');
  const r = g.createRadialGradient(32, 32, 0, 32, 32, 32);
  r.addColorStop(0, 'rgba(255,255,255,1)');
  r.addColorStop(0.25, 'rgba(255,214,170,0.55)');
  r.addColorStop(1, 'rgba(255,150,80,0)');
  g.fillStyle = r;
  g.fillRect(0, 0, 64, 64);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

export function creerKit(racine, { env = null, anisotropie = 1, base = 'assets/kit/', bas = false, compiler = null, calme = null, televerser = null } = {}) {
  racine.updateMatrixWorld(true);
  // ---------------------------------------------------------------- vides du contrat
  const groupes = [];
  const parCle = new Map();
  racine.traverse((o) => {
    const m = /^kit_(.+)_(\d+)$/.exec(o.name || '');
    if (!m || o.isMesh) return;
    const type = (o.userData && o.userData.kit) || m[1];
    const anime = o.userData && o.userData.anime;
    if (anime) {
      groupes.push({ type, parent: o.parent, vides: [o], anime, repos: { p: o.position.clone(), q: o.quaternion.clone() } });
      return;
    }
    const cle = `${type}|${o.parent.uuid}`;
    if (!parCle.has(cle)) {
      const g = { type, parent: o.parent, vides: [], anime: null };
      parCle.set(cle, g);
      groupes.push(g);
    }
    parCle.get(cle).vides.push(o);
  });
  const types = [...new Set(groupes.map((g) => g.type))];
  for (const g of groupes) g.surAnneau = (() => { for (let x = g.parent; x; x = x.parent) if (x.name === 'anneau_rotatif') return true; return false; })();
  // sphère englobante grossière de chaque groupe (positions des vides, repère du parent), pour l'ordre
  // de chargement et l'effacement au loin avant même que les maillages n'arrivent
  for (const g of groupes) {
    const pts = g.vides.map((v) => v.position);
    const c = new THREE.Vector3();
    pts.forEach((p) => c.add(p));
    c.divideScalar(Math.max(1, pts.length));
    let r = 0;
    pts.forEach((p) => { r = Math.max(r, p.distanceTo(c)); });
    g.sphere = new THREE.Sphere(c, r + 5);
    g.objet = null;
  }

  const etat = { types: types.length, vides: groupes.reduce((s, g) => s + g.vides.length, 0), charges: 0, pret: types.length === 0,
    version: {}, octets: 0, erreurs: 0, groupes: groupes.length };
  const loader = new GLTFLoader();
  loader.setMeshoptDecoder(MeshoptDecoder);
  const sources = new Map(); // type -> { version, geometrie, materiau, noeud, halo }
  let basPartout = bas;
  const versionVoulue = (type) => (basPartout || !PROCHES.has(type) ? 'bas' : 'normal');

  // ---------------------------------------------------------------- matériaux
  function preparer(m, type) {
    const mat = m.isMeshStandardMaterial ? m : new THREE.MeshStandardMaterial({ color: 0xcccccc });
    // reflets : carte d'environnement de la scène (scene.environment)
    mat.envMap = env;
    mat.envMapIntensity = 0.7;
    enrichir(mat, { genre: CUIVRE.has(type) ? 'texture' : null });
    for (const t of [mat.map, mat.metalnessMap, mat.roughnessMap, mat.emissiveMap]) {
      if (t && t.anisotropy < anisotropie) { t.anisotropy = anisotropie; t.needsUpdate = true; }
    }
    // masque des lanternes (banc) : ambre franc, assez fort pour le bloom
    if (mat.emissiveMap) mat.emissiveIntensity = 2.6;
    return mat;
  }

  async function lire(type, version) {
    const url = new URL(`${base}${type}${version === 'bas' ? '-bas' : ''}.glb`, document.baseURI).href;
    const res = await fetch(url);
    if (!res.ok) throw new Error(`${url} : ${res.status}`);
    const buf = await res.arrayBuffer();
    etat.octets += buf.byteLength;
    const gltf = await loader.parseAsync(buf, '');
    let mesh = null;
    gltf.scene.traverse((o) => { if (o.isMesh && !mesh) mesh = o; });
    if (!mesh) throw new Error(`${url} : aucun maillage`);
    gltf.scene.updateMatrixWorld(true);
    // la quantification meshopt range une échelle et un décalage dans la matrice du nœud : on la garde
    return { version, geometrie: mesh.geometry, materiau: preparer(mesh.material, type), noeud: mesh.matrixWorld.clone() };
  }

  const mTmp = new THREE.Matrix4();
  function construire(g, src) {
    if (g.anime) {
      let mesh = g.objet;
      if (!mesh) {
        mesh = new THREE.Mesh(src.geometrie, src.materiau);
        mesh.name = `${g.vides[0].name}_maillage`;
        mesh.matrixAutoUpdate = false;
        mesh.userData.kitAnime = true;
        g.vides[0].add(mesh);
        g.objet = mesh;
        if (g.type === 'drone-maintenance') {
          // feu de position : double éclat bref, comme les balises de la station
          const halo = new THREE.Sprite(new THREE.SpriteMaterial({ map: haloTex(), color: new THREE.Color(1.6, 1.15, 0.7),
            blending: THREE.AdditiveBlending, depthWrite: false, transparent: true }));
          halo.position.set(0, 0.86, 0);
          halo.scale.setScalar(0.55);
          halo.userData.kitAnime = true;
          g.vides[0].add(halo);
          g.halo = halo;
        }
      } else {
        mesh.geometry = src.geometrie;
        mesh.material = src.materiau;
      }
      mesh.matrix.copy(src.noeud);
      mesh.matrixWorldNeedsUpdate = true;
      return;
    }
    const n = g.vides.length;
    let im = g.objet;
    if (!im || im.count !== n) {
      im = new THREE.InstancedMesh(src.geometrie, src.materiau, n);
      im.name = `kit_${g.type}`;
      im.userData.kit = g.type;
      g.parent.add(im);
      g.objet = im;
    } else {
      im.geometry = src.geometrie;
      im.material = src.materiau;
    }
    g.vides.forEach((v, i) => {
      v.updateMatrix();
      mTmp.multiplyMatrices(v.matrix, src.noeud);
      im.setMatrixAt(i, mTmp);
    });
    im.instanceMatrix.needsUpdate = true;
    im.computeBoundingSphere();
    g.sphere.copy(im.boundingSphere);
  }

  let _halo = null;
  function haloTex() { if (!_halo) _halo = textureHalo(); return _halo; }

  function liberer(src) {
    if (!src) return;
    src.geometrie.dispose();
    for (const t of [src.materiau.map, src.materiau.metalnessMap, src.materiau.roughnessMap, src.materiau.normalMap, src.materiau.emissiveMap]) if (t) t.dispose();
    src.materiau.dispose();
  }

  // téléchargements lancés à l'avance (en parallèle pour la première image), construits dans l'ordre
  const enCours = new Map();
  function prefetch(type) {
    const v = versionVoulue(type), k = `${type}|${v}`;
    if (!enCours.has(k)) {
      enCours.set(k, lire(type, v).catch((e) => { etat.erreurs++; console.warn('[kit]', e && e.message); return null; }));
    }
    return enCours.get(k);
  }

  async function chargerType(type) {
    const voulu = versionVoulue(type);
    const actuel = sources.get(type);
    if (actuel && actuel.version === voulu) return;
    const src = await prefetch(type);
    enCours.delete(`${type}|${voulu}`);
    if (!src) return;
    // lot H : construction et envoi au GPU à l'arrêt seulement (jamais pendant un trajet)
    if (calme) await calme();
    const nouveaux = [];
    const remplaces = [];
    for (const g of groupes) {
      if (g.type !== type) continue;
      const neuf = !g.objet;
      construire(g, src);
      if (neuf) { g.objet.visible = false; nouveaux.push(g); } else remplaces.push(g);
    }
    // shaders compilés avant la première apparition (pas d'à-coup quand l'objet entre dans le champ)
    if (compiler && nouveaux.length) {
      try { await compiler(nouveaux.map((g) => g.objet)); } catch (e) { /* compilé au premier rendu */ }
    }
    // premier dessin hors écran : textures, tampons et pipeline prêts avant la première apparition
    if (televerser && (nouveaux.length || remplaces.length)) {
      try { televerser([...nouveaux, ...remplaces].map((g) => g.objet)); } catch (e) { /* envoyé au premier rendu */ }
    }
    for (const g of nouveaux) g.pret = true;
    sources.set(type, src);
    etat.version[type] = voulu;
    if (actuel) liberer(actuel);
    etat.charges = sources.size;
    etat.pret = sources.size === types.length;
  }

  // ---------------------------------------------------------------- distances
  const cTmp = new THREE.Vector3();
  function distance(g, pos) {
    cTmp.copy(g.sphere.center).applyMatrix4(g.parent.matrixWorld);
    return Math.max(0, cTmp.distanceTo(pos) - g.sphere.radius);
  }
  function typesParProximite(pos) {
    racine.updateMatrixWorld(true);
    const d = new Map();
    for (const g of groupes) d.set(g.type, Math.min(d.has(g.type) ? d.get(g.type) : Infinity, distance(g, pos)));
    return [...d.entries()].sort((a, b) => a[1] - b[1]);
  }

  // file de chargement : un objet à la fois, le plus proche de la caméra d'abord
  let file = Promise.resolve();
  function enFile(liste, parallele = false) {
    if (parallele) liste.forEach((type) => prefetch(type));
    for (const type of liste) file = file.then(() => chargerType(type));
    return file;
  }

  // ---------------------------------------------------------------- animation
  const qA = new THREE.Quaternion(), qB = new THREE.Quaternion(), vA = new THREE.Vector3(), vB = new THREE.Vector3();
  const X = new THREE.Vector3(1, 0, 0), Y = new THREE.Vector3(0, 1, 0), Z = new THREE.Vector3(0, 0, 1);
  function animerGroupe(g, t) {
    const v = g.vides[0];
    const ud = v.userData || {};
    if (g.anime === 'flotte') {
      // dérive lente sur trois périodes premières entre elles, roulis et lacet doux
      const a = +ud.amplitude || 0.5;
      v.position.copy(g.repos.p).add(vA.set(
        a * Math.sin((TAU * t) / 23 + 0.4), 0.6 * a * Math.sin((TAU * t) / 31 + 1.9), a * Math.sin((TAU * t) / 37 + 3.1)));
      qA.setFromAxisAngle(Y, 0.21 * Math.sin((TAU * t) / 41));
      qB.setFromAxisAngle(X, 0.1 * Math.sin((TAU * t) / 29 + 1.2));
      v.quaternion.copy(g.repos.q).multiply(qA).multiply(qB);
    } else if (g.anime === 'robot') {
      // il tourne un peu la tête vers sa jardinière, avance et recule d'un rien, vibre sur ses chenilles
      const avance = 0.16 * Math.sin((TAU * t) / 13);
      qA.setFromAxisAngle(Y, 0.22 * Math.sin((TAU * t) / 7.3) + 0.06 * Math.sin((TAU * t) / 2.1));
      v.quaternion.copy(g.repos.q).multiply(qA);
      vA.set(0, 0.008 * Math.sin(TAU * t * 1.7), -avance).applyQuaternion(g.repos.q);
      v.position.copy(g.repos.p).add(vA);
    } else if (g.anime === 'orbite') {
      const c = ud.centre || [0, 0, 0], ax = ud.axe || [0, 1, 0];
      vA.fromArray(ax).normalize();
      const phi = (TAU * t) / (+ud.periode || 40);
      qA.setFromAxisAngle(vA, phi);
      vB.fromArray(c);
      v.position.copy(g.repos.p).sub(vB).applyQuaternion(qA).add(vB);
      v.position.y += 0.18 * Math.sin((TAU * t) / 5.3);
      qB.setFromAxisAngle(Z, 0.07 * Math.sin((TAU * t) / 3.7));
      v.quaternion.copy(qA).multiply(g.repos.q).multiply(qB);
      if (g.halo) {
        const cyc = ((t * 0.83) % 1 + 1) % 1;
        const eclat = Math.exp(-cyc * 26) + (cyc >= 0.16 ? 0.6 * Math.exp(-(cyc - 0.16) * 26) : 0);
        g.halo.material.opacity = 0.15 + 0.85 * eclat;
        g.halo.scale.setScalar(0.42 + 0.3 * eclat);
      }
    }
  }

  function animer(t, dt, posCamera) {
    for (const g of groupes) {
      if (!g.objet || !g.pret) continue;
      const loin = LOIN[g.type] || LOIN_DEFAUT;
      const vis = !posCamera || (distance(g, posCamera) < loin && (!DANS_ANNEAU.has(g.type) || dansAnneau(posCamera))
        && !(g.surAnneau && COQUE.has(g.type) && dansAnneau(posCamera)));
      g.objet.visible = vis;
      if (g.halo) g.halo.visible = vis;
      if (vis && g.anime) animerGroupe(g, t);
    }
  }

  return {
    etat,
    types,
    // types visibles depuis une position (moins loin que leur distance d'effacement), les plus proches d'abord
    typesVisibles(pos) {
      return typesParProximite(pos).filter(([type, d]) => d < (LOIN[type] || LOIN_DEFAUT) && (!DANS_ANNEAU.has(type) || dansAnneau(pos)))
        .map(([type]) => type);
    },
    // charge des types (ou tous, du plus proche au plus loin de pos) ; résout quand c'est fait
    charger(liste, pos, { parallele = false } = {}) {
      const ordre = pos ? typesParProximite(pos).map(([type]) => type) : types;
      return enFile(liste ? ordre.filter((x) => liste.includes(x)) : ordre, parallele);
    },
    // qualité réduite (téléphone, ou images trop lentes) : versions -bas partout
    passerBas() {
      if (basPartout) return file;
      basPartout = true;
      etat.bas = true;
      return enFile(types.filter((x) => sources.has(x) && PROCHES.has(x)));
    },
    animer,
    get bas() { return basPartout; },
  };
}
