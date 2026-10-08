// Le ciel : fond cuit une fois dans un petit cubemap (bleu nuit, voie lactée ténue aux tons chauds),
// étoiles en points, disque du soleil dessiné au fond (la planète le cache naturellement),
// et un éblouissement par-dessus tout, dosé par la part du disque réellement visible.
import * as THREE from 'three';
import { SIMPLEX } from './glsl.js';

const BAKE = /* glsl */ `
precision highp float;
uniform float uFace;
uniform float uSize;
${SIMPLEX}
vec3 dirFace(vec2 sc){
  float s = sc.x, t = sc.y;
  if (uFace < 0.5) return vec3(1.0, -t, -s);
  if (uFace < 1.5) return vec3(-1.0, -t, s);
  if (uFace < 2.5) return vec3(s, 1.0, t);
  if (uFace < 3.5) return vec3(s, -1.0, -t);
  if (uFace < 4.5) return vec3(s, -t, 1.0);
  return vec3(-s, -t, -1.0);
}
float fbm(vec3 p){ float a = 0.5, s = 0.0; for (int i = 0; i < 6; i++) { s += a * snoise(p); p = p * 2.1 + 7.3; a *= 0.5; } return s; }
void main(){
  vec3 d = normalize(dirFace((gl_FragCoord.xy / uSize) * 2.0 - 1.0));
  vec3 m = normalize(vec3(0.42, 0.78, 0.46));
  float b = dot(d, m);
  float bande = exp(-b * b / 0.022);
  float large = exp(-b * b / 0.12);
  float n = fbm(d * 2.6);
  float n2 = fbm(d * 7.0 + 3.0);
  float poussiere = smoothstep(0.05, 0.45, fbm(d * 4.2 + 11.0)) * exp(-b * b / 0.006);
  vec3 fond = mix(vec3(0.0021, 0.0033, 0.0080), vec3(0.0040, 0.0060, 0.0125), 0.5 + 0.5 * n);
  vec3 lacte = vec3(0.016, 0.0125, 0.0095) * bande * (0.55 + 0.45 * n2) + vec3(0.004, 0.0045, 0.0062) * large;
  lacte *= 1.0 - 0.85 * poussiere;
  // nébuleuses très discrètes, rouille et ambre
  float neb = smoothstep(0.25, 0.75, fbm(d * 1.6 + 5.0)) * bande;
  lacte += vec3(0.010, 0.0042, 0.0018) * neb;
  vec3 c = fond + lacte;
  gl_FragColor = vec4(sqrt(c), 1.0);
}
`;

const FOND_VERT = /* glsl */ `
varying vec3 vDir;
void main(){
  vDir = position;
  vec4 p = projectionMatrix * vec4(mat3(viewMatrix) * position, 1.0);
  gl_Position = vec4(p.xy, p.w * 0.999999, p.w);
}
`;

const FOND_FRAG = /* glsl */ `
uniform samplerCube uCiel;
uniform vec3 uSoleil;
uniform vec3 uCouleurSoleil;
uniform float uRs;
uniform float uFond;
varying vec3 vDir;
void main(){
  vec3 d = normalize(vDir);
  vec3 c = texture(uCiel, d).rgb;
  c = c * c * uFond;
  float ca = clamp(dot(d, uSoleil), -1.0, 1.0);
  float ang = acos(ca);
  float disque = 1.0 - smoothstep(uRs * 0.9, uRs, ang);
  float couronne = exp(-max(ang - uRs, 0.0) / (uRs * 1.3));
  float lueur = exp(-ang / 0.09);
  c += uCouleurSoleil * (disque * 90.0 + couronne * 5.0 + lueur * 0.18);
  gl_FragColor = vec4(c, 1.0);
}
`;

const ETOILES_VERT = /* glsl */ `
attribute float aTaille;
attribute vec3 aCouleur;
attribute float aPhase;
uniform float uTemps;
uniform float uPixel;
varying vec3 vCol;
void main(){
  vec4 p = projectionMatrix * vec4(mat3(viewMatrix) * position, 1.0);
  gl_Position = vec4(p.xy, p.w * 0.999998, p.w);
  float sc = 0.78 + 0.22 * sin(uTemps * (0.7 + aPhase * 2.3) + aPhase * 50.0);
  gl_PointSize = max(aTaille * uPixel, 1.0);
  vCol = aCouleur * sc;
}
`;

const ETOILES_FRAG = /* glsl */ `
varying vec3 vCol;
void main(){
  vec2 c = gl_PointCoord - 0.5;
  float a = smoothstep(0.5, 0.05, length(c));
  gl_FragColor = vec4(vCol * a * a, 1.0);
}
`;

const ECLAT_FRAG = /* glsl */ `
uniform vec2 uSol;
uniform vec2 uRes;
uniform float uVis;
uniform vec3 uCouleur;
void main(){
  vec2 uv = (gl_FragCoord.xy / uRes) * 2.0 - 1.0;
  vec2 dl = uv - uSol;
  dl.x *= uRes.x / uRes.y;
  float r = length(dl);
  float halo = exp(-r * 3.0) * 0.22 + exp(-r * 12.0) * 0.55 + exp(-r * 40.0) * 1.2;
  float trait = exp(-abs(dl.y) * 140.0) * exp(-abs(dl.x) * 1.8) * 0.3;
  float rc = (r - 0.42) * 16.0;
  float cercle = exp(-rc * rc) * 0.035;
  gl_FragColor = vec4(uCouleur * (halo + trait + cercle) * uVis, 1.0);
}
`;

