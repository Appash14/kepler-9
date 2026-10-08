// Post-traitement sobre (pmndrs/postprocessing) :
// passe 1 : rendu de la scène dans un tampon HDR (demi-flottant), multiéchantillonné (MSAA) quand le
//           GPU l'accepte pour ce format : les câbles, rambardes et petits feux de la station ne
//           clignotent plus d'une image à l'autre
// passe 2 : bloom (seuil au-dessus des surfaces éclairées : seuls le soleil, les émissifs et le noyau
//           débordent), étalonnage de la halte (exposition, teinte, saturation), tone mapping AgX
// passe 3 : SMAA sur l'image déjà ramenée en 0..1, vignette, grain très léger
import * as THREE from 'three';
import {
  EffectComposer, RenderPass, EffectPass, BloomEffect, SMAAEffect, SMAAPreset,
  ToneMappingEffect, ToneMappingMode, VignetteEffect, NoiseEffect, BlendFunction, Effect,
} from 'postprocessing';

class EtalonnageEffect extends Effect {
  constructor() {
    super('EtalonnageEffect', /* glsl */ `
      uniform float exposition;
      uniform float saturation;
      uniform vec3 teinte;
      void mainImage(const in vec4 inputColor, const in vec2 uv, out vec4 outputColor) {
        vec3 c = inputColor.rgb * exposition * teinte;
        float l = dot(c, vec3(0.2126, 0.7152, 0.0722));
        c = max(mix(vec3(l), c, saturation), 0.0);
        outputColor = vec4(c, inputColor.a);
      }`, {
      uniforms: new Map([
        ['exposition', new THREE.Uniform(1)],
        ['saturation', new THREE.Uniform(1)],
        ['teinte', new THREE.Uniform(new THREE.Vector3(1, 1, 1))],
      ]),
    });
  }
}

// Nombre d'échantillons MSAA réellement acceptés pour le format du tampon de scène. postprocessing ne
// teste que RGBA8 ; or beaucoup de GPU mobiles plafonnent plus bas (ou à zéro) en RGBA16F.
function echantillonsPossibles(renderer, type, voulu) {
  const gl = renderer.getContext();
  if (!voulu || typeof WebGL2RenderingContext === 'undefined' || !(gl instanceof WebGL2RenderingContext)) return 0;
  let format = gl.RGBA8;
  if (type === THREE.HalfFloatType) {
    // RGBA16F n'est interrogeable que s'il est rendu possible par l'une des deux extensions (lot F :
    // EXT_color_buffer_half_float suffit, c'est souvent la seule sur les GPU mobiles)
    if (!renderer.extensions.has('EXT_color_buffer_float') && !renderer.extensions.has('EXT_color_buffer_half_float')) return 0;
    format = gl.RGBA16F;
  }
  try {
    const liste = gl.getInternalformatParameter(gl.RENDERBUFFER, format, gl.SAMPLES);
    if (!liste || !liste.length) return 0;
    // la liste est décroissante : le plus grand nombre qui ne dépasse pas la demande
    for (const n of liste) if (n <= voulu) return n;
    return 0;
  } catch (e) {
    return 0;
  }
}

// Lissage temporel du bloom (lot F). Le halo de l'image courante est mélangé à celui de la précédente
// (constante de temps 22 ms : poids 0,53 pour l'image courante à 60 images/s). Un point très brillant qui
// s'allume et s'éteint d'une image à l'autre (soleil vu entre les rayons de l'anneau qui tournent, reflet
// d'un hublot) ne fait plus clignoter un grand halo ; le halo ne suit qu'avec une image de retard. Une
// seule passe plein écran, à la résolution déjà réduite du bloom.
function lisserBloom(bloom) {
  const passe = bloom.mipmapBlurPass;
  if (!passe || !passe.renderTarget) return null;
  const type = passe.renderTarget.texture.type;
  const opts = { type, depthBuffer: false, minFilter: THREE.LinearFilter, magFilter: THREE.LinearFilter };
  let A = new THREE.WebGLRenderTarget(1, 1, opts), B = new THREE.WebGLRenderTarget(1, 1, opts);
  const mat = new THREE.ShaderMaterial({
    uniforms: { cur: { value: null }, prev: { value: null }, k: { value: 1 } },
    vertexShader: 'varying vec2 vUv; void main(){ vUv = position.xy * 0.5 + 0.5; gl_Position = vec4(position.xy, 0.0, 1.0); }',
    fragmentShader: `uniform sampler2D cur; uniform sampler2D prev; uniform float k; varying vec2 vUv;
      void main(){ vec4 c = texture2D(cur, vUv), p = texture2D(prev, vUv);
        gl_FragColor = max(vec4(0.0), mix(p, c, k)); }`,
    depthTest: false, depthWrite: false,
  });
  const tri = new THREE.BufferGeometry();
  tri.setAttribute('position', new THREE.Float32BufferAttribute([-1, -1, 0, 3, -1, 0, -1, 3, 0], 3));
  const quad = new THREE.Mesh(tri, mat);
  quad.frustumCulled = false;
  const sc = new THREE.Scene(); sc.add(quad);
  const cam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
  let neuf = true;
  const etat = { actif: true, reinitialiser() { neuf = true; } };
  const update = bloom.update.bind(bloom);
  bloom.update = (renderer, inputBuffer, dt) => {
    update(renderer, inputBuffer, dt);
    const src = passe.renderTarget;
    if (!etat.actif) { bloom.uniforms.get('map').value = src.texture; return; }
    if (A.width !== src.width || A.height !== src.height) { A.setSize(src.width, src.height); B.setSize(src.width, src.height); neuf = true; }
    mat.uniforms.cur.value = src.texture;
    mat.uniforms.prev.value = A.texture;
    mat.uniforms.k.value = neuf || !(dt > 0) ? 1 : 1 - Math.exp(-dt / 0.022);
    renderer.setRenderTarget(B);
    renderer.render(sc, cam);
    [A, B] = [B, A];
    neuf = false;
    bloom.uniforms.get('map').value = A.texture;
  };
  return etat;
}

