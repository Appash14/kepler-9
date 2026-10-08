// La traversée des anneaux : des milliers de blocs de glace et de roche (une seule InstancedMesh,
// rotation propre et dérive orbitale calculées dans le shader, aucune mise à jour par image côté
// processeur) et une poussière de cristaux qui scintille autour de la caméra.
import * as THREE from 'three';
import { HASH } from './glsl.js';

function geometrieBloc() {
  const g = new THREE.IcosahedronGeometry(1, 1);
  const p = g.attributes.position;
  const v = new THREE.Vector3();
  // déformation radiale, identique pour les sommets confondus (pas de fissure)
  const h = (x, y, z) => {
    const s = Math.sin(x * 12.9898 + y * 78.233 + z * 37.719) * 43758.5453;
    return s - Math.floor(s);
  };
  for (let i = 0; i < p.count; i++) {
    v.fromBufferAttribute(p, i);
    const k = 0.72 + 0.5 * h(Math.round(v.x * 1000), Math.round(v.y * 1000), Math.round(v.z * 1000));
    v.multiplyScalar(k);
    p.setXYZ(i, v.x, v.y * 0.82, v.z);
  }
  g.computeVertexNormals();
  return g;
}

export function creerDebris(geo, niveau, centre, profil) {
  const champ = 650; // rayon du champ de blocs (m)
  const n = niveau.debris;
  const g = geometrieBloc();
  const spin = new Float32Array(n * 4);
  let seed = 4242;
  const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
  const gauss = () => { let s = 0; for (let i = 0; i < 4; i++) s += rnd(); return (s - 2) / 0.58; };

  const mat = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.55, metalness: 0.0, flatShading: true });
  // uDemiH : demi-hauteur de l'image en pixels de rendu (taille apparente des blocs, voir plus bas)
  const U = { uTemps: { value: 0 }, uDerive: { value: 1.6 }, uChamp: { value: champ }, uDemiH: { value: 450 } };
  mat.onBeforeCompile = (sh) => {
    Object.assign(sh.uniforms, U);
    sh.vertexShader = sh.vertexShader
      .replace('#include <common>', `#include <common>
attribute vec4 aSpin;
uniform float uTemps;
uniform float uDerive;
uniform float uChamp;
uniform float uDemiH;
mat3 rotAxe(vec3 a, float t){
  float c = cos(t), s = sin(t), k = 1.0 - c;
  return mat3(c + a.x*a.x*k, a.y*a.x*k + a.z*s, a.z*a.x*k - a.y*s,
              a.x*a.y*k - a.z*s, c + a.y*a.y*k, a.z*a.y*k + a.x*s,
              a.x*a.z*k + a.y*s, a.y*a.z*k - a.x*s, c + a.z*a.z*k);
}`)
      .replace('#include <beginnormal_vertex>', `mat3 rSpin = rotAxe(aSpin.xyz, uTemps * aSpin.w);
vec3 objectNormal = rSpin * normal;
#ifdef USE_TANGENT
vec3 objectTangent = vec3(tangent.xyz);
#endif`)
      .replace('#include <begin_vertex>', 'vec3 transformed = rSpin * position;')
      .replace('#include <project_vertex>', `vec4 mvPosition = instanceMatrix * vec4(transformed, 1.0);
vec3 centreB = instanceMatrix[3].xyz;
vec3 c2 = centreB;
c2.x = mod(c2.x + uDerive * uTemps * (0.75 + 0.5 * fract(centreB.z * 0.0713)) + uChamp, 2.0 * uChamp) - uChamp;
float sc = 1.0 - smoothstep(0.72 * uChamp, uChamp, length(c2.xz));
// lot F : taille apparente du bloc en pixels. Sous un pixel, un bloc tombait entre les centres des
// pixels une image sur deux et clignotait (points sombres qui apparaissent et disparaissent) ; au loin,
// les blocs faisaient des « particules » éparpillées. Sous 1,6 px, un bloc s'efface en rétrécissant.
vec4 cVue = modelViewMatrix * vec4(c2, 1.0);
float px = length(instanceMatrix[0].xyz) * sc / max(-cVue.z, 0.5) * projectionMatrix[1][1] * uDemiH;
sc *= smoothstep(0.6, 1.6, px);
mvPosition.xyz = c2 + (mvPosition.xyz - centreB) * sc;
mvPosition = modelViewMatrix * mvPosition;
gl_Position = projectionMatrix * mvPosition;`);
  };
  mat.customProgramCacheKey = () => 'debris-v3';

  const radial0 = centre.clone().sub(geo.C).normalize();
  const tangente0 = new THREE.Vector3().crossVectors(geo.normale, radial0).normalize();
  const binormale0 = new THREE.Vector3().crossVectors(tangente0, geo.normale).normalize();
  const dataP = profil && profil.image && profil.image.data;
  const wv = new THREE.Vector3();
  // densité des anneaux au rayon r (0 hors des anneaux et dans les lacunes)
  const densite = (r) => {
    const x = (r - geo.rInt) / (geo.rExt - geo.rInt);
    if (x <= 0.004 || x >= 0.996) return 0;
    if (!dataP) return 1;
    const n2 = dataP.length / 4;
    return dataP[Math.min(n2 - 1, Math.floor(x * n2)) * 4 + 3] / 255;
  };
  const mesh = new THREE.InstancedMesh(g, mat, n);
  mesh.name = 'debris_anneaux';
  const m4 = new THREE.Matrix4(), q = new THREE.Quaternion(), s = new THREE.Vector3(), p = new THREE.Vector3(), e = new THREE.Euler();
  const glace = new THREE.Color('#c9d3d6'), sale = new THREE.Color('#b3a893'), roche = new THREE.Color('#7a6957'), cuivre = new THREE.Color('#9b6a46');
  const c = new THREE.Color();
  // quelques gros blocs posés près du point de vue, pour la composition
  const heros = [[-24, 3, -38, 9], [30, -5, -62, 12], [-58, -2, -120, 15], [14, 6, -18, 3.2], [-9, -3, -12, 1.6], [70, 4, -140, 10]];
  for (let i = 0; i < n; i++) {
    let x, y, z, t;
    if (i < heros.length) {
      [x, y, z, t] = heros[i];
    } else {
      const r = champ * Math.sqrt(rnd());
      const a = rnd() * Math.PI * 2;
      x = Math.cos(a) * r; z = Math.sin(a) * r;
      y = gauss() * 5.5;
      t = 0.25 * Math.pow(1 - rnd(), -0.85);
      t = Math.min(t, 7.5);
    }
    p.set(x, y, z);
    wv.copy(centre).addScaledVector(tangente0, x).addScaledVector(binormale0, z);
    const dloc = densite(wv.distanceTo(geo.C));
    if (i >= heros.length && rnd() > Math.min(1, dloc * 1.6)) t = 0; // pas de bloc dans les lacunes ni hors des anneaux
    e.set(rnd() * 6.28, rnd() * 6.28, rnd() * 6.28);
    q.setFromEuler(e);
    s.set(t * (0.7 + 0.6 * rnd()), t * (0.6 + 0.5 * rnd()), t * (0.7 + 0.6 * rnd()));
    m4.compose(p, q, s);
    mesh.setMatrixAt(i, m4);
    const k = rnd();
    c.copy(k < 0.5 ? glace : k < 0.8 ? sale : k < 0.97 ? roche : cuivre).multiplyScalar(0.85 + 0.3 * rnd());
    mesh.setColorAt(i, c);
    const ax = new THREE.Vector3(rnd() - 0.5, rnd() - 0.5, rnd() - 0.5).normalize();
    spin.set([ax.x, ax.y, ax.z, (rnd() - 0.5) * 0.5 / Math.max(0.6, Math.sqrt(t))], i * 4);
  }
  g.setAttribute('aSpin', new THREE.InstancedBufferAttribute(spin, 4));
  mesh.instanceMatrix.needsUpdate = true;
  mesh.frustumCulled = false;

  // repère local : Y = normale des anneaux, X = sens de l'orbite
  const radial = centre.clone().sub(geo.C).normalize();
  const tangente = new THREE.Vector3().crossVectors(geo.normale, radial).normalize();
  const binormale = new THREE.Vector3().crossVectors(tangente, geo.normale).normalize();
  const base = new THREE.Matrix4().makeBasis(tangente, geo.normale, binormale);
  const groupe = new THREE.Group();
  groupe.name = 'traversee';
  groupe.position.copy(centre);
  groupe.quaternion.setFromRotationMatrix(base);
  groupe.add(mesh);

  // --- poussière ---
  const np = niveau.poussiere;
  const pp = new Float32Array(np * 3), ph = new Float32Array(np);
  for (let i = 0; i < np; i++) {
    pp.set([(rnd() - 0.5) * 220, gauss() * 9, (rnd() - 0.5) * 220], i * 3);
    ph[i] = rnd();
  }
  const gp = new THREE.BufferGeometry();
  gp.setAttribute('position', new THREE.BufferAttribute(pp, 3));
  gp.setAttribute('aPhase', new THREE.BufferAttribute(ph, 1));
  const UP = {
    uTemps: U.uTemps, uCam: { value: new THREE.Vector3() }, uPixel: { value: 1 },
    uCouleur: { value: new THREE.Color(1.0, 0.86, 0.66) }, uForce: { value: 1 },
  };
  const poussiere = new THREE.Points(gp, new THREE.ShaderMaterial({
    uniforms: UP,
    vertexShader: /* glsl */ `
attribute float aPhase;
uniform float uTemps;
uniform vec3 uCam;
uniform float uPixel;
varying float vA;
${HASH}
void main(){
  vec3 b = vec3(220.0, 60.0, 220.0);
  vec3 p = position + vec3(uTemps * (1.2 + aPhase), 0.0, uTemps * 0.3 * (aPhase - 0.5));
  p = mod(p - uCam + b * 0.5, b) - b * 0.5 + uCam;
  vec4 mv = modelViewMatrix * vec4(p, 1.0);
  float dist = -mv.z;
  gl_Position = projectionMatrix * mv;
  gl_PointSize = clamp(90.0 / max(dist, 1.0), 1.0, 5.0) * uPixel;
  float scint = 0.35 + 0.65 * pow(max(0.5 + 0.5 * sin(uTemps * (2.0 + aPhase * 5.0) + aPhase * 60.0), 0.0), 6.0);
  vA = scint * smoothstep(110.0, 30.0, length(p - uCam)) * smoothstep(0.5, 3.0, dist);
}`,
    fragmentShader: /* glsl */ `
uniform vec3 uCouleur;
uniform float uForce;
varying float vA;
void main(){
  float a = smoothstep(0.5, 0.0, length(gl_PointCoord - 0.5));
  gl_FragColor = vec4(uCouleur * a * vA * uForce * 2.4, 1.0);
}`,
    transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
  }));
  poussiere.frustumCulled = false;
  poussiere.name = 'poussiere_anneaux';
  groupe.add(poussiere);

  const inv = new THREE.Matrix4();
  const majCamera = (camPos) => {
    inv.copy(groupe.matrixWorld).invert();
    UP.uCam.value.copy(camPos).applyMatrix4(inv);
  };

  return { groupe, mesh, poussiere, U, UP, majCamera };
}
