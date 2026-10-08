// Chef d'orchestre de la démo « Kepler-9 » : chargement, scène, ambiances, navigation, boucle.
import * as THREE from 'three';
import { HALTES, INDEX, TRAJETS, NIVEAUX } from './config.js';
import { creerGeometrie } from './world/geometrie.js';
import { profilAnneaux, creerAnneaux } from './world/anneaux.js';
import { creerPlanete } from './world/planete.js';
import { creerCiel } from './world/ciel.js';
import { creerDebris } from './world/debris.js';
import { chargerGlb, creerStation, stationParDefaut } from './world/station.js';
import { creerKit } from './world/kit.js';
import { creerReflets } from './world/reflets.js';
import { U_LUMIERE } from './world/materiaux.js';
import { creerEnvironnement } from './world/environnement.js';
import { calculerPoses, Pose } from './engine/poses.js';
import { creerRig, couloirsEntree } from './engine/rig.js';
import { creerPost } from './engine/post.js';
import { brancherGestes } from './engine/gestes.js';
import { creerInterface } from './ui/interface.js';
import { creerOccupation } from './engine/occupation.js';
import { installerGardeFous, assainirBloom } from './engine/securite.js';
import gsap from 'gsap';

const smoother = (x) => { x = Math.min(1, Math.max(0, x)); return x * x * x * (x * (x * 6 - 15) + 10); };
const ease = (x) => { x = Math.min(1, Math.max(0, x)); return x < 0.5 ? 4 * x * x * x : 1 - Math.pow(-2 * x + 2, 3) / 2; };
const attendre = (ms) => new Promise((r) => setTimeout(r, ms));
const image = () => new Promise((r) => requestAnimationFrame(() => r()));