export function creerPost(renderer, scene, camera, niveau, { profondeur16 = false } = {}) {
  // tampon HDR demi-flottant si le GPU sait y dessiner, sinon 8 bits (moins de bloom, mais une image)
  const hdr = renderer.extensions.has('EXT_color_buffer_float') || renderer.extensions.has('EXT_color_buffer_half_float');
  const type = hdr ? THREE.HalfFloatType : THREE.UnsignedByteType;
  const composer = new EffectComposer(renderer, { frameBufferType: type, multisampling: 0 });
  // MSAA sur le seul tampon où la scène est dessinée : les passes plein écran suivantes n'ont pas
  // d'arêtes, inutile d'y payer le multiéchantillonnage
  const msaa = echantillonsPossibles(renderer, type, niveau.msaa || 0);
  if (msaa > 0) {
    composer.inputBuffer.samples = msaa;
    composer.inputBuffer.dispose();
  }
  composer.addPass(new RenderPass(scene, camera));
  const bloom = new BloomEffect({
    mipmapBlur: true, luminanceThreshold: 1.05, luminanceSmoothing: 0.35,
    intensity: 0.9, radius: 0.74, levels: niveau.bloomNiveaux,
  });
  const lissage = lisserBloom(bloom);
  const etalonnage = new EtalonnageEffect();
  const tone = new ToneMappingEffect({ mode: ToneMappingMode.AGX });
  composer.addPass(new EffectPass(camera, bloom, etalonnage, tone));
  const fin = [];
  if (niveau.smaa) fin.push(new SMAAEffect({ preset: SMAAPreset.MEDIUM }));
  const vignette = new VignetteEffect({ offset: 0.3, darkness: 0.52 });
  fin.push(vignette);
  let grain = null;
  if (niveau.grain) {
    grain = new NoiseEffect({ blendFunction: BlendFunction.SOFT_LIGHT, premultiply: false });
    grain.blendMode.opacity.value = 0.12;
    fin.push(grain);
  }
  composer.addPass(new EffectPass(camera, ...fin));
  // mode test « pire téléphone » : profondeur sur 16 bits. Le SMAA demande la profondeur, si bien que
  // le compositeur a déjà créé ses textures (flottantes 32 bits) en ajoutant la passe : on les passe
  // toutes en 16 bits (même format partout, sinon la copie de profondeur échoue).
  if (profondeur16) {
    if (!composer.inputBuffer.depthTexture) composer.inputBuffer.depthTexture = new THREE.DepthTexture(1, 1);
    for (const rt of [composer.inputBuffer, composer.outputBuffer, composer.depthRenderTarget]) {
      if (!rt) continue;
      if (rt.depthTexture) rt.depthTexture.type = THREE.UnsignedShortType;
      rt.dispose();
    }
  }
  return {
    composer, bloom, etalonnage, vignette, grain, msaa, hdr, smaa: !!niveau.smaa, lissage,
    // le moniteur de fluidité peut renoncer au MSAA (une seule fois, sans retour : pas d'oscillation)
    couperMsaa() {
      if (!this.msaa) return;
      this.msaa = 0;
      composer.inputBuffer.samples = 0;
      composer.inputBuffer.dispose();
    },
    regler({ exposition, saturation, teinte, bloom: b }) {
      etalonnage.uniforms.get('exposition').value = exposition;
      etalonnage.uniforms.get('saturation').value = saturation;
      etalonnage.uniforms.get('teinte').value.set(teinte[0], teinte[1], teinte[2]);
      bloom.intensity = b;
    },
  };
}
