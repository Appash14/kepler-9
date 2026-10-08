// Matériaux soignés (lot G) : injections dans les MeshStandardMaterial de la station et du kit.
// - cuivre poli : reconnu à sa couleur (orangé saturé) ; métal à 1, rugosité basse et différente d'une
//   facette à l'autre (chaque face accroche le soleil à son tour), teinte de réflexion chaude et claire
//   (le F0 d'un cuivre poli, pas la couleur de base sombre) ;
// - métaux peints (gris) : satinés ; coque blanc cassé : mate, légèrement variée ;
// - lumière précalculée (atlas de la station, cuit par Cycles) : occlusion ambiante appliquée à la lumière
//   d'ambiance et aux reflets, un peu à la lumière directe (contact), et lumière des émissifs (rebonds).
// Les reflets viennent de la carte d'environnement rendue depuis la scène (reflets.js). Les sorties des
// shaders restent bornées par securite.js (lot F) : pas de NaN, éclats plafonnés.
export const U_LUMIERE = {
  tLumiere: { value: null }, // occlusion ambiante (canal rouge)
  tLumiereGI: { value: null }, // lumière des émissifs (rgb = racine de GI / gi_max)
  uGIMax: { value: 4.0 },
  uForceAO: { value: 0.0 },
  uForceGI: { value: 0.0 },
  uAODirect: { value: 0.55 },
  uTailleLum: { value: 2048 },
};

const HASH = /* glsl */ `
float kHash(vec3 c) { return fract(sin(dot(c, vec3(12.9898, 78.233, 37.719))) * 43758.5453); }
// part « cuivre » d'une couleur linéaire : orangé saturé (rouge > vert > bleu)
float kCuivre(vec3 c) {
  float mx = max(c.r, max(c.g, c.b)), mn = min(c.r, min(c.g, c.b));
  float sat = (mx - mn) / max(mx, 1e-4);
  return smoothstep(0.55, 0.78, sat) * step(c.b, c.g) * step(c.g, c.r) * smoothstep(0.03, 0.09, c.r);
}`;

// cuivre et métaux : appliqué juste après metalnessmap_fragment (facteurs définis, avant l'éclairage).
// Couleurs par sommet (station) : une rugosité par facette (hachage de la couleur, légèrement variée face
// par face par Blender). Textures (kit IA, navette) : rugosité fixe, sinon elle varierait d'un texel à
// l'autre et scintillerait.
const METAL = (parSommet) => /* glsl */ `
${parSommet ? '#if defined( USE_COLOR ) || defined( USE_COLOR_ALPHA )' : ''}
{
  vec3 cK = ${parSommet ? 'vColor.rgb' : 'diffuseColor.rgb'};
  float cu = kCuivre(cK)${parSommet ? '' : ' * smoothstep(0.1, 0.2, cK.r)'};
  float hK = ${parSommet ? 'kHash(floor(cK * 4096.0 + 0.5))' : '0.45'};
  // cuivre poli : F0 chaud et clair (couleur relevée, un peu de F0 de cuivre réel ; le F0 mesuré
  // (0,955, 0,637, 0,538) seul tirait vers le rose)
  vec3 f0 = mix(min(cK * 2.0, vec3(1.0)), vec3(0.96, 0.56, 0.30), 0.35);
  diffuseColor.rgb = mix(diffuseColor.rgb, f0, cu);
  metalnessFactor = mix(metalnessFactor, 1.0, cu);
  // pas sous 0,2 : un reflet plus fin qu'un pixel clignoterait sur l'anneau qui tourne (lot F)
  roughnessFactor = mix(roughnessFactor, mix(0.2, 0.38, hK), cu);
  ${parSommet ? `// métaux peints (gris) : satinés
  metalnessFactor = mix(metalnessFactor, 0.5 + 0.3 * hK, 1.0 - cu);
  roughnessFactor = mix(roughnessFactor, 0.34 + 0.16 * hK, 1.0 - cu);` : ''}
}
${parSommet ? '#endif' : ''}`;

// paraboles (Tom, 2026-10-02 : « pourquoi toutes les paraboles ne sont pas aussi belles ») : du cuivre partout,
// rugosité variée par facette (couleurs variées face par face, dos compris depuis le lot H). Lot H : la coupe
// (face concave, couleur claire) est un cuivre satiné à moitié métal, pour que la lumière cuite de son cornet
// (rebonds chauds) s'y lise ; dos, rebord et cornet en cuivre poli ; monture en bronze sombre. La lumière cuite
// compte aussi dans les reflets de ces métaux (KEPLER_GI_METAL, voir LUMIERE).
const CUIVRE_TOUT = /* glsl */ `
{
  #if defined( USE_COLOR ) || defined( USE_COLOR_ALPHA )
  vec3 cP = vColor.rgb;
  #else
  vec3 cP = vec3(0.7);
  #endif
  float hK = kHash(floor(cP * 4096.0 + 0.5));
  float clair = dot(cP, vec3(0.3333));
  float coupe = smoothstep(0.62, 0.74, clair) * (1.0 - kCuivre(cP));
  float sombre = 1.0 - smoothstep(0.12, 0.3, clair);
  diffuseColor.rgb = vec3(0.96, 0.60, 0.36) * mix(mix(0.66, 1.0, smoothstep(0.15, 0.75, clair)), 0.42, sombre);
  metalnessFactor = mix(1.0, 0.5, coupe);
  roughnessFactor = mix(0.2, 0.34, hK) + 0.08 * coupe;
}`;