export async function demarrer({ niveauNom, params, repli }) {
  const test = params.has('test');
  // ?test-mobile=1 : pire cas d'un téléphone (voir main.js) ; mediump, profondeur 16 bits, DPR 1
  const testMobile = params.has('test-mobile');
  // lot H : ?saccades=1 (tests/saccades.py) : ni résolution dynamique ni repli (SwiftShader est lent), le reste
  // comme en vrai (chargement progressif du kit, ouverture)
  const saccades = params.has('saccades');
  if (test) gsap.ticker.lagSmoothing(0);
  // avant toute création de matériau : sorties des shaders sans NaN ni infini (voir securite.js)
  installerGardeFous();
  const reduit = matchMedia('(prefers-reduced-motion: reduce)').matches || params.has('still');
  const niveau = { ...NIVEAUX[niveauNom] };
  if (params.get('cube')) niveau.cube = Math.max(128, Math.min(2048, +params.get('cube')));
  const app = document.getElementById('app');
  const etat = {
    pret: false, halte: HALTES[0].id, enRoute: false, u: 1, glb: false, niveau: niveauNom,
    appels: 0, triangles: 0, ips: 0, dpr: 1, echelle: 1, soleil: 0, navette: '', sources: {}, erreurs: [], image: 0,
  };

  let courant = 0;
  const depart = INDEX[(location.hash || '').slice(1)];
  if (depart != null) courant = depart;

  const ui = creerInterface({
    haltes: HALTES, reduit,
    surSaut: (i, src) => naviguer(i, src),
    surGeste: (d, src) => geste(d, src),
  });
  ui.progression(0.03, 'préparation');

  // ------------------------------------------------------------------ rendu
  const canvas = document.getElementById('scene');
  let renderer;
  try {
    // highp demandé explicitement (WebGL 2 le garantit dans les fragment shaders) : la géante et les
    // anneaux calculent sur des coordonnées de plusieurs milliers de mètres
    renderer = new THREE.WebGLRenderer({
      canvas, antialias: false, powerPreference: 'high-performance', stencil: false,
      precision: testMobile ? 'mediump' : 'highp',
    });
  } catch (e) {
    repli('gl');
    return;
  }
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.NoToneMapping;
  renderer.info.autoReset = false;
  renderer.setClearColor(0x000000, 1);
  canvas.addEventListener('webglcontextlost', (e) => { e.preventDefault(); repli('ctx'); }, false);

  const scene = new THREE.Scene();
  // plan proche à 0,8 m (lot F) : aucune halte n'a de paroi à moins de 3 m ; une poutre qui frôlerait
  // l'objectif en trajet est coupée au lieu de remplir l'écran, et la profondeur gagne en précision
  const camera = new THREE.PerspectiveCamera(40, window.innerWidth / window.innerHeight, 0.8, 30000);
  const geo = creerGeometrie();

  // le glb part tout de suite, en parallèle des cuissons
  const urlGlb = new URL('assets/station.glb', document.baseURI).href;
  const glbPromesse = params.has('sansglb') ? Promise.resolve(null)
    : chargerGlb(urlGlb, (p) => ui.progression(0.06 + 0.5 * p, 'assemblage de la station')).catch((e) => {
      console.warn('[station] glb illisible, espace réservé utilisé :', e && e.message);
      return null;
    });

  // lot G : lumière précalculée (atlas cuit par Cycles sur GPU) : 2048 px sur ordinateur, 1024 au niveau bas
  const lumierePromesse = params.has('sansglb') || params.has('sanslumiere') ? Promise.resolve(null)
    : chargerLumiere(niveauNom === 'low' || testMobile ? 1024 : 2048, Math.min(4, renderer.capabilities.getMaxAnisotropy()));

  // ------------------------------------------------------------------ monde en code
  const profil = profilAnneaux();
  const ciel = creerCiel(renderer, niveau, geo.rayonSoleil);
  // longitude (repère de la planète) du point situé sous la station : la grande tempête y est placée
  const qPl = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), geo.normale).invert();
  const dLoc = geo.d.clone().applyQuaternion(qPl);
  const lonFace = (Math.atan2(dLoc.z, dLoc.x) * 180) / Math.PI - 12;
  const planete = creerPlanete(renderer, geo, niveau, profil, niveau.cube, { lonFace });
  const anneaux = creerAnneaux(geo, profil);
  ui.progression(0.08, 'la géante prend ses couleurs');
  await image();
  ciel.cuire();
  planete.cuire();
  scene.add(ciel.groupe, planete.sphere, planete.atmo, anneaux.mesh, ciel.eclat);

  // ------------------------------------------------------------------ station
  let racine = await glbPromesse;
  etat.glb = !!racine;
  if (!racine) racine = stationParDefaut(geo);
  ui.progression(0.62, 'assemblage de la station');
  await image();
  const soleilApproche = geo.soleil((HALTES[0].soleil * Math.PI) / 180);
  const env = creerEnvironnement(renderer, geo, soleilApproche);
  scene.environment = env;
  const station = creerStation(racine, geo, env, {
    estGlb: etat.glb, tempsReduit: reduit,
    anisotropie: Math.min(niveauNom === 'high' ? 8 : 4, renderer.capabilities.getMaxAnisotropy()),
  });
  scene.add(station.groupe);
  // lot G : objets du kit IA posés sur les vides kit_* du glb (versions -bas au niveau bas)
  const kit = creerKit(station.racine, {
    env: null, anisotropie: Math.min(niveauNom === 'high' ? 8 : 4, renderer.capabilities.getMaxAnisotropy()),
    bas: niveauNom === 'low' || testMobile,
    compiler: (objets) => (renderer.compileAsync ? Promise.all(objets.map((o) => {
      o.visible = true;
      return renderer.compileAsync(o, camera, scene).finally(() => { o.visible = false; });
    })) : Promise.resolve()),
    // lot H : un objet qui arrive après la première image n'est construit et envoyé au GPU qu'à l'arrêt
    calme: () => attendreCalme(),
    televerser: (objets) => televerser(objets),
  });
  etat.kit = kit.etat;
  const t0occ = performance.now();
  const occupation = creerOccupation(station);
  etat.occupation = { ms: Math.round(performance.now() - t0occ), cellules: occupation.cellules, dims: occupation.dims, bande: !!occupation.bande };
  const poses = calculerPoses(station, geo, HALTES, { hautDuVide: !etat.glb, occupation });
  etat.sources = poses.sources;
  etat.fusion = station.fusion;
  const debris = creerDebris(geo, niveau, poses.centreDebris, profil);
  station.orienterSignal(poses.viseeAntennes);
  if (poses.f.quai) etat.navetteCadrage = station.cadrerNavette(poses.f.quai(new Pose()).pos);
  scene.add(debris.groupe);
  // lumière précalculée : seulement si l'atlas correspond aux coordonnées du glb (même empreinte)
  const lumiere = await lumierePromesse;
  etat.lumiere = { active: false };
  if (lumiere && etat.glb) {
    let uvGlb = null;
    try { uvGlb = JSON.parse(racine.userData.lumiere_uv || 'null'); } catch (e) { uvGlb = null; }
    const ok = !uvGlb || !lumiere.info.empreinte_uv || uvGlb.empreinte === lumiere.info.empreinte_uv;
    if (ok) {
      U_LUMIERE.tLumiere.value = lumiere.ao;
      U_LUMIERE.tLumiereGI.value = lumiere.gi;
      U_LUMIERE.uGIMax.value = lumiere.info.gi_max;
      U_LUMIERE.uForceAO.value = 1;
      U_LUMIERE.uForceGI.value = 1.0;
      U_LUMIERE.uTailleLum.value = lumiere.taille;
    } else console.warn('[lumière] atlas cuit pour d\'autres coordonnées : ignoré');
    etat.lumiere = { active: ok, taille: lumiere.taille, octets: lumiere.octets, giMax: lumiere.info.gi_max };
  }
  // reflets : carte d'environnement rendue depuis la scène (géante, anneaux, étoiles, soleil), une par halte
  const reflets = creerReflets(renderer, scene, {
    taille: niveauNom === 'low' || testMobile ? 128 : niveauNom === 'mid' ? 192 : 256,
    cacher: [station.groupe, debris.groupe, ciel.eclat],
  });
  etat.reflets = reflets.etat;
  function envHalte(i) {
    const Li = poses.soleils[i];
    return reflets.calculer(i, () => {
      planete.uniforms.uSoleil.value.copy(Li);
      anneaux.uniforms.uSoleil.value.copy(Li);
      ciel.uniformsFond.uSoleil.value.copy(Li);
      anneaux.uniforms.uPres.value = 0;
    });
  }

  // ------------------------------------------------------------------ lumières
  const cibleLum = new THREE.Object3D();
  cibleLum.position.copy(station.centre);
  scene.add(cibleLum);
  const soleilL = new THREE.DirectionalLight(0xffffff, 3);
  soleilL.target = cibleLum;
  const planeteL = new THREE.DirectionalLight(0xe2a54f, 1);
  planeteL.target = cibleLum;
  const cielL = new THREE.HemisphereLight(0x22304e, 0x6b4a2a, 0.4);
  cielL.position.copy(geo.d);
  const lampes = [0, 1].map(() => { const l = new THREE.PointLight(0xffb35c, 0, 60, 2); scene.add(l); return l; });
  // lot G : contre-jour des vues extérieures (comme au lever) : une lumière chaude venue de derrière la
  // station, vers l'objectif ; elle ourle les arêtes et fait briller le cuivre et les métaux à l'angle
  // rasant. Elle n'éclaire que la station (la géante et les anneaux ont leur propre soleil).
  const contreJour = new THREE.DirectionalLight(0xffd6a6, 0);
  contreJour.target = cibleLum;
  scene.add(soleilL, planeteL, cielL, contreJour);
  scene.fog = new THREE.FogExp2(0x0b1222, 0);

  // ------------------------------------------------------------------ post-traitement et taille
  const post = creerPost(renderer, scene, camera, niveau, { profondeur16: testMobile });
  // ------------------------------------------------------------------ préchauffage (lot H)
  // Tom (MacBook) : une micro-saccade quand un élément apparaît d'un coup (les blocs des anneaux...). Un
  // programme compilé d'avance (compileAsync) n'est vraiment prêt qu'après un premier dessin : états du GPU
  // (pipeline), géométries, instances et textures n'y partent qu'à ce moment. Tout ce qui peut apparaître est
  // donc dessiné une fois, visible et sans tri par le champ : pendant l'écran de chargement par la vraie chaîne
  // de rendu, puis, pour les objets du kit qui arrivent ensuite, à l'arrêt seulement (jamais pendant un
  // trajet), dans une petite cible hors écran au format du tampon de la scène.
  const toutVisible = (racines) => {
    const etats = [];
    for (const r of racines) r.traverse((o) => { etats.push([o, o.visible, o.frustumCulled]); o.visible = true; o.frustumCulled = false; });
    return () => { for (const [o, v, f] of etats) { o.visible = v; o.frustumCulled = f; } };
  };
  let rtChauffe = null;
  function televerser(objets) {
    // pendant le chargement, le préchauffage complet (plus bas) s'en charge
    if (!etat.pret) return;
    const ib = post.composer.inputBuffer;
    if (!rtChauffe) rtChauffe = new THREE.WebGLRenderTarget(8, 8, { type: ib.texture.type, samples: ib.samples || 0, depthBuffer: true, stencilBuffer: !!ib.stencilBuffer });
    for (const o of objets) {
      o.traverse((x) => {
        const m = x.material;
        if (!m) return;
        for (const k of ['map', 'normalMap', 'roughnessMap', 'metalnessMap', 'emissiveMap', 'aoMap']) if (m[k] && m[k].isTexture) renderer.initTexture(m[k]);
      });
    }
    const rendre = toutVisible(objets);
    const avant = renderer.getRenderTarget();
    renderer.setRenderTarget(rtChauffe);
    renderer.render(scene, camera);
    renderer.setRenderTarget(avant);
    rendre();
    etat.prechauffages = (etat.prechauffages || 0) + 1;
  }
  // résolu quand la caméra est arrêtée à une halte depuis un instant (pas de trajet, pas de fondu) ; tout de
  // suite pendant le chargement (l'écran de chargement cache tout)
  const attendreCalme = () => new Promise((res) => {
    const essai = () => (!etat.pret || (!rig.enRoute && !enFondu && horloge - arriveeT > 0.6) ? res() : setTimeout(essai, 200));
    essai();
  });
  const bloomAssaini = assainirBloom(post.bloom);
  etat.rendu = { msaa: post.msaa, smaa: post.smaa, hdr: post.hdr, precision: renderer.capabilities.precision, bloomAssaini };
  let dprBase = testMobile ? 1 : Math.min(window.devicePixelRatio || 1, niveau.dpr);
  // repli (lot F) : téléphone sans MSAA possible pour le tampon HDR : un peu plus de définition (1,6 au
  // lieu de 1,25) pour que le SMAA seul tienne les arêtes fines ; la résolution dynamique redescend si
  // les images ralentissent
  if (!post.msaa && niveauNom === 'low' && !testMobile) dprBase = Math.min(window.devicePixelRatio || 1, 1.6);
  let echelle = 1;
  // la résolution dynamique ne descend pas sous un pixel par pixel CSS quand l'écran est plus fin :
  // en dessous, l'image devient floue et les arêtes fines scintillent
  const plancherEchelle = (base) => (dprBase > 1 ? Math.max(base, 1 / dprBase) : base);
  const taille = new THREE.Vector2();
  function appliquerTaille() {
    const w = Math.max(1, canvas.clientWidth), h = Math.max(1, canvas.clientHeight);
    renderer.setPixelRatio(dprBase * echelle);
    renderer.setSize(w, h, false);
    post.composer.setSize(w, h);
    camera.aspect = w / h;
    renderer.getDrawingBufferSize(taille);
    ciel.uniformsEclat.uRes.value.copy(taille);
    etat.dpr = +(dprBase * echelle).toFixed(2);
  }
  appliquerTaille();
  window.addEventListener('resize', appliquerTaille);

  // ------------------------------------------------------------------ rig et navigation
  let arriveeT = -10, enFondu = false;
  // couloirs d'entrée des haltes intérieures (voir rig.js) : calculés par tranches après l'ouverture,
  // d'un coup en mode test (captures reproductibles)
  const couloirs = couloirsEntree(station, HALTES, (i, out) => poses.f[HALTES[i].id](out));
  etat.couloirs = { ms: 0, haltes: [] };
  const besoinCouloirs = Object.values(TRAJETS).some((d) => d.type === 'travelling' || d.type === 'orbite');
  const calculerCouloirs = () => {
    if (!besoinCouloirs) return;
    const t0c = performance.now();
    const fini = couloirs.avancer(test ? 1e9 : 4);
    etat.couloirs.ms += performance.now() - t0c;
    if (fini) { etat.couloirs.ms = Math.round(etat.couloirs.ms); etat.couloirs.haltes = couloirs.haltes; } else setTimeout(calculerCouloirs, 40);
  };
  const rig = creerRig(camera, {
    haltes: HALTES, trajets: TRAJETS, poses, centre: station.centre, normale: geo.normale,
    axe: station.axeAnneau, origine: new THREE.Vector3(0, 0, 0), occupation, couloirs,
    angleAnneau: () => station.angleAnneau,
    vitesseAnneau: () => station.vitesseAnneau || 0,
    courant: () => courant,
    arrivee: (v) => { courant = v; arrivee(); },
  });
  const nav = { de: -1, vers: -1 };

  function arrivee() {
    nav.de = -1; nav.vers = -1;
    arriveeT = horloge;
    // lot H : reflets des haltes voisines calculés à l'arrêt (avant : au départ du trajet, une image figée)
    const ici = courant;
    attendreCalme().then(async () => {
      for (const j of [ici + 1, ici - 1]) {
        if (j < 0 || j >= HALTES.length || courant !== ici || rig.enRoute) continue;
        envHalte(j);
        await attendre(300);
        await attendreCalme();
      }
    });
    if (focusArrivee) { focusArrivee = false; setTimeout(() => ui.focusTitre(HALTES[courant].id), 900); }
    navetteArrivee(courant);
    const id = HALTES[courant].id;
    if (location.hash.slice(1) !== id) history.replaceState(null, '', '#' + id);
  }
  function navetteDepart(de, vers) {
    const q = INDEX.quai;
    if (vers >= q && de < q) station.navette.demarrer();
  }
  function navetteArrivee(i) {
    const q = INDEX.quai;
    if (i < q) station.navette.attendre();
    else if (i > q && station.navette.etat === 'attente') station.navette.arrimer();
  }
  function navetteSaut(i) {
    const q = INDEX.quai;
    if (i < q) station.navette.attendre();
    else if (i === q) { station.navette.attendre(); station.navette.demarrer(); station.navette.avancer(5.5); }
    else station.navette.arrimer();
  }
  const libre = () => etat.pret && !rig.enRoute && !enFondu && horloge - arriveeT > 0.6;

  let focusArrivee = false;
  function geste(dir, source) {
    ui.premierGeste();
    if (!libre()) return false;
    focusArrivee = source === 'clavier';
    const j = courant + dir;
    if (j < 0 || j >= HALTES.length) return false;
    scroll.aligner(j);
    voyager(j);
    return true;
  }
  function voyager(j) {
    // reflets de la halte d'arrivée : calculés maintenant (caméra encore immobile), appliqués à mi-trajet
    envHalte(j);
    if (reduit) { couper(j, false); return; }
    ui.cacherCarte();
    nav.de = courant; nav.vers = j;
    navetteDepart(courant, j);
    rig.demarrer(courant, j, horloge);
  }
  function naviguer(j) {
    if (!etat.pret || enFondu) return;
    scroll.aligner(j);
    if (j === courant && !rig.enRoute) return;
    ui.premierGeste();
    if (!rig.enRoute && Math.abs(j - courant) === 1 && !reduit) { voyager(j); return; }
    couper(j, !reduit);
  }
  async function couper(j, approche) {
    enFondu = true;
    ui.cacherCarte();
    await ui.fonduNoir(true, reduit ? 0.25 : 0.35);
    rig.annuler();
    navetteSaut(j);
    reflets.appliquer(envHalte(j));
    const voisin = Math.min(HALTES.length - 1, Math.max(0, j > courant ? j - 1 : j + 1));
    courant = j;
    if (approche && voisin !== j) {
      const p = new Pose();
      rig.poseDe(voisin, p);
      nav.de = voisin; nav.vers = j;
      rig.demarrer(voisin, j, horloge, { depuis: p, u0: 0.72 });
    } else {
      nav.de = -1; nav.vers = -1;
      arriveeT = horloge;
      history.replaceState(null, '', '#' + HALTES[j].id);
    }
    rig.reamorcer();
    await image();
    await ui.fonduNoir(false, reduit ? 0.35 : 0.6);
    enFondu = false;
  }
  window.addEventListener('hashchange', () => {
    const i = INDEX[location.hash.slice(1)];
    if (i != null && i !== courant && !rig.enRoute) naviguer(i);
  });
  const scroll = brancherGestes({
    actif: () => app.classList.contains('is-3d'),
    geste, saut: (i) => naviguer(i), dernier: HALTES.length - 1,
    pointeur: (x, y) => rig.etat.pointeur.set(x, y),
  });

  scroll.aligner(courant);

  // ------------------------------------------------------------------ ambiances
  const amb = (i) => ({ h: HALTES[i], L: poses.soleils[i] });
  const qS = new THREE.Quaternion();
  const slerpDir = (a, b, t, out) => { qS.setFromUnitVectors(a, b); qS.slerp(_qI, 1 - t); return out.copy(a).applyQuaternion(qS); };
  const _qI = new THREE.Quaternion();
  const cA = new THREE.Color(), cB = new THREE.Color(), cTmp = new THREE.Color();
  const L = new THREE.Vector3(), vTmp = new THREE.Vector3(), vTmp2 = new THREE.Vector3();
  const couleurSoleilBase = new THREE.Color(1.0, 0.94, 0.86);
  const posNoyau = station.posNoyau;
  const poseTmp = new Pose();
  let leverDerive = 0;

  function lampeDe(h, k, out) {
    const l = h.lampes && h.lampes[k];
    if (!l) return null;
    if (l.ou === 'noyau') out.copy(posNoyau);
    else { rig.poseDe(INDEX[h.id], poseTmp); out.copy(poseTmp.cible); }
    out.x += l.decal[0]; out.y += l.decal[1]; out.z += l.decal[2];
    return l;
  }

  function majAmbiance(t, dt) {
    const tr = rig.trajet;
    let a = courant, b = courant, e = 0, es = 0;
    if (tr) { a = tr.de; b = tr.vers; e = smoother(tr.u); es = ease(tr.u); }
    const A = amb(a), B = amb(b);
    const mix = (x, y) => x + (y - x) * e;
    // soleil : interpolation sur la sphère entre les directions des deux haltes
    slerpDir(A.L, B.L, es, L);
    // au lever, le soleil continue de monter doucement
    if (courant === INDEX.lever && !tr && !reduit) leverDerive = Math.min(leverDerive + dt / 45, 1);
    else if (tr) leverDerive *= Math.pow(0.2, dt);
    if (leverDerive > 0.0005 && (a === INDEX.lever || b === INDEX.lever)) {
      const w = (a === INDEX.lever ? (tr ? 1 - e : 1) : e) * smoother(leverDerive);
      slerpDir(L.clone(), poses.Lplus, w, L);
    }
    etat.soleil = Math.round((Math.acos(THREE.MathUtils.clamp(L.dot(vTmp2.copy(geo.d).negate()), -1, 1)) * 180) / Math.PI);
    // visibilité du soleil depuis la station (ombre de la géante) et rougissement près du bord
    const visSt = geo.visibiliteSoleil(station.centre, L);
    vTmp.copy(geo.C).sub(station.centre);
    const sep = Math.acos(THREE.MathUtils.clamp(vTmp.normalize().dot(L), -1, 1));
    const rp = Math.asin(geo.R / geo.C.distanceTo(station.centre));
    const marge = THREE.MathUtils.clamp((sep - rp) / (9 * Math.PI / 180), 0, 1);
    cTmp.setRGB(1.0, 0.42, 0.18).lerp(couleurSoleilBase, smoother(marge));
    const force = mix(A.h.soleilForce, B.h.soleilForce);
    soleilL.color.copy(cTmp);
    soleilL.intensity = 3.4 * visSt * force;
    soleilL.position.copy(station.centre).addScaledVector(L, 400);
    // lumière renvoyée par la géante (fraction éclairée vue depuis la station)
    const phase = geo.phase(L);
    planeteL.intensity = 1.3 * Math.pow(phase, 1.2) * (0.6 + 0.4 * force);
    planeteL.position.copy(station.centre).addScaledVector(geo.d, -400);
    cielL.intensity = mix(A.h.ciel, B.h.ciel);
    // contre-jour : derrière le sujet par rapport à l'objectif, un peu au-dessus
    contreJour.intensity = mix(A.h.contreJour || 0, B.h.contreJour || 0);
    if (contreJour.intensity > 0.001) {
      camera.getWorldDirection(vTmp);
      contreJour.position.copy(station.centre).addScaledVector(vTmp, 500).add(vTmp2.set(0, 160, 0));
    }
    // brouillard
    cA.set(A.h.brume[0]); cB.set(B.h.brume[0]);
    scene.fog.color.copy(cA).lerp(cB, e);
    scene.fog.density = mix(A.h.brume[1], B.h.brume[1]);
    // lampes locales : celles de la halte de départ s'éteignent, celles d'arrivée s'allument
    const la = lampeDe(A.h, 0, lampes[0].position), lb = a !== b ? lampeDe(B.h, 0, lampes[1].position) : null;
    lampes[0].visible = true; lampes[1].visible = true;
    lampes[0].intensity = la ? la.force * (a !== b ? 1 - e : 1) : 0;
    if (la) { lampes[0].color.set(la.couleur); lampes[0].distance = la.portee; }
    lampes[1].intensity = lb ? lb.force * e : 0;
    if (lb) { lampes[1].color.set(lb.couleur); lampes[1].distance = lb.portee; }
    // étalonnage
    post.regler({
      exposition: mix(A.h.expo, B.h.expo),
      saturation: mix(A.h.sat, B.h.sat),
      teinte: [mix(A.h.teinte[0], B.h.teinte[0]), mix(A.h.teinte[1], B.h.teinte[1]), mix(A.h.teinte[2], B.h.teinte[2])],
      bloom: mix(A.h.bloom, B.h.bloom),
    });
    // monde en code
    planete.uniforms.uSoleil.value.copy(L);
    planete.uniforms.uCouleurSoleil.value.copy(couleurSoleilBase);
    planete.uniforms.uTemps.value = t;
    anneaux.uniforms.uSoleil.value.copy(L);
    anneaux.uniforms.uCouleurSoleil.value.copy(couleurSoleilBase);
    anneaux.uniforms.uTemps.value = t;
    ciel.uniformsFond.uSoleil.value.copy(L);
    ciel.uniformsEtoiles.uTemps.value = t;
    ciel.uniformsEtoiles.uPixel.value = renderer.getPixelRatio();
    // poids de chaque halte (pour les effets locaux)
    return { e, a, b, wAntennes: (a === INDEX.antennes ? 1 - e : 0) + (b === INDEX.antennes && a !== b ? e : 0) };
  }

  // éblouissement : position du soleil à l'écran et part visible depuis la caméra
  const solEcran = new THREE.Vector3();
  let cacheStation = 0;
  // part du disque solaire masquée par la station, sur cinq rayons répartis sur le disque (lot F : un
  // seul rayon basculait d'un coup entre caché et visible, et le halo clignotait), lissée sur 0,3 s
  const exL = new THREE.Vector3(), eyL = new THREE.Vector3(), dL = new THREE.Vector3();
  function majEclat(dt) {
    exL.set(0, 1, 0).cross(L);
    if (exL.lengthSq() < 1e-6) exL.set(1, 0, 0).cross(L);
    exL.normalize(); eyL.crossVectors(L, exL);
    let bloque = 0;
    for (let i = 0; i < 5; i++) {
      dL.copy(L);
      if (i) dL.addScaledVector(i < 3 ? exL : eyL, (i % 2 ? 1 : -1) * 0.011).normalize();
      if (occupation.rayon(camera.position, dL, 320, 1.5) < Infinity) bloque += 0.2;
    }
    cacheStation += (bloque - cacheStation) * (1 - Math.exp(-dt / 0.3));
    const vis = geo.visibiliteSoleil(camera.position, L) * (1 - cacheStation);
    solEcran.copy(camera.position).addScaledVector(L, 10000).project(camera);
    const devant = vTmp2.copy(L).dot(camera.getWorldDirection(vTmp)) > 0;
    const horsCadre = Math.max(Math.abs(solEcran.x), Math.abs(solEcran.y));
    const dansCadre = devant ? 1 - smoother((horsCadre - 1.0) / 0.6) : 0;
    const v = vis * dansCadre;
    ciel.uniformsEclat.uSol.value.set(solEcran.x, solEcran.y);
    ciel.uniformsEclat.uVis.value = v * 0.85;
    ciel.eclat.visible = v > 0.002;
    // les étoiles pâlissent quand le soleil est dans le champ
    ciel.uniformsFond.uFond.value = 1 - 0.55 * v;
  }

  // ------------------------------------------------------------------ cadrage (décalage pour la carte)
  const decal = new THREE.Vector2();
  function decalHalte(i, out) {
    const portrait = camera.aspect < 0.9;
    if (portrait) return out.set(0, 0.3);
    return out.set(HALTES[i].carte === 'droite' ? -0.34 : 0.34, 0.02);
  }
  const dA = new THREE.Vector2(), dB = new THREE.Vector2();
  function fovEcran(v) {
    const a = camera.aspect;
    if (a >= 1.2) return v;
    const tanH = Math.tan((v * Math.PI) / 360) * (16 / 9) * (a < 0.9 ? 0.6 : 0.78);
    const v2 = (Math.atan(tanH / a) * 360) / Math.PI;
    return THREE.MathUtils.clamp(v2, v, 84);
  }
  function majProjection() {
    const tr = rig.trajet;
    decalHalte(tr ? tr.de : courant, dA);
    decalHalte(tr ? tr.vers : courant, dB);
    const e = tr ? smoother(tr.u) : 1;
    decal.copy(dA).lerp(dB, tr ? e : 1);
    camera.fov = fovEcran(rig.lisse.fov);
    camera.updateProjectionMatrix();
    camera.projectionMatrix.elements[8] = -decal.x;
    camera.projectionMatrix.elements[9] = -decal.y;
    camera.projectionMatrixInverse.copy(camera.projectionMatrix).invert();
  }

  // ------------------------------------------------------------------ boucle
  let horloge = 0, tPrec = performance.now() / 1000, enMarche = false, gel = false;
  const ipsFen = [];
  const qual = { tBas: 0, tHaut: 0, tLent: 0, dernier: 0 };
  // lot H : en mesure de saccades, pas de 0,25 s au plus (SwiftShader : une image prend des centaines de ms)
  const dtMax = test ? 0.5 : saccades ? 0.25 : 0.05;

  function boucle() {
    const maintenant = performance.now() / 1000;
    const dtReel = Math.max(0, maintenant - tPrec);
    tPrec = maintenant;
    const dt = gel ? 0 : Math.min(dtReel, dtMax);
    horloge += dt;
    const t = horloge;

    // Une nouvelle position de scroll remplace la destination souhaitée, sans couper le trajet.
    // Chaque halte intermédiaire garde sa pause et sa carte avant le prochain départ.
    if (!gel && libre() && scroll.cible !== courant && app.classList.contains('is-3d')) {
      ui.premierGeste();
      voyager(courant + Math.sign(scroll.cible - courant));
    }
    const u = rig.maj(t, dt, { reduit, instantane: false });
    const info = majAmbiance(t, dt);
    station.animer(t, dt, { signal: info.wAntennes, pixel: renderer.getPixelRatio(), camera: camera.position });
    kit.animer(t, dt, camera.position);

    // traversée des anneaux : blocs et poussière seulement près du plan
    const h = Math.abs(geo.hauteurPlan(camera.position));
    // lot F : l'effacement des anneaux près de la caméra ne commence qu'en entrant dans la couche de blocs
    // (avant : dès 300 m au-dessus du plan, la géante se voyait à travers un voile, comme un reflet flou)
    const presPlan = 1 - smoother((h - 25) / 140);
    // les blocs ne servent qu'à la traversée des anneaux (halte « Les anneaux » et ses deux trajets) :
    // vus du lever ou du pont radio, ils faisaient des « particules bizarres » devant la géante (Tom, lot F)
    const trD = rig.trajet;
    const traversee = trD ? (trD.de === INDEX.anneaux || trD.vers === INDEX.anneaux) : courant === INDEX.anneaux;
    debris.groupe.visible = traversee && h < 200 && camera.position.distanceTo(poses.centreDebris) < 700;
    debris.U.uTemps.value = t;
    debris.U.uDemiH.value = taille.y * 0.5;
    debris.UP.uPixel.value = renderer.getPixelRatio();
    debris.UP.uForce.value = presPlan;
    debris.majCamera(camera.position);
    anneaux.uniforms.uPres.value = presPlan;

    majProjection();
    majEclat(dt);
    // reflets : ceux de la halte d'arrivée à partir de la moitié du trajet
    {
      const trR = rig.trajet;
      const cible = trR ? (trR.u >= 0.5 ? trR.vers : trR.de) : courant;
      if (reflets.a(cible)) reflets.appliquer(envHalte(cible));
    }

    // cartes et rail
    const tr = rig.trajet;
    if (tr) {
      if (tr.u > 0.84) ui.montrerCarte(HALTES[tr.vers].id);
      ui.rail(tr.de, tr.vers, tr.u);
    } else {
      if (etat.pret) ui.montrerCarte(HALTES[courant].id);
      ui.rail(courant, -1, 1);
    }

    renderer.info.reset();
    post.composer.render(dt);
    etat.image++;
    etat.appels = renderer.info.render.calls;
    etat.triangles = renderer.info.render.triangles;
    // lot H : ce que le GPU a reçu (un programme ou une texture qui apparaît pendant un trajet = une saccade)
    etat.programmes = renderer.info.programs ? renderer.info.programs.length : 0;
    etat.textures = renderer.info.memory.textures;
    etat.geometries = renderer.info.memory.geometries;
    etat.halte = HALTES[courant].id;
    etat.enRoute = !!tr;
    etat.u = u;
    etat.navette = station.navette.etat;

    // images par seconde et résolution dynamique (jamais en mode test)
    if (dtReel > 0 && dtReel < 0.25) { ipsFen.push(dtReel); if (ipsFen.length > 45) ipsFen.shift(); }
    const moy = ipsFen.reduce((s, x) => s + x, 0) / Math.max(1, ipsFen.length);
    etat.ips = moy ? Math.round(1 / moy) : 0;
    // lot F : sous 28 images/s (GPU faible), décision dès 20 images et pas de 15 % au lieu de 8 %
    const tresLent = ipsFen.length >= 20 && moy > 1 / 28;
    if (!test && !saccades && etat.pret && (ipsFen.length >= 45 || tresLent) && maintenant - qual.dernier > 1.5) {
      const min = plancherEchelle(matchMedia('(pointer: coarse)').matches ? 0.6 : 0.7);
      if (moy > 1 / 47) {
        qual.tHaut = 0;
        // ordre des renoncements : sur ordinateur, le MSAA part avant la moindre perte de définition (le
        // rendu retombe alors exactement sur l'ancien réglage) ; sur téléphone (niveau bas), la définition
        // descend d'abord jusqu'au plancher, puis le MSAA part
        const msaaDabord = post.msaa > 0 && (niveauNom !== 'low' || echelle <= min);
        // lot G : les objets du kit passent aux versions -bas au premier renoncement
        if (!kit.bas) kit.passerBas();
        if (msaaDabord) {
          post.couperMsaa(); etat.rendu.msaa = 0; qual.dernier = maintenant; ipsFen.length = 0;
          if (tresLent && echelle > min) { echelle = Math.max(min, echelle - 0.15); appliquerTaille(); }
        } else if (echelle > min) { echelle = Math.max(min, echelle - (tresLent ? 0.15 : 0.08)); qual.dernier = maintenant; appliquerTaille(); ipsFen.length = 0; }
        else if (moy > 1 / 12) { qual.tLent += 1.5; if (qual.tLent > 8) { repli('lent'); return; } }
      } else if (moy < 1 / 57) {
        qual.tHaut += dtReel * 45;
        if (qual.tHaut > 3 && echelle < 1) { echelle = Math.min(1, echelle + 0.05); qual.dernier = maintenant; qual.tHaut = 0; appliquerTaille(); ipsFen.length = 0; }
      }
      etat.echelle = +echelle.toFixed(2);
    }
  }

  // ?diag=1 : petit panneau avec ce que l'appareil a réellement obtenu (niveau, définition, MSAA,
  // images/s, appels de dessin) ; une capture d'écran suffit pour diagnostiquer un téléphone
  let diag = null;
  if (params.has('diag')) {
    diag = document.createElement('pre');
    diag.style.cssText = 'position:fixed;left:8px;top:110px;z-index:50;margin:0;padding:6px 8px;font:11px/1.35 monospace;color:#efe6d2;background:rgba(7,11,22,.78);pointer-events:none;white-space:pre';
    document.body.appendChild(diag);
    const gl = renderer.getContext(), ext = gl.getExtension('WEBGL_debug_renderer_info');
    diag.dataset.gpu = ext ? String(gl.getParameter(ext.UNMASKED_RENDERER_WEBGL)).slice(0, 46) : '?';
    setInterval(() => {
      const r = etat.rendu || {};
      diag.textContent = `${diag.dataset.gpu}\nniveau ${etat.niveau}  dpr ${etat.dpr}  échelle ${etat.echelle}\nMSAA ${r.msaa}x  SMAA ${r.smaa ? 'oui' : 'non'}  HDR ${r.hdr ? 'oui' : 'non'}\nimages/s ${etat.ips}  appels ${etat.appels}  triangles ${Math.round(etat.triangles / 1000)} k`;
    }, 500);
  }

  function lancer() {
    if (enMarche) return;
    enMarche = true;
    tPrec = performance.now() / 1000;
    renderer.setAnimationLoop(boucle);
  }
  function arreter() { enMarche = false; renderer.setAnimationLoop(null); }
  document.addEventListener('visibilitychange', () => { if (document.hidden) arreter(); else lancer(); });

  // ------------------------------------------------------------------ préchauffage et première image
  ui.progression(0.7, 'réglage de la lumière');
  navetteSaut(courant);
  rig.maj(0, 0, { reduit, instantane: true });
  majAmbiance(0, 0);
  majProjection();
  majEclat(1);
  // kit : les objets visibles depuis la première halte arrivent avant la première image (téléchargés en
  // parallèle) ; les autres après, un par un, les plus proches d'abord. En mode test : tout, tout de suite.
  await kit.charger(test ? null : kit.typesVisibles(camera.position), camera.position, { parallele: true });
  reflets.appliquer(envHalte(courant));
  // lot H : reflets des haltes voisines dès le chargement (le premier trajet ne les calcule plus au départ)
  for (const j of [courant + 1, courant - 1]) if (j >= 0 && j < HALTES.length) envHalte(j);
  majAmbiance(0, 0);
  kit.animer(0, 0, camera.position);
  // lot H : tout visible et sans tri par le champ le temps d'une compilation et d'une image (cachée par l'écran
  // de chargement) : débris des anneaux, éclat du soleil, signal, pollen, objets du kit déjà là...
  {
    const rendre = toutVisible([scene]);
    try {
      if (renderer.compileAsync) await renderer.compileAsync(scene, camera);
    } catch (e) { /* la compilation se fera au premier rendu */ }
    renderer.info.reset();
    post.composer.render(0);
    rendre();
    etat.prechauffage = { appels: renderer.info.render.calls, triangles: renderer.info.render.triangles };
  }
  ui.progression(0.9, 'mise en orbite');
  // quelques images cachées pour finir de compiler les passes de post-traitement
  lancer();
  await image(); await image();
  ui.progression(1, 'en orbite');
  await attendre(test ? 50 : 350);

  // ouverture : la caméra glisse depuis le large jusqu'à la première halte
  if (courant === 0 && !reduit && !test) {
    const p = new Pose();
    rig.poseDe(0, p);
    const loin = new Pose().copy(p);
    const off = loin.pos.clone().sub(station.centre);
    off.applyAxisAngle(new THREE.Vector3(0, 1, 0), 0.22).multiplyScalar(2.4);
    loin.pos.copy(station.centre).add(off);
    loin.fov = p.fov + 6;
    rig.reamorcer();
    nav.de = 0; nav.vers = 0;
    rig.demarrer(0, 0, horloge, { depuis: loin, def: { type: 'recul', duree: 6.5 } });
  }
  etat.pret = true;
  etat.tPret = Math.round(performance.now());
  ui.pret();
  calculerCouloirs();
  if (!test) setTimeout(() => kit.charger(null, camera.position), 2500);

  // ------------------------------------------------------------------ crochet de test
  window.__station = {
    get halte() { return HALTES[courant].id; },
    haltes: HALTES.map((h) => h.id),
    etat,
    aller(id, { anime = false } = {}) {
      const i = INDEX[id];
      if (i == null) return false;
      if (anime) { naviguer(i); return true; }
      scroll.aligner(i);
      rig.annuler();
      courant = i;
      nav.de = -1; nav.vers = -1;
      reflets.appliquer(envHalte(i));
      navetteSaut(i);
      if (i === INDEX.quai) station.navette.avancer(3.5);
      rig.reamorcer();
      arriveeT = horloge - 1;
      ui.cacherCarte();
      ui.montrerCarte(id);
      history.replaceState(null, '', '#' + id);
      return true;
    },
    repli: (raison) => repli(raison || 'test'),
    // fige un trajet entre deux haltes voisines à la fraction u (0..1), pour les captures
    trajet(de, vers, u) {
      const a = INDEX[de], b = INDEX[vers];
      if (a == null || b == null) return false;
      gel = false;
      rig.annuler();
      courant = a;
      navetteSaut(a);
      ui.cacherCarte();
      const p = new Pose();
      rig.poseDe(a, p);
      nav.de = a; nav.vers = b;
      envHalte(b);
      reflets.appliquer(envHalte(u >= 0.5 ? b : a));
      navetteDepart(a, b);
      rig.demarrer(a, b, horloge, { depuis: p });
      const tr = rig.trajet;
      tr.t0 = horloge - u * tr.duree;
      rig.reamorcer();
      gel = true;
      return true;
    },
    degeler() { gel = false; },
    // fige l'horloge à t secondes (anneau, navette, soleil et débris au même instant d'une passe à
    // l'autre) et pose la caméra sans respiration ni travelling : captures comparables pixel à pixel
    // lot G : l'angle de l'anneau est fixé lui aussi (il dépendait du temps réel écoulé au chargement)
    figer(t) { horloge = t; tPrec = performance.now() / 1000; gel = true; rig.etat.respiration = 0; station.fixerAngle(t); },
  };
  // en mode test seulement : accès direct à la scène pour les sondes de rendu. Quelques classes de
  // three.js seulement (déjà utilisées par le site) : exposer tout l'espace de noms empêcherait
  // l'élagage du paquet (+150 Ko).
  if (test) {
    const outils = { Vector2: THREE.Vector2, Vector3: THREE.Vector3, Matrix4: THREE.Matrix4, Box3: THREE.Box3, Raycaster: THREE.Raycaster,
      MeshDepthMaterial: THREE.MeshDepthMaterial, WebGLRenderTarget: THREE.WebGLRenderTarget, RGBADepthPacking: THREE.RGBADepthPacking };
    Object.assign(window.__station, { scene, camera, renderer, post, station, rig, occupation, kit, lumiere: U_LUMIERE, reflets, THREE: outils });
    // lot H : une image de la boucle à la demande (films de trajets, tests/film.py : boucle d'animation arrêtée,
    // horloge simulée)
    window.__station.boucle = boucle;
  }
}

