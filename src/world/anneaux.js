// Les anneaux de la géante : un disque plat dans le plan équatorial, dessiné par un shader.
// Profil radial (densité et couleur) généré une fois en JS : anneau intérieur sombre et ténu,
// anneau principal dense, grande division, anneau extérieur avec deux lacunes, filament fin au bord.
// Le shader ajoute les annelets fins, l'opacité qui croît en vue rasante, la face éclairée ou
// rétroéclairée, l'ombre de la planète, et s'efface près de la caméra quand on est dans le plan.
import * as THREE from 'three';
import { HASH, OMBRE_PLANETE } from './glsl.js';

export function profilAnneaux() {
  // Profil radial, de l'intérieur (x = 0) à l'extérieur (x = 1). Canal alpha : épaisseur optique.
  const n = 4096;
  const data = new Uint8Array(n * 4);
  let seed = 1234567;
  const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
  // bruit 1D périodique à plusieurs échelles (accepte n'importe quel x)
  const oct = [];
  for (let k = 0; k < 7; k++) {
    const m = 16 << k, v = new Float32Array(m + 1);
    for (let i = 0; i <= m; i++) v[i] = rnd();
    oct.push(v);
  }
  const bruit = (x, deb = 0, fin = oct.length) => {
    let s = 0, a = 0.5, t = 0;
    for (let k = deb; k < fin; k++) {
      const v = oct[k], m = v.length - 1, f = x * m, i0 = Math.floor(f), u = f - i0;
      const i = ((i0 % m) + m) % m, j = (i + 1) % m;
      const w = u * u * (3 - 2 * u);
      s += a * (v[i] * (1 - w) + v[j] * w); t += a; a *= 0.62;
    }
    return s / t;
  };
  const sm = (a, b, x) => { const t = Math.min(1, Math.max(0, (x - a) / (b - a))); return t * t * (3 - 2 * t); };
  const fenetre = (a, b, x, bord) => sm(a - bord, a + bord, x) * (1 - sm(b - bord, b + bord, x));
  const lacune = (c, l, x) => 1 - Math.exp(-Math.pow((x - c) / l, 6)) * 0.98;
  const couleurs = {
    terne: new THREE.Color('#8b7a66'), gris: new THREE.Color('#9d9282'), creme: new THREE.Color('#dcc29a'),
    tan: new THREE.Color('#c6a277'), clair: new THREE.Color('#ead8b8'), rouille: new THREE.Color('#b58560'),
    glace: new THREE.Color('#bec8cc'), cassini: new THREE.Color('#6a5d50'),
  };
  const c = new THREE.Color(), c2 = new THREE.Color();
  // quelques paliers brillants dans l'anneau intérieur
  const paliers = [0.035, 0.062, 0.09, 0.118, 0.141, 0.158];
  for (let i = 0; i < n; i++) {
    const x = i / (n - 1);
    let dens = 0;
    // anneau intérieur : ténu, gris-brun, à paliers
    const C = fenetre(0.0, 0.17, x, 0.004);
    let dC = 0.07 + 0.08 * bruit(x * 2.0 + 0.3, 2, 6);
    for (const p of paliers) dC += 0.22 * Math.exp(-Math.pow((x - p) / 0.0035, 4));
    // anneau principal : dense, très structuré, bord extérieur franc
    const B = fenetre(0.17, 0.53, x, 0.0018) * sm(0.17, 0.2, x);
    const dB = 0.45 + 0.45 * bruit(x * 1.3 + 0.1, 0, 3) + 0.22 * (bruit(x * 6.0 + 2.0, 3, 7) - 0.5) + 0.12 * Math.sin(x * 260.0 + 3.0 * bruit(x * 3.0, 2, 5));
    // division de Cassini : presque vide, deux annelets fantômes
    const cas = fenetre(0.53, 0.575, x, 0.0012);
    const dCas = 0.025 + 0.13 * Math.exp(-Math.pow((x - 0.545) / 0.0016, 2)) + 0.09 * Math.exp(-Math.pow((x - 0.561) / 0.0012, 2));
    // anneau extérieur : moyen, deux lacunes nettes, bord extérieur franc
    const A = fenetre(0.575, 0.86, x, 0.0015);
    let dA = 0.42 + 0.22 * bruit(x * 2.1 + 1.3, 0, 4) + 0.1 * (bruit(x * 9.0 + 5.0, 3, 7) - 0.5);
    dA *= lacune(0.815, 0.0042, x) * lacune(0.849, 0.0016, x);
    dA *= 1 + 0.25 * Math.exp(-Math.pow((x - 0.6) / 0.012, 2)); // bord intérieur un peu plus dense
    // division de Roche, puis filament extérieur
    const F = 0.6 * Math.exp(-Math.pow((x - 0.925) / 0.0022, 2)) + 0.05 * Math.exp(-Math.pow((x - 0.925) / 0.02, 2));
    dens = C * dC + B * dB + cas * dCas + A * dA + F + 0.012 * fenetre(0.86, 0.98, x, 0.01);
    // annelets à toutes les échelles
    dens *= 0.7 + 0.6 * bruit(x * 23.0 + 7.0, 2, 7);
    dens = Math.min(1, Math.max(0, dens));
    // couleur : brun gris à l'intérieur, crème et fauve dans l'anneau principal, plus gris et glacé dehors
    if (x < 0.17) c.copy(couleurs.terne).lerp(couleurs.gris, bruit(x * 5.0, 1, 5));
    else if (x < 0.53) {
      c.copy(couleurs.creme).lerp(couleurs.tan, sm(0.3, 0.7, bruit(x * 7.0 + 1.0, 1, 6)));
      c.lerp(couleurs.clair, 0.45 * sm(0.55, 0.85, bruit(x * 15.0 + 4.0, 2, 7)));
      c.lerp(couleurs.rouille, 0.3 * sm(0.62, 0.9, bruit(x * 4.0 + 9.0, 1, 5)));
    } else if (x < 0.575) c.copy(couleurs.cassini);
    else if (x < 0.86) c.copy(couleurs.creme).lerp(couleurs.gris, 0.35 + 0.3 * bruit(x * 6.0 + 2.0, 1, 6)).lerp(couleurs.glace, 0.25 * sm(0.7, 0.86, x));
    else c.copy(couleurs.glace).lerp(couleurs.clair, 0.3);
    // albédo qui change d'un annelet à l'autre
    c2.copy(c).multiplyScalar(0.72 + 0.52 * bruit(x * 31.0 + 2.0, 2, 7));
    data[i * 4] = Math.min(255, c2.r * 255);
    data[i * 4 + 1] = Math.min(255, c2.g * 255);
    data[i * 4 + 2] = Math.min(255, c2.b * 255);
    data[i * 4 + 3] = Math.round(dens * 255);
  }
  const tex = new THREE.DataTexture(data, n, 1, THREE.RGBAFormat);
  tex.magFilter = THREE.LinearFilter;
  tex.minFilter = THREE.LinearMipmapLinearFilter;
  tex.generateMipmaps = true;
  tex.wrapS = THREE.ClampToEdgeWrapping;
  tex.needsUpdate = true;
  return tex;
}