export function creerCiel(renderer, niveau, rayonSoleil) {
  // --- cuisson du fond ---
  const taille = niveau.ciel;
  const rt = new THREE.WebGLCubeRenderTarget(taille, {
    type: THREE.UnsignedByteType, generateMipmaps: true,
    minFilter: THREE.LinearMipmapLinearFilter, magFilter: THREE.LinearFilter,
  });
  const matBake = new THREE.ShaderMaterial({
    uniforms: { uFace: { value: 0 }, uSize: { value: taille } },
    vertexShader: 'void main(){ gl_Position = vec4(position.xy, 0.0, 1.0); }',
    fragmentShader: BAKE, depthTest: false, depthWrite: false,
  });
  const tri = new THREE.BufferGeometry();
  tri.setAttribute('position', new THREE.Float32BufferAttribute([-1, -1, 0, 3, -1, 0, -1, 3, 0], 3));
  const q = new THREE.Mesh(tri, matBake);
  q.frustumCulled = false;
  const sc = new THREE.Scene();
  sc.add(q);
  const cam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
  const cuire = () => {
    const avant = renderer.getRenderTarget();
    for (let f = 0; f < 6; f++) {
      matBake.uniforms.uFace.value = f;
      renderer.setRenderTarget(rt, f);
      renderer.render(sc, cam);
    }
    renderer.setRenderTarget(avant);
    matBake.dispose();
  };

  const groupe = new THREE.Group();
  groupe.name = 'ciel';

  const uniformsFond = {
    uCiel: { value: rt.texture },
    uSoleil: { value: new THREE.Vector3(1, 0, 0) },
    uCouleurSoleil: { value: new THREE.Color(1, 0.95, 0.88) },
    uRs: { value: rayonSoleil },
    uFond: { value: 1.0 },
  };
  const fond = new THREE.Mesh(
    new THREE.SphereGeometry(1, 48, 24),
    new THREE.ShaderMaterial({
      uniforms: uniformsFond, vertexShader: FOND_VERT, fragmentShader: FOND_FRAG,
      side: THREE.BackSide, depthWrite: false,
    }),
  );
  fond.frustumCulled = false;
  fond.renderOrder = -100;
  groupe.add(fond);

  // --- étoiles ---
  const n = niveau.etoiles;
  const pos = new Float32Array(n * 3), taille2 = new Float32Array(n), col = new Float32Array(n * 3), ph = new Float32Array(n);
  let seed = 99;
  const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
  const m = new THREE.Vector3(0.42, 0.78, 0.46).normalize();
  const v = new THREE.Vector3();
  const teintes = [[1, 0.93, 0.84], [1, 1, 1], [1, 0.86, 0.64], [1, 0.72, 0.48], [0.84, 0.9, 1.0]];
  for (let i = 0; i < n; i++) {
    // un tiers des étoiles se resserre vers la voie lactée
    for (;;) {
      v.set(rnd() * 2 - 1, rnd() * 2 - 1, rnd() * 2 - 1);
      const l = v.length();
      if (l < 0.05 || l > 1) continue;
      v.divideScalar(l);
      if (i % 3 === 0 && Math.abs(v.dot(m)) > 0.22 * rnd() + 0.05) continue;
      break;
    }
    pos.set([v.x, v.y, v.z], i * 3);
    const mag = Math.pow(rnd(), 7.0);
    taille2[i] = 1.2 + mag * 2.8 + rnd() * 0.7;
    const t = teintes[Math.floor(Math.pow(rnd(), 1.4) * teintes.length) % teintes.length];
    const e = 0.32 + mag * 4.2 + rnd() * 0.2;
    col.set([t[0] * e, t[1] * e, t[2] * e], i * 3);
    ph[i] = rnd();
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  g.setAttribute('aTaille', new THREE.BufferAttribute(taille2, 1));
  g.setAttribute('aCouleur', new THREE.BufferAttribute(col, 3));
  g.setAttribute('aPhase', new THREE.BufferAttribute(ph, 1));
  const uniformsEtoiles = { uTemps: { value: 0 }, uPixel: { value: 1 } };
  const etoiles = new THREE.Points(g, new THREE.ShaderMaterial({
    uniforms: uniformsEtoiles, vertexShader: ETOILES_VERT, fragmentShader: ETOILES_FRAG,
    transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
  }));
  etoiles.frustumCulled = false;
  etoiles.renderOrder = -99;
  groupe.add(etoiles);

  // --- éblouissement (par-dessus tout) ---
  const uniformsEclat = {
    uSol: { value: new THREE.Vector2() }, uRes: { value: new THREE.Vector2(1, 1) },
    uVis: { value: 0 }, uCouleur: { value: new THREE.Color(1.0, 0.72, 0.42) },
  };
  const eclat = new THREE.Mesh(tri.clone(), new THREE.ShaderMaterial({
    uniforms: uniformsEclat,
    vertexShader: 'void main(){ gl_Position = vec4(position.xy, 0.0, 1.0); }',
    fragmentShader: ECLAT_FRAG,
    transparent: true, depthTest: false, depthWrite: false, blending: THREE.AdditiveBlending,
  }));
  eclat.frustumCulled = false;
  eclat.renderOrder = 1000;
  eclat.visible = false;

  return { groupe, fond, etoiles, eclat, uniformsFond, uniformsEtoiles, uniformsEclat, cuire };
}