// Atlas de lumière précalculée (lot G) : assets/lumiere.json (gi_max, empreinte des UV),
// assets/lumiere-ao-<taille>.webp (occlusion ambiante, gris) et assets/lumiere-gi-<taille/2>.webp (lumière
// des émissifs, rgb = racine de GI / gi_max, plus douce : moitié de la définition).
async function chargerLumiere(taille, anisotropie) {
  try {
    const base = new URL('assets/', document.baseURI).href;
    const rep = await fetch(base + 'lumiere.json', { cache: 'no-cache' });
    if (!rep.ok || (rep.headers.get('content-type') || '').includes('text/html')) return null;
    const info = await rep.json();
    const lire = async (nom) => {
      const res = await fetch(base + nom);
      if (!res.ok) throw new Error(`${nom} : ${res.status}`);
      const blob = await res.blob();
      const bitmap = await createImageBitmap(blob, { imageOrientation: 'none', premultiplyAlpha: 'none', colorSpaceConversion: 'none' });
      const t = new THREE.Texture(bitmap);
      t.flipY = false; // convention glTF des coordonnées de texture
      t.colorSpace = THREE.NoColorSpace;
      t.generateMipmaps = true;
      t.minFilter = THREE.LinearMipmapLinearFilter;
      t.magFilter = THREE.LinearFilter;
      t.anisotropy = anisotropie;
      t.needsUpdate = true;
      return { t, octets: blob.size };
    };
    const [ao, gi] = await Promise.all([lire(`lumiere-ao-${taille}.webp`), lire(`lumiere-gi-${taille / 2}.webp`)]);
    return { ao: ao.t, gi: gi.t, info, taille, octets: ao.octets + gi.octets };
  } catch (e) {
    console.warn('[lumière] atlas illisible :', e && e.message);
    return null;
  }
}