const VERT = /* glsl */ `
varying vec3 vMonde;
varying vec2 vPlan;
void main(){
  vPlan = position.xy;
  vec4 w = modelMatrix * vec4(position, 1.0);
  vMonde = w.xyz;
  gl_Position = projectionMatrix * viewMatrix * w;
}
`;

const FRAG = /* glsl */ `
uniform sampler2D uProfil;
uniform float uRInt;
uniform float uRExt;
uniform vec3 uCentre;
uniform float uRayon;
uniform vec3 uNormale;
uniform vec3 uSoleil;
uniform vec3 uCouleurSoleil;
uniform float uEclat;
uniform float uPres;
uniform float uTemps;
varying vec3 vMonde;
varying vec2 vPlan;
${HASH}
${OMBRE_PLANETE}
void main(){
  float r = length(vPlan);
  float x = (r - uRInt) / (uRExt - uRInt);
  if (x < 0.0 || x > 1.0) discard;
  vec4 pr = texture(uProfil, vec2(x, 0.5));
  float tau = pr.a;
  // annelets fins, filtrés selon la taille du pixel pour ne pas scintiller
  float f1 = x * 9000.0;
  float fw = fwidth(f1);
  float an = vnoise1(f1) * 2.0 - 1.0;
  tau *= 1.0 + 0.28 * an * (1.0 - smoothstep(0.3, 1.2, fw));
  float f2 = x * 52000.0;
  float an2 = vnoise1(f2) * 2.0 - 1.0;
  tau *= 1.0 + 0.2 * an2 * (1.0 - smoothstep(0.3, 1.2, fwidth(f2)));
  // grumeaux le long de l'orbite
  float grain = vnoise2(vPlan * 0.018 + vec2(uTemps * 0.01, 0.0));
  tau *= 0.88 + 0.24 * grain;
  tau = max(tau, 0.0);

  vec3 V = normalize(cameraPosition - vMonde);
  float muV = abs(dot(V, uNormale));
  float muS = dot(uSoleil, uNormale);
  float alpha = 1.0 - exp(-tau * 3.2 / max(muV, 0.035));

  float memeCote = step(0.0, dot(V, uNormale) * muS);
  float aS = max(abs(muS), 0.06);
  float face = 0.32 + 0.68 * (1.0 - exp(-tau * 2.5 / aS));
  float dos = exp(-tau * 1.4 / aS) * (1.0 - exp(-tau * 1.8 / max(muV, 0.05))) * 1.5;
  float eclair = mix(dos, face, memeCote);
  float avant = pow(max(dot(-V, uSoleil), 0.0), 6.0);
  float phase = 1.0 + 2.2 * avant;
  float ombre = ombrePlanete(vMonde, uSoleil, uCentre, uRayon);
  vec3 col = pr.rgb * uCouleurSoleil * eclair * phase * ombre * uEclat;
  // lumière renvoyée par la planète sur la partie intérieure
  col += pr.rgb * vec3(0.05, 0.035, 0.02) * (1.0 - x) * uEclat;
  // près de la caméra, dans le plan : les blocs instanciés prennent le relais
  float dist = length(cameraPosition - vMonde);
  // près de la caméra, dans la couche de blocs seulement (uPres, voir app.js) : le disque s'efface en amas
  // et les blocs prennent le relais (un plancher opaque à 45 % couvrait toute la moitié basse de la halte)
  float amas = smoothstep(0.3, 0.7, vnoise2(vPlan * 0.045 + 7.0));
  alpha *= mix(1.0, smoothstep(70.0, 420.0, dist) * (0.75 + 0.25 * amas), uPres);
  gl_FragColor = vec4(col, alpha);
}
`;

export function creerAnneaux(geo, profil) {
  const uniforms = {
    uProfil: { value: profil },
    uRInt: { value: geo.rInt },
    uRExt: { value: geo.rExt },
    uCentre: { value: geo.C },
    uRayon: { value: geo.R },
    uNormale: { value: geo.normale },
    uSoleil: { value: new THREE.Vector3(1, 0, 0) },
    uCouleurSoleil: { value: new THREE.Color(1, 1, 1) },
    uEclat: { value: 0.78 },
    uPres: { value: 0 },
    uTemps: { value: 0 },
  };
  const mesh = new THREE.Mesh(
    new THREE.RingGeometry(geo.rInt, geo.rExt, 720, 1),
    new THREE.ShaderMaterial({
      uniforms, vertexShader: VERT, fragmentShader: FRAG,
      transparent: true, depthWrite: false, side: THREE.DoubleSide,
    }),
  );
  mesh.material.forceSinglePass = true;
  mesh.name = 'anneaux_geante';
  mesh.position.copy(geo.C);
  mesh.quaternion.setFromUnitVectors(new THREE.Vector3(0, 0, 1), geo.normale);
  mesh.renderOrder = 3;
  mesh.frustumCulled = false;
  return { mesh, uniforms };
}
