// Carte d'environnement pour les reflets du cuivre et du verre : une petite scène peinte
// (géante ambrée d'un côté, bande claire des anneaux, nuit bleue de l'autre, point chaud du soleil)
// convertie une fois en PMREM.
import * as THREE from 'three';

export function creerEnvironnement(renderer, geo, soleil) {
  const scene = new THREE.Scene();
  const mat = new THREE.ShaderMaterial({
    side: THREE.BackSide,
    uniforms: {
      uPlanete: { value: geo.C.clone().normalize() },
      uNormale: { value: geo.normale.clone() },
      uSoleil: { value: soleil.clone() },
      uRayon: { value: Math.asin(geo.R / geo.C.length()) },
    },
    vertexShader: 'varying vec3 vD; void main(){ vD = position; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }',
    fragmentShader: /* glsl */ `
      uniform vec3 uPlanete; uniform vec3 uNormale; uniform vec3 uSoleil; uniform float uRayon;
      varying vec3 vD;
      void main(){
        vec3 d = normalize(vD);
        float a = acos(clamp(dot(d, uPlanete), -1.0, 1.0));
        float disque = 1.0 - smoothstep(uRayon * 0.96, uRayon * 1.04, a);
        float bandes = 0.5 + 0.5 * sin(dot(d, uNormale) * 40.0);
        vec3 planete = mix(vec3(0.55, 0.30, 0.13), vec3(0.85, 0.62, 0.36), bandes) * (0.5 + 0.5 * smoothstep(-0.2, 0.6, dot(d, uSoleil)));
        vec3 nuit = mix(vec3(0.006, 0.009, 0.02), vec3(0.02, 0.026, 0.045), 0.5 + 0.5 * d.y);
        float anneau = exp(-(dot(d, uNormale) / 0.035) * (dot(d, uNormale) / 0.035)) * (1.0 - disque);
        vec3 c = mix(nuit, planete, disque) + vec3(0.42, 0.36, 0.28) * anneau;
        c += vec3(1.0, 0.85, 0.65) * 30.0 * smoothstep(0.9993, 0.9999, dot(d, uSoleil));
        c += vec3(1.0, 0.7, 0.4) * 0.25 * pow(max(dot(d, uSoleil), 0.0), 16.0);
        gl_FragColor = vec4(c, 1.0);
      }`,
  });
  scene.add(new THREE.Mesh(new THREE.SphereGeometry(10, 64, 32), mat));
  const pmrem = new THREE.PMREMGenerator(renderer);
  const rt = pmrem.fromScene(scene, 0.02, 0.1, 100);
  pmrem.dispose();
  mat.dispose();
  return rt.texture;
}