const COQUE = /* glsl */ `
#if defined( USE_COLOR ) || defined( USE_COLOR_ALPHA )
{
  float hK = kHash(floor(vColor.rgb * 4096.0 + 0.5));
  roughnessFactor = clamp(roughnessFactor + 0.08 + (hK - 0.5) * 0.2, 0.35, 0.92);
}
#endif`;

const LUMIERE = /* glsl */ `
#ifdef KEPLER_LUMIERE
{
  // niveau de mipmap plafonné : l'atlas range des milliers d'îles côte à côte, et les niveaux grossiers
  // mélangeraient les voisines (taches de couleur au loin) ; 1,5 niveau reste dans la marge des îles
  vec2 tK = vLumUv * uTailleLum;
  float lodK = 0.5 * log2(max(max(dot(dFdx(tK), dFdx(tK)), dot(dFdy(tK), dFdy(tK))), 1e-8));
  float aoT = textureLod(tLumiere, vLumUv, clamp(lodK, 0.0, 1.5)).r;
  float aoK = mix(1.0, aoT * sqrt(aoT), uForceAO);
  vec3 lmK = textureLod(tLumiereGI, vLumUv, clamp(lodK - 1.0, 0.0, 1.0)).rgb;
  reflectedLight.indirectDiffuse *= aoK;
  #if defined( USE_ENVMAP ) && defined( STANDARD )
    float dnvK = saturate(dot(geometryNormal, geometryViewDir));
    reflectedLight.indirectSpecular *= computeSpecularOcclusion(dnvK, aoK, material.roughness);
  #endif
  reflectedLight.directDiffuse *= mix(1.0, aoK, uAODirect);
  reflectedLight.directSpecular *= mix(1.0, aoK, uAODirect * 0.6);
  vec3 giK = lmK * lmK * uGIMax * uForceGI;
  // toute la lumière des émissifs est chaude (r >= g >= b) : on retire les franges vertes ou bleues que la
  // compression WebP (chrominance sous-échantillonnée) laisse au bord des îles sombres
  giK.g = min(giK.g, giK.r);
  giK.b = min(giK.b, giK.g);
  reflectedLight.indirectDiffuse += giK * material.diffuseColor;
  #ifdef KEPLER_GI_METAL
  // paraboles (lot H) : un métal n'a pas de diffus ; la lumière de son cornet, cuite dans l'atlas, passe par
  // ses reflets (la coupe se reflète elle-même, éclairée par le foyer)
  reflectedLight.indirectSpecular += giK * material.specularColorBlended * 0.9;
  #else
  reflectedLight.indirectSpecular += giK * material.specularColorBlended * 0.25;
  #endif
}
#endif`;

// genre : 'metal' (couleurs par sommet), 'coque', 'texture' (kit, navette), 'cuivre' (paraboles) ; lumiere : atlas cuit
const ENRICHIS = new WeakSet();
export function enrichir(mat, { genre = null, lumiere = false } = {}) {
  if (!mat || !mat.isMeshStandardMaterial || ENRICHIS.has(mat)) return mat;
  ENRICHIS.add(mat);
  const prec = mat.onBeforeCompile;
  const precCle = mat.customProgramCacheKey;
  const aPrec = prec && prec !== mat.constructor.prototype.onBeforeCompile;
  mat.onBeforeCompile = function (sh, r) {
    if (aPrec) prec.call(this, sh, r);
    let f = sh.fragmentShader;
    f = f.replace('#include <common>', `#include <common>\n${HASH}`);
    if (genre === 'metal') f = f.replace('#include <metalnessmap_fragment>', `#include <metalnessmap_fragment>\n${METAL(true)}`);
    if (genre === 'texture') f = f.replace('#include <metalnessmap_fragment>', `#include <metalnessmap_fragment>\n${METAL(false)}`);
    if (genre === 'coque') f = f.replace('#include <roughnessmap_fragment>', `#include <roughnessmap_fragment>\n${COQUE}`);
    if (genre === 'cuivre') f = f.replace('#include <metalnessmap_fragment>', `#include <metalnessmap_fragment>\n${CUIVRE_TOUT}`);
    if (lumiere) {
      Object.assign(sh.uniforms, U_LUMIERE);
      sh.defines = sh.defines || {};
      sh.defines.KEPLER_LUMIERE = '';
      if (genre === 'cuivre') sh.defines.KEPLER_GI_METAL = '';
      f = f.replace('#include <common>', '#include <common>\nuniform sampler2D tLumiere;\nuniform sampler2D tLumiereGI;\nuniform float uGIMax, uForceAO, uForceGI, uAODirect, uTailleLum;\nvarying vec2 vLumUv;')
        .replace('#include <aomap_fragment>', `#include <aomap_fragment>\n${LUMIERE}`);
      sh.vertexShader = sh.vertexShader
        .replace('#include <common>', '#include <common>\nvarying vec2 vLumUv;')
        .replace('#include <uv_vertex>', '#include <uv_vertex>\nvLumUv = uv;');
    }
    sh.fragmentShader = f;
  };
  mat.customProgramCacheKey = function () {
    return `${aPrec && precCle ? precCle.call(this) : ''}|k-${genre || ''}-${lumiere ? 1 : 0}`;
  };
  mat.needsUpdate = true;
  return mat;
}
