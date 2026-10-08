// La géante gazeuse.
// 1. Palette de bandes générée en JS : une vingtaine de bandes principales de largeurs inégales
//    (zones claires, ceintures rouille, équateur ambré, pôles ternes) et environ 140 rubans fins.
//    Le canal alpha garde la force des frontières (là où la couleur change vite) : c'est là que
//    l'atmosphère se déchire en festons et en volutes.
// 2. Cuisson unique dans un cubemap, par tuiles : 32 tourbillons déforment le domaine (une grande
//    tempête à spirale, une chaîne d'ovales blancs, deux barges sombres, des remous aux frontières),
//    puis un domain warping anisotrope à plusieurs échelles, plus fort aux frontières, des festons,
//    des stries fines et des pôles marbrés.
// 3. Rendu à chaque image : rotation différentielle par latitude (jets alternés), couche de détail
//    fin advectée qui reste nette de près, terminateur net avec une légère diffusion, assombrissement
//    du limbe, brume, ombre des anneaux, éclairs côté nuit, bord rétroéclairé.
// 4. Une coquille d'atmosphère additive autour du disque.
import * as THREE from 'three';
import { SIMPLEX, HASH } from './glsl.js';

// générateur pseudo-aléatoire déterministe
function alea(seed) {
  let s = seed >>> 0;
  return () => { s = (s + 0x6d2b79f5) >>> 0; let t = s; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}

const PAL = {
  zone: ['#efd9b0', '#f1ddb7', '#ead09f', '#edd5a8'],
  claire: ['#f6e9ce', '#f3e3c2', '#f8eed8'],
  equateur: ['#ecd09b', '#e6c185', '#efd6a6'],
  ambre: ['#e2a54f', '#e7b263', '#d99a48'],
  ceinture: ['#c8873e', '#bf7d40', '#cf9450', '#b97a48'],
  rouille: ['#a8572f', '#b5643a', '#9a4a2a', '#ad5b33'],
  forte: ['#8e4527', '#7a3b22', '#9a4a2a'],
  brun: ['#5a3322', '#4a2a1c', '#63392a'],
  polaire: ['#7b5c43', '#6a4e3a', '#846549', '#735640'],
};

// bandes principales, du pôle sud au pôle nord : [latitude de début, de fin, sorte]
const MAJEURES = [
  [-90, -74, 'polaire'], [-74, -66, 'brun'], [-66, -61, 'ceinture'], [-61, -57.5, 'zone'], [-57.5, -53, 'rouille'],
  [-53, -49.5, 'zone'], [-49.5, -46, 'ceinture'], [-46, -40.5, 'claire'], [-40.5, -36, 'ceinture'], [-36, -32.5, 'zone'],
  [-32.5, -28, 'rouille'], [-28, -17.5, 'claire'], [-17.5, -13.5, 'rouille'], [-13.5, -9.5, 'forte'], [-9.5, -7, 'ambre'],
  [-7, -2, 'equateur'], [-2, 1.5, 'ambre'], [1.5, 6.5, 'equateur'], [6.5, 9.5, 'rouille'], [9.5, 13.5, 'forte'],
  [13.5, 17, 'brun'], [17, 22.5, 'claire'], [22.5, 27, 'ceinture'], [27, 30, 'rouille'], [30, 35.5, 'zone'],
  [35.5, 39, 'ceinture'], [39, 44, 'claire'], [44, 48.5, 'rouille'], [48.5, 53, 'zone'], [53, 58, 'ceinture'],
  [58, 63, 'zone'], [63, 70, 'brun'], [70, 90, 'polaire'],
];

function textureBandes() {
  const n = 2048;
  const rnd = alea(20261001);
  const pick = (k) => new THREE.Color(PAL[k][Math.floor(rnd() * PAL[k].length)]);
  const col = new Float32Array(n * 3);
  const latDe = (i) => -90 + (180 * i) / (n - 1);
  // 1. bandes principales, avec un léger dégradé interne
  for (const [l0, l1, k] of MAJEURES) {
    const a = pick(k), b = pick(k);
    for (let i = 0; i < n; i++) {
      const lat = latDe(i);
      if (lat < l0 || lat > l1) continue;
      const t = (lat - l0) / (l1 - l0);
      const c = a.clone().lerp(b, t * t * (3 - 2 * t));
      col.set([c.r, c.g, c.b], i * 3);
    }
  }
  // 2. rubans fins : décalages de teinte de largeurs variées, plus nombreux près de l'équateur
  const toutes = Object.keys(PAL);
  for (let r = 0; r < 150; r++) {
    const u = rnd() * 2 - 1;
    const centre = Math.sign(u) * Math.pow(Math.abs(u), 1.25) * 80;
    const largeur = 0.12 + Math.pow(rnd(), 2.2) * 1.6;
    const cible = pick(toutes[Math.floor(rnd() * toutes.length)]);
    const force = 0.08 + rnd() * 0.3;
    for (let i = 0; i < n; i++) {
      const d = Math.abs(latDe(i) - centre) / largeur;
      if (d > 1.5) continue;
      const w = force * (1 - Math.min(1, Math.max(0, (d - 0.6) / 0.9)));
      col[i * 3] += (cible.r - col[i * 3]) * w;
      col[i * 3 + 1] += (cible.g - col[i * 3 + 1]) * w;
      col[i * 3 + 2] += (cible.b - col[i * 3 + 2]) * w;
    }
  }
  // 3. adoucir légèrement les transitions (flou de 2 texels, deux passes)
  for (let pass = 0; pass < 2; pass++) {
    const src = col.slice();
    for (let i = 2; i < n - 2; i++) {
      for (let c = 0; c < 3; c++) {
        col[i * 3 + c] = (src[(i - 2) * 3 + c] + 2 * src[(i - 1) * 3 + c] + 3 * src[i * 3 + c] + 2 * src[(i + 1) * 3 + c] + src[(i + 2) * 3 + c]) / 9;
      }
    }
  }
  // 4. force des frontières : variation locale de luminance, étalée sur environ 2 degrés
  const lum = new Float32Array(n);
  for (let i = 0; i < n; i++) lum[i] = 0.2126 * col[i * 3] + 0.7152 * col[i * 3 + 1] + 0.0722 * col[i * 3 + 2];
  const grad = new Float32Array(n);
  for (let i = 3; i < n - 3; i++) grad[i] = Math.abs(lum[i + 3] - lum[i - 3]);
  const bord = new Float32Array(n);
  const rayon = 12;
  let maxB = 1e-6;
  for (let i = 0; i < n; i++) {
    let s = 0, wsum = 0;
    for (let k = -rayon; k <= rayon; k++) { const j = i + k; if (j < 0 || j >= n) continue; const w = 1 - Math.abs(k) / (rayon + 1); s += grad[j] * w; wsum += w; }
    bord[i] = s / wsum;
    maxB = Math.max(maxB, bord[i]);
  }
  const data = new Uint8Array(n * 4);
  for (let i = 0; i < n; i++) {
    data[i * 4] = Math.min(255, Math.pow(Math.max(0, col[i * 3]), 1 / 2.2) * 255);
    data[i * 4 + 1] = Math.min(255, Math.pow(Math.max(0, col[i * 3 + 1]), 1 / 2.2) * 255);
    data[i * 4 + 2] = Math.min(255, Math.pow(Math.max(0, col[i * 3 + 2]), 1 / 2.2) * 255);
    data[i * 4 + 3] = Math.min(255, Math.pow(bord[i] / maxB, 0.6) * 255);
  }
  const tex = new THREE.DataTexture(data, n, 1, THREE.RGBAFormat);
  tex.magFilter = THREE.LinearFilter;
  tex.minFilter = THREE.LinearFilter;
  tex.wrapS = THREE.ClampToEdgeWrapping;
  tex.needsUpdate = true;
  return tex;
}

// Tourbillons : [latitude, longitude, rayon (degrés), étirement est-ouest, tourbillon (radians), sorte]
// sorte : 0 remous (déforme seulement), 1 ovale blanc, 2 barge sombre, 3 grande tempête
function tourbillons(lonFace = 0) {
  // hémisphère nord : c'est lui qu'on voit au-dessus des anneaux depuis la station
  const t = [
    [21.0, 0, 6.4, 1.85, -2.9, 3],
    [37.5, -78, 2.3, 1.45, -2.4, 1], [37.2, -52, 2.0, 1.4, -2.2, 1], [37.8, -28, 2.4, 1.5, -2.4, 1], [36.8, 30, 1.7, 1.4, -2.0, 1], [37.4, 54, 2.1, 1.45, -2.2, 1],
    [-15.4, -40, 1.5, 2.8, 1.6, 2], [-15.8, 96, 1.4, 2.6, 1.5, 2],
    [-41.5, 150, 2.6, 1.6, 2.2, 1], [58.5, -130, 1.9, 1.5, -2.0, 1],
  ];
  // remous aux frontières, sens alterné comme le cisaillement des jets
  const rnd = alea(77);
  const frontieres = [];
  for (let i = 1; i < MAJEURES.length - 1; i++) frontieres.push(MAJEURES[i][0]);
  while (t.length < 48) {
    const f = frontieres[Math.floor(rnd() * frontieres.length)];
    if (Math.abs(f) > 66) continue;
    const lat = f + (rnd() - 0.5) * 1.8;
    const lon = rnd() * 360 - 180;
    const sens = Math.sin((f * Math.PI) / 9) > 0 ? 1 : -1;
    // un remous sur trois porte un cœur clair ou sombre, les autres ne font que tordre les bandes
    const sorte = rnd() < 0.34 ? (rnd() < 0.5 ? 4 : 5) : 0;
    t.push([lat, lon, 0.7 + rnd() * 1.7, 1.5 + rnd() * 1.3, sens * (1.8 + rnd() * 1.8), sorte]);
  }
  // la grande tempête et ses voisines du côté que regarde la station
  return t.map(([la, lo, r, e, tw, k]) => [la, lo + lonFace, r, e, tw, k]);
}

const BAKE_FRAG = /* glsl */ `
precision highp float;
uniform float uFace;
uniform float uSize;
uniform sampler2D uBandes;
uniform vec4 uT[48];
uniform vec4 uTb[48];
${SIMPLEX}
vec3 dirFace(vec2 sc){
  // conventions des faces de cubemap OpenGL (sc, tc dans [-1, 1])
  float s = sc.x, t = sc.y;
  if (uFace < 0.5) return vec3(1.0, -t, -s);
  if (uFace < 1.5) return vec3(-1.0, -t, s);
  if (uFace < 2.5) return vec3(s, 1.0, t);
  if (uFace < 3.5) return vec3(s, -1.0, -t);
  if (uFace < 4.5) return vec3(s, -t, 1.0);
  return vec3(-s, -t, -1.0);
}
float fbm(vec3 p){
  float a = 0.5, s = 0.0;
  for (int i = 0; i < 6; i++) { s += a * snoise(p); p = p * 2.03 + vec3(1.7, 9.2, 3.4); a *= 0.5; }
  return s;
}
float fbm3(vec3 p){
  float a = 0.5, s = 0.0;
  for (int i = 0; i < 3; i++) { s += a * snoise(p); p = p * 2.11 + vec3(5.1, 1.3, 7.7); a *= 0.5; }
  return s;
}
vec3 tourne(vec3 p, vec3 ax, float a){ return p * cos(a) + cross(ax, p) * sin(a) + ax * dot(ax, p) * (1.0 - cos(a)); }
vec4 bande(float lat){
  vec4 b = texture(uBandes, vec2(0.5 + lat / 3.14159265, 0.5));
  return vec4(pow(b.rgb, vec3(2.2)), b.a);
}
void main(){
  vec2 st = gl_FragCoord.xy / uSize;
  vec3 p = normalize(dirFace(st * 2.0 - 1.0));
  vec3 p0 = p;

  // --- tourbillons : chacun fait tourner le domaine autour de son centre
  float mBlanc = 0.0, mBarge = 0.0, mGrande = 0.0, spirale = 0.0, sillage = 0.0, collier = 0.0, anneauBlanc = 0.0, rClair = 0.0, rSombre = 0.0;
  for (int i = 0; i < 48; i++) {
    vec4 T = uT[i]; vec4 B = uTb[i];
    vec3 c = T.xyz;
    vec3 est = normalize(cross(vec3(0.0, 1.0, 0.0), c));
    vec3 nord = cross(c, est);
    vec3 dp = p0 - c;
    vec2 q = vec2(dot(dp, est) / (T.w * B.x), dot(dp, nord) / T.w);
    float r = length(q);
    if (r > 3.2) continue;
    float tw = B.y * exp(-r * r * 1.15);
    p = normalize(tourne(p, c, tw));
    int k = int(B.z + 0.5);
    float m = 1.0 - smoothstep(0.78, 1.0, r);
    if (k == 1) { mBlanc = max(mBlanc, m); anneauBlanc = max(anneauBlanc, exp(-((r - 0.92) * 9.0) * ((r - 0.92) * 9.0))); }
    else if (k == 4) rClair = max(rClair, m * (0.55 + 0.45 * sin(atan(q.y, q.x) * 2.0 + 6.0 * log(r + 0.08))));
    else if (k == 5) rSombre = max(rSombre, m * (0.55 + 0.45 * sin(atan(q.y, q.x) * 2.0 + 6.0 * log(r + 0.08))));
    else if (k == 2) mBarge = max(mBarge, m);
    else if (k == 3) {
      mGrande = max(mGrande, m);
      float ang = atan(q.y, q.x);
      // bras spiraux : l'angle s'enroule avec le logarithme du rayon
      spirale = 0.5 + 0.5 * sin(2.0 * ang + 7.5 * log(r + 0.06) + 2.2 * fbm3(vec3(q * 3.0, 4.0)));
      // sillage turbulent à l'ouest de la tempête
      sillage = max(sillage, exp(-(q.y * 1.4) * (q.y * 1.4)) * smoothstep(0.9, 1.6, -q.x) * (1.0 - smoothstep(2.0, 3.2, -q.x)));
      collier = max(collier, exp(-((r - 1.1) * 5.5) * ((r - 1.1) * 5.5)));
    }
  }

  // --- double domain warping anisotrope : volutes étirées le long des parallèles
  float frontiere0 = bande(asin(clamp(p.y, -1.0, 1.0))).a;
  vec3 A = vec3(3.0, 15.0, 3.0);
  vec3 w1 = vec3(fbm3(p * A + 1.3), fbm3(p * A + 7.1), fbm3(p * A + 3.9));
  vec3 q1 = normalize(p + vec3(w1.x, w1.y * 0.22, w1.z) * (0.03 + 0.04 * frontiere0));
  vec3 B2 = vec3(7.0, 34.0, 7.0);
  vec3 w2 = vec3(fbm3(q1 * B2 + 11.3), fbm3(q1 * B2 + 17.1), fbm3(q1 * B2 + 23.9));
  vec3 q = normalize(q1 + vec3(w2.x, w2.y * 0.3, w2.z) * (0.012 + 0.03 * frontiere0 + 0.02 * sillage));
  float lat0 = asin(clamp(q.y, -1.0, 1.0));
  float lon = atan(q.z, q.x);
  vec4 b0 = bande(lat0);
  float frontiere = b0.a;
  float n1 = fbm(vec3(q.x * 4.5, q.y * 26.0, q.z * 4.5) + w2 * 1.6);
  float n2 = fbm(vec3(q.x * 11.0, q.y * 62.0, q.z * 11.0) + vec3(n1 * 2.2) + 17.0);
  // déplacement en latitude : faible au cœur des bandes, plus fort aux frontières (cisaillement)
  float amp = 0.004 + 0.016 * frontiere + 0.012 * sillage;
  float dLat = amp * n1 + 0.4 * amp * n2;
  // festons : boucles le long des frontières, comme sur Jupiter
  float fest = sin(lon * 17.0 + n1 * 5.0) * sin(lon * 5.0 - n2 * 2.0) * 0.006 * frontiere;
  float lat = lat0 + dLat + fest;
  vec4 b = bande(lat);
  vec3 col = b.rgb;

  // --- texture fine : stries le long des bandes, remous, ombres de relief nuageux
  float stri = fbm(vec3(q.x * 26.0, q.y * 190.0, q.z * 26.0) + vec3(n2 * 3.0));
  col *= 0.9 + 0.2 * (0.5 + 0.5 * stri);
  float grumeaux = fbm3(vec3(q.x * 40.0, q.y * 120.0, q.z * 40.0) + vec3(n1 * 4.0));
  col *= 0.96 + 0.08 * grumeaux;
  // panaches clairs qui s'enroulent aux frontières
  float panache = smoothstep(0.28, 0.75, n2 + 0.35 * n1) * frontiere;
  col = mix(col, vec3(0.95, 0.87, 0.72), panache * 0.45);
  // traînées sombres dans les ceintures
  float sombre = smoothstep(0.35, 0.8, -n2) * (1.0 - smoothstep(0.55, 0.75, dot(b.rgb, vec3(0.33))));
  col = mix(col, col * vec3(0.62, 0.5, 0.44), sombre * 0.5);

  // --- pôles marbrés, plus ternes
  float polaire = smoothstep(0.95, 1.25, abs(lat0));
  float marbre = fbm(p * 9.0 + 5.0);
  col = mix(col, col * vec3(0.78, 0.74, 0.72) * (0.85 + 0.3 * marbre), polaire);

  // --- tempêtes
  vec3 rouilleSombre = vec3(0.47, 0.13, 0.05), rouilleClaire = vec3(0.80, 0.38, 0.17);
  vec3 grande = mix(rouilleSombre, rouilleClaire, spirale);
  grande = mix(grande, vec3(0.9, 0.62, 0.38), 0.25 * fbm3(p * 60.0));
  col = mix(col, grande, mGrande * 0.94);
  // collier clair autour de la grande tempête, sillage remué
  col = mix(col, vec3(0.96, 0.88, 0.72), collier * 0.6 + sillage * 0.12);
  col = mix(col, vec3(0.97, 0.92, 0.82), mBlanc * 0.88);
  col = mix(col, col * vec3(0.7, 0.58, 0.48), anneauBlanc * 0.45);
  col = mix(col, vec3(0.22, 0.11, 0.06), mBarge * 0.82);
  col = mix(col, vec3(0.95, 0.88, 0.74), rClair * 0.42);
  col = mix(col, col * vec3(0.55, 0.42, 0.34), rSombre * 0.45);

  // saturation et contraste : la géante doit rester riche après le tone mapping
  float lum = dot(col, vec3(0.2126, 0.7152, 0.0722));
  col = max(mix(vec3(lum), col, 1.28), 0.0);
  col = pow(col, vec3(1.1)) * 1.06;
  gl_FragColor = vec4(pow(clamp(col, 0.0, 1.0), vec3(1.0 / 2.2)), 1.0);
}
`;

const PLANETE_VERT = /* glsl */ `
varying vec3 vMonde;
varying vec3 vLocal;
void main(){
  vLocal = position;
  vec4 w = modelMatrix * vec4(position, 1.0);
  vMonde = w.xyz;
  gl_Position = projectionMatrix * viewMatrix * w;
}
`;

const PLANETE_FRAG = /* glsl */ `
uniform samplerCube uCube;
uniform vec3 uSoleil;
uniform vec3 uCouleurSoleil;
uniform float uTemps;
uniform float uRotation;
uniform vec3 uCentre;
uniform float uRayon;
uniform vec3 uNormale;
uniform float uRInt;
uniform float uRExt;
uniform sampler2D uProfil;
uniform float uEclat;
uniform float uNuit;
uniform float uDetail;
varying vec3 vMonde;
varying vec3 vLocal;
${SIMPLEX}
${HASH}
vec3 rotY(vec3 p, float a){ float c = cos(a), s = sin(a); return vec3(c * p.x + s * p.z, p.y, -s * p.x + c * p.z); }
void main(){
  vec3 N = normalize(vMonde - uCentre);
  vec3 V = normalize(cameraPosition - vMonde);
  vec3 d = normalize(vLocal);
  // rotation différentielle : jets alternés d'une bande à l'autre, l'équateur plus rapide
  float sl = d.y;
  float jets = 1.0 + 0.4 * cos(sl * 3.0) + 0.22 * sin(sl * 23.0) + 0.1 * sin(sl * 47.0 + 1.3);
  float w = uTemps * uRotation * jets;
  d = rotY(d, w);
  // ondulation lente des bandes
  float t = uTemps * 0.012;
  vec3 o = vec3(snoise(d * 5.0 + vec3(t, 0.0, 0.0)), snoise(d * 5.0 + vec3(0.0, t, 7.0)), snoise(d * 5.0 + vec3(3.0, 0.0, t)));
  d = normalize(d + o * 0.003);
  vec3 alb = pow(texture(uCube, d).rgb, vec3(2.2));
  // détail fin advecté : reste net quand la géante remplit l'écran
  float f1 = 0.0;
  if (uDetail > 0.0) {
    float fy1 = d.y * 300.0, fy2 = d.y * 780.0;
    f1 = snoise(vec3(d.x * 52.0, fy1, d.z * 52.0) + vec3(0.0, 0.0, t * 3.0));
    float f2 = snoise(vec3(d.x * 130.0, fy2, d.z * 130.0) + vec3(f1 * 0.6, 0.0, -t * 5.0));
    float g1 = 1.0 - smoothstep(0.35, 1.2, fwidth(fy1));
    float g2 = 1.0 - smoothstep(0.35, 1.2, fwidth(fy2));
    alb *= 1.0 + uDetail * (0.07 * f1 * g1 + 0.05 * f2 * g2);
  }

  float NdL = dot(N, uSoleil);
  float mu = max(dot(N, V), 0.0);
  // terminateur net, avec une légère diffusion au-delà
  float diff = pow(clamp(NdL, 0.0, 1.0), 0.72) * smoothstep(-0.015, 0.035, NdL);
  float diffusion = exp(-max(-NdL, 0.0) * 30.0) * (1.0 - smoothstep(-0.005, 0.04, NdL)) * 0.06;
  vec3 teinte = mix(vec3(1.0, 0.5, 0.24), vec3(1.0), smoothstep(0.0, 0.22, NdL));
  float limbe = 0.45 + 0.55 * pow(mu, 0.38);

  // ombre des anneaux sur les nuages
  float ombreAnneaux = 1.0;
  float dn = dot(uSoleil, uNormale);
  if (abs(dn) > 1e-4) {
    float tt = dot(uCentre - vMonde, uNormale) / dn;
    if (tt > 0.0) {
      vec3 hit = vMonde + uSoleil * tt;
      float r = length(hit - uCentre);
      float x = (r - uRInt) / (uRExt - uRInt);
      if (x > 0.0 && x < 1.0) {
        // pénombre (lot F) : le soleil n'est pas un point ; moyenne sur ±1,6 % de la largeur des anneaux
        // et ombre moins dure (avant : des bandes noires nettes et striées sous la ligne des anneaux)
        float a = 0.0;
        for (int k = -2; k <= 2; k++) a += texture(uProfil, vec2(x + float(k) * 0.008, 0.5)).a;
        a *= 0.2;
        ombreAnneaux = 1.0 - 0.62 * smoothstep(0.0, 0.8, a);
      }
    }
  }

  vec3 col = alb * diff * teinte * uCouleurSoleil * limbe * ombreAnneaux * uEclat;
  col += alb * vec3(1.0, 0.55, 0.3) * diffusion * uCouleurSoleil * uEclat;
  // brume d'altitude vers le limbe, côté jour
  float fres = pow(max(1.0 - mu, 0.0), 3.0);
  float jourBrume = smoothstep(-0.1, 0.45, NdL);
  col = mix(col, vec3(0.98, 0.72, 0.45) * uCouleurSoleil * uEclat * 0.85, fres * 0.5 * jourBrume);
  // côté nuit : lueur des anneaux et des étoiles, quelques éclairs dans les tempêtes
  float nuit = 1.0 - smoothstep(-0.2, 0.05, NdL);
  col += alb * vec3(0.026, 0.022, 0.024) * uNuit * (0.4 + 0.6 * nuit);
  // contre-jour : quand le soleil est derrière, le bord du disque s'allume
  float contre = pow(max(dot(-V, uSoleil), 0.0), 5.0);
  col += vec3(1.0, 0.56, 0.26) * contre * pow(max(1.0 - mu, 0.0), 7.0) * 2.4 * uCouleurSoleil;
  gl_FragColor = vec4(col, 1.0);
}
`;

const ATMO_FRAG = /* glsl */ `
uniform vec3 uSoleil;
uniform vec3 uCouleurSoleil;
uniform vec3 uCentre;
uniform float uRayon;
uniform float uEclat;
varying vec3 vMonde;
void main(){
  vec3 dir = normalize(vMonde - cameraPosition);
  vec3 oc = uCentre - cameraPosition;
  float tca = dot(oc, dir);
  float b = sqrt(max(dot(oc, oc) - tca * tca, 0.0));
  float h = (b - uRayon) / uRayon;           // altitude du point le plus proche, en rayons
  vec3 Pc = cameraPosition + dir * tca;
  vec3 Nc = normalize(Pc - uCentre);
  float eclaire = smoothstep(-0.3, 0.3, dot(Nc, uSoleil));
  float halo = h > 0.0 ? exp(-h / 0.009) * 0.9 + exp(-h / 0.02) * 0.14 : exp(h / 0.005) * 0.55;
  float avant = pow(max(dot(dir, uSoleil), 0.0), 10.0);
  float phase = 0.55 + 7.0 * avant;
  vec3 c = mix(vec3(0.95, 0.55, 0.26), vec3(1.0, 0.8, 0.56), eclaire);
  vec3 col = c * halo * phase * max(eclaire, avant * 0.9) * uCouleurSoleil * uEclat;
  gl_FragColor = vec4(col, 1.0);
}
`;

export function creerPlanete(renderer, geo, niveau, profilAnneau, cubeTaille, { lonFace = 0 } = {}) {
  // --- cuisson du cubemap, par tuiles (pas de longue commande GPU unique)
  const taille = cubeTaille;
  const rt = new THREE.WebGLCubeRenderTarget(taille, {
    type: THREE.UnsignedByteType,
    generateMipmaps: true,
    minFilter: THREE.LinearMipmapLinearFilter,
    magFilter: THREE.LinearFilter,
  });
  rt.texture.anisotropy = Math.min(8, renderer.capabilities.getMaxAnisotropy());
  const bandes = textureBandes();
  const uT = [], uTb = [];
  for (const [la, lo, r, etire, tour, sorte] of tourbillons(lonFace)) {
    const lat = (la * Math.PI) / 180, lon = (lo * Math.PI) / 180;
    const c = new THREE.Vector3(Math.cos(lat) * Math.cos(lon), Math.sin(lat), Math.cos(lat) * Math.sin(lon));
    uT.push(new THREE.Vector4(c.x, c.y, c.z, (r * Math.PI) / 180));
    uTb.push(new THREE.Vector4(etire, tour, sorte, 1));
  }
  const matBake = new THREE.ShaderMaterial({
    uniforms: {
      uFace: { value: 0 }, uSize: { value: taille }, uBandes: { value: bandes },
      uT: { value: uT }, uTb: { value: uTb },
    },
    vertexShader: 'void main(){ gl_Position = vec4(position.xy, 0.0, 1.0); }',
    fragmentShader: BAKE_FRAG,
    depthTest: false, depthWrite: false,
  });
  const triangle = new THREE.BufferGeometry();
  triangle.setAttribute('position', new THREE.Float32BufferAttribute([-1, -1, 0, 3, -1, 0, -1, 3, 0], 3));
  const quad = new THREE.Mesh(triangle, matBake);
  quad.frustumCulled = false;
  const sceneBake = new THREE.Scene();
  sceneBake.add(quad);
  const camBake = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);

  const cuire = () => {
    const avant = renderer.getRenderTarget();
    const tuiles = taille > 768 ? 3 : taille > 384 ? 2 : 1;
    const pas = Math.ceil(taille / tuiles);
    for (let f = 0; f < 6; f++) {
      matBake.uniforms.uFace.value = f;
      renderer.setRenderTarget(rt, f);
      rt.scissorTest = true;
      for (let ty = 0; ty < tuiles; ty++) {
        for (let tx = 0; tx < tuiles; tx++) {
          rt.scissor.set(tx * pas, ty * pas, Math.min(pas, taille - tx * pas), Math.min(pas, taille - ty * pas));
          renderer.setRenderTarget(rt, f);
          renderer.render(sceneBake, camBake);
        }
      }
      rt.scissorTest = false;
    }
    renderer.setRenderTarget(avant);
    matBake.dispose();
    triangle.dispose();
    bandes.dispose();
  };

  // --- la sphère
  const uniforms = {
    uCube: { value: rt.texture },
    uSoleil: { value: new THREE.Vector3(1, 0, 0) },
    uCouleurSoleil: { value: new THREE.Color(1, 1, 1) },
    uTemps: { value: 0 },
    uRotation: { value: 0.0016 },
    uCentre: { value: geo.C },
    uRayon: { value: geo.R },
    uNormale: { value: geo.normale },
    uRInt: { value: geo.rInt },
    uRExt: { value: geo.rExt },
    uProfil: { value: profilAnneau },
    uEclat: { value: 1.0 },
    uNuit: { value: 1.0 },
    uDetail: { value: niveau.detailPlanete ?? 1 },
  };
  const [ws, hs] = niveau.sphere;
  const sphere = new THREE.Mesh(
    new THREE.SphereGeometry(geo.R, ws, hs),
    new THREE.ShaderMaterial({ uniforms, vertexShader: PLANETE_VERT, fragmentShader: PLANETE_FRAG }),
  );
  sphere.name = 'geante';
  sphere.position.copy(geo.C);
  // axe de rotation de la planète = normale au plan des anneaux (anneaux équatoriaux)
  sphere.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), geo.normale);
  sphere.renderOrder = 0;

  const atmoUniforms = {
    uSoleil: uniforms.uSoleil, uCouleurSoleil: uniforms.uCouleurSoleil,
    uCentre: uniforms.uCentre, uRayon: uniforms.uRayon, uEclat: { value: 1.0 },
  };
  const atmo = new THREE.Mesh(
    new THREE.SphereGeometry(geo.R * 1.08, 96, 64),
    new THREE.ShaderMaterial({
      uniforms: atmoUniforms,
      vertexShader: 'varying vec3 vMonde; void main(){ vec4 w = modelMatrix * vec4(position,1.0); vMonde = w.xyz; gl_Position = projectionMatrix * viewMatrix * w; }',
      fragmentShader: ATMO_FRAG,
      transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
    }),
  );
  atmo.name = 'atmosphere';
  atmo.position.copy(geo.C);
  atmo.renderOrder = 2;

  return { sphere, atmo, uniforms, atmoUniforms, cuire, rt };
}
