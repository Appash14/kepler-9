// Garde-fous du rendu HDR (lot F).
// Dans le clip de Tom, un grand rectangle noir apparaît pendant une image, de temps en temps (serre,
// trajet anneaux vers quai). C'est la signature d'un seul pixel NaN ou infini dans le tampon
// demi-flottant de la scène : le flou en cascade du bloom l'étale en blocs, puis le tone mapping les
// noircit. Sources trouvées : le reflet du verre (pow() d'un nombre négatif quand la vue est pile dans
// l'axe d'une facette) et les éclats du soleil sur le verre et le cuivre lisses, qui dépassent les
// 65 504 du demi-flottant. Les mêmes éclats, larges d'un pixel, s'allumaient et s'éteignaient d'une
// image à l'autre avec un halo énorme (lucioles). Trois garde-fous, sans passe en plus :
// 1. la sortie de tous les matériaux three.js est assainie (NaN vers 0) et plafonnée (ECLAT_MAX) ;
// 2. l'entrée du bloom est assainie (filet pour les shaders maison : géante, anneaux, ciel...) ;
// 3. les pow() à base peut-être négative sont corrigés à la source (verre, faisceau, poussière...).
import * as THREE from 'three';

// plafond des matériaux de la station : au-dessus, AgX rend du blanc de toute façon ; seul le halo du
// bloom grandissait encore (un éclat à 30 000 faisait un halo de la moitié de l'écran)
export const ECLAT_MAX = 64;
// plafond de l'entrée du bloom : le disque du soleil (90) garde tout son halo
export const BLOOM_MAX = 256;

export function installerGardeFous() {
  if (THREE.ShaderChunk.dithering_fragment.includes('garde-fou')) return;
  THREE.ShaderChunk.dithering_fragment += /* glsl */ `
// garde-fou (lot F) : jamais de NaN ni d'infini dans le tampon HDR, éclats plafonnés
// un NaN échoue à toute comparaison : on le remplace par du noir (isnan seul est parfois ignoré par
// les pilotes ; max() avec un NaN dépend du GPU, SwiftShader rend même un blanc)
gl_FragColor = (any(isnan(gl_FragColor)) || !all(greaterThanEqual(gl_FragColor, vec4(-1.0)))) ? vec4(0.0) : gl_FragColor;
gl_FragColor = min(max(vec4(0.0), gl_FragColor), vec4(6.0e4));
gl_FragColor.rgb *= min(1.0, ${ECLAT_MAX.toFixed(1)} / max(max(gl_FragColor.r, max(gl_FragColor.g, gl_FragColor.b)), 1e-4));
gl_FragColor.a = min(gl_FragColor.a, 1.0);
`;
}

// postprocessing : le bloom lit le tampon de scène dans sa passe de luminance, avant tout le reste
export function assainirBloom(bloom) {
  const m = bloom.luminanceMaterial;
  const avant = 'vec4 texel=texture2D(inputBuffer,vUv);';
  if (!m || !m.fragmentShader.includes(avant)) return false;
  m.fragmentShader = m.fragmentShader.replace(avant,
    `vec4 texel=texture2D(inputBuffer,vUv);texel=(any(isnan(texel))||!all(greaterThanEqual(texel,vec4(-1.0))))?vec4(0.0):min(max(vec4(0.0),texel),vec4(${BLOOM_MAX.toFixed(1)}));`);
  m.needsUpdate = true;
  return true;
}
