// Reflets (lot G) : la carte d'environnement est rendue depuis la VRAIE scène (géante gazeuse et ses
// bandes, anneaux, étoiles, disque du soleil), vue du centre de la station, puis filtrée en PMREM. Elle est
// refaite pour chaque halte (le soleil et la phase de la géante changent d'une halte à l'autre) : calculée
// au départ du trajet, quand la caméra est encore presque immobile, et appliquée à mi-parcours. Le cuivre
// poli y voit la planète, les anneaux et l'éclat du soleil.
import * as THREE from 'three';

export function creerReflets(renderer, scene, { taille = 256, cacher = [], avant = null, apres = null } = {}) {
  const cible = new THREE.WebGLCubeRenderTarget(taille, { type: THREE.HalfFloatType, generateMipmaps: false });
  const cam = new THREE.CubeCamera(2, 60000, cible);
  const pmrem = new THREE.PMREMGenerator(renderer);
  pmrem.compileCubemapShader();
  const cache = new Map(); // clé (halte) -> WebGLRenderTarget PMREM
  const ordre = [];
  const etat = { calculs: 0, ms: 0, taille };

  function calculer(cle, preparer) {
    if (cache.has(cle)) return cache.get(cle).texture;
    const t0 = performance.now();
    const visibles = cacher.map((o) => o && o.visible);
    cacher.forEach((o) => { if (o) o.visible = false; });
    const brume = scene.fog;
    scene.fog = null;
    const fond = scene.background;
    const env = scene.environment;
    scene.environment = null;
    if (avant) avant();
    if (preparer) preparer();
    cam.position.set(0, 0, 0);
    cam.update(renderer, scene);
    if (apres) apres();
    scene.fog = brume;
    scene.background = fond;
    scene.environment = env;
    cacher.forEach((o, i) => { if (o) o.visible = visibles[i]; });
    const rt = pmrem.fromCubemap(cible.texture);
    cache.set(cle, rt);
    ordre.push(cle);
    // quatre cartes au plus en mémoire (halte courante, suivante, précédente...) : on libère la plus
    // ancienne qui n'est pas affichée
    while (ordre.length > 4) {
      const i = ordre.findIndex((k) => k !== cle && cache.get(k).texture !== scene.environment);
      if (i < 0) break;
      const k = ordre.splice(i, 1)[0];
      cache.get(k).dispose();
      cache.delete(k);
    }
    etat.calculs++;
    etat.ms += performance.now() - t0;
    return rt.texture;
  }

  return {
    etat,
    calculer,
    appliquer(texture) { if (texture && scene.environment !== texture) scene.environment = texture; },
    a(cle) { return cache.has(cle); },
  };
}
